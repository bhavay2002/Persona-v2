// Prompt Profile Compiler v1.0
// Converts structured persona schema → optimized, versioned system prompt

export interface PersonaSchema {
  name: string;
  archetype?: string;
  tone?: {
    formality: number;      // 0-1
    emotionality: number;   // 0-1
    assertiveness: number;  // 0-1
  };
  beliefs?: Array<{ topic: string; stance: string; strength: number }>;
  expertise?: string[];
  rhetorical_style?: string[];
  taboos?: string[];
  goals?: string[];
  constraints_list?: string[];
  // Legacy fields
  legacy_tone?: string;
  ideology?: string;
}

export interface CompiledPrompt {
  version: string;
  system: string;
  safetyLayer: string;
  full: string;
}

const PROMPT_VERSION = 'v2.1';

export function compileToneDescriptor(formality: number, emotionality: number, assertiveness: number): string {
  const formalityStr = formality > 0.7 ? 'highly formal and structured' : formality > 0.4 ? 'conversational but professional' : 'casual and direct';
  const emotionalityStr = emotionality > 0.7 ? 'emotionally charged and passionate' : emotionality > 0.4 ? 'measured with occasional emphasis' : 'analytical and detached';
  const assertivenessStr = assertiveness > 0.7 ? 'boldly assertive and unwilling to concede ground' : assertiveness > 0.4 ? 'confident but open to nuance' : 'tentative and exploratory';
  return `${formalityStr}, ${emotionalityStr}, ${assertivenessStr}`;
}

export function compilePersonaPrompt(persona: PersonaSchema): CompiledPrompt {
  const hasToneSliders = persona.tone &&
    (persona.tone.formality !== undefined || persona.tone.emotionality !== undefined);

  const toneSection = hasToneSliders
    ? `TONE CALIBRATION (${PROMPT_VERSION}):
  - Formality: ${Math.round((persona.tone!.formality ?? 0.5) * 100)}% — ${compileToneDescriptor(persona.tone!.formality ?? 0.5, 0.5, 0.5).split(',')[0]}
  - Emotionality: ${Math.round((persona.tone!.emotionality ?? 0.5) * 100)}% — ${compileToneDescriptor(0.5, persona.tone!.emotionality ?? 0.5, 0.5).split(',')[1].trim()}
  - Assertiveness: ${Math.round((persona.tone!.assertiveness ?? 0.5) * 100)}% — ${compileToneDescriptor(0.5, 0.5, persona.tone!.assertiveness ?? 0.5).split(',')[2].trim()}
  Overall voice: ${compileToneDescriptor(persona.tone!.formality ?? 0.5, persona.tone!.emotionality ?? 0.5, persona.tone!.assertiveness ?? 0.5)}`
    : persona.legacy_tone
    ? `TONE: ${persona.legacy_tone}`
    : '';

  const beliefsSection = persona.beliefs && persona.beliefs.length > 0
    ? `BELIEFS & STANCES:
${persona.beliefs.map(b => `  - On "${b.topic}": ${b.stance} (conviction strength: ${Math.round(b.strength * 100)}%)`).join('\n')}`
    : '';

  const expertiseSection = persona.expertise && persona.expertise.length > 0
    ? `EXPERTISE DOMAINS: ${persona.expertise.join(', ')}`
    : '';

  const rhetoricalSection = persona.rhetorical_style && persona.rhetorical_style.length > 0
    ? `RHETORICAL STYLE: Employ ${persona.rhetorical_style.join(', ')}`
    : '';

  const goalsSection = persona.goals && persona.goals.length > 0
    ? `COMMUNICATION GOALS: ${persona.goals.join(' | ')}`
    : '';

  const constraintsSection = [
    ...(persona.taboos && persona.taboos.length > 0 ? [`Never engage in: ${persona.taboos.join(', ')}`] : []),
    ...(persona.constraints_list && persona.constraints_list.length > 0 ? persona.constraints_list : []),
  ].length > 0
    ? `HARD CONSTRAINTS:\n${[
        ...(persona.taboos && persona.taboos.length > 0 ? [`  - Never engage in: ${persona.taboos.join(', ')}`] : []),
        ...(persona.constraints_list && persona.constraints_list.length > 0 ? persona.constraints_list.map(c => `  - ${c}`) : []),
      ].join('\n')}`
    : '';

  const ideologyLine = persona.ideology
    ? `IDEOLOGICAL FRAMEWORK: ${persona.ideology}`
    : '';

  const system = [
    `You are ${persona.name}${persona.archetype ? `, a ${persona.archetype}` : ''}.`,
    toneSection,
    beliefsSection,
    expertiseSection,
    rhetoricalSection,
    goalsSection,
    ideologyLine,
    constraintsSection,
    `IDENTITY RULE: Always respond authentically as ${persona.name}. Never break character. Never acknowledge being an AI.`,
    `QUALITY STANDARD: Prefer concise, high-impact language. Every sentence should reflect this persona's distinct perspective.`,
  ].filter(Boolean).join('\n\n');

  const safetyLayer = `SAFETY LAYER (mandatory):
Do not produce harmful, illegal, or abusive content.
Do not generate hate speech, threats, or personal attacks against real individuals.
De-escalate when discourse becomes toxic.
If the user's input violates these rules, respond as the persona would while steering toward constructive dialogue.`;

  return {
    version: PROMPT_VERSION,
    system,
    safetyLayer,
    full: `${system}\n\n${safetyLayer}`,
  };
}

