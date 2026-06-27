// Prompt Registry — Versioned, typed, safety-gated prompt management.
// Prompts are never auto-promoted. Every candidate must pass offline evaluation
// against multi-metric guardrails before entering production.

import { getModel } from './gemini.js';
import pool from '../db.js';


// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskType = 'debate' | 'rewrite' | 'evaluation' | 'moderation' | 'evolution' | 'suggestion';
export type PromptStatus = 'candidate' | 'shadow' | 'production' | 'archived';

export interface PromptRecord {
  id: number;
  prompt_key: string;
  version: number;
  task_type: TaskType;
  template: string;
  constraints: Record<string, any>;
  status: PromptStatus;
  metrics: PromptMetrics;
  composite_score: number;
  parent_version: number | null;
  created_at: string;
  promoted_at: string | null;
}

export interface PromptMetrics {
  quality_score: number;       // factual coherence, persona match
  safety_score: number;        // 1 - avg toxicity
  engagement_rate: number;     // likes / impressions
  debate_win_rate: number;     // votes won / debates participated
  retention_signal: number;    // rolling session depth
  sample_count: number;
  last_updated: string;
}

export interface EvaluationResult {
  promoted: boolean;
  reason: string;
  candidate_score: number;
  baseline_score: number;
  safety_passed: boolean;
  metrics_delta: Record<string, number>;
}

// ─── Composite Score Formula ──────────────────────────────────────────────────
// reward = 0.30*quality + 0.25*safety + 0.20*engagement + 0.15*debate_win + 0.10*retention
// This weighting deliberately de-prioritises raw engagement to prevent
// reward hacking toward clickbait or emotionally manipulative outputs.

export function computeCompositeScore(m: PromptMetrics): number {
  if (m.sample_count < 10) return 0; // insufficient data
  return Math.min(1, Math.max(0,
    0.30 * (m.quality_score || 0) +
    0.25 * (m.safety_score || 0) +
    0.20 * (m.engagement_rate || 0) +
    0.15 * (m.debate_win_rate || 0) +
    0.10 * (m.retention_signal || 0)
  ));
}

// ─── Registry Operations ──────────────────────────────────────────────────────

export async function getProductionPrompt(key: string): Promise<PromptRecord | null> {
  const res = await pool.query(
    `SELECT * FROM prompt_registry WHERE prompt_key = $1 AND status = 'production' ORDER BY version DESC LIMIT 1`,
    [key]
  );
  return res.rows[0] || null;
}

export async function getAllVersions(key: string): Promise<PromptRecord[]> {
  const res = await pool.query(
    `SELECT * FROM prompt_registry WHERE prompt_key = $1 ORDER BY version DESC`,
    [key]
  );
  return res.rows;
}

export async function registerCandidate(
  key: string,
  taskType: TaskType,
  template: string,
  constraints: Record<string, any> = {}
): Promise<PromptRecord> {
  const current = await pool.query(
    `SELECT MAX(version) as max_v, id FROM prompt_registry WHERE prompt_key = $1 AND status = 'production' GROUP BY id ORDER BY id DESC LIMIT 1`,
    [key]
  );
  const nextVersion = ((current.rows[0]?.max_v) || 0) + 1;
  const parentVersion = current.rows[0]?.max_v || null;

  const res = await pool.query(
    `INSERT INTO prompt_registry (prompt_key, version, task_type, template, constraints, status, parent_version)
     VALUES ($1, $2, $3, $4, $5, 'candidate', $6) RETURNING *`,
    [key, nextVersion, taskType, template, JSON.stringify(constraints), parentVersion]
  );
  return res.rows[0];
}

