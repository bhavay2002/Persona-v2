import pool from '../db.js';
import { createNotification } from './notifier.js';

export interface BehaviorReport {
  personaId: number;
  toxicity_avg: number;
  posting_frequency: number;
  repetition_score: number;
  extremity_score: number;
  abuse_flags: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  action_taken: string;
}

export async function analyzeBehavior(personaId: number): Promise<BehaviorReport> {
  const [personaRes, recentPosts, allMetrics] = await Promise.all([
    pool.query('SELECT * FROM personas WHERE id = $1', [personaId]),
    pool.query(
      `SELECT content, created_at FROM posts WHERE persona_id = $1
       AND created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC`,
      [personaId]
    ),
    pool.query(
      `SELECT ai_metrics FROM posts WHERE persona_id = $1
       AND ai_metrics IS NOT NULL ORDER BY created_at DESC LIMIT 20`,
      [personaId]
    ),
  ]);

  if (!personaRes.rows.length) throw new Error('Persona not found');
  const p = personaRes.rows[0];

  // Posting frequency (posts in last 24h)
  const posting_frequency = recentPosts.rows.length;

  // Toxicity average from AI evaluation metrics
  let toxicity_avg = 0;
  if (allMetrics.rows.length > 0) {
    const vals = allMetrics.rows
      .map((r: any) => parseFloat(r.ai_metrics?.toxicity ?? 0))
      .filter((v: number) => v > 0);
    if (vals.length > 0) toxicity_avg = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
  }

  // Repetition score — bag-of-words overlap between consecutive posts
  let repetition_score = 0;
  if (recentPosts.rows.length >= 3) {
    const contents = recentPosts.rows.map((r: any) =>
      new Set(r.content.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4))
    );
    let totalOverlap = 0;
    let pairs = 0;
    for (let i = 0; i < Math.min(contents.length - 1, 5); i++) {
      const a = contents[i];
      const b = contents[i + 1];
      const intersection = [...a].filter(w => b.has(w)).length;
      const union = new Set([...a, ...b]).size;
      if (union > 0) { totalOverlap += intersection / union; pairs++; }
    }
    repetition_score = pairs > 0 ? totalOverlap / pairs : 0;
  }

  // Extremity score from existing drift tracking
  const extremity_score = Math.min(1, (parseFloat(p.drift_score) || 0) / 100);
  const abuse_flags = parseInt(p.abuse_flags) || 0;

  // Rule-based risk classification
  let risk_level: BehaviorReport['risk_level'] = 'low';

  if (posting_frequency > 50) {
    risk_level = 'critical';
  } else if (toxicity_avg > 0.6 && repetition_score > 0.65 && extremity_score > 0.7) {
    risk_level = 'critical';
  } else if (toxicity_avg > 0.5 && (repetition_score > 0.55 || posting_frequency > 25)) {
    risk_level = 'high';
  } else if (toxicity_avg > 0.35 || posting_frequency > 15 || abuse_flags >= 3) {
    risk_level = 'medium';
  }

  const report: BehaviorReport = {
    personaId,
    toxicity_avg,
    posting_frequency,
    repetition_score,
    extremity_score,
    abuse_flags,
    risk_level,
    action_taken: 'none',
  };

  await applyAbuseAction(personaId, p.user_id, risk_level, report);
  report.action_taken = getActionLabel(risk_level);
  return report;
}

function getActionLabel(level: string): string {
  if (level === 'critical') return 'shadow_ban';
  if (level === 'high') return 'reduce_reach';
  if (level === 'medium') return 'warn';
  return 'none';
}

async function applyAbuseAction(
  personaId: number,
  userId: number,
  level: BehaviorReport['risk_level'],
  report: BehaviorReport
): Promise<void> {
  const meta = JSON.stringify({
    toxicity_avg: report.toxicity_avg,
    posting_frequency: report.posting_frequency,
    repetition_score: report.repetition_score,
  });

  if (level === 'critical') {
    await pool.query(
      'UPDATE personas SET shadow_banned = true, abuse_flags = abuse_flags + 1, trust_score = GREATEST(0, trust_score - 30) WHERE id = $1',
      [personaId]
    );
    await logModerationAction('persona', personaId, 'shadow_ban', 'Auto shadow-banned: critical risk score', meta);
    await createNotification(userId, 'milestone', 'Persona Restricted',
      'This persona has been restricted due to detected abusive behavior patterns.', 'persona', personaId);

  } else if (level === 'high') {
    await pool.query(
      'UPDATE personas SET abuse_flags = abuse_flags + 1, trust_score = GREATEST(0, trust_score - 15) WHERE id = $1',
      [personaId]
    );
    await logModerationAction('persona', personaId, 'reduce_reach', 'Reach reduced: high risk score', meta);
    await createNotification(userId, 'milestone', 'Persona Warning',
      'This persona has received a warning. Reach has been temporarily reduced.', 'persona', personaId);

  } else if (level === 'medium') {
    await pool.query(
      'UPDATE personas SET trust_score = GREATEST(0, trust_score - 5) WHERE id = $1',
      [personaId]
    );
    await logModerationAction('persona', personaId, 'warn', 'Soft warning: medium risk score', meta);
  }
}

export async function logModerationAction(
  entityType: string,
  entityId: number,
  action: string,
  reason: string,
  metadata = '{}'
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO moderation_log (entity_type, entity_id, action, reason, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [entityType, entityId, action, reason, metadata]
    );
  } catch { /* non-critical */ }
}
