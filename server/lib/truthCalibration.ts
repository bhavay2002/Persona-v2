// Truth Score → Calibrated Probabilistic System
//
// Architecture:
//   Raw features (reasoning, bias, emotion, coherence, novelty)
//     → Feature aggregation (weighted raw composite)
//     → Platt scaling  (a * x + b → sigmoid → probability)
//     → Confidence interval (Wilson score)
//     → Brier score tracking (calibration quality metric)
//     → Human evaluation loop (online parameter updates)
//
// This converts heuristic scoring into:
//   P(statement is correct | evidence, model outputs) ± CI
//
// Platt update rule (online gradient descent):
//   p = σ(a*x + b)
//   ∂L/∂a = -(y - p) * p(1-p) * x   [Brier gradient]
//   ∂L/∂b = -(y - p) * p(1-p)
//   a += lr * (y - p) * p(1-p) * x
//   b += lr * (y - p) * p(1-p)

import pool from '../db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FeatureVector {
  reasoning_score: number;    // logical soundness 0-1
  bias_score: number;         // detected bias magnitude 0-1 (lower=less biased)
  emotion_score: number;      // emotional loading 0-1
  coherence_score: number;    // internal consistency 0-1
  novelty_score: number;      // originality 0-1
  source_confidence: number;  // evidence/sourcing quality 0-1
}

export interface CalibrationResult {
  raw_composite: number;
  calibrated_prob: number;    // P(correct | features)
  confidence_low: number;     // 95% CI lower bound
  confidence_high: number;    // 95% CI upper bound
  uncertainty: number;        // 1 - confidence (width of CI)
  n_labeled: number;          // number of labeled examples used for calibration
}

export interface ReliabilityCurvePoint {
  bin_center: number;         // e.g., 0.05, 0.15, ..., 0.95
  mean_predicted: number;     // mean calibrated_prob in this bin
  mean_actual: number;        // mean human_label in this bin (accuracy)
  count: number;              // n in this bin
}

export interface CalibrationStatus {
  platt_a: number;
  platt_b: number;
  n_labeled: number;
  brier_score: number;
  reliability_curve: ReliabilityCurvePoint[];
  calibration_gap: number;    // mean |predicted - actual| across bins
  is_calibrated: boolean;     // gap < 0.10
}

// ─── Math Helpers ─────────────────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// Wilson score 95% confidence interval for a proportion
// Returns [low, high] where the true p lies with 95% confidence
function wilsonCI(p: number, n: number): [number, number] {
  if (n === 0) return [Math.max(0, p - 0.18), Math.min(1, p + 0.18)];
  const z = 1.96;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margin = (z / (1 + z2 / n)) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// Raw composite from feature vector
function computeRawComposite(f: FeatureVector): number {
  return Math.max(0, Math.min(1,
    0.30 * f.reasoning_score +
    0.20 * f.coherence_score +
    0.20 * f.source_confidence +
    0.15 * f.novelty_score -
    0.10 * f.bias_score -
    0.05 * f.emotion_score
  ));
}

// ─── Calibration Params (DB-backed, singleton) ────────────────────────────────

let _params: { platt_a: number; platt_b: number; n_labeled: number; brier_score: number; brier_n: number } | null = null;

async function getParams() {
  if (_params) return _params;
  const res = await pool.query('SELECT * FROM calibration_params WHERE id = 1');
  _params = {
    platt_a: parseFloat(res.rows[0].platt_a),
    platt_b: parseFloat(res.rows[0].platt_b),
    n_labeled: res.rows[0].n_labeled,
    brier_score: parseFloat(res.rows[0].brier_score || '0.25'),
    brier_n: res.rows[0].brier_n || 0,
  };
  return _params;
}

async function saveParams(p: typeof _params) {
  _params = p;
  await pool.query(
    `UPDATE calibration_params SET platt_a=$1, platt_b=$2, n_labeled=$3, brier_score=$4, brier_n=$5, last_updated=NOW() WHERE id=1`,
    [p!.platt_a, p!.platt_b, p!.n_labeled, p!.brier_score, p!.brier_n]
  );
}

// ─── Core: Calibrate a Feature Vector ─────────────────────────────────────────

export async function calibrate(features: FeatureVector): Promise<CalibrationResult> {
  const params = await getParams();
  const raw = computeRawComposite(features);

  // Platt scaling
  const logit = params!.platt_a * raw + params!.platt_b;
  const calibrated_prob = sigmoid(logit);

  // Wilson confidence interval (shrinks with more labeled data)
  const [lo, hi] = wilsonCI(calibrated_prob, params!.n_labeled);

  return {
    raw_composite: Math.round(raw * 1000) / 1000,
    calibrated_prob: Math.round(calibrated_prob * 1000) / 1000,
    confidence_low: Math.round(lo * 1000) / 1000,
    confidence_high: Math.round(hi * 1000) / 1000,
    uncertainty: Math.round((hi - lo) * 1000) / 1000,
    n_labeled: params!.n_labeled,
  };
}

// ─── Store Evaluation ─────────────────────────────────────────────────────────

export async function storeEvaluation(
  features: FeatureVector,
  calibrationResult: CalibrationResult,
  refs: { postId?: number; debateMessageId?: number }
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO truth_evaluations
       (post_id, debate_message_id, raw_composite, feature_vector,
        calibrated_prob, confidence_low, confidence_high)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      refs.postId || null,
      refs.debateMessageId || null,
      calibrationResult.raw_composite,
      JSON.stringify(features),
      calibrationResult.calibrated_prob,
      calibrationResult.confidence_low,
      calibrationResult.confidence_high,
    ]
  );
  return res.rows[0].id;
}

