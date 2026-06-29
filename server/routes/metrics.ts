import { Router } from 'express';
import pool from '../db.js';
import { getExperimentResults } from '../lib/experimentEngine.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const [platformRes, topPersonasRes, archetypeRes, weeklyActivityRes, weeklyDebatesRes, topTopicsRes, qualityDistRes, debateWinnersRes] = await Promise.all([
      pool.query(`SELECT
        (SELECT COUNT(*)::int FROM users) as user_count,
        (SELECT COUNT(*)::int FROM personas WHERE status != 'archived') as persona_count,
        (SELECT COUNT(*)::int FROM posts WHERE NOT COALESCE(shadow_banned, false)) as post_count,
        (SELECT COUNT(*)::int FROM debates) as debate_count,
        (SELECT COALESCE(SUM(like_count),0)::int FROM posts WHERE NOT COALESCE(shadow_banned,false)) as total_likes,
        (SELECT COUNT(*)::int FROM debates WHERE COALESCE(is_ai_generated,false) = true) as ai_debate_count,
        (SELECT COUNT(*)::int FROM persona_marketplace) as marketplace_count`),
      pool.query(`SELECT
          p.id, p.name, p.avatar_emoji, p.archetype, p.ideology,
          p.clone_count,
          COALESCE(p.trust_score, 100) as trust_score,
          (SELECT COUNT(*)::int FROM posts WHERE persona_id = p.id) as post_count,
          (SELECT COALESCE(SUM(like_count), 0)::int FROM posts WHERE persona_id = p.id) as total_likes,
          (SELECT COUNT(*)::int FROM debates WHERE persona_a_id = p.id OR persona_b_id = p.id) as debate_count,
          (
            COALESCE(p.trust_score, 100) * 0.3 +
            COALESCE((SELECT SUM(like_count) FROM posts WHERE persona_id = p.id), 0) * 0.4 +
            COALESCE((SELECT COUNT(*) FROM debates WHERE persona_a_id = p.id OR persona_b_id = p.id), 0) * 15 +
            COALESCE(p.clone_count, 0) * 5
          ) as composite_score
        FROM personas p
        WHERE p.status != 'archived'
        ORDER BY composite_score DESC LIMIT 10`),
      pool.query(`SELECT
          COALESCE(p.archetype, 'independent') as archetype,
          COUNT(DISTINCT p.id)::int as persona_count,
          ROUND(AVG(COALESCE(p.trust_score, 100))::numeric, 1) as avg_trust,
          COALESCE(SUM((SELECT COUNT(*) FROM posts WHERE persona_id = p.id)), 0)::int as total_posts,
          COALESCE(SUM((SELECT SUM(like_count) FROM posts WHERE persona_id = p.id)), 0)::int as total_likes,
          COALESCE(SUM(p.debate_count), 0)::int as total_debates
        FROM personas p WHERE p.status != 'archived'
        GROUP BY p.archetype ORDER BY total_likes DESC LIMIT 8`),
      pool.query(`SELECT DATE_TRUNC('day', created_at)::date as day, COUNT(*)::int as posts, COALESCE(SUM(like_count), 0)::int as likes
        FROM posts WHERE created_at > NOW() - INTERVAL '14 days'
        GROUP BY day ORDER BY day ASC`),
      pool.query(`SELECT DATE_TRUNC('day', created_at)::date as day, COUNT(*)::int as debates
        FROM debates WHERE created_at > NOW() - INTERVAL '14 days'
        GROUP BY day ORDER BY day ASC`),
      pool.query(`SELECT UNNEST(topic_tags) as tag, COUNT(*)::int as count
        FROM posts
        WHERE topic_tags IS NOT NULL AND array_length(topic_tags, 1) > 0
          AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY tag ORDER BY count DESC LIMIT 15`),
      pool.query(`SELECT
          CASE
            WHEN like_count = 0 THEN '0 likes'
            WHEN like_count BETWEEN 1 AND 5 THEN '1–5'
            WHEN like_count BETWEEN 6 AND 20 THEN '6–20'
            WHEN like_count BETWEEN 21 AND 50 THEN '21–50'
            ELSE '50+'
          END as bucket,
          COUNT(*)::int as count
        FROM posts WHERE NOT COALESCE(shadow_banned, false)
        GROUP BY bucket ORDER BY MIN(like_count) ASC`),
      pool.query(`SELECT
          p.archetype,
          SUM(CASE WHEN d.votes_a > d.votes_b AND d.persona_a_id = p.id THEN 1
                   WHEN d.votes_b > d.votes_a AND d.persona_b_id = p.id THEN 1
                   ELSE 0 END)::int as wins,
          COUNT(d.id)::int as total_debates
        FROM personas p
        JOIN debates d ON (d.persona_a_id = p.id OR d.persona_b_id = p.id)
        WHERE d.votes_a + d.votes_b > 0
        GROUP BY p.archetype HAVING COUNT(d.id) > 0`),
    ]);

    const experiments = await getExperimentResults();
    const dayMap: Record<string, any> = {};
    for (const row of weeklyActivityRes.rows) dayMap[row.day] = { day: row.day, posts: row.posts, likes: row.likes, debates: 0 };
    for (const row of weeklyDebatesRes.rows) {
      if (dayMap[row.day]) dayMap[row.day].debates = row.debates;
      else dayMap[row.day] = { day: row.day, posts: 0, likes: 0, debates: row.debates };
    }

    const weeklyActivity = Object.values(dayMap).sort((a: any, b: any) => new Date(a.day).getTime() - new Date(b.day).getTime());
    const winRates = debateWinnersRes.rows.map((r: any) => ({ archetype: r.archetype || 'independent', wins: r.wins, total: r.total_debates, win_rate: r.total_debates > 0 ? Math.round((r.wins / r.total_debates) * 100) : 0 })).sort((a: any, b: any) => b.win_rate - a.win_rate);

    res.json({ platform: platformRes.rows[0], topPersonas: topPersonasRes.rows, archetypeStats: archetypeRes.rows, weeklyActivity, topTopics: topTopicsRes.rows, qualityDist: qualityDistRes.rows, winRates, experiments });
  } catch (err) {
    console.error('Metrics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
