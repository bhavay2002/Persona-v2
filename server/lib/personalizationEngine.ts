// Personalization Engine — Behavioral Intelligence System
//
// Maintains a per-user behavioral profile that evolves across all interactions.
// Used for: adaptive feed ranking, AI prompt injection, opponent difficulty, challenge mode.
//
// Profile updates use EMA (Exponential Moving Average) with α=0.20 so old observations
// decay slowly — the system remembers the full history without storing raw events.
//
// Feed ranking uses a 5-component weighted formula:
//   0.35 * semantic_similarity  (topic interest vector cosine similarity)
//   0.20 * topic_match          (raw affinity average for post topics)
//   0.15 * diversity_boost      (inverse repeat-topic penalty)
//   0.15 * engagement_pred      (match user content-length preference)
//   0.15 * recency              (exponential decay by post age)

import { getModel } from './gemini.js';
import pool from '../db.js';


const α = 0.20;
function ema(old: number, next: number): number { return α * next + (1 - α) * old; }
function clamp(v: number, lo = 0, hi = 1): number { return Math.max(lo, Math.min(hi, v)); }

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DebateStyle {
  analytical: number;
  emotional: number;
  persuasive: number;
}

export interface UserBehaviorProfile {
  debate_style: DebateStyle;
  bias_profile: Record<string, string>;
  topic_affinities: Record<string, number>;
  engagement_pattern: {
    avg_post_length: number;
    interaction_type: 'debate_heavy' | 'post_heavy' | 'mixed';
    sessions: number;
  };
  skill_level: number;
  openness_score: number;
  challenge_mode: boolean;
  total_interactions: number;
  last_updated: string;
}

export const DEFAULT_PROFILE: UserBehaviorProfile = {
  debate_style: { analytical: 0.50, emotional: 0.50, persuasive: 0.50 },
  bias_profile: {},
  topic_affinities: {},
  engagement_pattern: { avg_post_length: 120, interaction_type: 'mixed', sessions: 0 },
  skill_level: 0.50,
  openness_score: 0.50,
  challenge_mode: false,
  total_interactions: 0,
  last_updated: new Date().toISOString(),
};

// ─── Profile CRUD ─────────────────────────────────────────────────────────────

