// Multi-Task Analyzer — Shared Encoder + Task-Specific Heads
//
// Architecture (mirrors production ML systems, implemented with LLMs):
//
//   Input Text
//     ↓
//   Shared Encoder (one Gemini call → raw signal representation)
//     ├── Bias Head      → bias_score   (0-1, lower=less biased)
//     ├── Emotion Head   → emotion_score (0-1)
//     └── Reasoning Head → reasoning_score (0-1)
//     ↓
//   Dynamic Loss Weighting (inverse-variance, updated from rolling window)
//     ↓
//   Composite + Drift Detection + Task Leakage Check
//
// Key Properties:
// - Single LLM call = shared representation, separate post-processing per task
// - Dynamic weights: high-variance tasks contribute less (uncertainty-weighted)
// - Drift: flags task conflicts (e.g. reasoning↓ while bias↑)
// - Task leakage: monitors cross-task correlation to detect representation overlap
// - Inference-time control: callers can prioritize specific tasks

import { getModel } from './gemini.js';
import pool from '../db.js';


// ─── Types ────────────────────────────────────────────────────────────────────

export interface SharedFeatures {
  text_complexity: number;        // 0-1: vocabulary complexity + sentence structure
  information_density: number;    // 0-1: facts/claims per sentence
  logical_coherence: number;      // 0-1: internal consistency + causal structure
  emotional_loading: number;      // 0-1: affective content intensity
  rhetorical_structure: number;   // 0-1: use of rhetoric patterns (appeals, framing)
  source_quality: number;         // 0-1: specificity of evidence cited
  certainty_level: number;        // 0-1: language absolutism vs hedging
}

export interface TaskHeadOutputs {
  bias_score: number;       // magnitude of detected bias/confirmation patterns
  emotion_score: number;    // emotional intensity in argument
  reasoning_score: number;  // logical quality + evidence-based argumentation
  uncertainty: {
    bias: number;
    emotion: number;
    reasoning: number;
  };
}

export interface TaskWeights {
  bias: number;
  emotion: number;
  reasoning: number;
  method: 'inverse_variance' | 'uniform';
}

export interface DriftAlert {
  detected: boolean;
  type: 'task_conflict' | 'score_shift' | 'leakage' | null;
  details: string;
  affected_tasks: string[];
  severity: number;  // 0-1
}

export interface MultiTaskResult {
  shared_features: SharedFeatures;
  tasks: TaskHeadOutputs;
  weights: TaskWeights;
  composite_score: number;
  drift: DriftAlert;
  leakage_score: number;     // cross-task correlation (high=potential leakage)
  inference_mode: 'balanced' | 'debate' | 'factcheck';
}

// ─── Rolling Window (in-memory, bounded) ──────────────────────────────────────
// Used for variance estimation and drift detection.

const WINDOW_SIZE = 20;

interface WindowEntry { bias: number; emotion: number; reasoning: number; ts: number }
const _window: WindowEntry[] = [];

function addToWindow(e: WindowEntry): void {
  _window.push(e);
  if (_window.length > WINDOW_SIZE) _window.shift();
}

function windowVariance(arr: number[]): number {
  if (arr.length < 2) return 0.04; // prior variance
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (arr.length - 1);
  return Math.max(0.001, variance);
}

function windowTrend(arr: number[]): number {
  if (arr.length < 3) return 0;
  // Simple linear regression slope
  const n = arr.length;
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const sumY = arr.reduce((s, y) => s + y, 0);
  const sumXY = arr.reduce((s, y, i) => s + i * y, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  return slope;
}

// Pearson correlation between two arrays
function pearsonCorr(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return 0;
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  const num = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0);
  const da = Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0));
  const db = Math.sqrt(b.reduce((s, x) => s + (x - mb) ** 2, 0));
  return (da === 0 || db === 0) ? 0 : num / (da * db);
}

