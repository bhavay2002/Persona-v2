import pool from '../db.js';

export function getVariant(userId: number, experimentName: string): 'A' | 'B' {
  const nameHash = experimentName.split('').reduce((sum, c) => sum + c.charCodeAt(0), 0);
  return (userId + nameHash) % 2 === 0 ? 'A' : 'B';
}

export async function recordExperimentEvent(
  experimentName: string,
  userId: number,
  eventType: string,
  metricValue: number,
  entityId?: number
): Promise<void> {
  try {
    const variant = getVariant(userId, experimentName);
    await pool.query(
      `INSERT INTO experiment_results (experiment_name, user_id, variant, event_type, metric_value, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [experimentName, userId, variant, eventType, metricValue, entityId || null]
    );
  } catch {}
}

export async function getExperimentResults(): Promise<any[]> {
  const result = await pool.query(`
    SELECT
      experiment_name,
      variant,
      COUNT(*)::int as events,
      ROUND(AVG(metric_value)::numeric, 3) as avg_metric,
      ROUND(SUM(metric_value)::numeric, 1) as total_metric
    FROM experiment_results
    GROUP BY experiment_name, variant
    ORDER BY experiment_name, variant
  `);

  const experiments: Record<string, any> = {};
  for (const row of result.rows) {
    if (!experiments[row.experiment_name]) experiments[row.experiment_name] = { name: row.experiment_name, A: null, B: null };
    experiments[row.experiment_name][row.variant] = {
      events: row.events,
      avg_metric: parseFloat(row.avg_metric),
      total_metric: parseFloat(row.total_metric),
    };
  }

  return Object.values(experiments).map((exp: any) => {
    const a = exp.A;
    const b = exp.B;
    if (a && b && a.avg_metric > 0) {
      const lift = Math.round(((b.avg_metric - a.avg_metric) / a.avg_metric) * 100);
      exp.lift = lift;
      exp.winner = lift > 0 ? 'B' : lift < 0 ? 'A' : 'tie';
      exp.confidence = Math.min(99, Math.round(Math.abs(lift) * 2.5 + (a.events + b.events) * 0.5));
    }
    return exp;
  });
}

export function getPromptVariantModifier(userId: number): string {
  const toneVariant = getVariant(userId, 'prompt-tone');
  const lengthVariant = getVariant(userId, 'response-length');
  const tone = toneVariant === 'A'
    ? 'Write with high confidence and persuasive assertiveness. Use bold, clear claims.'
    : 'Write analytically and precisely. Use evidence-based, measured language.';
  const length = lengthVariant === 'A'
    ? 'Keep it concise and punchy — 2-3 sentences maximum.'
    : 'Provide depth with specific examples — 3-5 sentences.';
  return `\n\nSTYLE GUIDANCE: ${tone} ${length}`;
}
