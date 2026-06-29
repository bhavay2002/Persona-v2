import { Router } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { computeCDS } from '../lib/cognitiveAnalyzer.js';

const router = Router();

// ─── GET /api/research/cds — CDS for the authenticated user ──────────────────
router.get('/cds', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;

    // Check if a cached score exists
    const cached = await pool.query(
      `SELECT * FROM user_cds_scores WHERE user_id = $1`, [userId]
    );

    // Return cached if <1h old
    if (cached.rows.length && cached.rows[0].computed_at) {
      const age = Date.now() - new Date(cached.rows[0].computed_at).getTime();
      if (age < 60 * 60 * 1000) {
        // Enrich with conflict pairs from persona_contradictions
        const pairsRes = await pool.query(
          `SELECT pc.conflict_score, pc.contradictions,
                  pa.name AS name_a, pb.name AS name_b
           FROM persona_contradictions pc
           JOIN personas pa ON pa.id = pc.persona_a_id
           JOIN personas pb ON pb.id = pc.persona_b_id
           WHERE pc.user_id = $1
           ORDER BY pc.conflict_score DESC`,
          [userId]
        );
        return res.json({
          ...cached.rows[0],
          conflict_pairs: pairsRes.rows.map((r: any) => {
            const top = (r.contradictions || []).sort((a: any, b: any) => (b.severity || 0) - (a.severity || 0))[0];
            return { persona_a: r.name_a, persona_b: r.name_b, score: parseFloat(r.conflict_score), top_contradiction: top?.explanation };
          }),
        });
      }
    }

    // Recompute fresh
    const result = await computeCDS(userId);
    res.json(result);
  } catch (err) {
    console.error('CDS error:', err);
    res.status(500).json({ error: 'CDS computation failed' });
  }
});

// ─── POST /api/research/cds/recompute — force CDS refresh ────────────────────
router.post('/cds/recompute', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const result = await computeCDS(req.userId!);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'CDS recompute failed' });
  }
});