// ─── Shared Encoder ───────────────────────────────────────────────────────────
// One Gemini call extracts a unified feature representation.
// Equivalent to a shared transformer encoder — all task heads read from this.

async function runSharedEncoder(text: string): Promise<SharedFeatures> {
  const model = getModel();

  const prompt = `You are a shared feature extraction engine for multi-task NLP analysis.
Extract raw signal features from this text that will be consumed by separate task-specific heads.

TEXT: "${text.slice(0, 700).replace(/"/g, "'")}"

Return ONLY valid JSON with no markdown:
{
  "text_complexity": 0.0-1.0,
  "information_density": 0.0-1.0,
  "logical_coherence": 0.0-1.0,
  "emotional_loading": 0.0-1.0,
  "rhetorical_structure": 0.0-1.0,
  "source_quality": 0.0-1.0,
  "certainty_level": 0.0-1.0
}

Definitions (be precise):
- text_complexity: vocabulary sophistication + avg sentence length normalized 0-1
- information_density: factual claims per sentence (0=vague, 1=dense with specifics)
- logical_coherence: how well ideas connect causally (0=incoherent, 1=tight logical chain)
- emotional_loading: affective language density (0=purely factual, 1=highly emotional)
- rhetorical_structure: use of rhetoric patterns—ethos/pathos/logos, framing, analogies (0-1)
- source_quality: specificity of evidence—named studies/data vs vague claims (0=no evidence, 1=strong specific evidence)
- certainty_level: language absolutism (0=hedged/uncertain, 1=definitive/absolute)`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(raw);

  const c = (v: any, d = 0.5) => Math.max(0, Math.min(1, parseFloat(v) || d));
  return {
    text_complexity:     c(parsed.text_complexity),
    information_density: c(parsed.information_density),
    logical_coherence:   c(parsed.logical_coherence),
    emotional_loading:   c(parsed.emotional_loading),
    rhetorical_structure: c(parsed.rhetorical_structure),
    source_quality:      c(parsed.source_quality),
    certainty_level:     c(parsed.certainty_level),
  };
}

// Rule-based fallback encoder (used when Gemini unavailable)
function ruleBasedEncoder(text: string): SharedFeatures {
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).length;
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 5);
  const avgLen = words / Math.max(sentences.length, 1);

  const evidence = (lower.match(/\b(study|research|data|evidence|shows|found|percent|according|reported)\b/g) || []).length;
  const absolute = (lower.match(/\b(always|never|everyone|no one|definitely|certainly|impossible|must)\b/g) || []).length;
  const hedge    = (lower.match(/\b(might|perhaps|possibly|some|often|arguably|tend to|suggests|may)\b/g) || []).length;
  const emotion  = (lower.match(/\b(outrage|hate|love|fear|terrible|awful|amazing|shocking|horrifying)\b/g) || []).length;
  const logic    = (lower.match(/\b(because|therefore|thus|hence|since|implies|consequently|leads to)\b/g) || []).length;
  const rhetoric = (lower.match(/\b(should|must|we need|essential|demand|vital|urgent|critical|imagine)\b/g) || []).length;

  return {
    text_complexity:      Math.min(1, (avgLen - 8) / 25 + 0.3),
    information_density:  Math.min(1, (evidence / Math.max(words, 1)) * 30),
    logical_coherence:    Math.min(1, (logic / Math.max(words, 1)) * 40 + 0.3),
    emotional_loading:    Math.min(1, emotion * 0.15 + (text.match(/!/g) || []).length * 0.1),
    rhetorical_structure: Math.min(1, rhetoric * 0.12),
    source_quality:       Math.min(1, evidence * 0.12),
    certainty_level:      Math.min(1, Math.max(0, 0.5 + absolute * 0.1 - hedge * 0.07)),
  };
}

// ─── Task Heads ───────────────────────────────────────────────────────────────
// Pure functions on shared features — no additional LLM calls.
// Each head has its own feature weighting that reflects what the task cares about.