export async function getUserProfile(userId: number): Promise<UserBehaviorProfile> {
  try {
    const res = await pool.query(
      'SELECT profile FROM user_behavior_profiles WHERE user_id = $1',
      [userId]
    );
    if (!res.rows.length) return { ...DEFAULT_PROFILE };
    return { ...DEFAULT_PROFILE, ...res.rows[0].profile };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

export async function saveUserProfile(userId: number, profile: UserBehaviorProfile): Promise<void> {
  await pool.query(
    `INSERT INTO user_behavior_profiles (user_id, profile, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET profile = $2, updated_at = NOW()`,
    [userId, JSON.stringify(profile)]
  );
}

export async function updateUserProfile(
  userId: number,
  updates: Partial<UserBehaviorProfile>
): Promise<UserBehaviorProfile> {
  const current = await getUserProfile(userId);
  const merged = mergeProfiles(current, updates);
  merged.total_interactions = (current.total_interactions || 0) + 1;
  merged.last_updated = new Date().toISOString();
  await saveUserProfile(userId, merged);
  return merged;
}

// EMA merge — numeric fields decay, categorical fields overwrite
function mergeProfiles(
  current: UserBehaviorProfile,
  updates: Partial<UserBehaviorProfile>
): UserBehaviorProfile {
  const merged: UserBehaviorProfile = JSON.parse(JSON.stringify(current));

  if (updates.debate_style) {
    merged.debate_style = {
      analytical: clamp(ema(current.debate_style.analytical, updates.debate_style.analytical)),
      emotional:  clamp(ema(current.debate_style.emotional,  updates.debate_style.emotional)),
      persuasive: clamp(ema(current.debate_style.persuasive, updates.debate_style.persuasive)),
    };
  }

  if (updates.topic_affinities) {
    for (const [topic, score] of Object.entries(updates.topic_affinities)) {
      const key = topic.toLowerCase().trim();
      merged.topic_affinities[key] = clamp(ema(current.topic_affinities[key] ?? 0.3, score));
    }
    // Decay topics not seen recently (keep map bounded)
    for (const key of Object.keys(merged.topic_affinities)) {
      if (!(key in (updates.topic_affinities || {}))) {
        merged.topic_affinities[key] = clamp(ema(merged.topic_affinities[key], 0.2));
        if (merged.topic_affinities[key] < 0.05) delete merged.topic_affinities[key];
      }
    }
  }

  if (updates.bias_profile) {
    merged.bias_profile = { ...current.bias_profile, ...updates.bias_profile };
  }

  if (typeof updates.skill_level === 'number') {
    merged.skill_level = clamp(ema(current.skill_level, updates.skill_level));
  }

  if (typeof updates.openness_score === 'number') {
    merged.openness_score = clamp(ema(current.openness_score, updates.openness_score));
  }

  if (typeof updates.challenge_mode === 'boolean') {
    merged.challenge_mode = updates.challenge_mode;
  }

  if (updates.engagement_pattern) {
    merged.engagement_pattern = {
      avg_post_length: Math.round(
        ema(current.engagement_pattern.avg_post_length, updates.engagement_pattern.avg_post_length)
      ),
      interaction_type: updates.engagement_pattern.interaction_type || current.engagement_pattern.interaction_type,
      sessions: current.engagement_pattern.sessions + 1,
    };
  }

  return merged;
}

// ─── Feature Extraction (LLM) ────────────────────────────────────────────────

export async function extractBehavioralFeatures(
  text: string
): Promise<Partial<UserBehaviorProfile>> {
  if (!text || text.trim().length < 20) return {};

  try {
    const model = getModel();
    const prompt = `Analyze this message and infer the author's behavioral profile signals.

MESSAGE: "${text.slice(0, 800)}"

Return ONLY valid JSON with no markdown:
{
  "thinking_style": {
    "analytical": 0.0-1.0,
    "emotional": 0.0-1.0,
    "persuasive": 0.0-1.0
  },
  "argument_strength": 0.0-1.0,
  "openness_to_opposing_views": 0.0-1.0,
  "detected_topics": ["topic1", "topic2"],
  "detected_bias": {"topic": "pro|anti|neutral"}
}

Rules:
- analytical: uses data, logic, evidence
- emotional: uses feelings, empathy, values
- persuasive: uses rhetoric, framing, calls to action
- All floats 0.0-1.0. Max 3 topics.`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    const topicAffinities: Record<string, number> = {};
    for (const topic of (parsed.detected_topics || []).slice(0, 3)) {
      topicAffinities[String(topic).toLowerCase()] = 0.75;
    }

    return {
      debate_style: {
        analytical: clamp(parseFloat(parsed.thinking_style?.analytical) || 0.5),
        emotional:  clamp(parseFloat(parsed.thinking_style?.emotional)  || 0.5),
        persuasive: clamp(parseFloat(parsed.thinking_style?.persuasive) || 0.5),
      },
      skill_level:    clamp(parseFloat(parsed.argument_strength) || 0.5),
      openness_score: clamp(parseFloat(parsed.openness_to_opposing_views) || 0.5),
      topic_affinities: topicAffinities,
      bias_profile: parsed.detected_bias || {},
    };
  } catch {
    return {};
  }
}

// ─── Topic Vector (Semantic Similarity) ──────────────────────────────────────
// Normalizes topic_affinities to a unit vector for cosine similarity.
// This allows semantic matching without pgvector — lightweight TF-IDF equivalent.

export function buildUserTopicVector(profile: UserBehaviorProfile): Record<string, number> {
  const affinities = profile.topic_affinities;
  const entries = Object.entries(affinities);
  if (entries.length === 0) return {};

  const norm = Math.sqrt(entries.reduce((s, [, v]) => s + v * v, 0));
  if (norm === 0) return {};

  const vec: Record<string, number> = {};
  for (const [k, v] of entries) {
    vec[k] = v / norm;
  }
  return vec;
}

// Cosine similarity between user topic unit-vector and post topic set.
// Post vector is uniform 1/sqrt(N) per topic (unit vector over N topics).
export function computeSemanticSimilarity(
  userVector: Record<string, number>,
  postTopics: string[]
): number {
  if (postTopics.length === 0 || Object.keys(userVector).length === 0) return 0.15;

  const postNorm = Math.sqrt(postTopics.length);
  let dot = 0;
  for (const t of postTopics) {
    dot += (userVector[t.toLowerCase()] || 0) * (1 / postNorm);
  }
  return clamp(dot);
}

// ─── Feed Personalization Scoring ────────────────────────────────────────────
// Formula:
//   0.35 * semantic_similarity  — cosine(user_topic_vector, post_topics)
//   0.20 * topic_match          — raw affinity avg for post topics
//   0.15 * diversity_boost      — 1.0 if not seen, 0.3/0.6 if seen (challenge mode)
//   0.15 * engagement_pred      — match user avg_post_length preference
//   0.15 * recency              — caller-provided exponential decay

export function personalizePostScore(
  _baseScore: number,
  post: any,
  profile: UserBehaviorProfile,
  seenTopics: Set<string>,
  userVector?: Record<string, number>,
  recency?: number
): number {
  const postTopics: string[] = (post.topic_tags || []).map((t: string) => t.toLowerCase());
  const vec = userVector ?? buildUserTopicVector(profile);

  // 1. Semantic similarity (0.35)
  const semanticSim = computeSemanticSimilarity(vec, postTopics);

  // 2. Topic match — raw affinity average (0.20)
  let topicMatch = 0.20;
  if (postTopics.length > 0) {
    const scores = postTopics.map(t => profile.topic_affinities[t] ?? 0.20);
    topicMatch = scores.reduce((s, x) => s + x, 0) / scores.length;
  }

  // 3. Diversity boost — inverse repeat penalty (0.15)
  const alreadySeen = postTopics.some(t => seenTopics.has(t));
  const diversityBoost = alreadySeen
    ? (profile.challenge_mode ? 0.60 : 0.30)
    : 1.0;

  // 4. Engagement prediction — content length match (0.15)
  const contentLength = (post.content || '').length;
  const preferLong = profile.engagement_pattern.avg_post_length > 200;
  const isLong = contentLength > 300;
  const engagementPred = (preferLong === isLong) ? 0.80 : 0.40;

  // 5. Recency — caller provides pre-computed decay (0.15)
  const recencyScore = recency ?? Math.exp(
    -0.05 * (Date.now() - new Date(post.created_at).getTime()) / 3_600_000
  );

  // 6. Challenge bonus for opposing-bias topics
  let challengeBonus = 0;
  if (profile.challenge_mode) {
    const userBiasTopics = Object.keys(profile.bias_profile).map(t => t.toLowerCase());
    if (postTopics.some(t => userBiasTopics.includes(t))) challengeBonus = 0.15;
  }

  return clamp(
    0.35 * semanticSim +
    0.20 * topicMatch +
    0.15 * diversityBoost +
    0.15 * engagementPred +
    0.15 * recencyScore +
    challengeBonus,
    0, 1.5  // allow slightly above 1 with challenge bonus
  );
}

// ─── Match Reason ─────────────────────────────────────────────────────────────
// Human-readable explanation of why a post was ranked for this user.

export function getMatchReason(
  post: any,
  profile: UserBehaviorProfile,
  semanticSim: number,
  isExploration: boolean
): string | null {
  if (isExploration) return 'Expanding your horizons';

  const postTopics: string[] = (post.topic_tags || []).map((t: string) => t.toLowerCase());

  let bestTopic = '';
  let bestScore = 0;
  for (const t of postTopics) {
    const s = profile.topic_affinities[t] ?? 0;
    if (s > bestScore) { bestScore = s; bestTopic = t; }
  }

  if (bestScore > 0.65) return `Strong match: #${bestTopic}`;
  if (semanticSim > 0.45) return `Matches your interests`;
  if (profile.challenge_mode) return 'Challenge: opposing view';
  if (bestScore > 0.30) return `Based on #${bestTopic}`;
  return null;
}

// ─── 80/20 Exploration Split ──────────────────────────────────────────────────
// 80% of feed slots: highest personalized score (exploit)
// 20% of feed slots: randomly sampled from remaining posts (explore)
// Exploration posts are injected at intervals: positions 4, 9, 14...

export function applyExplorationSplit<T extends { _personalized_score?: number }>(
  posts: T[],
  explorationRatio = 0.20
): { post: T; isExploration: boolean }[] {
  if (posts.length < 4) {
    return posts.map(p => ({ post: p, isExploration: false }));
  }

  const explorationCount = Math.max(1, Math.round(posts.length * explorationRatio));
  const exploitCount = posts.length - explorationCount;

  const sorted = [...posts].sort((a, b) => (b._personalized_score ?? 0) - (a._personalized_score ?? 0));
  const exploitPool = sorted.slice(0, exploitCount).map(p => ({ post: p, isExploration: false }));
  const diversePool = sorted.slice(exploitCount);

  // Fisher-Yates shuffle the diverse pool
  for (let i = diversePool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [diversePool[i], diversePool[j]] = [diversePool[j], diversePool[i]];
  }

  const explorationItems = diversePool
    .slice(0, explorationCount)
    .map(p => ({ post: p, isExploration: true }));

  // Interleave: inject exploration posts every 5 positions
  const result = [...exploitPool];
  for (let i = 0; i < explorationItems.length; i++) {
    const insertAt = Math.min(4 + i * 5, result.length);
    result.splice(insertAt, 0, explorationItems[i]);
  }

  return result;
}

// ─── Personalization Insights ─────────────────────────────────────────────────
// Summary of what the system has inferred about the user — drives the sidebar widget.

export function getPersonalizationInsights(profile: UserBehaviorProfile) {
  const topInterests = Object.entries(profile.topic_affinities)
    .filter(([, v]) => v > 0.25)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([topic, score]) => ({ topic, score: Math.round(score * 100) }));

  const styleEntries = Object.entries(profile.debate_style).sort((a, b) => b[1] - a[1]);
  const dominantStyle = styleEntries[0][0];
  const dominantStrength = Math.round(styleEntries[0][1] * 100);

  const topBias = Object.entries(profile.bias_profile).slice(0, 3).map(([topic, stance]) => ({
    topic, stance
  }));

  return {
    top_interests: topInterests,
    dominant_style: dominantStyle,
    dominant_style_strength: dominantStrength,
    skill_level: Math.round(profile.skill_level * 100),
    difficulty: getAdaptiveDifficulty(profile),
    openness: Math.round(profile.openness_score * 100),
    challenge_mode: profile.challenge_mode,
    bias_signals: topBias,
    total_interactions: profile.total_interactions,
    last_updated: profile.last_updated,
    exploration_ratio: 20,
    is_cold_start: profile.total_interactions < 3,
  };
}

// ─── Adaptive AI Difficulty ───────────────────────────────────────────────────

export type Difficulty = 'easy' | 'medium' | 'hard';

export function getAdaptiveDifficulty(profile: UserBehaviorProfile): Difficulty {
  if (profile.skill_level < 0.40) return 'easy';
  if (profile.skill_level < 0.70) return 'medium';
  return 'hard';
}

export function getDifficultyModifier(difficulty: Difficulty): string {
  if (difficulty === 'easy') {
    return 'Adjust your language to be clear and accessible. Avoid jargon. Use simple analogies. Allow some openings in your argument that the user can counter.';
  }
  if (difficulty === 'hard') {
    return 'Argue with maximum sophistication. Use technical vocabulary, academic citations, multi-step logical chains. Leave no opening in your argument.';
  }
  return 'Use moderate sophistication — clear structure, some evidence, occasional rhetorical technique.';
}

// ─── Prompt Context Block ─────────────────────────────────────────────────────

export function buildPersonalizationContext(profile: UserBehaviorProfile): string {
  const difficulty = getAdaptiveDifficulty(profile);
  const dominant = Object.entries(profile.debate_style)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)[0];

  const topTopics = Object.entries(profile.topic_affinities)
    .filter(([, v]) => v > 0.4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);

  const lines = [
    `USER PROFILE (tailor your response accordingly):`,
    `- Dominant thinking style: ${dominant} (skill: ${Math.round(profile.skill_level * 100)}th percentile → ${difficulty} mode)`,
    `- Openness to opposing views: ${Math.round(profile.openness_score * 100)}%`,
    topTopics.length ? `- Active interests: ${topTopics.join(', ')}` : '',
    Object.keys(profile.bias_profile).length
      ? `- Known biases: ${Object.entries(profile.bias_profile).map(([t, s]) => `${s} on ${t}`).join(', ')}`
      : '',
    profile.challenge_mode
      ? '- CHALLENGE MODE ON: Intentionally introduce contradictory viewpoints to broaden perspective.'
      : '',
    `- Difficulty calibration: ${getDifficultyModifier(difficulty)}`,
  ].filter(Boolean);

  return lines.join('\n');
}

// ─── Convenience Updaters ─────────────────────────────────────────────────────

export async function recordPostInteraction(
  userId: number,
  text: string,
  topicTags: string[]
): Promise<void> {
  const affinities: Record<string, number> = {};
  for (const t of topicTags) affinities[t.toLowerCase()] = 0.7;

  await updateUserProfile(userId, {
    topic_affinities: affinities,
    engagement_pattern: {
      avg_post_length: text.length,
      interaction_type: 'post_heavy',
      sessions: 0,
    },
  });
}

export async function recordDebateInteraction(
  userId: number,
  debateScore: number
): Promise<void> {
  await updateUserProfile(userId, {
    skill_level: debateScore,
    engagement_pattern: {
      avg_post_length: 150,
      interaction_type: 'debate_heavy',
      sessions: 0,
    },
  });
}
