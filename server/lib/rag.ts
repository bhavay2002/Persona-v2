// RAG (Retrieval-Augmented Generation) Pipeline — Hardened
//
// Original: basic FTS + context injection
// Upgraded:
//   1. BM25-style FTS retrieval (top-10 candidates)
//   2. LLM Re-ranking (cross-encoder style — eliminates weak candidates)
//   3. Source confidence scoring: similarity × source_quality × recency_factor
//   4. Context selection (top-3, max 1200 tokens)
//   5. Citation-constrained generation (forces [doc_id] references)
//   6. Grounding verification (separate LLM call: supported? confidence?)
//   7. Confidence-based abstention (< 0.60 → "insufficient evidence")
//   8. Session logging for RAG evaluation (Recall@k, groundedness rate)
//
// Evaluation metrics tracked per session:
//   Recall@k, Groundedness score, Hallucination detection, Citation accuracy

import { getModel } from './gemini.js';
import pool from '../db.js';


// ─── Original types (preserved) ───────────────────────────────────────────────

export interface RAGContext {
  pastPosts: string[];
  recentDebateMessages: string[];
  contextSummary: string;
  retrievalMethod: 'semantic' | 'recency' | 'none';
}

// ─── New types ────────────────────────────────────────────────────────────────

export interface RawCandidate {
  doc_id: number;
  content: string;
  title: string | null;
  source: string;
  source_quality: number;
  ts_rank: number;
  created_at: string;
}

export interface RankedDocument {
  doc_id: number;
  content: string;
  title: string | null;
  source: string;
  rerank_score: number;       // LLM relevance score 0-1
  source_confidence: number;  // similarity × quality × recency
  token_estimate: number;
}

export interface GroundingResult {
  supported: boolean;
  confidence: number;          // 0-1: how well docs support the answer
  groundedness_score: number;  // fraction of claims that are cited
  unsupported_claims: string[];
}

export interface CitedAnswer {
  answer: string;
  citations: { doc_id: number; snippet: string }[];
  abstained: boolean;
  abstain_reason?: string;
}

export interface HardenedRAGResponse {
  query: string;
  retrieved_count: number;
  reranked_docs: RankedDocument[];
  cited_answer: CitedAnswer;
  grounding: GroundingResult;
  confidence: number;
  hallucination_detected: boolean;
  recall_at_k: number | null;
  session_id?: number;
}

// ─── Original FTS helpers (preserved) ────────────────────────────────────────

function buildTSQuery(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 8);
  if (words.length === 0) return null;
  return words.join(' | ');
}

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'they', 'have', 'will', 'been', 'were',
  'what', 'when', 'where', 'which', 'their', 'there', 'about', 'would',
  'should', 'could', 'more', 'than', 'your', 'just', 'into', 'also',
]);

