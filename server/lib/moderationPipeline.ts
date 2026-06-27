
import { getModel } from './gemini.js';

// ─── Layer 1: Regex fast gate ────────────────────────────────────────────────

const BANNED_PATTERNS = [
  /\b(how\s+to\s+(make|build|create)\s+(bomb|weapon|explosive|poison))\b/i,
  /\b(child\s+(porn|abuse|exploitation))\b/i,
  /\b(terrorist\s+attack|mass\s+shooting|ethnic\s+cleansing)\b/i,
];

export interface RegexResult {
  blocked: boolean;
  reason?: string;
}

export function regexFilter(text: string): RegexResult {
  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(text)) {
      return { blocked: true, reason: 'Content matches prohibited pattern' };
    }
  }
  return { blocked: false };
}

// ─── Layer 2: LLM input moderation ──────────────────────────────────────────

export interface InputModerationResult {
  safe: boolean;
  categories: string[];
  severity: number;
  explanation: string;
  action: 'allow' | 'warn' | 'block';
}

export async function moderateInput(text: string): Promise<InputModerationResult> {
  try {
    const model = getModel();
    const prompt = `You are a content safety classifier for a debate and opinion platform. Analyze this input and return ONLY valid JSON with no markdown or code blocks.

Respond with this exact schema:
{"safe":true,"categories":[],"severity":0.0,"explanation":"Content is appropriate for platform use"}

Categories if unsafe: "violence", "hate_speech", "harassment", "extremism", "self_harm", "explicit_content"
Severity: 0.0 (clean) to 1.0 (extremely harmful)

IMPORTANT: Controversial political opinions, strong rhetoric, and heated debate arguments are ALLOWED. Only flag content that is genuinely harmful.

Input: "${text.slice(0, 500).replace(/"/g, "'")}"`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    const severity: number = parsed.severity || 0;
    let action: 'allow' | 'warn' | 'block' = 'allow';
    if (!parsed.safe && severity >= 0.7) action = 'block';
    else if (!parsed.safe && severity >= 0.4) action = 'warn';

    return {
      safe: parsed.safe ?? true,
      categories: parsed.categories || [],
      severity,
      explanation: parsed.explanation || '',
      action,
    };
  } catch {
    // Fail open — moderation errors must never block legitimate usage
    return { safe: true, categories: [], severity: 0, explanation: 'Moderation unavailable', action: 'allow' };
  }
}

// ─── Layer 4: LLM output moderation ─────────────────────────────────────────

export interface OutputModerationResult {
  safe: boolean;
  toxicity: number;
  violence: number;
  hate: number;
  action: 'allow' | 'warn' | 'block';
  categories: string[];
}

export async function moderateOutput(text: string): Promise<OutputModerationResult> {
  try {
    const model = getModel();
    const prompt = `Evaluate this AI-generated response for safety. Return ONLY valid JSON with no markdown.

Respond with this exact schema:
{"safe":true,"toxicity":0.0,"violence":0.0,"hate":0.0,"action":"allow","categories":[]}

Scores: 0.0 to 1.0. action: "allow" | "warn" | "block"
Strong debate arguments and controversial political opinions are normal and ALLOWED.

Text: "${text.slice(0, 800).replace(/"/g, "'")}"`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    return {
      safe: parsed.safe ?? true,
      toxicity: parsed.toxicity || 0,
      violence: parsed.violence || 0,
      hate: parsed.hate || 0,
      action: parsed.action || 'allow',
      categories: parsed.categories || [],
    };
  } catch {
    return { safe: true, toxicity: 0, violence: 0, hate: 0, action: 'allow', categories: [] };
  }
}