// ─── Human Evaluation Loop ────────────────────────────────────────────────────
// Submit a binary label (1=correct, 0=incorrect) for a stored evaluation.
// Updates Platt parameters via online gradient descent.
// Updates the running Brier score.

const LEARNING_RATE = 0.05;

export async function submitHumanLabel(
  evaluationId: number,
  label: 0 | 1,
  reason?: string
): Promise<{ brier_contribution: number; params_updated: boolean }> {
  // Fetch the stored evaluation
  const evalRes = await pool.query(
    'SELECT * FROM truth_evaluations WHERE id = $1', [evaluationId]
  );
  if (!evalRes.rows.length) throw new Error('Evaluation not found');

  const ev = evalRes.rows[0];
  if (ev.human_label !== null) throw new Error('Already labeled');

  const p = parseFloat(ev.calibrated_prob);
  const y = label;

  // Brier score contribution: (p - y)^2
  const brier = (p - y) * (p - y);

  // Store label
  await pool.query(
    `UPDATE truth_evaluations
     SET human_label=$1, brier_contribution=$2, label_reason=$3, labeled_at=NOW()
     WHERE id=$4`,
    [y, brier, reason || null, evaluationId]
  );

  // Online Platt parameter update (gradient descent on Brier loss)
  const params = await getParams();
  const raw = parseFloat(ev.raw_composite);
  const pq = p * (1 - p); // p*(1-p) — Bernoulli variance

  const grad_a = (y - p) * pq * raw;
  const grad_b = (y - p) * pq;

  const new_a = params!.platt_a + LEARNING_RATE * grad_a;
  const new_b = params!.platt_b + LEARNING_RATE * grad_b;

  // Welford running mean for Brier score
  const n = params!.brier_n + 1;
  const new_brier = params!.brier_score + (brier - params!.brier_score) / n;

  await saveParams({
    platt_a: Math.max(0.1, Math.min(5.0, new_a)),
    platt_b: Math.max(-3.0, Math.min(3.0, new_b)),
    n_labeled: params!.n_labeled + 1,
    brier_score: new_brier,
    brier_n: n,
  });

  return { brier_contribution: Math.round(brier * 1000000) / 1000000, params_updated: true };
}

// ─── Reliability Curve ────────────────────────────────────────────────────────
// Bin predictions [0.0-0.1), [0.1-0.2), …, [0.9-1.0]
// Compute mean predicted vs mean actual (accuracy) per bin.
// A perfectly calibrated model shows points on the diagonal.

export async function getReliabilityCurve(): Promise<ReliabilityCurvePoint[]> {
  const res = await pool.query(`
    SELECT
      FLOOR(calibrated_prob * 10) / 10.0 + 0.05 AS bin_center,
      AVG(calibrated_prob) AS mean_predicted,
      AVG(human_label::float) AS mean_actual,
      COUNT(*) AS count
    FROM truth_evaluations
    WHERE human_label IS NOT NULL
    GROUP BY FLOOR(calibrated_prob * 10)
    ORDER BY bin_center
  `);

  return res.rows.map(r => ({
    bin_center: parseFloat(r.bin_center),
    mean_predicted: Math.round(parseFloat(r.mean_predicted) * 1000) / 1000,
    mean_actual: Math.round(parseFloat(r.mean_actual) * 1000) / 1000,
    count: parseInt(r.count),
  }));
}

// ─── Full Calibration Status ──────────────────────────────────────────────────

export async function getCalibrationStatus(): Promise<CalibrationStatus> {
  const [params, curve] = await Promise.all([getParams(), getReliabilityCurve()]);

  const calibration_gap = curve.length > 0
    ? curve.reduce((s, p) => s + Math.abs(p.mean_predicted - p.mean_actual), 0) / curve.length
    : 0.25; // default uncertainty when no labels yet

  return {
    platt_a: Math.round(params!.platt_a * 1000000) / 1000000,
    platt_b: Math.round(params!.platt_b * 1000000) / 1000000,
    n_labeled: params!.n_labeled,
    brier_score: Math.round(params!.brier_score * 1000000) / 1000000,
    reliability_curve: curve,
    calibration_gap: Math.round(calibration_gap * 1000) / 1000,
    is_calibrated: calibration_gap < 0.10,
  };
}

// ─── Human Evaluation Queue ───────────────────────────────────────────────────

export async function getEvaluationQueue(limit = 20): Promise<any[]> {
  const res = await pool.query(`
    SELECT te.*, p.content as post_content, p.persona_id
    FROM truth_evaluations te
    LEFT JOIN posts p ON te.post_id = p.id
    WHERE te.human_label IS NULL
    ORDER BY te.created_at DESC
    LIMIT $1
  `, [limit]);
  return res.rows;
}

export async function getEvaluationStats(): Promise<any> {
  const res = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE human_label IS NOT NULL)::int AS labeled,
      COUNT(*) FILTER (WHERE human_label = 1)::int AS correct,
      COUNT(*) FILTER (WHERE human_label = 0)::int AS incorrect,
      AVG(calibrated_prob) AS avg_prob,
      AVG(brier_contribution) AS avg_brier
    FROM truth_evaluations
  `);
  return res.rows[0];
}

// ─── Feature Vector Builder ───────────────────────────────────────────────────
// Maps EvaluationMetrics → FeatureVector for calibration input.

export function metricsToFeatures(m: {
  reasoning_quality: number;
  coherence: number;
  novelty: number;
  redundancy: number;
  toxicity: number;
  persona_match: number;
}): FeatureVector {
  return {
    reasoning_score: m.reasoning_quality,
    coherence_score: m.coherence,
    novelty_score: m.novelty,
    bias_score: Math.max(0, m.toxicity * 0.6 + m.redundancy * 0.4),
    emotion_score: m.toxicity * 0.5,
    source_confidence: m.persona_match,
  };
}