function biasHead(f: SharedFeatures): { score: number; uncertainty: number } {
  // Bias is driven by: certainty (absolute language), emotional loading, low source quality
  const score = Math.min(1, Math.max(0,
    0.40 * f.certainty_level +
    0.30 * f.emotional_loading +
    0.20 * (1 - f.source_quality) +
    0.10 * f.rhetorical_structure
  ));
  // Uncertainty is high when emotional_loading and certainty conflict (mixed signals)
  const uncertainty = Math.abs(f.certainty_level - f.emotional_loading) * 0.3 + 0.1;
  return { score: Math.round(score * 1000) / 1000, uncertainty: Math.round(uncertainty * 1000) / 1000 };
}

function emotionHead(f: SharedFeatures): { score: number; uncertainty: number } {
  // Emotion driven by: emotional_loading (primary), certainty amplifies it
  const score = Math.min(1, Math.max(0,
    0.60 * f.emotional_loading +
    0.20 * f.rhetorical_structure +
    0.20 * (1 - f.logical_coherence) * f.emotional_loading
  ));
  const uncertainty = (1 - f.logical_coherence) * 0.2 + 0.05;
  return { score: Math.round(score * 1000) / 1000, uncertainty: Math.round(uncertainty * 1000) / 1000 };
}

function reasoningHead(f: SharedFeatures): { score: number; uncertainty: number } {
  // Reasoning driven by: coherence (primary), source quality, density, low emotion interference
  const emotionPenalty = f.emotional_loading * 0.15; // emotion degrades reasoning signal
  const score = Math.min(1, Math.max(0,
    0.40 * f.logical_coherence +
    0.25 * f.source_quality +
    0.20 * f.information_density +
    0.10 * f.text_complexity +
    0.05 * (1 - f.certainty_level) - // hedging = epistemic humility = good reasoning signal
    emotionPenalty
  ));
  // Uncertainty: high when source_quality and coherence disagree
  const uncertainty = Math.abs(f.source_quality - f.logical_coherence) * 0.25 + 0.05;
  return { score: Math.round(score * 1000) / 1000, uncertainty: Math.round(uncertainty * 1000) / 1000 };
}

// ─── Dynamic Loss Weighting ────────────────────────────────────────────────────
// Uncertainty-weighted: w_i = 1 / (σ_i² + ε)
// High-variance tasks contribute less. Inspired by Kendall et al. 2018.

function computeDynamicWeights(
  uncertainties: { bias: number; emotion: number; reasoning: number },
  inferenceMode: 'balanced' | 'debate' | 'factcheck'
): TaskWeights {
  const eps = 0.01;
  const raw = {
    bias:      1 / (uncertainties.bias ** 2 + eps),
    emotion:   1 / (uncertainties.emotion ** 2 + eps),
    reasoning: 1 / (uncertainties.reasoning ** 2 + eps),
  };

  // Inference-time override: boost task weights for specific use cases
  if (inferenceMode === 'debate') {
    raw.reasoning *= 1.5;   // debates → prioritize reasoning
    raw.emotion   *= 0.8;
  } else if (inferenceMode === 'factcheck') {
    raw.bias      *= 1.4;   // factchecking → prioritize bias + reasoning
    raw.reasoning *= 1.3;
    raw.emotion   *= 0.5;
  }

  const total = raw.bias + raw.emotion + raw.reasoning;
  return {
    bias:      Math.round((raw.bias / total) * 1000) / 1000,
    emotion:   Math.round((raw.emotion / total) * 1000) / 1000,
    reasoning: Math.round((raw.reasoning / total) * 1000) / 1000,
    method: 'inverse_variance',
  };
}

// ─── Drift Detection ──────────────────────────────────────────────────────────

