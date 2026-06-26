// Feedback Loop — Structured event pipeline with delayed reward resolution.
//
// Architecture:
//   User Interaction → logFeedbackEvent() → feedback_events table
//   → processDelayedRewards() [job, runs every 10 min] → updateBanditReward()
//   → updatePromptMetrics() → composite score → promotion gate
//
// Reward formula (weighted, anti-reward-hacking):
//   reward = 0.30*quality + 0.25*safety + 0.20*engagement + 0.15*debate_win + 0.10*retention
//   Toxicity is subtracted, not treated as engagement signal.
//
// Delayed Rewards:
//   Some signals (debate win, retention depth) are only known after the session ends.
//   We use temporal credit assignment: events from the same session are linked
//   and a session-level reward is computed when the session closes.

import pool from '../db.js';
import { updateBanditReward } from './banditEngine.js';
import { updatePromptMetrics } from './promptRegistry.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type FeedbackEventType =
  | 'post_created'
  | 'post_liked'
  | 'post_evaluated'     // ai_metrics attached
  | 'debate_won'
  | 'debate_message_sent'
  | 'debate_message_scored'
  | 'marketplace_clone'
  | 'session_depth'      // user completed N actions in a session (retention signal)
  | 'moderation_block'   // negative signal
  | 'shadow_ban';        // strong negative signal

export interface FeedbackEvent {
  user_id: number;
  persona_id?: number;
  event_type: FeedbackEventType;
  reward: number;
  experiment_name?: string;
  variant?: string;
  prompt_key?: string;
  prompt_version?: number;
  context?: Record<string, any>;
}

// ─── Reward Computation ───────────────────────────────────────────────────────
// Each event type has a base reward value. The actual reward is the base
// modulated by quality signals where available.

const BASE_REWARDS: Record<FeedbackEventType, number> = {
  post_created:           0.30,
  post_liked:             0.55,
  post_evaluated:         0.00,  // overridden by composite quality metric
  debate_won:             0.90,
  debate_message_sent:    0.25,
  debate_message_scored:  0.00,  // overridden by logic + persuasion scores
  marketplace_clone:      0.80,
  session_depth:          0.60,
  moderation_block:      -0.80,  // negative reward
  shadow_ban:            -1.00,  // maximum negative
};

export function computeReward(eventType: FeedbackEventType, context: Record<string, any> = {}): number {
  const base = BASE_REWARDS[eventType] ?? 0;

  switch (eventType) {
    case 'post_evaluated': {
      const m = context.metrics || {};
      // Mirrors the promptRegistry composite formula
      return Math.max(0,
        0.30 * (m.persona_match || 0) +
        0.25 * (1 - (m.toxicity || 0)) +
        0.20 * (m.coherence || 0) +
        0.15 * (m.reasoning_quality || 0) +
        0.10 * (m.novelty || 0) -
        0.10 * (m.redundancy || 0)
      );
    }
    case 'debate_message_scored': {
      const logic = context.logic_score || 0;
      const persuasion = context.persuasiveness_score || 0;
      const toxicity = context.toxicity_score || 0;
      return Math.max(0, 0.40 * logic + 0.40 * persuasion - 0.20 * toxicity);
    }
    default:
      return base;
  }
}

// ─── Event Logging ────────────────────────────────────────────────────────────

export async function logFeedbackEvent(event: FeedbackEvent): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO feedback_events
       (user_id, persona_id, event_type, reward, experiment_name, variant, prompt_key, prompt_version, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.user_id,
        event.persona_id || null,
        event.event_type,
        event.reward,
        event.experiment_name || null,
        event.variant || null,
        event.prompt_key || null,
        event.prompt_version || null,
        JSON.stringify(event.context || {}),
      ]
    );
  } catch {
    // Feedback logging is non-critical — never block the main request
  }
}

// ─── Delayed Reward Processor ─────────────────────────────────────────────────
// Runs as a background job (registered in index.ts, polled every 10 min).
// Aggregates unprocessed feedback events and updates bandit + prompt metrics.

