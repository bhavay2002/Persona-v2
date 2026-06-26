// Debate Engine — Multi-agent prompt system, scoring, fallacy detection
import { getModel } from './gemini.js';
import { PersonaSchema, compilePersonaPrompt } from './promptCompiler.js';


export interface DebateParticipant {
  personaId: number;
  personaSchema: PersonaSchema;
  stance: string;
}

export interface DebateMessage {
  personaId: number;
  personaName: string;
  content: string;
}

// ─── Multi-Agent System Prompt (per persona + stance) ──────────────────────
export function buildDebateSystemPrompt(participant: DebateParticipant, topic: string): string {
  const compiled = compilePersonaPrompt(participant.personaSchema);
  return `${compiled.system}

DEBATE CONTEXT:
Topic: "${topic}"
Your Stance: You strongly support — "${participant.stance}"

DEBATE RULES:
- Stay consistent with your stance throughout — never concede your core position
- Challenge your opponent's logic directly, not their character
- Structure arguments as: CLAIM → REASONING → EVIDENCE/EXAMPLE
- Avoid repetition of points already made
- Escalate the sophistication of your argument each turn

GOAL: Win the debate through superior persuasion, logic, and clarity of reasoning.

${compiled.safetyLayer}`;
}

// ─── Counterargument Prompt ─────────────────────────────────────────────────
export function buildCounterargumentPrompt(
  participant: DebateParticipant,
  topic: string,
  lastOpponentMessage: string,
  debateHistory: DebateMessage[]
): string {
  const system = buildDebateSystemPrompt(participant, topic);

  const historySummary = debateHistory.length > 2
    ? `\nDEBATE HISTORY (last ${Math.min(debateHistory.length, 3)} turns):\n${
        debateHistory.slice(-3).map(m => `${m.personaName}: "${m.content.slice(0, 120)}..."`).join('\n')
      }\n\nCURRENT TURN: Do not repeat points already made above.`
    : '';

  return `${system}
${historySummary}

OPPONENT'S ARGUMENT:
"${lastOpponentMessage}"

TASK:
1. Identify the weakest point in the opponent's argument
2. Deliver a sharp counterargument that dismantles it
3. Reinforce your own stance with new evidence or reasoning
4. End with a strong, memorable closing line

Respond in 2-4 sentences. Be concise, precise, and unmistakably in your persona's voice.
Output ONLY the argument text — no labels, no preamble.`;
}

// ─── Opening Statement Prompt ──────────────────────────────────────────────
export function buildOpeningPrompt(participant: DebateParticipant, topic: string): string {
  const system = buildDebateSystemPrompt(participant, topic);
  return `${system}

TASK: Generate a compelling opening statement for this debate.
Requirements:
- State your position clearly in the first sentence
- Provide your strongest single argument with evidence
- Use your persona's distinctive rhetorical style
- Close with a challenge to the opponent

2-3 sentences. Output ONLY the statement text.`;
}

// ─── Message Type Classifier ───────────────────────────────────────────────
export function classifyMessageType(content: string, isFirst: boolean): 'argument' | 'rebuttal' | 'summary' {
  if (isFirst) return 'argument';
  const lower = content.toLowerCase();
  const rebuttals = ['however', 'but', 'wrong', 'incorrect', 'actually', 'contrary', 'fails', 'ignores', 'overlooks', 'you claim', 'the opponent'];
  if (rebuttals.some(w => lower.includes(w))) return 'rebuttal';
  if (lower.includes('in conclusion') || lower.includes('to summarize') || lower.includes('ultimately')) return 'summary';
  return 'argument';
}

// ─── Scoring Algorithm ─────────────────────────────────────────────────────
// score = (0.35 * persuasiveness) + (0.25 * logic) + (0.20 * engagement) + (0.10 * originality) - (0.10 * fallacy_penalty)
export interface MessageScores {
  logicScore: number;
  persuasivenessScore: number;
  toxicityScore: number;
  compositeScore: number;
  fallacies: Array<{ name: string; explanation: string; severity: number }>;
}

export async function analyzeMessage(content: string): Promise<MessageScores> {
  try {
    const model = getModel();
    const prompt = `Analyze the following debate argument and return a JSON object ONLY (no markdown, no explanation).

Argument: "${content}"

Return this exact JSON structure:
{
  "logic_score": 0.0-1.0,
  "persuasiveness_score": 0.0-1.0,
  "toxicity_score": 0.0-1.0,
  "fallacies": [
    {"name": "fallacy name", "explanation": "brief explanation", "severity": 0.0-1.0}
  ]
}

Scoring guidelines:
- logic_score: quality of reasoning, evidence, internal consistency
- persuasiveness_score: emotional resonance, rhetoric strength, clarity
- toxicity_score: personal attacks, hate speech, inflammatory language (0 = clean)
- fallacies: only include if clearly present (ad hominem, straw man, false dichotomy, etc.)

Return valid JSON only.`;

    const result = await model.generateContent(prompt);
    let raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    const logic = Math.max(0, Math.min(1, parsed.logic_score || 0.5));
    const persuasiveness = Math.max(0, Math.min(1, parsed.persuasiveness_score || 0.5));
    const toxicity = Math.max(0, Math.min(1, parsed.toxicity_score || 0));
    const fallacies = Array.isArray(parsed.fallacies) ? parsed.fallacies : [];
    const fallacyPenalty = fallacies.reduce((sum: number, f: any) => sum + (f.severity || 0), 0) / Math.max(1, fallacies.length);

    const compositeScore = Math.min(1,
      (0.35 * persuasiveness) + (0.25 * logic) + (0.20 * 0.7) + (0.10 * 0.6) - (0.10 * fallacyPenalty)
    );

    return { logicScore: logic, persuasivenessScore: persuasiveness, toxicityScore: toxicity, compositeScore, fallacies };
  } catch {
    return { logicScore: 0.5, persuasivenessScore: 0.5, toxicityScore: 0, compositeScore: 0.5, fallacies: [] };
  }
}

// ─── Debate Quality Score (aggregate) ────────────────────────────────────────
export function computeDebateQuality(messages: Array<{ logic_score?: number; persuasiveness_score?: number; toxicity_score?: number }>): number {
  if (!messages.length) return 0;
  const analyzed = messages.filter(m => m.logic_score !== null && m.logic_score !== undefined);
  if (!analyzed.length) return 0;
  const avgLogic = analyzed.reduce((s, m) => s + (m.logic_score || 0), 0) / analyzed.length;
  const avgPersuasion = analyzed.reduce((s, m) => s + (m.persuasiveness_score || 0), 0) / analyzed.length;
  const avgToxicity = analyzed.reduce((s, m) => s + (m.toxicity_score || 0), 0) / analyzed.length;
  return Math.round(((avgLogic * 0.4 + avgPersuasion * 0.4 - avgToxicity * 0.2)) * 100);
}
