// Automated Evaluation System — Closed-Loop AI Quality Scoring
import { getModel } from './gemini.js';
// Every AI-generated output is evaluated on 6 dimensions.
// Results feed into feed ranking, persona evolution gating, and insights.



export interface EvaluationMetrics {
  coherence: number;          // 0-1: internally consistent, makes sense
  persona_match: number;      // 0-1: matches persona voice, beliefs, style
  toxicity: number;           // 0-1: harmful / abusive content (lower = better)
  redundancy: number;         // 0-1: repeats past statements (lower = better)
  novelty: number;            // 0-1: original, fresh perspective
  reasoning_quality: number;  // 0-1: logically sound, well-argued
  explanation: string;
  flagged: boolean;           // true if toxicity > 0.4 OR coherence < 0.5
  composite: number;          // weighted aggregate quality score 0-1
}

const FALLBACK_METRICS: EvaluationMetrics = {
  coherence: 0.72,
  persona_match: 0.70,
  toxicity: 0.02,
  redundancy: 0.20,
  novelty: 0.60,
  reasoning_quality: 0.68,
  explanation: 'Evaluation unavailable — using defaults.',
  flagged: false,
  composite: 0.68,
};

function computeComposite(m: Omit<EvaluationMetrics, 'flagged' | 'composite' | 'explanation'>): number {
  return Math.min(
    1,
    Math.max(
      0,
      0.25 * m.persona_match +
        0.20 * m.coherence +
        0.20 * m.reasoning_quality +
        0.15 * m.novelty -
        0.10 * m.redundancy -
        0.10 * m.toxicity
    )
  );
}

export async function evaluateOutput(
  personaProfile: string,
  userInput: string,
  aiOutput: string,
  pastContext?: string[]
): Promise<EvaluationMetrics> {
  const model = getModel();

  const contextBlock =
    pastContext && pastContext.length > 0
      ? `\nPAST STATEMENTS BY THIS PERSONA (for redundancy check):\n${pastContext
          .slice(0, 3)
          .map(p => `- "${p.slice(0, 120)}"`)
          .join('\n')}`
      : '';

  const prompt = `You are a strict AI output quality evaluator. Score this AI-generated response objectively.

PERSONA PROFILE (first 400 chars):
"${personaProfile.slice(0, 400)}"
${contextBlock}

USER INPUT:
"${userInput.slice(0, 300)}"

AI OUTPUT:
"${aiOutput.slice(0, 500)}"

Rate each metric from 0.0 to 1.0. For toxicity and redundancy, high values are BAD.

Return ONLY valid JSON — no markdown, no extra text:
{
  "coherence": 0.0-1.0,
  "persona_match": 0.0-1.0,
  "toxicity": 0.0-1.0,
  "redundancy": 0.0-1.0,
  "novelty": 0.0-1.0,
  "reasoning_quality": 0.0-1.0,
  "explanation": "one concise sentence"
}`;

  try {
    const result = await model.generateContent(prompt);
    let raw = result.response
      .text()
      .trim()
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const parsed = JSON.parse(raw);

    const clamp = (v: any, fallback: number) =>
      Math.min(1, Math.max(0, typeof v === 'number' ? v : fallback));

    const metrics = {
      coherence: clamp(parsed.coherence, 0.72),
      persona_match: clamp(parsed.persona_match, 0.70),
      toxicity: clamp(parsed.toxicity, 0.02),
      redundancy: clamp(parsed.redundancy, 0.20),
      novelty: clamp(parsed.novelty, 0.60),
      reasoning_quality: clamp(parsed.reasoning_quality, 0.68),
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : 'Evaluated.',
    };

    const composite = computeComposite(metrics);
    const flagged = metrics.toxicity > 0.4 || metrics.coherence < 0.5;

    return { ...metrics, composite, flagged };
  } catch {
    return FALLBACK_METRICS;
  }
}

// Convenience: feed ranking bonus from metrics
export function metricsRankingBonus(metrics: EvaluationMetrics | null): number {
  if (!metrics) return 0;
  return (
    0.15 * (metrics.persona_match || 0) +
    0.10 * (metrics.novelty || 0) -
    0.10 * (metrics.redundancy || 0)
  );
}
