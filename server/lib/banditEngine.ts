// Bandit Engine — Thompson Sampling + Contextual Bandits
// Replaces the deterministic (userId + nameHash) % 2 A/B split with
// a proper Bayesian adaptive experiment system that learns which variants
// work best and routes traffic accordingly.
//
// Thompson Sampling math:
//   Each variant maintains Beta(alpha, beta) parameters.
//   At selection time: θ_i ~ Beta(alpha_i, beta_i) for each variant.
//   We select the variant with the highest sampled θ.
//   After observing reward r ∈ [0,1]: alpha += r, beta += (1 - r).
//
// Contextual Bandits:
//   For each (experiment, context_key) pair we maintain SEPARATE bandit states.
//   context_key encodes user expertise × topic × thinking style.
//   This lets the system learn "variant A works better for logical thinkers".

import pool from '../db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BanditState {
  experiment_name: string;
  variant: string;
  alpha: number;
  beta_param: number;
  context_key: string;
  impressions: number;
  reward_sum: number;
}

export interface ExperimentSummary {
  experiment_name: string;
  variants: {
    variant: string;
    alpha: number;
    beta_param: number;
    impressions: number;
    mean_reward: number;
    confidence: number;
    is_leading: boolean;
  }[];
  total_impressions: number;
  recommended_variant: string;
  exploration_rate: number;
}

export interface GuardrailConfig {
  max_toxicity: number;        // stop if avg toxicity exceeds this
  min_engagement: number;      // stop if engagement drops below this
  max_latency_ms: number;      // stop if p95 latency exceeds this
  min_impressions: number;     // guardrails only apply after N impressions
}

const DEFAULT_GUARDRAILS: GuardrailConfig = {
  max_toxicity: 0.35,
  min_engagement: 0.05,
  max_latency_ms: 5000,
  min_impressions: 50,
};

// ─── Gamma / Beta sampling (pure JS — no scipy) ───────────────────────────────
// We use the Marsaglia-Tsang method to sample from Gamma(a, 1),
// then Beta(a, b) = Gamma(a) / (Gamma(a) + Gamma(b)).