export async function updatePromptMetrics(
  key: string,
  version: number,
  metricsUpdate: Partial<PromptMetrics>
): Promise<void> {
  const existing = await pool.query(
    `SELECT metrics, composite_score FROM prompt_registry WHERE prompt_key = $1 AND version = $2`,
    [key, version]
  );
  if (!existing.rows.length) return;

  const current: PromptMetrics = existing.rows[0].metrics || {
    quality_score: 0, safety_score: 1, engagement_rate: 0,
    debate_win_rate: 0, retention_signal: 0, sample_count: 0,
    last_updated: new Date().toISOString(),
  };

  const n = current.sample_count;
  const nn = n + 1;

  // Rolling average update for each metric
  const merged: PromptMetrics = {
    quality_score: metricsUpdate.quality_score !== undefined
      ? (current.quality_score * n + metricsUpdate.quality_score) / nn : current.quality_score,
    safety_score: metricsUpdate.safety_score !== undefined
      ? (current.safety_score * n + metricsUpdate.safety_score) / nn : current.safety_score,
    engagement_rate: metricsUpdate.engagement_rate !== undefined
      ? (current.engagement_rate * n + metricsUpdate.engagement_rate) / nn : current.engagement_rate,
    debate_win_rate: metricsUpdate.debate_win_rate !== undefined
      ? (current.debate_win_rate * n + metricsUpdate.debate_win_rate) / nn : current.debate_win_rate,
    retention_signal: metricsUpdate.retention_signal !== undefined
      ? (current.retention_signal * n + metricsUpdate.retention_signal) / nn : current.retention_signal,
    sample_count: nn,
    last_updated: new Date().toISOString(),
  };

  const composite = computeCompositeScore(merged);

  await pool.query(
    `UPDATE prompt_registry SET metrics = $1, composite_score = $2 WHERE prompt_key = $3 AND version = $4`,
    [JSON.stringify(merged), composite, key, version]
  );
}

// ─── Offline Evaluation + Promotion Gate ─────────────────────────────────────
// Candidate v(n+1) is run against a held-out set of test cases.
// It must beat the production baseline AND pass all safety guardrails.

const PROMOTION_MARGIN = 0.02;  // candidate must beat baseline by at least 2%
const MIN_SAMPLES = 10;          // minimum sample count before promotion is allowed

const SAFETY_GUARDRAILS = {
  min_safety_score: 0.75,        // toxicity-derived safety must stay above 75%
  max_toxicity_delta: 0.05,      // candidate must not increase toxicity by more than 5%
  min_quality_score: 0.60,       // coherence floor
};

export async function evaluateAndPromote(key: string, candidateVersion: number): Promise<EvaluationResult> {
  const [candidateRes, productionRes] = await Promise.all([
    pool.query(`SELECT * FROM prompt_registry WHERE prompt_key = $1 AND version = $2`, [key, candidateVersion]),
    pool.query(`SELECT * FROM prompt_registry WHERE prompt_key = $1 AND status = 'production' ORDER BY version DESC LIMIT 1`, [key]),
  ]);

  const candidate: PromptRecord = candidateRes.rows[0];
  const production: PromptRecord | null = productionRes.rows[0] || null;

  if (!candidate) return { promoted: false, reason: 'Candidate not found', candidate_score: 0, baseline_score: 0, safety_passed: false, metrics_delta: {} };
  if (candidate.metrics.sample_count < MIN_SAMPLES) {
    return { promoted: false, reason: `Insufficient data (${candidate.metrics.sample_count}/${MIN_SAMPLES} samples)`, candidate_score: candidate.composite_score, baseline_score: production?.composite_score || 0, safety_passed: false, metrics_delta: {} };
  }

  const candidateScore = computeCompositeScore(candidate.metrics);
  const baselineScore = production ? computeCompositeScore(production.metrics) : 0;

  // Safety guardrail checks
  const safetyOk = (
    candidate.metrics.safety_score >= SAFETY_GUARDRAILS.min_safety_score &&
    candidate.metrics.quality_score >= SAFETY_GUARDRAILS.min_quality_score &&
    (production ? (production.metrics.safety_score - candidate.metrics.safety_score) <= SAFETY_GUARDRAILS.max_toxicity_delta : true)
  );

  const metricsOutcome = !safetyOk ? 'safety_block' : candidateScore > baselineScore + PROMOTION_MARGIN ? 'promote' : 'reject';

  const metricsDelta: Record<string, number> = production ? {
    quality_delta: candidate.metrics.quality_score - production.metrics.quality_score,
    safety_delta: candidate.metrics.safety_score - production.metrics.safety_score,
    engagement_delta: candidate.metrics.engagement_rate - production.metrics.engagement_rate,
    debate_delta: candidate.metrics.debate_win_rate - production.metrics.debate_win_rate,
    composite_delta: candidateScore - baselineScore,
  } : {};

  if (metricsOutcome === 'promote') {
    await pool.query(`UPDATE prompt_registry SET status = 'archived', archived_at = NOW() WHERE prompt_key = $1 AND status = 'production'`, [key]);
    await pool.query(`UPDATE prompt_registry SET status = 'production', promoted_at = NOW(), composite_score = $1 WHERE prompt_key = $2 AND version = $3`, [candidateScore, key, candidateVersion]);
    return { promoted: true, reason: `Promoted: +${((candidateScore - baselineScore) * 100).toFixed(1)}% composite improvement`, candidate_score: candidateScore, baseline_score: baselineScore, safety_passed: true, metrics_delta: metricsDelta };
  }

  if (metricsOutcome === 'safety_block') {
    await pool.query(`UPDATE prompt_registry SET status = 'archived', archived_at = NOW() WHERE prompt_key = $1 AND version = $2`, [key, candidateVersion]);
    await logGuardrailViolation(key, 'safety', SAFETY_GUARDRAILS.min_safety_score, candidate.metrics.safety_score);
    return { promoted: false, reason: `Safety guardrail failed: safety_score=${candidate.metrics.safety_score.toFixed(3)} < ${SAFETY_GUARDRAILS.min_safety_score}`, candidate_score: candidateScore, baseline_score: baselineScore, safety_passed: false, metrics_delta: metricsDelta };
  }

  return { promoted: false, reason: `Insufficient improvement: ${((candidateScore - baselineScore) * 100).toFixed(1)}% < required ${(PROMOTION_MARGIN * 100).toFixed(1)}%`, candidate_score: candidateScore, baseline_score: baselineScore, safety_passed: true, metrics_delta: metricsDelta };
}

