
import { getModel } from './gemini.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CoDebateSuggestion {
  continuation: string;
  counter: string;
  improvement: string;
  toneNote: string;
}

export interface LiveScore {
  logic_score: number;
  persuasiveness: number;
  clarity: number;
  emotional_intensity: number;
  overall: number;
}

export interface BehaviorProfile {
  debateId: number;
  personaId: number;
  messageCount: number;
  avgLogic: number;
  avgPersuasion: number;
  avgClarity: number;
  dominantStyle: 'emotional' | 'logical' | 'balanced';
  repetitionScore: number;
  lastWords: string[];
  strategy: string;
  strategyLabel: string;
  updatedAt: number;
}

// ─── Co-Debate Suggestion Engine ─────────────────────────────────────────────

export async function generateCoDebateSuggestion(
  text: string,
  personaName: string,
  personaTone: string,
  topic: string,
  stance: string
): Promise<CoDebateSuggestion> {
  const FALLBACK: CoDebateSuggestion = {
    continuation: '',
    counter: '',
    improvement: '',
    toneNote: '',
  };

  if (!text || text.trim().length < 10) return FALLBACK;

  try {
    const model = getModel();
    const prompt = `You are a real-time debate coach assisting the persona "${personaName}" (tone: ${personaTone || 'neutral'}) in a debate on: "${topic}".
Their stance: "${stance}"

Partial argument being typed:
"${text.slice(0, 400)}"

Return ONLY valid JSON with no markdown:
{
  "continuation": "one sentence that completes or extends this thought powerfully (max 25 words)",
  "counter": "the strongest counterargument their opponent might raise right now (max 20 words)",
  "improvement": "one specific word or phrase change that makes this more persuasive (max 15 words)",
  "toneNote": "brief tone observation for this persona (max 10 words)"
}

Be specific to the partial text. Do not be generic.`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim()
      .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    return {
      continuation: (parsed.continuation || '').slice(0, 200),
      counter: (parsed.counter || '').slice(0, 200),
      improvement: (parsed.improvement || '').slice(0, 200),
      toneNote: (parsed.toneNote || '').slice(0, 100),
    };
  } catch {
    return FALLBACK;
  }
}

// ─── Live Scoring Engine ──────────────────────────────────────────────────────

export async function computeLiveScore(text: string): Promise<LiveScore> {
  const FALLBACK: LiveScore = {
    logic_score: 0, persuasiveness: 0, clarity: 0, emotional_intensity: 0, overall: 0,
  };

  if (!text || text.trim().split(/\s+/).length < 4) return FALLBACK;

  try {
    const model = getModel();
    const prompt = `Score this partial debate argument objectively. Return ONLY valid JSON with no markdown:
{
  "logic_score": 0.0-1.0,
  "persuasiveness": 0.0-1.0,
  "clarity": 0.0-1.0,
  "emotional_intensity": 0.0-1.0
}

Text: "${text.slice(0, 300).replace(/"/g, "'")}"

Score based on what is written, even if incomplete.`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim()
      .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    const clamp = (v: any) => Math.min(1, Math.max(0, typeof v === 'number' ? v : 0));
    const l = clamp(parsed.logic_score);
    const p = clamp(parsed.persuasiveness);
    const c = clamp(parsed.clarity);
    const e = clamp(parsed.emotional_intensity);

    return {
      logic_score: l,
      persuasiveness: p,
      clarity: c,
      emotional_intensity: e,
      overall: Math.round(((l * 0.35 + p * 0.30 + c * 0.25 + (1 - e) * 0.10)) * 100) / 100,
    };
  } catch {
    return FALLBACK;
  }
}

// ─── Behavior Tracker / Adaptive Strategy Engine ─────────────────────────────

const STRATEGY_MAP: Record<string, { strategy: string; label: string }> = {
  dominate: {
    strategy: 'Use simple, forceful claims. Exploit logical gaps directly. Avoid matching their emotional register.',
    label: 'Dominate — opponent is weak, press the advantage',
  },
  contrast: {
    strategy: 'Stay coldly logical. Reference evidence. Let their emotion work against them by staying composed.',
    label: 'Contrast — match their logic against their emotion',
  },
  mirror_counter: {
    strategy: 'Mirror their tone, then pivot to introduce an angle they have not addressed. Outflank, don\'t confront.',
    label: 'Mirror + Counter — balanced opponent, find new angles',
  },
  pressure: {
    strategy: 'Force them to repeat themselves by challenging their core assumption repeatedly. Expose the loop.',
    label: 'Pressure — opponent is repeating, expose the loop',
  },
  escalate: {
    strategy: 'They are strong. Escalate sophistication — introduce systemic consequences and second-order effects.',
    label: 'Escalate — strong opponent, raise the stakes',
  },
};

export function computeAdaptiveStrategy(profile: Partial<BehaviorProfile>): { strategy: string; label: string } {
  const strength = ((profile.avgLogic || 0) + (profile.avgPersuasion || 0)) / 2;
  const isEmotional = profile.dominantStyle === 'emotional';
  const isRepetitive = (profile.repetitionScore || 0) > 0.5;
  const messageCount = profile.messageCount || 0;

  if (messageCount < 2) return STRATEGY_MAP.mirror_counter;
  if (isRepetitive) return STRATEGY_MAP.pressure;
  if (strength < 0.35) return STRATEGY_MAP.dominate;
  if (isEmotional && strength < 0.55) return STRATEGY_MAP.contrast;
  if (strength > 0.72) return STRATEGY_MAP.escalate;
  return STRATEGY_MAP.mirror_counter;
}

export function updateBehaviorProfile(
  existing: BehaviorProfile | undefined,
  debateId: number,
  personaId: number,
  score: LiveScore,
  text: string
): BehaviorProfile {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const prev = existing || {
    debateId, personaId,
    messageCount: 0, avgLogic: 0, avgPersuasion: 0, avgClarity: 0,
    dominantStyle: 'balanced' as const,
    repetitionScore: 0, lastWords: [], strategy: '', strategyLabel: '', updatedAt: 0,
  };

  const n = prev.messageCount + 1;
  const newLogic = (prev.avgLogic * prev.messageCount + score.logic_score) / n;
  const newPersuasion = (prev.avgPersuasion * prev.messageCount + score.persuasiveness) / n;
  const newClarity = (prev.avgClarity * prev.messageCount + score.clarity) / n;

  const overlap = words.filter(w => prev.lastWords.includes(w)).length;
  const repScore = words.length > 0 ? Math.min(1, overlap / words.length) : 0;

  const emotional = score.emotional_intensity;
  const logical = score.logic_score;
  const dominantStyle: BehaviorProfile['dominantStyle'] =
    emotional > logical + 0.2 ? 'emotional'
    : logical > emotional + 0.2 ? 'logical'
    : 'balanced';

  const profileUpdate: BehaviorProfile = {
    debateId, personaId,
    messageCount: n,
    avgLogic: newLogic,
    avgPersuasion: newPersuasion,
    avgClarity: newClarity,
    dominantStyle,
    repetitionScore: repScore,
    lastWords: [...prev.lastWords, ...words].slice(-60),
    strategy: '', strategyLabel: '', updatedAt: Date.now(),
  };

  const { strategy, label } = computeAdaptiveStrategy(profileUpdate);
  profileUpdate.strategy = strategy;
  profileUpdate.strategyLabel = label;

  return profileUpdate;
}
