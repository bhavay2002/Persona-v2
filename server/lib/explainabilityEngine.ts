// Explainability Engine — Argument Structure + Reasoning Transparency
//
// Decomposes any argument into:
//   Claim → Evidence → Assumptions → Conclusion
//   + a reasoning graph (nodes + edges) for visual rendering
//   + fallacy detection with text spans and severity
//   + linkage back to the Knowledge Graph
//
// Results are stored in argument_structures for caching.

import { getModel } from './gemini.js';
import pool from '../db.js';


// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArgumentStructure {
  claim: string;
  evidence: string[];
  assumptions: string[];
  conclusion: string;
  reasoning_graph: ReasoningGraph;
  fallacies: Fallacy[];
  overall_strength: number;  // 0-1 composite
  confidence: number;
}

export interface ReasoningGraph {
  nodes: ReasoningNode[];
  edges: ReasoningEdge[];
}

export interface ReasoningNode {
  id: string;
  type: 'claim' | 'evidence' | 'assumption' | 'conclusion';
  text: string;
  strength?: number;
}

export interface ReasoningEdge {
  from: string;
  to: string;
  type: 'supports' | 'assumes' | 'leads_to' | 'undermines';
  label?: string;
}

export interface Fallacy {
  type: string;
  text_span: string;
  severity: number;
  explanation: string;
}

// ─── Core Analysis ────────────────────────────────────────────────────────────

export async function analyzeArgument(
  text: string,
  opts: { personaId?: number; postId?: number; debateMessageId?: number } = {}
): Promise<ArgumentStructure> {
  // Check cache first
  if (opts.postId || opts.debateMessageId) {
    const cached = await getStoredAnalysis(
      opts.postId ? 'post' : 'debate_message',
      opts.postId || opts.debateMessageId!
    );
    if (cached) return cached;
  }

  const model = getModel();

  const prompt = `You are an expert in argumentation theory and logical analysis.

Analyze the following argument with clinical precision:

ARGUMENT: "${text.slice(0, 2000)}"

Perform three analyses:

1. STRUCTURAL DECOMPOSITION — Break the argument into its logical components.
2. REASONING GRAPH — Map the logical flow as nodes and edges.
3. FALLACY DETECTION — Identify logical errors with exact text spans.

Return ONLY valid JSON with no markdown:
{
  "claim": "the central thesis in one sentence",
  "evidence": ["evidence point 1", "evidence point 2"],
  "assumptions": ["unstated assumption 1", "unstated assumption 2"],
  "conclusion": "what follows if the argument is accepted",
  "reasoning_graph": {
    "nodes": [
      {"id": "c1", "type": "claim", "text": "...", "strength": 0.0-1.0},
      {"id": "e1", "type": "evidence", "text": "...", "strength": 0.0-1.0},
      {"id": "a1", "type": "assumption", "text": "...", "strength": 0.0-1.0},
      {"id": "co1", "type": "conclusion", "text": "...", "strength": 0.0-1.0}
    ],
    "edges": [
      {"from": "e1", "to": "c1", "type": "supports", "label": "provides basis for"},
      {"from": "a1", "to": "c1", "type": "assumes", "label": "requires"},
      {"from": "c1", "to": "co1", "type": "leads_to", "label": "implies"}
    ]
  },
  "fallacies": [
    {
      "type": "ad hominem|strawman|false dilemma|appeal to authority|slippery slope|hasty generalization|circular reasoning|appeal to emotion|red herring",
      "text_span": "exact quote from the argument",
      "severity": 0.0-1.0,
      "explanation": "one sentence explaining the logical error"
    }
  ],
  "overall_strength": 0.0-1.0,
  "confidence": 0.0-1.0
}

If there are no fallacies, return "fallacies": [].
If the argument has no distinct claim/evidence/assumptions, use your best interpretation.
Do NOT invent content not present in the argument.`;

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    const structure: ArgumentStructure = {
      claim: parsed.claim || '',
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      conclusion: parsed.conclusion || '',
      reasoning_graph: buildSafeReasoningGraph(parsed.reasoning_graph),
      fallacies: Array.isArray(parsed.fallacies) ? parsed.fallacies.filter((f: any) => f.severity >= 0.2) : [],
      overall_strength: Math.min(1, Math.max(0, parseFloat(parsed.overall_strength) || 0.5)),
      confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0.7)),
    };

    // Cache the result
    if (opts.postId || opts.debateMessageId) {
      await storeAnalysis(structure, opts).catch(() => {});
    }

    return structure;
  } catch {
    // Fallback: minimal structure
    return {
      claim: text.slice(0, 100),
      evidence: [],
      assumptions: [],
      conclusion: '',
      reasoning_graph: { nodes: [{ id: 'c1', type: 'claim', text: text.slice(0, 100) }], edges: [] },
      fallacies: [],
      overall_strength: 0.5,
      confidence: 0.3,
    };
  }
}

