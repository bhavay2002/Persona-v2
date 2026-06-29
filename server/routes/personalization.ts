import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import {
  getUserProfile, updateUserProfile, extractBehavioralFeatures,
  personalizePostScore, getAdaptiveDifficulty, buildPersonalizationContext,
  getPersonalizationInsights, DEFAULT_PROFILE,
} from '../lib/personalizationEngine.js';
import { getCachedFeed, setCachedFeed } from '../lib/cache.js';
import { trustFeedBoost } from '../lib/trustEngine.js';
import { metricsRankingBonus } from '../lib/evaluation.js';
import pool from '../db.js';

const router = Router();

function basePostScore(p: any): number {
  const engagement = Math.min(1, ((p.like_count || 0) * 2) / 20);
  const ageHours = (Date.now() - new Date(p.created_at).getTime()) / 3_600_000;
  const recency = Math.exp(-0.05 * ageHours);
  const metrics = metricsRankingBonus(p.ai_metrics || null);
  const trust = trustFeedBoost(p.trust_score ?? 100);
  return ((0.30 * engagement) + (0.15 * recency) + metrics) * trust;
}

// ─── User Profile ─────────────────────────────────────────────────────────────

router.get('/profile', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const profile = await getUserProfile(req.userId!);
    const difficulty = getAdaptiveDifficulty(profile);
    res.json({ profile, difficulty, prompt_context: buildPersonalizationContext(profile) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/profile', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const { challenge_mode, openness_score, skill_level } = req.body;
    const updates: any = {};
    if (typeof challenge_mode === 'boolean') updates.challenge_mode = challenge_mode;
    if (typeof openness_score === 'number') updates.openness_score = Math.max(0, Math.min(1, openness_score));
    if (typeof skill_level === 'number') updates.skill_level = Math.max(0, Math.min(1, skill_level));

    const profile = await updateUserProfile(req.userId!, updates);
    res.json({ profile, difficulty: getAdaptiveDifficulty(profile) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/profile/reset', authenticateToken, async (req: AuthRequest, res) => {
  try {
    await pool.query('DELETE FROM user_behavior_profiles WHERE user_id = $1', [req.userId!]);
    res.json({ profile: DEFAULT_PROFILE, message: 'Profile reset to defaults' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Personalized Feed ────────────────────────────────────────────────────────

router.get('/feed', authenticateToken, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const { limit = '20', tag } = req.query as Record<string, string>;
  const cacheKey = `pfeed:${userId}:${tag || 'all'}:${limit}`;

  const cached = getCachedFeed(cacheKey);
  if (cached) return res.json({ ...cached, _cached: true });

  try {
    const profile = await getUserProfile(userId);

    const postParams: any[] = [Math.min(parseInt(limit) * 2, 100)];
    const conditions = ['pe.shadow_banned = false', 'COALESCE(p.shadow_banned, false) = false'];
    if (tag) { postParams.push(tag); conditions.push(`$${postParams.length} = ANY(p.topic_tags)`); }

    const [postsRes, debatesRes] = await Promise.all([
      pool.query(`
        SELECT p.*, pe.name as persona_name, pe.avatar_emoji, pe.tone, pe.ideology,
          pe.archetype, pe.tone_formality, pe.tone_emotionality, pe.tone_assertiveness,
          pe.rhetorical_style, pe.trust_score, 'post' as item_type
        FROM posts p
        JOIN personas pe ON p.persona_id = pe.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.created_at DESC LIMIT $1
      `, postParams),
      pool.query(`
        SELECT d.id, d.topic, d.status, d.votes_a, d.votes_b, d.created_at,
          d.stance_a, d.stance_b, d.quality_score,
          pa.name as persona_a_name, pa.avatar_emoji as persona_a_emoji,
          pa.trust_score as trust_score_a, pb.name as persona_b_name,
          pb.avatar_emoji as persona_b_emoji, pb.trust_score as trust_score_b,
          (SELECT COUNT(*) FROM debate_messages dm WHERE dm.debate_id = d.id)::int as message_count,
          'debate' as item_type
        FROM debates d
        JOIN personas pa ON d.persona_a_id = pa.id
        LEFT JOIN personas pb ON d.persona_b_id = pb.id
        WHERE pa.shadow_banned = false
        ORDER BY d.created_at DESC LIMIT $1
      `, [Math.ceil(parseInt(limit) / 2)]),
    ]);

    const seenTopics = new Set<string>();
    const posts = postsRes.rows
      .map(p => {
        const base = basePostScore(p);
        const score = personalizePostScore(base, p, profile, seenTopics);
        (p.topic_tags || []).forEach((t: string) => seenTopics.add(t.toLowerCase()));
        return { ...p, _rank: score };
      })
      .sort((a, b) => b._rank - a._rank)
      .slice(0, parseInt(limit));

    const payload = {
      posts,
      debates: debatesRes.rows,
      profile_summary: {
        skill_level: profile.skill_level,
        difficulty: getAdaptiveDifficulty(profile),
        challenge_mode: profile.challenge_mode,
        top_topics: Object.entries(profile.topic_affinities)
          .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t),
        total_interactions: profile.total_interactions,
      },
    };

    setCachedFeed(cacheKey, payload);
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Difficulty ───────────────────────────────────────────────────────────────

router.get('/difficulty', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const profile = await getUserProfile(req.userId!);
    const difficulty = getAdaptiveDifficulty(profile);
    res.json({
      difficulty,
      skill_level: profile.skill_level,
      description:
        difficulty === 'easy' ? 'Accessible arguments with clear openings for rebuttal'
        : difficulty === 'hard' ? 'Maximum sophistication — multi-step chains, minimal openings'
        : 'Structured arguments with moderate complexity',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Extract Features (manual trigger) ────────────────────────────────────────

router.post('/analyze-text', authenticateToken, async (req: AuthRequest, res) => {
  const { text } = req.body;
  if (!text || text.length < 20) return res.status(400).json({ error: 'text must be >= 20 chars' });
  try {
    const features = await extractBehavioralFeatures(text);
    res.json({ features });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Personalization Insights ─────────────────────────────────────────────────

router.get('/insights', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const profile = await getUserProfile(req.userId!);
    res.json(getPersonalizationInsights(profile));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Prompt Context ───────────────────────────────────────────────────────────

router.get('/context', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const profile = await getUserProfile(req.userId!);
    res.json({
      prompt_context: buildPersonalizationContext(profile),
      difficulty: getAdaptiveDifficulty(profile),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
