import { Router } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { classifyThinkingStyle, generateNarrativeInsights, computeDriftScore, driftLabel } from '../lib/personaEvolution.js';
import { addJob } from '../lib/jobQueue.js';

const router = Router();

router.get('/', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const personas = await pool.query(
      `SELECT p.*,
        (SELECT COUNT(*)::int FROM posts WHERE persona_id = p.id) as post_count_actual,
        (SELECT COALESCE(SUM(like_count),0)::int FROM posts WHERE persona_id = p.id) as total_likes,
        COALESCE(p.trust_score, 100) as trust_score,
        COALESCE(p.abuse_flags, 0) as abuse_flags,
        COALESCE(p.shadow_banned, false) as shadow_banned,
        p.longitudinal_insight
       FROM personas p WHERE p.user_id = $1`,
      [req.userId]
    );

    if (personas.rows.length === 0) {
      return res.json({ personaCount: 0, totalPosts: 0, totalDebates: 0, topPersona: null, toneBreakdown: [], ideologyBreakdown: [], personaStats: [], dominantStyle: null, diversityScore: 0, narrativeInsights: null });
    }

    const personaIds = personas.rows.map((p: any) => p.id);

    // All queries in parallel
    const [debateStats, activityOverTime, recentPosts, thinkingStyleRows, debateScoreRows, evolutionLogs, cognitiveProfileRows, timeseriesRows, contradictionRows] = await Promise.all([
      pool.query(
        `SELECT persona_a_id as persona_id, COUNT(*)::int as count FROM debates WHERE persona_a_id = ANY($1) GROUP BY persona_a_id
         UNION ALL
         SELECT persona_b_id as persona_id, COUNT(*)::int as count FROM debates WHERE persona_b_id = ANY($1) GROUP BY persona_b_id`,
        [personaIds]
      ),
      pool.query(
        `SELECT DATE_TRUNC('day', created_at)::date as day, COUNT(*)::int as count
         FROM posts WHERE persona_id = ANY($1)
         GROUP BY day ORDER BY day DESC LIMIT 14`,
        [personaIds]
      ),
      pool.query(
        `SELECT p.id, p.content, p.persona_id FROM posts p WHERE p.persona_id = ANY($1) ORDER BY p.created_at DESC LIMIT 30`,
        [personaIds]
      ),
      pool.query(
        `SELECT pts.thinking_style, pts.political_bias, pts.emotional_bias, pts.extremity_score
         FROM post_thinking_styles pts
         JOIN posts p ON pts.post_id = p.id
         WHERE p.persona_id = ANY($1)`,
        [personaIds]
      ),
      pool.query(
        `SELECT AVG(dm.logic_score)::float as avg_logic, AVG(dm.persuasiveness_score)::float as avg_persuasion
         FROM debate_messages dm WHERE dm.persona_id = ANY($1) AND dm.logic_score IS NOT NULL`,
        [personaIds]
      ),
      pool.query(
        `SELECT pel.*, pe.name as persona_name, pe.avatar_emoji
         FROM persona_evolution_log pel
         JOIN personas pe ON pel.persona_id = pe.id
         WHERE pe.user_id = $1
         ORDER BY pel.created_at DESC LIMIT 10`,
        [req.userId]
      ),
      // Cognitive profiles: per-persona averages of cognitive_metrics fields
      pool.query(
        `SELECT
           p.persona_id,
           COUNT(*)::int AS analyzed_count,
           AVG((pts.cognitive_metrics->>'argument_complexity')::numeric) AS avg_complexity,
           AVG((pts.cognitive_metrics->>'openness_score')::numeric) AS avg_openness,
           AVG((pts.cognitive_metrics->>'certainty_score')::numeric) AS avg_certainty,
           AVG((pts.cognitive_metrics->>'emotional_intensity')::numeric) AS avg_emotionality,
           MODE() WITHIN GROUP (ORDER BY pts.thinking_style) AS dominant_style
         FROM posts p
         JOIN post_thinking_styles pts ON pts.post_id = p.id
         WHERE p.persona_id = ANY($1) AND pts.cognitive_metrics IS NOT NULL
         GROUP BY p.persona_id`,
        [personaIds]
      ),
      // Longitudinal timeseries data (last 12 weeks)
      pool.query(
        `SELECT * FROM persona_cognitive_timeseries
         WHERE persona_id = ANY($1)
         ORDER BY persona_id, period_start ASC`,
        [personaIds]
      ),
      // Cross-persona contradictions for this user
      pool.query(
        `SELECT pc.*,
           pa.name AS persona_a_name, pa.avatar_emoji AS persona_a_emoji,
           pb.name AS persona_b_name, pb.avatar_emoji AS persona_b_emoji
         FROM persona_contradictions pc
         JOIN personas pa ON pc.persona_a_id = pa.id
         JOIN personas pb ON pc.persona_b_id = pb.id
         WHERE pc.user_id = $1 AND pc.severity > 0
         ORDER BY pc.severity DESC`,
        [req.userId]
      ),
    ]);

    // Build thinking style distribution
    const thinkingDist: Record<string, number> = { analytical: 0, emotional: 0, persuasive: 0, informative: 0 };
    const biasMap: Record<string, number> = {};
    const emotionMap: Record<string, number> = {};
    let totalExtremity = 0;

    for (const row of thinkingStyleRows.rows) {
      if (row.thinking_style) thinkingDist[row.thinking_style] = (thinkingDist[row.thinking_style] || 0) + 1;
      if (row.political_bias) biasMap[row.political_bias] = (biasMap[row.political_bias] || 0) + 1;
      if (row.emotional_bias) emotionMap[row.emotional_bias] = (emotionMap[row.emotional_bias] || 0) + 1;
      totalExtremity += row.extremity_score || 0;
    }

    const analyzedCount = thinkingStyleRows.rows.length;
    const dominantThinking = Object.entries(thinkingDist).sort((a, b) => b[1] - a[1])[0]?.[0] || 'informative';
    const dominantPolitical = Object.entries(biasMap).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';
    const dominantEmotional = Object.entries(emotionMap).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';
    const avgExtremity = analyzedCount > 0 ? totalExtremity / analyzedCount : 0;

    // Compute thinking style percentages
    const thinkingPercents: Record<string, number> = {};
    if (analyzedCount > 0) {
      for (const [style, count] of Object.entries(thinkingDist)) {
        thinkingPercents[style] = Math.round((count / analyzedCount) * 100);
      }
    }

    // Build per-persona stats with drift info
    let totalPosts = 0;
    let totalDebates = 0;
    let topPersona: any = null;
    let topActivity = -1;
    const toneMap: Record<string, number> = {};
    const ideologyMap: Record<string, number> = {};
    const personaStats: any[] = [];

    for (const p of personas.rows) {
      const postCount = p.post_count_actual || 0;
      const debateCount = debateStats.rows
        .filter((s: any) => s.persona_id === p.id)
        .reduce((acc: number, s: any) => acc + parseInt(s.count), 0);

      totalPosts += postCount;
      totalDebates += debateCount;

      const activity = postCount + debateCount;
      if (activity > topActivity) {
        topActivity = activity;
        topPersona = { ...p, postCount, debateCount, totalLikes: p.total_likes || 0 };
      }

      if (p.tone) toneMap[p.tone] = (toneMap[p.tone] || 0) + postCount + 1;
      if (p.ideology) ideologyMap[p.ideology] = (ideologyMap[p.ideology] || 0) + postCount + 1;

      const avgFormality = parseFloat(p.tone_formality) ?? 0.5;
      const avgEmotionality = parseFloat(p.tone_emotionality) ?? 0.5;
      const avgAssertiveness = parseFloat(p.tone_assertiveness) ?? 0.5;

      // Drift from baseline
      let driftScore = parseFloat(p.drift_score) || 0;
      const baseline = p.baseline_traits && Object.keys(p.baseline_traits).length > 0 ? p.baseline_traits : null;
      if (baseline) {
        driftScore = computeDriftScore(
          { formality: baseline.tone_formality ?? 0.5, emotionality: baseline.tone_emotionality ?? 0.5, assertiveness: baseline.tone_assertiveness ?? 0.5 },
          { formality: avgFormality, emotionality: avgEmotionality, assertiveness: avgAssertiveness }
        );
      }
      const drift = driftLabel(driftScore);

      const traitScores = [
        { label: 'Formal', score: avgFormality },
        { label: 'Passionate', score: avgEmotionality },
        { label: 'Assertive', score: avgAssertiveness },
        { label: 'Analytical', score: 1 - avgEmotionality },
        { label: 'Measured', score: 1 - avgAssertiveness },
      ].sort((a, b) => b.score - a.score);

      personaStats.push({
        id: p.id, name: p.name, avatar_emoji: p.avatar_emoji, archetype: p.archetype,
        status: p.status || 'active',
        postCount, debateCount, totalLikes: p.total_likes || 0,
        consistencyScore: p.consistency_score ?? 100,
        reputationScore: p.reputation_score ?? 100,
        dominantTrait: traitScores[0].label,
        toneFormality: avgFormality, toneEmotionality: avgEmotionality, toneAssertiveness: avgAssertiveness,
        beliefs: Array.isArray(p.beliefs) ? p.beliefs : [],
        version: p.version || 1,
        driftScore, driftLabel: drift.label, driftColor: drift.color,
        evolutionSummary: p.evolution_summary || null,
        lastEvolvedAt: p.last_evolved_at || null,
        trustScore: parseFloat(p.trust_score) || 100,
        abuseFlags: parseInt(p.abuse_flags) || 0,
        shadowBanned: p.shadow_banned || false,
      });
    }

    const toneBreakdown = Object.entries(toneMap).map(([tone, count]) => ({ tone, count })).sort((a, b) => b.count - a.count);
    const ideologyBreakdown = Object.entries(ideologyMap).map(([ideology, count]) => ({ ideology, count })).sort((a, b) => b.count - a.count);
    const uniqueTones = Object.keys(toneMap).length;
    const uniqueIdeologies = Object.keys(ideologyMap).length;
    const diversityScore = Math.min(100, Math.round(((uniqueTones + uniqueIdeologies) / (personas.rows.length * 2)) * 100));

    // Top topics from tags
    const tagsResult = await pool.query(
      `SELECT tag, COUNT(*)::int as count FROM posts, UNNEST(topic_tags) as tag WHERE persona_id = ANY($1) GROUP BY tag ORDER BY count DESC LIMIT 5`,
      [personaIds]
    );
    const topTopics = tagsResult.rows.map((r: any) => r.tag);

    // Generate AI narrative insights if enough data
    let narrativeInsights: string | null = null;
    if (totalPosts >= 2) {
      narrativeInsights = await generateNarrativeInsights({
        personaCount: personas.rows.length,
        thinkingDistribution: thinkingPercents,
        biasProfile: { dominant_political: dominantPolitical, dominant_emotional: dominantEmotional, avg_extremity: avgExtremity },
        topTopics,
        diversityScore,
        dominantPersona: topPersona?.name || 'Unknown',
      });
    }

    // Build timeseries map: personaId → { weeks, insight }
    const longitudinalInsightMap: Record<number, any> = {};
    for (const p of personas.rows) {
      if (p.longitudinal_insight) longitudinalInsightMap[p.id] = p.longitudinal_insight;
    }
    const timeseriesMap: Record<number, { weeks: any[]; insight: any }> = {};
    for (const row of timeseriesRows.rows) {
      if (!timeseriesMap[row.persona_id]) {
        timeseriesMap[row.persona_id] = { weeks: [], insight: longitudinalInsightMap[row.persona_id] || null };
      }
      timeseriesMap[row.persona_id].weeks.push(row);
    }

    // Trigger background thinking-style analysis for unclassified posts
    (async () => {
      try {
        const unclassified = await pool.query(
          `SELECT p.id, p.content FROM posts p
           WHERE p.persona_id = ANY($1)
           AND NOT EXISTS (SELECT 1 FROM post_thinking_styles pts WHERE pts.post_id = p.id)
           ORDER BY p.created_at DESC LIMIT 5`,
          [personaIds]
        );
        for (const post of unclassified.rows) {
          const style = await classifyThinkingStyle(post.content);
          await pool.query(
            `INSERT INTO post_thinking_styles (post_id, thinking_style, confidence, political_bias, emotional_bias, extremity_score)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
            [post.id, style.thinking_style, style.confidence, style.political_bias, style.emotional_bias, style.extremity_score]
          );
        }
      } catch {}
    })();

    // Trigger contradiction detection if stale (> 24h) and user has 2+ personas with claims
    (async () => {
      try {
        if (personaIds.length >= 2) {
          const lastRun = await pool.query(
            'SELECT MAX(updated_at) AS last FROM persona_contradictions WHERE user_id = $1',
            [req.userId]
          );
          const last = lastRun.rows[0]?.last;
          const hoursSince = last ? (Date.now() - new Date(last).getTime()) / 3_600_000 : Infinity;
          if (hoursSince > 24) {
            addJob('detect-contradictions', { userId: req.userId!, personaIds });
          }
        }
      } catch {}
    })();

    const dominantStyle = Object.entries(thinkingDist).sort((a, b) => b[1] - a[1])[0]?.[0] ||
      toneBreakdown[0]?.tone || ideologyBreakdown[0]?.ideology || 'Balanced';

    res.json({
      personaCount: personas.rows.length,
      totalPosts, totalDebates,
      topPersona, toneBreakdown, ideologyBreakdown,
      activityOverTime: activityOverTime.rows,
      dominantStyle, diversityScore,
      personaStats: personaStats.sort((a, b) => (b.postCount + b.debateCount) - (a.postCount + a.debateCount)),
      thinkingDistribution: thinkingPercents,
      biasProfile: { dominantPolitical, dominantEmotional, avgExtremity: Math.round(avgExtremity * 100) },
      debateIntelligence: {
        avgLogic: Math.round((debateScoreRows.rows[0]?.avg_logic || 0) * 100),
        avgPersuasion: Math.round((debateScoreRows.rows[0]?.avg_persuasion || 0) * 100),
      },
      topTopics,
      narrativeInsights,
      evolutionLog: evolutionLogs.rows,
      analyzedPostCount: analyzedCount,
      cognitiveProfiles: cognitiveProfileRows.rows,
      timeseries: timeseriesMap,
      contradictions: contradictionRows.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