// ─── Reasoning Graph Builder ──────────────────────────────────────────────────
// Validates and sanitizes the LLM-returned graph to prevent render errors.

function buildSafeReasoningGraph(raw: any): ReasoningGraph {
  if (!raw || typeof raw !== 'object') {
    return { nodes: [], edges: [] };
  }

  const validTypes = new Set(['claim', 'evidence', 'assumption', 'conclusion']);
  const validEdgeTypes = new Set(['supports', 'assumes', 'leads_to', 'undermines']);

  const nodes: ReasoningNode[] = (raw.nodes || [])
    .filter((n: any) => n.id && n.text && validTypes.has(n.type))
    .slice(0, 12)
    .map((n: any) => ({
      id: String(n.id),
      type: n.type as ReasoningNode['type'],
      text: String(n.text).slice(0, 200),
      strength: typeof n.strength === 'number' ? Math.min(1, Math.max(0, n.strength)) : 0.5,
    }));

  const nodeIds = new Set(nodes.map(n => n.id));

  const edges: ReasoningEdge[] = (raw.edges || [])
    .filter((e: any) => e.from && e.to && validEdgeTypes.has(e.type) && nodeIds.has(String(e.from)) && nodeIds.has(String(e.to)))
    .slice(0, 20)
    .map((e: any) => ({
      from: String(e.from),
      to: String(e.to),
      type: e.type as ReasoningEdge['type'],
      label: e.label ? String(e.label).slice(0, 40) : undefined,
    }));

  return { nodes, edges };
}

// ─── Storage ──────────────────────────────────────────────────────────────────

async function storeAnalysis(
  structure: ArgumentStructure,
  opts: { personaId?: number; postId?: number; debateMessageId?: number }
): Promise<void> {
  await pool.query(
    `INSERT INTO argument_structures
     (post_id, debate_message_id, persona_id, claim, evidence, assumptions, conclusion, reasoning_graph, fallacies)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING`,
    [
      opts.postId || null,
      opts.debateMessageId || null,
      opts.personaId || null,
      structure.claim,
      JSON.stringify(structure.evidence),
      JSON.stringify(structure.assumptions),
      structure.conclusion,
      JSON.stringify(structure.reasoning_graph),
      JSON.stringify(structure.fallacies),
    ]
  );
}

export async function getStoredAnalysis(
  type: 'post' | 'debate_message',
  id: number
): Promise<ArgumentStructure | null> {
  const col = type === 'post' ? 'post_id' : 'debate_message_id';
  const res = await pool.query(
    `SELECT * FROM argument_structures WHERE ${col} = $1 ORDER BY created_at DESC LIMIT 1`,
    [id]
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    claim: r.claim,
    evidence: r.evidence || [],
    assumptions: r.assumptions || [],
    conclusion: r.conclusion,
    reasoning_graph: r.reasoning_graph || { nodes: [], edges: [] },
    fallacies: r.fallacies || [],
    overall_strength: 0.5,
    confidence: 0.7,
  };
}

// ─── Fallacy-Only Analysis ────────────────────────────────────────────────────
// Faster endpoint when only fallacy detection is needed (debate scoring).

export async function detectFallaciesOnly(text: string): Promise<Fallacy[]> {
  try {
    const model = getModel();
    const prompt = `Detect logical fallacies in this argument. Be precise — only flag genuine logical errors.

ARGUMENT: "${text.slice(0, 1000)}"

Return ONLY valid JSON with no markdown:
{
  "fallacies": [
    {
      "type": "fallacy name",
      "text_span": "exact quote",
      "severity": 0.0-1.0,
      "explanation": "one sentence"
    }
  ]
}

If no fallacies found, return {"fallacies": []}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);
    return (parsed.fallacies || []).filter((f: any) => f.severity >= 0.3);
  } catch {
    return [];
  }
}

// ─── Recent Argument Structures ───────────────────────────────────────────────

export async function getRecentAnalyses(limit = 20): Promise<any[]> {
  const res = await pool.query(`
    SELECT
      a.*,
      p.name as persona_name,
      p.avatar_emoji,
      jsonb_array_length(a.fallacies) as fallacy_count
    FROM argument_structures a
    LEFT JOIN personas p ON p.id = a.persona_id
    ORDER BY a.created_at DESC
    LIMIT $1
  `, [limit]);
  return res.rows;
}
