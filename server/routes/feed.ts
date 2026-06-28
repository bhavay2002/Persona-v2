import { Router } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import { getCachedFeed, setCachedFeed } from '../lib/cache.js';
import { metricsRankingBonus } from '../lib/evaluation.js';
import { trustFeedBoost } from '../lib/trustEngine.js';
import {
  getUserProfile,
  buildUserTopicVector,
  computeSemanticSimilarity,
  personalizePostScore,
  applyExplorationSplit,
  getMatchReason,
} from '../lib/personalizationEngine.js';
import { JWT_SECRET } from '../config.js';

const router = Router();

function recencyDecay(createdAt: Date): number {
  const ageHours = (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
  return Math.exp(-0.05 * ageHours);
}

function rankPost(post: any): number {
  const engagement = Math.min(1, ((post.like_count || 0) * 2 + (post.comment_count || 0)) / 20);
  const recency = recencyDecay(post.created_at);
  const aiBonus = post.ai_generated ? 0.08 : 0;
  const metricsBonus = metricsRankingBonus(post.ai_metrics || null);
  const trust = trustFeedBoost(post.trust_score ?? 100);
  const jitter = Math.random() * 0.05;
  return ((0.30 * engagement) + (0.15 * recency) + (0.08 * aiBonus) + metricsBonus + jitter) * trust;
}

function rankDebate(debate: any): number {
  const totalVotes = (debate.votes_a || 0) + (debate.votes_b || 0);
  const messages = parseInt(debate.message_count || 0);
  const engagement = Math.min(1, (totalVotes + messages * 1.5) / 25);
  const recency = recencyDecay(debate.created_at);
  const isLive = debate.status === 'active' ? 0.3 : 0;
  const quality = (debate.quality_score || 0) / 100;
  const trustScore = ((debate.trust_score_a || 100) + (debate.trust_score_b || 100)) / 2;
  const trust = trustFeedBoost(trustScore);
  const jitter = Math.random() * 0.05;
  return ((0.30 * engagement) + (0.20 * isLive) + (0.15 * recency) + (0.10 * quality) + jitter) * trust;
}

// Optional auth — attaches userId if valid token present, never blocks
function optionalAuth(req: any, _res: any, next: any) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
      req.userId = decoded.userId;
    }
  } catch {}
  next();
}

const BASE_QUERY = `
  SELECT p.*, pe.name as persona_name, pe.avatar_emoji, pe.tone, pe.ideology,
    pe.archetype, pe.tone_formality, pe.tone_emotionality, pe.tone_assertiveness,
    pe.rhetorical_style, pe.trust_score,
    'post' as item_type
  FROM posts p
  JOIN personas pe ON p.persona_id = pe.id
  WHERE pe.shadow_banned = false AND COALESCE(p.shadow_banned, false) = false
  ORDER BY p.created_at DESC
  LIMIT $1
`;

const DEBATES_QUERY = `
  SELECT d.id, d.topic, d.description, d.status, d.votes_a, d.votes_b, d.created_at,
    d.stance_a, d.stance_b, d.quality_score, d.trust_score,
    pa.name as persona_a_name, pa.avatar_emoji as persona_a_emoji,
    pa.archetype as persona_a_archetype, pa.trust_score as trust_score_a,
    pb.name as persona_b_name, pb.avatar_emoji as persona_b_emoji,
    pb.archetype as persona_b_archetype, pb.trust_score as trust_score_b,
    (SELECT COUNT(*) FROM debate_messages dm WHERE dm.debate_id = d.id)::int as message_count,
    'debate' as item_type
  FROM debates d
  JOIN personas pa ON d.persona_a_id = pa.id
  LEFT JOIN personas pb ON d.persona_b_id = pb.id
  WHERE pa.shadow_banned = false
  ORDER BY d.created_at DESC
  LIMIT $1
`;

const STATS_QUERY = `
  SELECT
    (SELECT COUNT(*)::int FROM posts) as total_posts,
    (SELECT COUNT(*)::int FROM debates) as total_debates,
    (SELECT COUNT(*)::int FROM personas WHERE status = 'active') as total_personas,
    (SELECT COUNT(*)::int FROM users) as total_users
`;

const TAGS_QUERY = `
  SELECT tag, COUNT(*) as count
  FROM posts, UNNEST(topic_tags) as tag
  GROUP BY tag ORDER BY count DESC LIMIT 12
`;