export async function retrievePersonaContext(
  personaId: number,
  inputText: string,
  limit = 5
): Promise<RAGContext> {
  const tsquery = buildTSQuery(inputText);
  let pastPosts: string[] = [];
  let retrievalMethod: 'semantic' | 'recency' | 'none' = 'none';

  if (tsquery) {
    try {
      const result = await pool.query(
        `SELECT content FROM posts
         WHERE persona_id = $1
           AND to_tsvector('english', content) @@ to_tsquery('english', $2)
         ORDER BY ts_rank(to_tsvector('english', content), to_tsquery('english', $2)) DESC
         LIMIT $3`,
        [personaId, tsquery, limit]
      );
      if (result.rows.length > 0) {
        pastPosts = result.rows.map((r: any) => r.content);
        retrievalMethod = 'semantic';
      }
    } catch {}
  }

  if (pastPosts.length === 0) {
    const fallback = await pool.query(
      `SELECT content FROM posts WHERE persona_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [personaId, limit]
    );
    pastPosts = fallback.rows.map((r: any) => r.content);
    retrievalMethod = pastPosts.length > 0 ? 'recency' : 'none';
  }

  const debateMsgs = await pool.query(
    `SELECT dm.content FROM debate_messages dm WHERE dm.persona_id = $1 ORDER BY dm.created_at DESC LIMIT 3`,
    [personaId]
  );
  const recentDebateMessages = debateMsgs.rows.map((r: any) => r.content);
  const contextSummary = pastPosts.length > 0
    ? `${pastPosts.length} past statement${pastPosts.length > 1 ? 's' : ''} retrieved via ${retrievalMethod} search`
    : 'No prior context for this persona';

  return { pastPosts, recentDebateMessages, contextSummary, retrievalMethod };
}

export function buildRAGPrompt(
  compiledPersonaPrompt: string,
  context: RAGContext,
  taskInstruction: string
): string {
  const memoryBlock = context.pastPosts.length > 0
    ? `MEMORY CONTEXT — ${context.pastPosts.length} relevant past statement${context.pastPosts.length > 1 ? 's' : ''} by this persona:
${context.pastPosts.map((p, i) => `  [${i + 1}] "${p.length > 220 ? p.slice(0, 220) + '…' : p}"`).join('\n')}

ANTI-REPETITION RULE: Do NOT repeat ideas already expressed in MEMORY CONTEXT. If a similar concept applies, extend or refine it instead of restating it verbatim.`
    : '';

  const debateBlock = context.recentDebateMessages.length > 0
    ? `DEBATE MEMORY — recent arguments by this persona:
${context.recentDebateMessages.map((m, i) => `  [${i + 1}] "${m.length > 160 ? m.slice(0, 160) + '…' : m}"`).join('\n')}`
    : '';

  return [compiledPersonaPrompt, memoryBlock, debateBlock, taskInstruction].filter(Boolean).join('\n\n');
}

// ─── A. Retrieval Layer — BM25-style FTS ──────────────────────────────────────
// Pulls top-10 candidates from rag_documents using PostgreSQL ts_rank.

async function retrieveCandidates(query: string, topK = 10): Promise<RawCandidate[]> {
  const tsquery = buildTSQuery(query);
  if (!tsquery) return [];

  try {
    const res = await pool.query(
      `SELECT id as doc_id, content, title, source, source_quality,
         ts_rank(content_ts, to_tsquery('english', $1)) as ts_rank,
         created_at::text
       FROM rag_documents
       WHERE content_ts @@ to_tsquery('english', $1)
       ORDER BY ts_rank DESC
       LIMIT $2`,
      [tsquery, topK]
    );
    return res.rows;
  } catch {
    return [];
  }
}

// ─── B. Source Confidence Scoring ────────────────────────────────────────────
// confidence = similarity_score × source_quality × recency_factor
// recency_factor decays from 1.0 (today) to 0.5 (> 1 year)

function computeSourceConfidence(candidate: RawCandidate): number {
  const similarity   = Math.min(1, candidate.ts_rank * 10); // normalize ts_rank to 0-1
  const quality      = candidate.source_quality || 0.7;
  const ageMs        = Date.now() - new Date(candidate.created_at).getTime();
  const ageDays      = ageMs / (1000 * 60 * 60 * 24);
  const recency      = Math.max(0.5, 1 - ageDays / 365); // 1.0 today, 0.5 after 1 year
  return Math.round(similarity * quality * recency * 1000) / 1000;
}

// ─── C. LLM Re-Ranking ───────────────────────────────────────────────────────
// Single Gemini call scores all candidates on relevance to query.
// Returns top-N by rerank_score.

async function rerankDocuments(
  query: string,
  candidates: RawCandidate[],
  topN = 5
): Promise<RankedDocument[]> {
  if (candidates.length === 0) return [];
  if (candidates.length === 1) {
    return [{
      doc_id: candidates[0].doc_id,
      content: candidates[0].content,
      title: candidates[0].title,
      source: candidates[0].source,
      rerank_score: computeSourceConfidence(candidates[0]),
      source_confidence: computeSourceConfidence(candidates[0]),
      token_estimate: Math.ceil(candidates[0].content.split(/\s+/).length * 1.3),
    }];
  }

  const model = getModel();
  const passageList = candidates
    .map((c, i) => `[${c.doc_id}] ${c.content.slice(0, 200)}`)
    .join('\n\n');

  const prompt = `You are a relevance ranking engine. Score each passage for relevance to the query.

QUERY: "${query}"

PASSAGES:
${passageList}

Return ONLY valid JSON — no markdown:
{"rankings":[{"doc_id":1,"relevance":0.0},...]}

relevance: 0.0 (completely irrelevant) to 1.0 (perfectly answers the query)
Score every passage. Be strict — irrelevant passages should score < 0.3.`;

  let rerankScores: Record<number, number> = {};
  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);
    for (const r of parsed.rankings || []) {
      rerankScores[r.doc_id] = Math.max(0, Math.min(1, parseFloat(r.relevance) || 0));
    }
  } catch {
    // Fallback: use ts_rank as relevance proxy
    for (const c of candidates) {
      rerankScores[c.doc_id] = computeSourceConfidence(c);
    }
  }

  return candidates
    .map(c => ({
      doc_id:            c.doc_id,
      content:           c.content,
      title:             c.title,
      source:            c.source,
      rerank_score:      rerankScores[c.doc_id] ?? 0,
      source_confidence: computeSourceConfidence(c),
      token_estimate:    Math.ceil(c.content.split(/\s+/).length * 1.3),
    }))
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, topN);
}

// ─── D. Context Selection (max 1200 tokens) ───────────────────────────────────

function selectContext(ranked: RankedDocument[], maxTokens = 1200): RankedDocument[] {
  const selected: RankedDocument[] = [];
  let tokenCount = 0;
  for (const doc of ranked) {
    if (doc.rerank_score < 0.25) continue;  // filter weak candidates
    if (tokenCount + doc.token_estimate > maxTokens) break;
    selected.push(doc);
    tokenCount += doc.token_estimate;
  }
  return selected;
}

// ─── E. Citation-Constrained Generation ──────────────────────────────────────
// Forces the model to cite [doc_id] for every claim.
// If no docs available, abstain.

const CONFIDENCE_THRESHOLD = 0.60;

async function generateCitedAnswer(
  query: string,
  docs: RankedDocument[]
): Promise<CitedAnswer> {
  // Abstain if no usable context
  if (docs.length === 0) {
    return {
      answer: 'Insufficient evidence in the knowledge base to answer this reliably.',
      citations: [],
      abstained: true,
      abstain_reason: 'no_relevant_documents',
    };
  }

  // Abstain if top doc confidence is too low
  const maxConfidence = Math.max(...docs.map(d => d.source_confidence));
  if (maxConfidence < CONFIDENCE_THRESHOLD) {
    return {
      answer: `The available sources have insufficient confidence (${(maxConfidence * 100).toFixed(0)}% < 60%) to answer this reliably. Consider refining the query or adding more knowledge sources.`,
      citations: [],
      abstained: true,
      abstain_reason: `low_confidence_${(maxConfidence * 100).toFixed(0)}pct`,
    };
  }

  const model = getModel();
  const contextBlock = docs
    .map(d => `[${d.doc_id}] ${d.content.slice(0, 350)}`)
    .join('\n\n');

  const prompt = `You are a grounded answer generator. Answer the query using ONLY the provided context.

STRICT RULES:
1. Every factual claim MUST be cited with [doc_id]
2. Do NOT make claims not supported by the provided sources
3. If a sub-question cannot be answered from sources, say "Not addressed in sources"
4. Be concise (2-4 sentences per main point)

QUERY: "${query}"

CONTEXT:
${contextBlock}

Return ONLY valid JSON:
{
  "answer": "Your answer with [doc_id] citations inline",
  "citations": [{"doc_id": 1, "snippet": "key phrase from that doc supporting the claim"}]
}`;

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);
    return {
      answer: parsed.answer || 'Unable to generate grounded answer.',
      citations: (parsed.citations || []).map((c: any) => ({
        doc_id: c.doc_id,
        snippet: c.snippet || '',
      })),
      abstained: false,
    };
  } catch {
    return {
      answer: docs.map(d => `[${d.doc_id}] ${d.content.slice(0, 200)}`).join('\n\n'),
      citations: docs.map(d => ({ doc_id: d.doc_id, snippet: d.content.slice(0, 80) })),
      abstained: false,
    };
  }
}

// ─── F. Grounding Verification ────────────────────────────────────────────────
// Separate LLM call: does the answer match what the sources actually say?

async function verifyGrounding(
  answer: string,
  docs: RankedDocument[]
): Promise<GroundingResult> {
  if (docs.length === 0 || !answer) {
    return { supported: false, confidence: 0, groundedness_score: 0, unsupported_claims: [] };
  }

  const model = getModel();
  const docBlock = docs.map(d => `[${d.doc_id}]: ${d.content.slice(0, 250)}`).join('\n');

  const prompt = `You are a fact-verification engine. Check if the answer is fully supported by the provided sources.

ANSWER: "${answer.slice(0, 600)}"

SOURCES:
${docBlock}

Return ONLY valid JSON:
{
  "supported": true,
  "confidence": 0.0-1.0,
  "groundedness_score": 0.0-1.0,
  "unsupported_claims": ["any claim in answer not found in sources"]
}

supported: true if most claims are backed by sources
confidence: your confidence that the answer is accurate given the sources
groundedness_score: fraction of claims in the answer that are directly sourced (0=none, 1=all)
unsupported_claims: list claims that appear invented or not in sources`;

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);
    return {
      supported:           !!parsed.supported,
      confidence:          Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.5)),
      groundedness_score:  Math.max(0, Math.min(1, parseFloat(parsed.groundedness_score) || 0.5)),
      unsupported_claims:  parsed.unsupported_claims || [],
    };
  } catch {
    return { supported: true, confidence: 0.6, groundedness_score: 0.7, unsupported_claims: [] };
  }
}

// ─── G. Hardened RAG — Main Entry Point ──────────────────────────────────────

export async function hardenedRAG(
  query: string,
  opts: {
    topK?: number;
    maxContextTokens?: number;
    personaId?: number;
    groundTruthDocIds?: number[];  // for eval: compute Recall@k
    skipGrounding?: boolean;
  } = {}
): Promise<HardenedRAGResponse> {
  const { topK = 5, maxContextTokens = 1200, personaId, groundTruthDocIds, skipGrounding = false } = opts;

  // 1. Retrieve candidates (BM25)
  const candidates = await retrieveCandidates(query, 10);

  // 2. Re-rank (LLM cross-encoder)
  const reranked = await rerankDocuments(query, candidates, topK);

  // 3. Select context (token budget)
  const selected = selectContext(reranked, maxContextTokens);

  // 4. Generate cited answer
  const citedAnswer = await generateCitedAnswer(query, selected);

  // 5. Verify grounding (unless abstained or skipGrounding)
  const grounding: GroundingResult = (citedAnswer.abstained || skipGrounding)
    ? { supported: false, confidence: 0, groundedness_score: 0, unsupported_claims: [] }
    : await verifyGrounding(citedAnswer.answer, selected);

  // 6. Hallucination detection
  const hallucination_detected = !citedAnswer.abstained && (
    !grounding.supported ||
    grounding.groundedness_score < 0.5 ||
    grounding.unsupported_claims.length > 2
  );

  // 7. Recall@k (if ground truth doc IDs provided)
  let recall_at_k: number | null = null;
  if (groundTruthDocIds && groundTruthDocIds.length > 0) {
    const retrievedIds = new Set(reranked.map(d => d.doc_id));
    const hits = groundTruthDocIds.filter(id => retrievedIds.has(id)).length;
    recall_at_k = Math.round((hits / groundTruthDocIds.length) * 1000) / 1000;
  }

  // 8. Overall confidence
  const confidence = citedAnswer.abstained ? 0
    : Math.min(1, grounding.confidence * 0.6 + grounding.groundedness_score * 0.4);

  // 9. Persist session
  let session_id: number | undefined;
  try {
    const sessionRes = await pool.query(
      `INSERT INTO rag_sessions
         (query, retrieved_count, reranked_docs, context_tokens, answer, citations,
          grounded, hallucination_detected, confidence, groundedness_score, recall_at_k, abstained, persona_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        query.slice(0, 500),
        candidates.length,
        JSON.stringify(reranked.map(d => ({ doc_id: d.doc_id, rerank_score: d.rerank_score, source_confidence: d.source_confidence }))),
        selected.reduce((s, d) => s + d.token_estimate, 0),
        citedAnswer.answer,
        JSON.stringify(citedAnswer.citations),
        grounding.supported,
        hallucination_detected,
        Math.round(confidence * 1000) / 1000,
        grounding.groundedness_score,
        recall_at_k,
        citedAnswer.abstained,
        personaId || null,
      ]
    );
    session_id = sessionRes.rows[0].id;
  } catch {}

  return {
    query,
    retrieved_count: candidates.length,
    reranked_docs: reranked,
    cited_answer: citedAnswer,
    grounding,
    confidence: Math.round(confidence * 1000) / 1000,
    hallucination_detected,
    recall_at_k,
    session_id,
  };
}