export async function processDelayedRewards(): Promise<{ processed: number }> {
  // Fetch events from the last 24h that have an experiment or prompt key attached
  const events = await pool.query(`
    SELECT
      experiment_name, variant, prompt_key, prompt_version,
      AVG(reward) as avg_reward,
      COUNT(*)::int as event_count,
      AVG(CASE WHEN context->>'toxicity' IS NOT NULL THEN (context->>'toxicity')::float END) as avg_toxicity,
      AVG(CASE WHEN context->>'engagement' IS NOT NULL THEN (context->>'engagement')::float END) as avg_engagement
    FROM feedback_events
    WHERE occurred_at > NOW() - INTERVAL '24 hours'
      AND (experiment_name IS NOT NULL OR prompt_key IS NOT NULL)
    GROUP BY experiment_name, variant, prompt_key, prompt_version
  `);

  let processed = 0;

  for (const row of events.rows) {
    const reward = parseFloat(row.avg_reward) || 0;

    // Update bandit reward
    if (row.experiment_name && row.variant) {
      await updateBanditReward(row.experiment_name, row.variant, reward).catch(() => {});
      processed++;
    }

    // Update prompt registry metrics
    if (row.prompt_key && row.prompt_version) {
      const avgToxicity = parseFloat(row.avg_toxicity) || 0;
      const avgEngagement = parseFloat(row.avg_engagement) || 0;
      await updatePromptMetrics(row.prompt_key, row.prompt_version, {
        safety_score: 1 - avgToxicity,
        engagement_rate: avgEngagement,
        sample_count: row.event_count,
        last_updated: new Date().toISOString(),
      }).catch(() => {});
      processed++;
    }
  }

  return { processed };
}

// ─── Session-Level Reward (Temporal Credit Assignment) ───────────────────────
// Called when a user's session closes or after a configurable time window.
// Aggregates all events in the session into a single session-level reward signal.

export async function computeSessionReward(userId: number, since: Date): Promise<number> {
  const res = await pool.query(`
    SELECT
      COUNT(*) as action_count,
      SUM(CASE WHEN event_type = 'post_liked' THEN 1 ELSE 0 END) as likes_received,
      SUM(CASE WHEN event_type = 'debate_won' THEN 1 ELSE 0 END) as debates_won,
      SUM(CASE WHEN event_type IN ('moderation_block', 'shadow_ban') THEN 1 ELSE 0 END) as violations,
      AVG(reward) as avg_base_reward
    FROM feedback_events
    WHERE user_id = $1 AND occurred_at > $2
  `, [userId, since.toISOString()]);

  if (!res.rows[0] || parseInt(res.rows[0].action_count) === 0) return 0;

  const r = res.rows[0];
  const actions = parseInt(r.action_count);
  const likes = parseInt(r.likes_received);
  const wins = parseInt(r.debates_won);
  const violations = parseInt(r.violations);
  const baseReward = parseFloat(r.avg_base_reward) || 0;

  // Depth signal: logarithmic — each additional action has diminishing marginal value
  const depthBonus = Math.min(0.5, Math.log(1 + actions) / 10);
  const qualityBonus = (likes * 0.1 + wins * 0.2) / Math.max(1, actions);
  const violationPenalty = violations * 0.3;

  return Math.min(1, Math.max(0, baseReward + depthBonus + qualityBonus - violationPenalty));
}

// ─── Feedback Stats (for observability endpoint) ──────────────────────────────

export async function getFeedbackStats(): Promise<{
  total_events: number;
  events_last_24h: number;
  avg_reward_last_24h: number;
  event_type_breakdown: Record<string, number>;
  top_experiments: { name: string; events: number; avg_reward: number }[];
}> {
  const [totals, breakdown, experiments] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int as total,
        COUNT(CASE WHEN occurred_at > NOW() - INTERVAL '24 hours' THEN 1 END)::int as last_24h,
        AVG(CASE WHEN occurred_at > NOW() - INTERVAL '24 hours' THEN reward END) as avg_reward_24h
      FROM feedback_events
    `),
    pool.query(`
      SELECT event_type, COUNT(*)::int as count
      FROM feedback_events
      WHERE occurred_at > NOW() - INTERVAL '7 days'
      GROUP BY event_type ORDER BY count DESC
    `),
    pool.query(`
      SELECT experiment_name, COUNT(*)::int as events, AVG(reward) as avg_reward
      FROM feedback_events
      WHERE experiment_name IS NOT NULL AND occurred_at > NOW() - INTERVAL '7 days'
      GROUP BY experiment_name ORDER BY events DESC LIMIT 10
    `),
  ]);

  const t = totals.rows[0];
  return {
    total_events: t.total || 0,
    events_last_24h: t.last_24h || 0,
    avg_reward_last_24h: parseFloat(t.avg_reward_24h) || 0,
    event_type_breakdown: Object.fromEntries(breakdown.rows.map((r: any) => [r.event_type, r.count])),
    top_experiments: experiments.rows.map((r: any) => ({
      name: r.experiment_name,
      events: r.events,
      avg_reward: parseFloat(r.avg_reward) || 0,
    })),
  };
}