function detectDrift(current: { bias: number; emotion: number; reasoning: number }): DriftAlert {
  if (_window.length < 5) {
    return { detected: false, type: null, details: 'Insufficient history for drift detection', affected_tasks: [], severity: 0 };
  }

  const biasArr     = _window.map(e => e.bias);
  const emotionArr  = _window.map(e => e.emotion);
  const reasonArr   = _window.map(e => e.reasoning);

  const biasTrend   = windowTrend(biasArr);
  const reasonTrend = windowTrend(reasonArr);
  const emotionTrend = windowTrend(emotionArr);

  // Task conflict: reasoning declining while bias rising
  if (reasonTrend < -0.015 && biasTrend > 0.015) {
    const severity = Math.min(1, (Math.abs(reasonTrend) + Math.abs(biasTrend)) * 10);
    return {
      detected: true,
      type: 'task_conflict',
      details: `Reasoning quality declining (trend: ${(reasonTrend * 100).toFixed(1)}%/sample) while bias increasing (${(biasTrend * 100).toFixed(1)}%/sample)`,
      affected_tasks: ['reasoning', 'bias'],
      severity: Math.round(severity * 100) / 100,
    };
  }

  // Score shift: any task moves > 20% from its rolling mean
  const biasM = biasArr.reduce((s, x) => s + x, 0) / biasArr.length;
  const emM   = emotionArr.reduce((s, x) => s + x, 0) / emotionArr.length;
  const reM   = reasonArr.reduce((s, x) => s + x, 0) / reasonArr.length;

  const shifts = [
    { task: 'bias', shift: Math.abs(current.bias - biasM), mean: biasM },
    { task: 'emotion', shift: Math.abs(current.emotion - emM), mean: emM },
    { task: 'reasoning', shift: Math.abs(current.reasoning - reM), mean: reM },
  ].filter(s => s.shift > 0.20);

  if (shifts.length > 0) {
    const worst = shifts.sort((a, b) => b.shift - a.shift)[0];
    return {
      detected: true,
      type: 'score_shift',
      details: `${worst.task} score shifted ${(worst.shift * 100).toFixed(0)}% from rolling mean (${(worst.mean * 100).toFixed(0)}%)`,
      affected_tasks: shifts.map(s => s.task),
      severity: Math.min(1, worst.shift / 0.35),
    };
  }

  return { detected: false, type: null, details: 'No drift detected', affected_tasks: [], severity: 0 };
}