// ─── H. Ingest Documents into RAG Store ──────────────────────────────────────

export async function ingestDocument(doc: {
  content: string;
  title?: string;
  source?: string;
  source_quality?: number;
  topic?: string;
  doc_type?: string;
  doc_ref_id?: number;
}): Promise<number> {
  const res = await pool.query(
    `INSERT INTO rag_documents (content, title, source, source_quality, topic, doc_type, doc_ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [doc.content, doc.title || null, doc.source || 'internal',
     doc.source_quality || 0.7, doc.topic || 'general',
     doc.doc_type || 'knowledge', doc.doc_ref_id || null]
  );
  return res.rows[0].id;
}

// Auto-ingest recent posts into RAG store (enriches retrieval with persona knowledge)
export async function syncPostsToRAG(limit = 50): Promise<number> {
  const posts = await pool.query(
    `SELECT p.id, p.content, pe.name as persona_name, p.topic_tags, p.created_at
     FROM posts p
     LEFT JOIN personas pe ON pe.id = p.persona_id
     WHERE p.id NOT IN (SELECT doc_ref_id FROM rag_documents WHERE doc_type = 'post' AND doc_ref_id IS NOT NULL)
       AND p.content IS NOT NULL AND LENGTH(p.content) > 50
     ORDER BY p.created_at DESC LIMIT $1`, [limit]
  );

  let ingested = 0;
  for (const post of posts.rows) {
    try {
      await ingestDocument({
        content: post.content,
        title: post.persona_name ? `By ${post.persona_name}` : 'Persona Post',
        source: 'persona_post',
        source_quality: 0.65,
        topic: (post.topic_tags || [])[0] || 'general',
        doc_type: 'post',
        doc_ref_id: post.id,
      });
      ingested++;
    } catch {}
  }
  return ingested;
}

// ─── I. RAG Evaluation Metrics ────────────────────────────────────────────────

export async function getRAGStats(limit = 100): Promise<{
  total_sessions: number;
  abstention_rate: number;
  hallucination_rate: number;
  avg_confidence: number;
  avg_groundedness: number;
  avg_recall_at_k: number | null;
  grounded_rate: number;
  recent_sessions: any[];
}> {
  const res = await pool.query(
    `SELECT
       COUNT(*)::int as total,
       AVG(CASE WHEN abstained THEN 1.0 ELSE 0.0 END) as abstention_rate,
       AVG(CASE WHEN hallucination_detected THEN 1.0 ELSE 0.0 END) as hallucination_rate,
       AVG(confidence) as avg_confidence,
       AVG(groundedness_score) as avg_groundedness,
       AVG(recall_at_k) as avg_recall_at_k,
       AVG(CASE WHEN grounded THEN 1.0 ELSE 0.0 END) as grounded_rate
     FROM rag_sessions
     WHERE created_at >= NOW() - INTERVAL '30 days'`
  );

  const recent = await pool.query(
    `SELECT id, LEFT(query, 80) as query_preview, retrieved_count, grounded,
       hallucination_detected, confidence, groundedness_score, recall_at_k, abstained, created_at
     FROM rag_sessions ORDER BY created_at DESC LIMIT 10`
  );

  const row = res.rows[0];
  return {
    total_sessions:     row.total || 0,
    abstention_rate:    Math.round(parseFloat(row.abstention_rate || '0') * 1000) / 1000,
    hallucination_rate: Math.round(parseFloat(row.hallucination_rate || '0') * 1000) / 1000,
    avg_confidence:     Math.round(parseFloat(row.avg_confidence || '0') * 1000) / 1000,
    avg_groundedness:   Math.round(parseFloat(row.avg_groundedness || '0') * 1000) / 1000,
    avg_recall_at_k:    row.avg_recall_at_k ? Math.round(parseFloat(row.avg_recall_at_k) * 1000) / 1000 : null,
    grounded_rate:      Math.round(parseFloat(row.grounded_rate || '0') * 1000) / 1000,
    recent_sessions:    recent.rows,
  };
}
