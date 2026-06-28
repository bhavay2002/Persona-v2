import pool from '../db.js';

export type TrustTier = 'low' | 'medium' | 'high';

export function getTrustTier(score: number): TrustTier {
  if (score >= 75) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

/**
 * Feed ranking multiplier: high trust = more visibility
 * Formula: 1 + trust_score / 200  → range [1.0, 2.0]
 */
export function trustFeedBoost(trustScore: number): number {
  return 1 + Math.max(0, Math.min(200, trustScore)) / 200;
}

/**
 * Recompute persona trust score from behavioral signals and store it.
 * Formula: base + quality_bonus + engagement_bonus + debate_bonus - toxicity_penalty - abuse_penalty
 */
export async function updatePersonaTrust(personaId: number): Promise<number> {
  const [postRes, debateRes, personaRes] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int as post_count,
         COALESCE(AVG(like_count), 0) as avg_likes,
         COALESCE(AVG((ai_metrics->>'composite')::numeric) FILTER (WHERE ai_metrics IS NOT NULL), 0) as avg_quality,
         COALESCE(AVG((ai_metrics->>'toxicity')::numeric) FILTER (WHERE ai_metrics IS NOT NULL), 0) as avg_toxicity
       FROM posts WHERE persona_id = $1`,
      [personaId]
    ),
    pool.query(
      `SELECT
         COALESCE(AVG(logic_score), 0) as avg_logic,
         COALESCE(AVG(persuasiveness_score), 0) as avg_persuasion,
         COALESCE(AVG(toxicity_score), 0) as avg_toxicity,
         COUNT(*)::int as msg_count
       FROM debate_messages WHERE persona_id = $1`,
      [personaId]
    ),
    pool.query(
      'SELECT abuse_flags, reputation_score FROM personas WHERE id = $1',
      [personaId]
    ),
  ]);

  const p = postRes.rows[0];
  const d = debateRes.rows[0];
  const a = personaRes.rows[0];
  if (!a) return 100;

  const base = 100;
  const qualityBonus    = 0.30 * parseFloat(p.avg_quality) * 100;
  const engagementBonus = 0.20 * Math.min(1, parseFloat(p.avg_likes) / 5) * 100;
  const debateBonus     = parseFloat(d.avg_logic) * 8 + parseFloat(d.avg_persuasion) * 5;
  const reputationBonus = 0.10 * (parseFloat(a.reputation_score || '100') - 100);
  const toxicityPenalty = 0.30 * Math.max(parseFloat(p.avg_toxicity), parseFloat(d.avg_toxicity)) * 100;
  const abusePenalty    = 0.20 * (parseInt(a.abuse_flags) || 0) * 10;

  const trust_score = Math.max(0, Math.min(200, Math.round(
    base + qualityBonus + engagementBonus + debateBonus + reputationBonus - toxicityPenalty - abusePenalty
  )));

  await pool.query('UPDATE personas SET trust_score = $1 WHERE id = $2', [trust_score, personaId]);
  return trust_score;
}

/**
 * Recompute debate trust score from message quality signals.
 * Formula: avg_logic + avg_persuasion - avg_toxicity - fallacy_penalty
 */
export async function updateDebateTrust(debateId: number): Promise<number> {
  const result = await pool.query(
    `SELECT
       COALESCE(AVG(logic_score), 0) as avg_logic,
       COALESCE(AVG(persuasiveness_score), 0) as avg_persuasion,
       COALESCE(AVG(toxicity_score), 0) as avg_toxicity,
       COUNT(CASE WHEN fallacies IS NOT NULL AND fallacies::text != '[]' THEN 1 END)::int as fallacy_count,
       COUNT(*)::int as msg_count
     FROM debate_messages WHERE debate_id = $1`,
    [debateId]
  );
  const r = result.rows[0];
  if (!r || r.msg_count === 0) return 0;

  const trust_score = Math.max(0, Math.min(100, Math.round(
    parseFloat(r.avg_logic) * 40 +
    parseFloat(r.avg_persuasion) * 35 -
    parseFloat(r.avg_toxicity) * 30 -
    parseInt(r.fallacy_count) * 5
  )));

  await pool.query('UPDATE debates SET trust_score = $1 WHERE id = $2', [trust_score, debateId]);
  return trust_score;
}

/**
 * Daily trust decay: 0.99x multiplier prevents stale reputation.
 * Shadow-banned personas are excluded — their trust stays frozen.
 */
export async function applyTrustDecay(): Promise<void> {
  await pool.query(
    `UPDATE personas
     SET trust_score = GREATEST(10, ROUND(trust_score * 0.99))
     WHERE trust_score > 10 AND shadow_banned = false`
  );
}
