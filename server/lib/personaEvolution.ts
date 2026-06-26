// Persona Auto-Training — Adaptive Identity Engine
// Analyzes behavioral signals, detects drift, suggests controlled updates
import { getModel } from './gemini.js';
import pool from '../db.js';


export interface BehaviorSignals {
  personaId: number;
  recentPosts: Array<{ content: string; like_count: number; intent_type?: string }>;
  debateOutcomes: Array<{ won: boolean; quality_score?: number }>;
  avgLogicScore?: number;
  avgPersuasiveness?: number;
}

export interface ThinkingStyleResult {
  thinking_style: 'analytical' | 'emotional' | 'persuasive' | 'informative';
  confidence: number;
  political_bias: 'left' | 'center' | 'right' | 'neutral';
  emotional_bias: 'positive' | 'negative' | 'neutral';
  extremity_score: number;
  explanation: string;
}

// ─── Thinking Style + Bias Classifier ──────────────────────────────────────
export async function classifyThinkingStyle(text: string): Promise<ThinkingStyleResult> {
  try {
    const model = getModel();
    const prompt = `Analyze this text and return ONLY valid JSON:

Text: "${text.slice(0, 500)}"

{
  "thinking_style": "analytical|emotional|persuasive|informative",
  "confidence": 0.0-1.0,
  "political_bias": "left|center|right|neutral",
  "emotional_bias": "positive|negative|neutral",
  "extremity_score": 0.0-1.0,
  "explanation": "one sentence"
}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);
    return {
      thinking_style: parsed.thinking_style || 'informative',
      confidence: Math.min(1, parsed.confidence || 0.5),
      political_bias: parsed.political_bias || 'neutral',
      emotional_bias: parsed.emotional_bias || 'neutral',
      extremity_score: Math.min(1, parsed.extremity_score || 0),
      explanation: parsed.explanation || '',
    };
  } catch {
    return { thinking_style: 'informative', confidence: 0.5, political_bias: 'neutral', emotional_bias: 'neutral', extremity_score: 0, explanation: '' };
  }
}

// ─── AI Narrative Insight Generator ─────────────────────────────────────────
export async function generateNarrativeInsights(payload: {
  personaCount: number;
  thinkingDistribution: Record<string, number>;
  biasProfile: { dominant_political: string; dominant_emotional: string; avg_extremity: number };
  topTopics: string[];
  diversityScore: number;
  dominantPersona: string;
}): Promise<string> {
  try {
    const model = getModel();
    const prompt = `You are a behavioral analyst AI. Analyze this user's identity platform usage data and generate 3-4 sentences of insightful, non-judgmental psychological observations.

Data:
- ${payload.personaCount} active personas (diversity score: ${payload.diversityScore}%)
- Thinking style distribution: ${JSON.stringify(payload.thinkingDistribution)}
- Political bias: ${payload.biasProfile.dominant_political}, Emotional bias: ${payload.biasProfile.dominant_emotional}, Extremity: ${Math.round(payload.biasProfile.avg_extremity * 100)}%
- Dominant persona: "${payload.dominantPersona}"
- Top themes: ${payload.topTopics.join(', ')}

Generate insights covering: dominant thinking pattern, emotional tendencies, diversity level, and one constructive recommendation.
Write in second person ("You..."). Be specific. 3-4 sentences only. No bullet points.`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch {
    return 'Insufficient behavioral data to generate narrative insights. Post more content and engage in debates to unlock your psychological analysis.';
  }
}

// ─── Persona Drift Detector ────────────────────────────────────────────────
// Uses simplified cosine-style distance on trait vectors
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 1;
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return magA && magB ? dot / (magA * magB) : 1;
}

export function computeDriftScore(
  original: { formality: number; emotionality: number; assertiveness: number },
  current: { formality: number; emotionality: number; assertiveness: number }
): number {
  const origVec = [original.formality, original.emotionality, original.assertiveness];
  const currVec = [current.formality, current.emotionality, current.assertiveness];
  const similarity = cosineSimilarity(origVec, currVec);
  return Math.round((1 - similarity) * 100) / 100;
}

export function driftLabel(score: number): { label: string; color: string } {
  if (score < 0.2) return { label: 'Stable', color: 'text-accent-teal-light' };
  if (score < 0.5) return { label: 'Evolving', color: 'text-yellow-400' };
  return { label: 'Significant Drift', color: 'text-red-400' };
}

// ─── Controlled Evolution Engine ──────────────────────────────────────────
// new_profile = 0.7 * original + 0.3 * learned_behavior
export async function evolvePersona(personaId: number): Promise<{
  updatedTraits: any;
  changesExplained: string;
  confidence: number;
  driftScore: number;
} | null> {
  try {
    const personaRow = await pool.query('SELECT * FROM personas WHERE id = $1', [personaId]);
    if (!personaRow.rows.length) return null;
    const persona = personaRow.rows[0];

    // Gather recent posts (last 20)
    const recentPosts = await pool.query(
      `SELECT content, like_count, intent_type FROM posts WHERE persona_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [personaId]
    );

    // Gather debate message scores
    const debateScores = await pool.query(
      `SELECT AVG(dm.logic_score) as avg_logic, AVG(dm.persuasiveness_score) as avg_persuasion,
        AVG(dm.toxicity_score) as avg_toxicity
       FROM debate_messages dm WHERE dm.persona_id = $1 AND dm.logic_score IS NOT NULL`,
      [personaId]
    );

    if (!recentPosts.rows.length) return null;

    const avgLogic = parseFloat(debateScores.rows[0]?.avg_logic) || 0.5;
    const avgPersuasion = parseFloat(debateScores.rows[0]?.avg_persuasion) || 0.5;
    const avgToxicity = parseFloat(debateScores.rows[0]?.avg_toxicity) || 0;

    // Safety gate: reject evolution if toxicity is high
    if (avgToxicity > 0.5) {
      return { updatedTraits: {}, changesExplained: 'Evolution blocked: toxicity threshold exceeded.', confidence: 0, driftScore: 0 };
    }

    const contentSample = recentPosts.rows.slice(0, 5).map((p: any) => p.content).join('\n\n---\n\n');
    const engagementSignal = recentPosts.rows.reduce((s: number, p: any) => s + (p.like_count || 0), 0);

    const model = getModel();
    const prompt = `You are an AI persona evolution engine. Analyze behavioral data and suggest refined traits.

ORIGINAL PERSONA:
Name: ${persona.name}
Archetype: ${persona.archetype || 'None'}
Tone formality: ${persona.tone_formality ?? 0.5}
Tone emotionality: ${persona.tone_emotionality ?? 0.5}
Tone assertiveness: ${persona.tone_assertiveness ?? 0.5}
Beliefs: ${JSON.stringify(persona.beliefs || [])}

BEHAVIORAL DATA (last ${recentPosts.rows.length} posts):
${contentSample.slice(0, 800)}

ENGAGEMENT SIGNALS:
Total likes: ${engagementSignal}
Avg debate logic score: ${avgLogic.toFixed(2)}
Avg debate persuasiveness: ${avgPersuasion.toFixed(2)}

TASK: Suggest refined traits that preserve core identity (α=0.7) while incorporating consistent new behaviors.

Return ONLY valid JSON:
{
  "tone_formality": 0.0-1.0,
  "tone_emotionality": 0.0-1.0,
  "tone_assertiveness": 0.0-1.0,
  "changes_explained": "1-2 sentences describing what evolved and why",
  "confidence": 0.0-1.0
}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    // Apply α-blend: new = 0.7 * original + 0.3 * learned
    const alpha = 0.7;
    const blended = {
      tone_formality: alpha * (persona.tone_formality ?? 0.5) + (1 - alpha) * (parsed.tone_formality ?? 0.5),
      tone_emotionality: alpha * (persona.tone_emotionality ?? 0.5) + (1 - alpha) * (parsed.tone_emotionality ?? 0.5),
      tone_assertiveness: alpha * (persona.tone_assertiveness ?? 0.5) + (1 - alpha) * (parsed.tone_assertiveness ?? 0.5),
    };

    const driftScore = computeDriftScore(
      { formality: persona.tone_formality ?? 0.5, emotionality: persona.tone_emotionality ?? 0.5, assertiveness: persona.tone_assertiveness ?? 0.5 },
      { formality: blended.tone_formality, emotionality: blended.tone_emotionality, assertiveness: blended.tone_assertiveness }
    );

    // Store baseline if not yet set
    if (!persona.baseline_traits || Object.keys(persona.baseline_traits).length === 0) {
      await pool.query(
        `UPDATE personas SET baseline_traits = $1 WHERE id = $2`,
        [JSON.stringify({ tone_formality: persona.tone_formality ?? 0.5, tone_emotionality: persona.tone_emotionality ?? 0.5, tone_assertiveness: persona.tone_assertiveness ?? 0.5 }), personaId]
      );
    }

    // Apply blended traits
    const versionBefore = persona.version || 1;
    await pool.query(
      `UPDATE personas SET
        tone_formality = $1, tone_emotionality = $2, tone_assertiveness = $3,
        drift_score = $4, evolution_summary = $5, version = version + 1, last_evolved_at = NOW()
       WHERE id = $6`,
      [blended.tone_formality, blended.tone_emotionality, blended.tone_assertiveness,
       driftScore, parsed.changes_explained, personaId]
    );

    // Log evolution
    await pool.query(
      `INSERT INTO persona_evolution_log (persona_id, version_before, version_after, changes_explained, updated_traits, confidence, drift_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [personaId, versionBefore, versionBefore + 1, parsed.changes_explained,
       JSON.stringify(blended), parsed.confidence || 0.7, driftScore]
    );

    return {
      updatedTraits: blended,
      changesExplained: parsed.changes_explained || 'Persona traits updated based on behavioral patterns.',
      confidence: parsed.confidence || 0.7,
      driftScore,
    };
  } catch (e) {
    console.error('Evolution error:', e);
    return null;
  }
}