// ─── GET /api/research/insights — population-level statistical insights ───────
router.get('/insights', authenticateToken, async (_req, res) => {
  try {
    const [
      cdsDistRes,
      cdsVsDebateRes,
      cdsVsComplexityRes,
      topInsightRes,
      populationRes,
    ] = await Promise.all([
      // CDS distribution across all users
      pool.query(`
        SELECT
          CASE
            WHEN cds_score < 0.25 THEN 'Low (0-0.25)'
            WHEN cds_score < 0.45 THEN 'Moderate (0.25-0.45)'
            WHEN cds_score < 0.65 THEN 'High (0.45-0.65)'
            ELSE 'Very High (0.65+)'
          END AS bucket,
          COUNT(*)::int AS user_count,
          ROUND(AVG(cds_score)::numeric, 3) AS avg_cds
        FROM user_cds_scores
        GROUP BY bucket
        ORDER BY avg_cds
      `),

      // CDS vs debate win rate (Pearson correlation proxy)
      pool.query(`
        SELECT
          ROUND(u.cds_score::numeric, 1) AS cds_bin,
          COUNT(DISTINCT dv.debate_id)::int AS debates_participated,
          COUNT(CASE WHEN dv.side = d.winner_side THEN 1 END)::int AS debates_won,
          CASE
            WHEN COUNT(DISTINCT dv.debate_id) > 0
            THEN ROUND((COUNT(CASE WHEN dv.side = d.winner_side THEN 1 END)::numeric /
                        COUNT(DISTINCT dv.debate_id)::numeric * 100), 1)
            ELSE 0
          END AS win_rate_pct,
          ROUND(AVG(u.cds_score)::numeric, 3) AS avg_cds
        FROM user_cds_scores u
        JOIN personas p ON p.user_id = u.user_id AND p.status != 'archived'
        JOIN debates d ON (d.persona_a_id = p.id OR d.persona_b_id = p.id)
        LEFT JOIN debate_votes dv ON dv.debate_id = d.id
        WHERE d.winner_side IS NOT NULL
        GROUP BY cds_bin
        HAVING COUNT(DISTINCT dv.debate_id) >= 1
        ORDER BY cds_bin
      `),

      // CDS vs argument complexity correlation
      pool.query(`
        SELECT
          ROUND(u.cds_score::numeric, 1) AS cds_bin,
          ROUND(AVG((pts.cognitive_metrics->>'argument_complexity')::numeric)::numeric, 3) AS avg_complexity,
          ROUND(AVG((pts.cognitive_metrics->>'openness_score')::numeric)::numeric, 3) AS avg_openness,
          COUNT(DISTINCT pts.post_id)::int AS post_count
        FROM user_cds_scores u
        JOIN personas p ON p.user_id = u.user_id
        JOIN posts po ON po.persona_id = p.id
        JOIN post_thinking_styles pts ON pts.post_id = po.id
        WHERE pts.cognitive_metrics IS NOT NULL
        GROUP BY cds_bin
        HAVING COUNT(DISTINCT pts.post_id) >= 2
        ORDER BY cds_bin
      `),

      // Key insight: top finding about CDS-performance correlation
      pool.query(`
        SELECT
          ROUND(AVG(CASE WHEN cds_score >= 0.4 AND cds_score < 0.7 THEN win_rate ELSE NULL END)::numeric, 1) AS mid_cds_win_rate,
          ROUND(AVG(CASE WHEN cds_score < 0.25 THEN win_rate ELSE NULL END)::numeric, 1) AS low_cds_win_rate,
          COUNT(*) AS users_with_data
        FROM (
          SELECT
            u.cds_score,
            CASE
              WHEN COUNT(DISTINCT dv.debate_id) > 0
              THEN COUNT(CASE WHEN dv.side = d.winner_side THEN 1 END)::numeric /
                   COUNT(DISTINCT dv.debate_id)::numeric
              ELSE NULL
            END AS win_rate
          FROM user_cds_scores u
          JOIN personas p ON p.user_id = u.user_id AND p.status != 'archived'
          JOIN debates d ON (d.persona_a_id = p.id OR d.persona_b_id = p.id)
          LEFT JOIN debate_votes dv ON dv.debate_id = d.id
          WHERE d.winner_side IS NOT NULL
          GROUP BY u.user_id, u.cds_score
        ) t
      `),

      // Population overview stats
      pool.query(`
        SELECT
          COUNT(*)::int AS users_with_cds,
          ROUND(AVG(cds_score)::numeric, 3) AS mean_cds,
          ROUND(STDDEV(cds_score)::numeric, 3) AS stddev_cds,
          ROUND(MIN(cds_score)::numeric, 3) AS min_cds,
          ROUND(MAX(cds_score)::numeric, 3) AS max_cds,
          ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cds_score)::numeric, 3) AS median_cds
        FROM user_cds_scores
      `),
    ]);

    // Compute Pearson correlation between cds_bin and avg_complexity
    const cx = cdsVsComplexityRes.rows;
    let pearsonCDSComplexity: number | null = null;
    if (cx.length >= 3) {
      const n = cx.length;
      const xs = cx.map((r: any) => parseFloat(r.cds_bin));
      const ys = cx.map((r: any) => parseFloat(r.avg_complexity));
      const mx = xs.reduce((a: number, b: number) => a + b, 0) / n;
      const my = ys.reduce((a: number, b: number) => a + b, 0) / n;
      const num = xs.reduce((s: number, x: number, i: number) => s + (x - mx) * (ys[i] - my), 0);
      const den = Math.sqrt(
        xs.reduce((s: number, x: number) => s + (x - mx) ** 2, 0) *
        ys.reduce((s: number, y: number) => s + (y - my) ** 2, 0)
      );
      pearsonCDSComplexity = den > 0 ? parseFloat((num / den).toFixed(3)) : null;
    }

    // Generate key findings
    const insight = topInsightRes.rows[0];
    const findings: string[] = [];
    if (insight?.mid_cds_win_rate && insight?.low_cds_win_rate) {
      const diff = parseFloat(insight.mid_cds_win_rate) - parseFloat(insight.low_cds_win_rate);
      if (Math.abs(diff) > 3) {
        findings.push(
          diff > 0
            ? `Users with moderate cognitive dissonance (0.4-0.7) achieve ${diff.toFixed(0)}% higher debate win rates than low-dissonance users, suggesting perspective-taking improves argument quality.`
            : `Users with low cognitive dissonance achieve ${Math.abs(diff).toFixed(0)}% higher debate win rates, suggesting ideological consistency correlates with stronger argumentation.`
        );
      }
    }
    if (pearsonCDSComplexity !== null && Math.abs(pearsonCDSComplexity) > 0.3) {
      findings.push(
        pearsonCDSComplexity > 0
          ? `Positive correlation (r=${pearsonCDSComplexity}) found between cognitive dissonance and argument complexity — more internally contradictory users produce more nuanced reasoning.`
          : `Negative correlation (r=${pearsonCDSComplexity}) found between cognitive dissonance and argument complexity — internally consistent users tend toward more complex reasoning.`
      );
    }
    if (findings.length === 0) {
      findings.push('Insufficient data for statistically significant findings. More user activity is needed to generate research insights.');
    }

    res.json({
      population: populationRes.rows[0],
      cds_distribution: cdsDistRes.rows,
      cds_vs_debate_performance: cdsVsDebateRes.rows,
      cds_vs_complexity: cdsVsComplexityRes.rows,
      correlations: {
        cds_vs_argument_complexity: pearsonCDSComplexity,
      },
      key_findings: findings,
    });
  } catch (err) {
    console.error('Research insights error:', err);
    res.status(500).json({ error: 'Failed to compute research insights' });
  }
});

// ─── GET /api/research/export — CSV data export ───────────────────────────────
router.get('/export', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const rows = await pool.query(
      `SELECT
         po.id AS post_id,
         p.name AS persona_name,
         p.archetype,
         p.ideology,
         pts.thinking_style,
         pts.cognitive_metrics->>'argument_complexity' AS argument_complexity,
         pts.cognitive_metrics->>'openness_score' AS openness_score,
         pts.cognitive_metrics->>'certainty_score' AS certainty_score,
         pts.cognitive_metrics->>'emotional_intensity' AS emotional_intensity,
         po.like_count,
         po.created_at
       FROM posts po
       JOIN personas p ON p.id = po.persona_id
       LEFT JOIN post_thinking_styles pts ON pts.post_id = po.id
       WHERE p.user_id = $1
       ORDER BY po.created_at DESC
       LIMIT 1000`,
      [userId]
    );

    const headers = Object.keys(rows.rows[0] || {});
    const csv = [
      headers.join(','),
      ...rows.rows.map((r: any) =>
        headers.map(h => {
          const v = r[h];
          if (v === null || v === undefined) return '';
          const s = String(v);
          return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(',')
      ),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="persona-research-data.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

export default router;
