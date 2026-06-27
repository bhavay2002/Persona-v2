// Knowledge Graph Layer — Belief & Idea Network
//
// Transforms raw content into a structured, queryable graph of ideas:
//   Persona → Claim → Topic → (SUPPORTS / CONTRADICTS / SIMILAR) → Claim
//
// Storage: PostgreSQL adjacency table (no pgvector needed).
// Relation detection: pure LLM — more accurate than cosine at this scale.
// Edge building: batched pairwise evaluation against recent same-topic claims.

import { getModel } from './gemini.js';
import pool from '../db.js';


// ─── Types ────────────────────────────────────────────────────────────────────

export type EdgeType = 'SUPPORTS' | 'CONTRADICTS' | 'SIMILAR';
export type Polarity = 'pro' | 'anti' | 'neutral';

export interface Claim {
  id: number;
  persona_id: number | null;
  post_id: number | null;
  debate_message_id: number | null;
  text: string;
  topic: string;
  polarity: Polarity;
  confidence: number;
  created_at: string;
}

export interface ClaimEdge {
  id: number;
  source_id: number;
  target_id: number;
  type: EdgeType;
  weight: number;
}

export interface GraphData {
  nodes: (Claim & { persona_name?: string; persona_emoji?: string; degree: number })[];
  edges: ClaimEdge[];
  stats: {
    total_nodes: number;
    total_edges: number;
    supports: number;
    contradicts: number;
    similar: number;
    topics: string[];
  };
}

export interface ExtractedClaim {
  text: string;
  topic: string;
  polarity: Polarity;
  confidence: number;
}

// ─── Claim Extraction ─────────────────────────────────────────────────────────
// One Gemini call extracts all claims from a piece of content.
// Returns structured claims ready for insertion and edge analysis.