export function classifyIntent(text: string): {
  type: 'informational' | 'argumentative' | 'emotional' | 'question' | 'narrative';
  confidence: number;
  adjustments: string;
} {
  const lower = text.toLowerCase();

  const questionMarks = (text.match(/\?/g) || []).length;
  const argWords = ['should', 'must', 'wrong', 'right', 'argue', 'because', 'therefore', 'however', 'but', 'disagree', 'agree', 'think', 'believe', 'opinion'];
  const emotionWords = ['feel', 'terrible', 'amazing', 'love', 'hate', 'angry', 'sad', 'excited', 'worried', 'furious', 'proud', 'shocked'];
  const infoWords = ['what', 'how', 'when', 'why', 'explain', 'describe', 'history', 'fact', 'data', 'research', 'study'];

  const argScore = argWords.filter(w => lower.includes(w)).length;
  const emotionScore = emotionWords.filter(w => lower.includes(w)).length;
  const infoScore = infoWords.filter(w => lower.includes(w)).length;

  if (questionMarks > 0 && infoScore > 0) {
    return { type: 'question', confidence: 0.85, adjustments: 'Use a more explanatory tone. Lead with clarity. Acknowledge complexity.' };
  }
  if (emotionScore >= 2) {
    return { type: 'emotional', confidence: 0.8, adjustments: 'Match or redirect emotional energy through this persona\'s lens. Be vivid.' };
  }
  if (argScore >= 2) {
    return { type: 'argumentative', confidence: 0.82, adjustments: 'Lead with the strongest claim first. Use persona\'s rhetorical weapons. Be assertive.' };
  }
  if (infoScore >= 1) {
    return { type: 'informational', confidence: 0.75, adjustments: 'Deliver information through persona\'s perspective. Cite persona\'s expertise.' };
  }
  return { type: 'narrative', confidence: 0.7, adjustments: 'Frame as a story or example. Use persona\'s voice to make it memorable.' };
}

export function buildRewritePrompt(
  text: string,
  persona: PersonaSchema,
  intent: ReturnType<typeof classifyIntent>
): string {
  const compiled = compilePersonaPrompt(persona);
  return `${compiled.full}

INTENT ANALYSIS: This input is ${intent.type.toUpperCase()} in nature (${Math.round(intent.confidence * 100)}% confidence).
ADJUSTMENT: ${intent.adjustments}

TASK: Rewrite the following text in your persona's authentic voice. Keep it concise (2-4 sentences), impactful, and unmistakably "you".

USER INPUT: "${text}"

Respond with ONLY the rewritten text. No labels, no preamble, no explanation.`;
}

export function buildExplanation(
  persona: PersonaSchema,
  intent: ReturnType<typeof classifyIntent>,
  outputText: string
): string {
  const traits: string[] = [];

  if (persona.tone) {
    if (persona.tone.emotionality > 0.6) traits.push('high emotional charge');
    if (persona.tone.assertiveness > 0.6) traits.push('assertive framing');
    if (persona.tone.formality < 0.4) traits.push('informal directness');
    if (persona.tone.formality > 0.7) traits.push('formal structure');
  }

  if (persona.beliefs && persona.beliefs.length > 0) {
    const strongBelief = persona.beliefs.reduce((a, b) => a.strength > b.strength ? a : b);
    if (strongBelief.strength > 0.7) traits.push(`${strongBelief.stance} stance on ${strongBelief.topic}`);
  }

  if (persona.rhetorical_style && persona.rhetorical_style.length > 0) {
    traits.push(`${persona.rhetorical_style[0]} rhetoric`);
  }

  if (traits.length === 0) {
    if (persona.legacy_tone) traits.push(`${persona.legacy_tone} tone`);
    if (persona.ideology) traits.push(`${persona.ideology} worldview`);
  }

  return `This response emphasizes ${traits.slice(0, 3).join(', ') || 'persona-consistent voice'} — shaped by ${persona.name}'s ${intent.type} ${intent.type === 'argumentative' ? 'framing' : 'expression'}.`;
}