router.get('/', optionalAuth, async (req: any, res) => {
  const { type = 'trending', tag, limit = 20 } = req.query;

  // ── For-You feed (personalized, auth required) ──────────────────────────────
  if (type === 'for-you') {
    if (!req.userId) {
      return res.status(401).json({ error: 'Sign in to access your personalized feed' });
    }

    try {
      const [postsResult, debatesResult, statsResult, tagsResult, profile] = await Promise.all([
        pool.query(BASE_QUERY, [Math.ceil(Number(limit) * 2)]), // fetch 2x to have diversity pool
        pool.query(DEBATES_QUERY, [Math.ceil(Number(limit) / 2)]),
        pool.query(STATS_QUERY),
        pool.query(TAGS_QUERY),
        getUserProfile(req.userId),
      ]);

      const userVector = buildUserTopicVector(profile);
      const seenTopics = new Set<string>();

      // Score every post with the 5-component personalized formula
      const scoredPosts = postsResult.rows.map(post => {
        const recency = recencyDecay(post.created_at);
        const score = personalizePostScore(0, post, profile, seenTopics, userVector, recency);
        const postTopics = (post.topic_tags || []).map((t: string) => t.toLowerCase());
        const semanticSim = computeSemanticSimilarity(userVector, postTopics);
        for (const t of postTopics) seenTopics.add(t);
        return { ...post, _personalized_score: score, _semantic_sim: semanticSim };
      });

      // Apply 80/20 exploration/exploitation split
      const split = applyExplorationSplit(scoredPosts, 0.20);

      // Trim to requested limit and attach match reasons
      const finalPosts = split.slice(0, Number(limit)).map(({ post, isExploration }) => {
        const matchReason = getMatchReason(post, profile, post._semantic_sim ?? 0, isExploration);
        return { ...post, _match_reason: matchReason, _is_exploration: isExploration };
      });

      // Rank debates normally (personalization mainly affects posts)
      const debates = debatesResult.rows
        .map(d => ({ ...d, _rank: rankDebate(d) }))
        .sort((a, b) => b._rank - a._rank);

      return res.json({
        posts: finalPosts,
        debates,
        stats: statsResult.rows[0],
        trendingTags: tagsResult.rows,
        _personalized: true,
        _cold_start: profile.total_interactions < 3,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  // ── Trending / Latest feed ──────────────────────────────────────────────────
  const cacheKey = `feed:${type}:${tag || 'all'}:${limit}`;

  if (type === 'trending') {
    const cached = getCachedFeed(cacheKey);
    if (cached) return res.json({ ...cached, _cached: true });
  }

  try {
    const postParams: any[] = [limit];
    const postConditions: string[] = ['pe.shadow_banned = false', 'COALESCE(p.shadow_banned, false) = false'];

    if (tag) {
      postParams.push(tag);
      postConditions.push(`$${postParams.length} = ANY(p.topic_tags)`);
    }

    const postWhere = `WHERE ${postConditions.join(' AND ')}`;

    const postsQuery = `
      SELECT p.*, pe.name as persona_name, pe.avatar_emoji, pe.tone, pe.ideology,
        pe.archetype, pe.tone_formality, pe.tone_emotionality, pe.tone_assertiveness,
        pe.rhetorical_style, pe.trust_score,
        'post' as item_type
      FROM posts p
      JOIN personas pe ON p.persona_id = pe.id
      ${postWhere}
      ORDER BY p.created_at DESC
      LIMIT $1
    `;

    const [postsResult, debatesResult, statsResult, tagsResult] = await Promise.all([
      pool.query(postsQuery, postParams),
      pool.query(DEBATES_QUERY, [Math.ceil(Number(limit) / 2)]),
      pool.query(STATS_QUERY),
      pool.query(TAGS_QUERY),
    ]);

    let posts = postsResult.rows;
    let debates = debatesResult.rows;

    if (type === 'trending') {
      posts = posts.map(p => ({ ...p, _rank: rankPost(p) })).sort((a, b) => b._rank - a._rank);
      debates = debates.map(d => ({ ...d, _rank: rankDebate(d) })).sort((a, b) => b._rank - a._rank);
    }

    const payload = { posts, debates, stats: statsResult.rows[0], trendingTags: tagsResult.rows };

    if (type === 'trending') setCachedFeed(cacheKey, payload);

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