function sampleGamma(shape: number): number {
  if (shape < 1) {
    return sampleGamma(1 + shape) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do {
      x = normalSample();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleBeta(alpha: number, betaParam: number): number {
  const x = sampleGamma(Math.max(alpha, 0.01));
  const y = sampleGamma(Math.max(betaParam, 0.01));
  return x / (x + y);
}

// ─── Context Key Builder ──────────────────────────────────────────────────────
// Buckets users into (expertise × topic × style) segments for contextual bandits.
// Granular enough to be useful, coarse enough to accumulate signal quickly.

export function buildContextKey(opts: {
  postCount?: number;
  topic?: string;
  thinkingStyle?: string;
}): string {
  const expertise = (opts.postCount || 0) < 5 ? 'novice'
    : (opts.postCount || 0) < 20 ? 'intermediate'
    : 'expert';

  const topicBucket = opts.topic
    ? opts.topic.toLowerCase().replace(/[^a-z]/g, '').slice(0, 12) || 'general'
    : 'general';

  const style = opts.thinkingStyle === 'analytical' ? 'logical'
    : opts.thinkingStyle === 'emotional' ? 'emotional'
    : 'neutral';

  return `${expertise}:${topicBucket}:${style}`;
}

// ─── Bandit DB Ops ────────────────────────────────────────────────────────────

async function getOrInitBanditState(
  experimentName: string,
  variant: string,
  contextKey: string
): Promise<BanditState> {
  const res = await pool.query(
    `INSERT INTO bandit_state (experiment_name, variant, context_key, alpha, beta_param, impressions, reward_sum)
     VALUES ($1, $2, $3, 1.0, 1.0, 0, 0)
     ON CONFLICT (experiment_name, variant, context_key) DO NOTHING
     RETURNING *`,
    [experimentName, variant, contextKey]
  );
  if (res.rows.length) return res.rows[0];

  const existing = await pool.query(
    `SELECT * FROM bandit_state WHERE experiment_name = $1 AND variant = $2 AND context_key = $3`,
    [experimentName, variant, contextKey]
  );
  return existing.rows[0];
}

async function getVariantStates(
  experimentName: string,
  contextKey: string,
  variants: string[]
): Promise<BanditState[]> {
  return Promise.all(variants.map(v => getOrInitBanditState(experimentName, v, contextKey)));
}

// ─── Thompson Sampling ────────────────────────────────────────────────────────

export async function thompsonSelect(
  experimentName: string,
  variants: string[],
  contextKey: string = 'global'
): Promise<{ variant: string; wasExploration: boolean }> {
  if (variants.length === 0) throw new Error('No variants provided');
  if (variants.length === 1) return { variant: variants[0], wasExploration: false };

  const states = await getVariantStates(experimentName, contextKey, variants);

  // Force exploration: if any variant has < 10 impressions, round-robin among them
  const underexplored = states.filter(s => s.impressions < 10);
  if (underexplored.length > 0) {
    const pick = underexplored[Math.floor(Math.random() * underexplored.length)];
    await incrementImpressions(experimentName, pick.variant, contextKey);
    return { variant: pick.variant, wasExploration: true };
  }

  // Thompson Sampling: draw θ from each variant's Beta distribution
  const samples = states.map(s => ({
    variant: s.variant,
    theta: sampleBeta(s.alpha, s.beta_param),
  }));

  const best = samples.reduce((a, b) => a.theta > b.theta ? a : b);
  await incrementImpressions(experimentName, best.variant, contextKey);
  return { variant: best.variant, wasExploration: false };
}

async function incrementImpressions(experimentName: string, variant: string, contextKey: string): Promise<void> {
  await pool.query(
    `UPDATE bandit_state SET impressions = impressions + 1, updated_at = NOW()
     WHERE experiment_name = $1 AND variant = $2 AND context_key = $3`,
    [experimentName, variant, contextKey]
  ).catch(() => {});
}

// ─── Reward Update ────────────────────────────────────────────────────────────

export async function updateBanditReward(
  experimentName: string,
  variant: string,
  reward: number,
  contextKey: string = 'global'
): Promise<void> {
  const clampedReward = Math.min(1, Math.max(0, reward));
  await pool.query(
    `UPDATE bandit_state
     SET alpha = alpha + $1,
         beta_param = beta_param + $2,
         reward_sum = reward_sum + $3,
         updated_at = NOW()
     WHERE experiment_name = $4 AND variant = $5 AND context_key = $6`,
    [clampedReward, 1 - clampedReward, clampedReward, experimentName, variant, contextKey]
  ).catch(() => {});
}

// ─── Experiment Summary ───────────────────────────────────────────────────────

export async function getExperimentSummary(experimentName: string): Promise<ExperimentSummary> {
  const res = await pool.query(
    `SELECT variant, SUM(alpha) as alpha, SUM(beta_param) as beta_p,
            SUM(impressions) as impressions, SUM(reward_sum) as reward_sum
     FROM bandit_state WHERE experiment_name = $1
     GROUP BY variant ORDER BY variant`,
    [experimentName]
  );

  if (!res.rows.length) {
    return { experiment_name: experimentName, variants: [], total_impressions: 0, recommended_variant: '', exploration_rate: 1 };
  }

  const totalImpressions = res.rows.reduce((s: number, r: any) => s + parseInt(r.impressions), 0);

  const variantData = res.rows.map((r: any) => {
    const alpha = parseFloat(r.alpha);
    const betaP = parseFloat(r.beta_p);
    const impr = parseInt(r.impressions);
    const meanReward = (alpha - 1) / Math.max(alpha + betaP - 2, 0.01);
    // 95% credible interval half-width as confidence proxy
    const variance = (alpha * betaP) / ((alpha + betaP) ** 2 * (alpha + betaP + 1));
    const confidence = Math.max(0, 1 - Math.sqrt(variance) * 4);
    return { variant: r.variant, alpha, beta_param: betaP, impressions: impr, mean_reward: meanReward, confidence, is_leading: false };
  });

  const leading = variantData.reduce((a, b) => a.mean_reward > b.mean_reward ? a : b);
  leading.is_leading = true;

  const underexploredRatio = variantData.filter(v => v.impressions < 10).length / variantData.length;

  return {
    experiment_name: experimentName,
    variants: variantData,
    total_impressions: totalImpressions,
    recommended_variant: leading.variant,
    exploration_rate: underexploredRatio,
  };
}

// ─── Guardrail Checker ────────────────────────────────────────────────────────
// Checks whether a running experiment violates any safety or quality guardrails.
// If violated, logs to guardrail_violations and returns which rule was broken.

export async function checkGuardrails(
  experimentName: string,
  currentMetrics: { avg_toxicity?: number; engagement_rate?: number; avg_latency_ms?: number },
  config: Partial<GuardrailConfig> = {}
): Promise<{ violated: boolean; violations: string[] }> {
  const cfg = { ...DEFAULT_GUARDRAILS, ...config };

  const [summaryRes] = await Promise.all([
    pool.query(`SELECT SUM(impressions) as total FROM bandit_state WHERE experiment_name = $1`, [experimentName]),
  ]);

  const totalImpr = parseInt(summaryRes.rows[0]?.total || '0');
  if (totalImpr < cfg.min_impressions) return { violated: false, violations: [] };

  const violations: string[] = [];

  if (currentMetrics.avg_toxicity !== undefined && currentMetrics.avg_toxicity > cfg.max_toxicity) {
    violations.push(`toxicity=${currentMetrics.avg_toxicity.toFixed(3)} > threshold=${cfg.max_toxicity}`);
    await logViolation(experimentName, 'toxicity', cfg.max_toxicity, currentMetrics.avg_toxicity);
  }
  if (currentMetrics.engagement_rate !== undefined && currentMetrics.engagement_rate < cfg.min_engagement) {
    violations.push(`engagement=${currentMetrics.engagement_rate.toFixed(3)} < threshold=${cfg.min_engagement}`);
    await logViolation(experimentName, 'engagement_drop', cfg.min_engagement, currentMetrics.engagement_rate);
  }
  if (currentMetrics.avg_latency_ms !== undefined && currentMetrics.avg_latency_ms > cfg.max_latency_ms) {
    violations.push(`latency=${currentMetrics.avg_latency_ms}ms > threshold=${cfg.max_latency_ms}ms`);
    await logViolation(experimentName, 'latency', cfg.max_latency_ms, currentMetrics.avg_latency_ms);
  }

  return { violated: violations.length > 0, violations };
}

async function logViolation(experimentName: string, type: string, threshold: number, observed: number): Promise<void> {
  await pool.query(
    `INSERT INTO guardrail_violations (experiment_name, guardrail_type, threshold, observed_value, action_taken)
     VALUES ($1, $2, $3, $4, 'flagged')`,
    [experimentName, type, threshold, observed]
  ).catch(() => {});
}

// ─── All Active Experiments ───────────────────────────────────────────────────

export async function listActiveExperiments(): Promise<string[]> {
  const res = await pool.query(
    `SELECT DISTINCT experiment_name FROM bandit_state WHERE impressions > 0 ORDER BY experiment_name`
  );
  return res.rows.map((r: any) => r.experiment_name);
}