export async function extractClaims(
  text: string,
  source: { personaId?: number; postId?: number; debateMessageId?: number }
): Promise<Claim[]> {
  if (!text || text.trim().length < 20) return [];

  try {
    const model = getModel();
    const prompt = `Extract distinct factual or argumentative claims from this text.
Each claim must be a self-contained, atomic proposition — one clear assertion per claim.
Ignore filler, pleasantries, and meta-commentary.

TEXT: "${text.slice(0, 1500)}"

Return ONLY valid JSON with no markdown:
{
  "claims": [
    {
      "text": "concise claim as a complete sentence",
      "topic": "single topic keyword (e.g. climate, healthcare, AI, economy)",
      "polarity": "pro | anti | neutral",
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- Maximum 5 claims per text
- Minimum confidence 0.4 to include
- topic must be ONE lowercase word or short phrase
- polarity: pro=supports an idea, anti=opposes an idea, neutral=factual statement`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    const claims: Claim[] = [];
    for (const c of (parsed.claims || [])) {
      if (!c.text || c.confidence < 0.4) continue;
      const res = await pool.query(
        `INSERT INTO claims (persona_id, post_id, debate_message_id, text, topic, polarity, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          source.personaId || null,
          source.postId || null,
          source.debateMessageId || null,
          c.text.trim(),
          (c.topic || 'general').toLowerCase().trim().slice(0, 30),
          ['pro', 'anti', 'neutral'].includes(c.polarity) ? c.polarity : 'neutral',
          Math.min(1, Math.max(0, parseFloat(c.confidence) || 0.5)),
        ]
      );
      claims.push(res.rows[0]);
    }
    return claims;
  } catch {
    return [];
  }
}

// ─── Edge Building ────────────────────────────────────────────────────────────
// For each new claim, compare against up to 20 existing same-topic claims
// in one batched LLM call. Inserts edges into claim_edges.

export async function buildEdgesForNewClaims(newClaimIds: number[]): Promise<void> {
  if (!newClaimIds.length) return;

  for (const newId of newClaimIds) {
    const newRes = await pool.query(`SELECT * FROM claims WHERE id = $1`, [newId]);
    if (!newRes.rows.length) continue;
    const newClaim: Claim = newRes.rows[0];

    // Get up to 20 existing claims on the same topic (exclude the new ones themselves)
    const comparisons = await pool.query(
      `SELECT * FROM claims
       WHERE topic = $1 AND id != $2 AND id != ALL($3::int[])
       ORDER BY created_at DESC LIMIT 20`,
      [newClaim.topic, newId, newClaimIds]
    );

    if (!comparisons.rows.length) continue;

    const candidates: Claim[] = comparisons.rows;

    // Batch evaluation: one LLM call evaluates all pairs
    const pairsText = candidates.map((c, i) =>
      `Pair ${i + 1}: Claim A = "${newClaim.text}" | Claim B = "${c.text}"`
    ).join('\n');

    try {
      const model = getModel();
      const prompt = `Determine the logical relationship between each pair of claims.

${pairsText}

For each pair return:
- "supports": A provides evidence or logical backing for B (or vice versa)
- "contradicts": A and B cannot both be true simultaneously
- "similar": A and B express the same idea in different words
- "unrelated": no meaningful logical connection

Return ONLY valid JSON with no markdown:
{
  "pairs": [
    {"pair": 1, "relation": "supports|contradicts|similar|unrelated", "confidence": 0.0-1.0}
  ]
}`;

      const result = await model.generateContent(prompt);
      const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(raw);

      for (const pair of (parsed.pairs || [])) {
        const idx = pair.pair - 1;
        if (idx < 0 || idx >= candidates.length) continue;
        if (pair.relation === 'unrelated' || pair.confidence < 0.5) continue;

        const edgeType = pair.relation.toUpperCase() as EdgeType;
        const targetId = candidates[idx].id;

        await pool.query(
          `INSERT INTO claim_edges (source_id, target_id, type, weight)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (source_id, target_id, type) DO UPDATE SET weight = EXCLUDED.weight`,
          [newId, targetId, edgeType, Math.min(1, Math.max(0, parseFloat(pair.confidence) || 0.5))]
        ).catch(() => {});
      }
    } catch {
      // Edge building is non-critical
    }
  }
}

// ─── Graph Data ───────────────────────────────────────────────────────────────
// Returns nodes + edges for the full visualization, with optional filters.

export async function getGraphData(opts: {
  topic?: string;
  edgeType?: EdgeType;
  personaId?: number;
  limit?: number;
} = {}): Promise<GraphData> {
  const limit = Math.min(opts.limit || 150, 300);

  let claimsQuery = `
    SELECT c.*, p.name as persona_name, p.avatar_emoji as persona_emoji
    FROM claims c
    LEFT JOIN personas p ON p.id = c.persona_id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (opts.topic) {
    params.push(opts.topic);
    claimsQuery += ` AND c.topic = $${params.length}`;
  }
  if (opts.personaId) {
    params.push(opts.personaId);
    claimsQuery += ` AND c.persona_id = $${params.length}`;
  }

  params.push(limit);
  claimsQuery += ` ORDER BY c.created_at DESC LIMIT $${params.length}`;

  const claimsRes = await pool.query(claimsQuery, params);
  const nodeIds = claimsRes.rows.map((r: any) => r.id);

  if (!nodeIds.length) {
    return { nodes: [], edges: [], stats: { total_nodes: 0, total_edges: 0, supports: 0, contradicts: 0, similar: 0, topics: [] } };
  }

  let edgesQuery = `
    SELECT * FROM claim_edges
    WHERE source_id = ANY($1) AND target_id = ANY($1)
  `;
  const edgeParams: any[] = [nodeIds];

  if (opts.edgeType) {
    edgeParams.push(opts.edgeType);
    edgesQuery += ` AND type = $${edgeParams.length}`;
  }

  const edgesRes = await pool.query(edgesQuery, edgeParams);

  // Compute degree for each node
  const degree: Record<number, number> = {};
  for (const edge of edgesRes.rows) {
    degree[edge.source_id] = (degree[edge.source_id] || 0) + 1;
    degree[edge.target_id] = (degree[edge.target_id] || 0) + 1;
  }

  const nodes = claimsRes.rows.map((r: any) => ({ ...r, degree: degree[r.id] || 0 }));

  const edges: ClaimEdge[] = edgesRes.rows;
  const topics = [...new Set(nodes.map((n: any) => n.topic))];

  return {
    nodes,
    edges,
    stats: {
      total_nodes: nodes.length,
      total_edges: edges.length,
      supports: edges.filter((e: any) => e.type === 'SUPPORTS').length,
      contradicts: edges.filter((e: any) => e.type === 'CONTRADICTS').length,
      similar: edges.filter((e: any) => e.type === 'SIMILAR').length,
      topics,
    },
  };
}

// ─── Claim Detail ─────────────────────────────────────────────────────────────

export async function getClaimWithEdges(claimId: number): Promise<{
  claim: Claim;
  related: { claim: Claim; edge: ClaimEdge }[];
} | null> {
  const claimRes = await pool.query(`SELECT * FROM claims WHERE id = $1`, [claimId]);
  if (!claimRes.rows.length) return null;

  const relatedRes = await pool.query(`
    SELECT c.*, e.type, e.weight, e.id as edge_id, e.source_id, e.target_id
    FROM claim_edges e
    JOIN claims c ON (c.id = CASE WHEN e.source_id = $1 THEN e.target_id ELSE e.source_id END)
    WHERE e.source_id = $1 OR e.target_id = $1
    ORDER BY e.weight DESC LIMIT 20
  `, [claimId]);

  return {
    claim: claimRes.rows[0],
    related: relatedRes.rows.map((r: any) => ({
      claim: {
        id: r.id, persona_id: r.persona_id, post_id: r.post_id,
        debate_message_id: r.debate_message_id, text: r.text,
        topic: r.topic, polarity: r.polarity, confidence: r.confidence, created_at: r.created_at,
      },
      edge: { id: r.edge_id, source_id: r.source_id, target_id: r.target_id, type: r.type, weight: r.weight },
    })),
  };
}

// ─── Topic Clusters ───────────────────────────────────────────────────────────

export async function getTopicClusters(): Promise<{
  topic: string;
  claim_count: number;
  pro_count: number;
  anti_count: number;
  contradiction_count: number;
}[]> {
  const res = await pool.query(`
    SELECT
      c.topic,
      COUNT(*)::int as claim_count,
      COUNT(CASE WHEN c.polarity = 'pro' THEN 1 END)::int as pro_count,
      COUNT(CASE WHEN c.polarity = 'anti' THEN 1 END)::int as anti_count,
      COUNT(CASE WHEN e.type = 'CONTRADICTS' THEN 1 END)::int as contradiction_count
    FROM claims c
    LEFT JOIN claim_edges e ON (e.source_id = c.id AND e.type = 'CONTRADICTS')
    GROUP BY c.topic
    ORDER BY claim_count DESC
    LIMIT 20
  `);
  return res.rows;
}

// ─── Persona Belief Profile ───────────────────────────────────────────────────

export async function getPersonaBeliefProfile(personaId: number): Promise<{
  claims: Claim[];
  topics: string[];
  dominant_polarity: string;
  contradiction_score: number;
}> {
  const res = await pool.query(
    `SELECT c.* FROM claims c WHERE c.persona_id = $1 ORDER BY c.created_at DESC LIMIT 50`,
    [personaId]
  );

  const claims: Claim[] = res.rows;
  const topics = [...new Set(claims.map(c => c.topic))];

  const polarityCounts = claims.reduce((acc: Record<string, number>, c) => {
    acc[c.polarity] = (acc[c.polarity] || 0) + 1;
    return acc;
  }, {});
  const dominant_polarity = Object.entries(polarityCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';

  // Contradiction score = contradictions involving this persona's claims
  const contraRes = await pool.query(
    `SELECT COUNT(*)::int as cnt FROM claim_edges e
     JOIN claims c ON c.id = e.source_id
     WHERE c.persona_id = $1 AND e.type = 'CONTRADICTS'`,
    [personaId]
  );
  const contradictions = contraRes.rows[0]?.cnt || 0;
  const contradiction_score = claims.length > 0 ? contradictions / claims.length : 0;

  return { claims, topics, dominant_polarity, contradiction_score };
}

// ─── Debate Suggestions from KG ──────────────────────────────────────────────
// Find high-contradiction-weight pairs between personas as debate seeds.

export async function suggestDebatesFromContradictions(): Promise<{
  topic: string;
  claim_a: string;
  claim_b: string;
  persona_a: string;
  persona_b: string;
  weight: number;
}[]> {
  const res = await pool.query(`
    SELECT
      e.weight,
      ca.text as claim_a, cb.text as claim_b,
      ca.topic,
      pa.name as persona_a, pb.name as persona_b
    FROM claim_edges e
    JOIN claims ca ON ca.id = e.source_id
    JOIN claims cb ON cb.id = e.target_id
    LEFT JOIN personas pa ON pa.id = ca.persona_id
    LEFT JOIN personas pb ON pb.id = cb.persona_id
    WHERE e.type = 'CONTRADICTS'
      AND ca.persona_id IS NOT NULL
      AND cb.persona_id IS NOT NULL
      AND ca.persona_id != cb.persona_id
    ORDER BY e.weight DESC
    LIMIT 10
  `);
  return res.rows;
}