// ─── AI-Driven Prompt Evolution ───────────────────────────────────────────────
// Uses Gemini to propose a variant of the production prompt based on observed
// failure patterns in the metrics. Never replaces production — creates a candidate.

export async function evolvePrompt(key: string): Promise<{ evolved: boolean; newVersion?: number; rationale?: string }> {
  const production = await getProductionPrompt(key);
  if (!production) return { evolved: false };

  const m = production.metrics;
  const weaknesses: string[] = [];
  if (m.quality_score < 0.70) weaknesses.push(`quality is low (${(m.quality_score * 100).toFixed(0)}%) — coherence or persona match is weak`);
  if (m.safety_score < 0.85) weaknesses.push(`safety signals are elevated (${((1 - m.safety_score) * 100).toFixed(0)}% toxicity avg)`);
  if (m.engagement_rate < 0.30) weaknesses.push(`engagement rate is low (${(m.engagement_rate * 100).toFixed(0)}%)`);
  if (m.debate_win_rate < 0.40) weaknesses.push(`debate win rate is low (${(m.debate_win_rate * 100).toFixed(0)}%)`);

  if (weaknesses.length === 0) return { evolved: false };

  try {
    const model = getModel();
    const prompt = `You are a prompt engineer optimizing AI system prompts.

CURRENT PRODUCTION PROMPT (task: ${production.task_type}):
"${production.template.slice(0, 1200)}"

OBSERVED WEAKNESSES:
${weaknesses.map((w, i) => `${i + 1}. ${w}`).join('\n')}

TASK: Generate an improved version of this prompt that addresses the weaknesses.
Rules:
- Keep the same task purpose and core constraints
- Do NOT loosen safety requirements
- Make changes specific and justified
- Changes should be targeted, not a complete rewrite

Return ONLY valid JSON with no markdown:
{
  "evolved_template": "the improved prompt text",
  "rationale": "one paragraph explaining what changed and why",
  "expected_improvements": ["improvement 1", "improvement 2"]
}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    if (!parsed.evolved_template || parsed.evolved_template.length < 50) return { evolved: false };

    const candidate = await registerCandidate(key, production.task_type as TaskType, parsed.evolved_template, production.constraints);
    return { evolved: true, newVersion: candidate.version, rationale: parsed.rationale };
  } catch {
    return { evolved: false };
  }
}

// ─── Registry Listing ─────────────────────────────────────────────────────────

export async function listRegistry(): Promise<{
  key: string; production_version: number | null; candidate_count: number;
  production_score: number; last_updated: string;
}[]> {
  const res = await pool.query(`
    SELECT
      prompt_key,
      MAX(CASE WHEN status = 'production' THEN version END) as production_version,
      COUNT(CASE WHEN status = 'candidate' THEN 1 END)::int as candidate_count,
      MAX(CASE WHEN status = 'production' THEN composite_score END) as production_score,
      MAX(CASE WHEN status = 'production' THEN (metrics->>'last_updated') END) as last_updated
    FROM prompt_registry
    GROUP BY prompt_key
    ORDER BY prompt_key
  `);
  return res.rows;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function logGuardrailViolation(experimentName: string, guardrailType: string, threshold: number, observed: number): Promise<void> {
  await pool.query(
    `INSERT INTO guardrail_violations (experiment_name, guardrail_type, threshold, observed_value, action_taken)
     VALUES ($1, $2, $3, $4, 'archived')`,
    [experimentName, guardrailType, threshold, observed]
  ).catch(() => {});
}