// Task leakage: high cross-task correlation suggests representation overlap
function detectLeakage(): number {
  if (_window.length < 5) return 0;
  const biasArr    = _window.map(e => e.bias);
  const emotionArr = _window.map(e => e.emotion);
  const reasonArr  = _window.map(e => e.reasoning);

  const corrBE = Math.abs(pearsonCorr(biasArr, emotionArr));
  const corrBR = Math.abs(pearsonCorr(biasArr, reasonArr));
  const corrER = Math.abs(pearsonCorr(emotionArr, reasonArr));

  return Math.round(((corrBE + corrBR + corrER) / 3) * 1000) / 1000;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runMultiTaskAnalysis(
  text: string,
  opts: {
    inferenceMode?: 'balanced' | 'debate' | 'factcheck';
    sourceId?: number;
    sourceType?: 'post' | 'debate_message';
    useFallback?: boolean;
  } = {}
): Promise<MultiTaskResult> {
  const { inferenceMode = 'balanced', sourceId, sourceType, useFallback = false } = opts;

  // 1. Shared encoder
  let shared: SharedFeatures;
  try {
    shared = useFallback ? ruleBasedEncoder(text) : await runSharedEncoder(text);
  } catch (err: any) {
    if (err?.message?.includes('429') || err?.message?.includes('quota')) {
      shared = ruleBasedEncoder(text);
    } else {
      shared = ruleBasedEncoder(text);
    }
  }

  // 2. Task heads (pure computation — no extra LLM calls)
  const biasOut    = biasHead(shared);
  const emotionOut = emotionHead(shared);
  const reasonOut  = reasoningHead(shared);

  const tasks: TaskHeadOutputs = {
    bias_score:     biasOut.score,
    emotion_score:  emotionOut.score,
    reasoning_score: reasonOut.score,
    uncertainty: {
      bias:     biasOut.uncertainty,
      emotion:  emotionOut.uncertainty,
      reasoning: reasonOut.uncertainty,
    },
  };

  // 3. Dynamic weights (inverse-variance + inference mode boost)
  const weights = computeDynamicWeights(tasks.uncertainty, inferenceMode);

  // 4. Composite with dynamic weights
  // reasoning contributes positively, bias and emotion negatively
  const composite = Math.max(0, Math.min(1,
    weights.reasoning * tasks.reasoning_score -
    weights.bias      * tasks.bias_score * 0.5 -
    weights.emotion   * tasks.emotion_score * 0.3 +
    0.30 * shared.logical_coherence +
    0.15 * shared.source_quality
  ));

  // 5. Drift and leakage detection
  const taskScores = { bias: tasks.bias_score, emotion: tasks.emotion_score, reasoning: tasks.reasoning_score };
  addToWindow({ ...taskScores, ts: Date.now() });
  const drift   = detectDrift(taskScores);
  const leakage = detectLeakage();

  const result: MultiTaskResult = {
    shared_features: shared,
    tasks,
    weights,
    composite_score: Math.round(composite * 1000) / 1000,
    drift,
    leakage_score: leakage,
    inference_mode: inferenceMode,
  };

  // 6. Persist to task_performance_log
  if (sourceId && sourceType) {
    await pool.query(
      `INSERT INTO task_performance_log
         (source_type, source_id, bias_score, emotion_score, reasoning_score,
          uncertainty_bias, uncertainty_emotion, uncertainty_reasoning,
          task_weights, drift_detected, drift_details, shared_features, composite_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        sourceType, sourceId,
        tasks.bias_score, tasks.emotion_score, tasks.reasoning_score,
        tasks.uncertainty.bias, tasks.uncertainty.emotion, tasks.uncertainty.reasoning,
        JSON.stringify(weights),
        drift.detected, drift.detected ? JSON.stringify(drift) : null,
        JSON.stringify(shared),
        result.composite_score,
      ]
    ).catch(() => {});
  }

  return result;
}

// ─── Per-Task Monitoring ──────────────────────────────────────────────────────

export async function getTaskPerformanceSummary(limit = 50): Promise<{
  recent: any[];
  averages: { bias: number; emotion: number; reasoning: number };
  drift_events: number;
  leakage_trend: number;
  task_weights: TaskWeights;
}> {
  const res = await pool.query(
    `SELECT * FROM task_performance_log ORDER BY created_at DESC LIMIT $1`, [limit]
  );

  const rows = res.rows;
  const avg = (key: string) => rows.length > 0
    ? rows.reduce((s: number, r: any) => s + parseFloat(r[key] || 0), 0) / rows.length
    : 0.5;

  const driftCount = rows.filter((r: any) => r.drift_detected).length;
  const currentWeights = _window.length >= 5
    ? computeDynamicWeights({
        bias: windowVariance(_window.map(e => e.bias)),
        emotion: windowVariance(_window.map(e => e.emotion)),
        reasoning: windowVariance(_window.map(e => e.reasoning)),
      }, 'balanced')
    : { bias: 0.33, emotion: 0.33, reasoning: 0.34, method: 'uniform' as const };

  return {
    recent: rows.slice(0, 10),
    averages: {
      bias:      Math.round(avg('bias_score') * 1000) / 1000,
      emotion:   Math.round(avg('emotion_score') * 1000) / 1000,
      reasoning: Math.round(avg('reasoning_score') * 1000) / 1000,
    },
    drift_events: driftCount,
    leakage_trend: detectLeakage(),
    task_weights: currentWeights,
  };
}
