// Meta-Learning Layer — Learns WHY certain prompts work, not just which ones.
//
// The system extracts structural patterns from high-performing prompt versions
// and stores them as reusable "strategies". Over time, the prompt evolution
// engine uses these patterns to generate better candidates.
//
// Example discovered pattern:
//   "chain-of-thought + adversarial framing in debate prompts
//    → increases win rate by 18% across all user segments"
//
// This makes the system self-improving at the strategy level, not just
// the parameter level — it learns which TYPES of prompt changes help.

import { getModel } from './gemini.js';
import pool from '../db.js';


// ─── Types ────────────────────────────────────────────────────────────────────

export interface PromptPattern {
  id: number;
  pattern_description: string;
  task_type: string;
  pattern_features: PatternFeatures;
  avg_reward: number;
  sample_count: number;
  discovered_at: string;
  last_seen_at: string;
}

export interface PatternFeatures {
  structural_elements: string[];     // e.g. ['chain-of-thought', 'adversarial framing']
  tone_modifiers: string[];          // e.g. ['Socratic', 'assertive']
  constraint_types: string[];        // e.g. ['anti-repetition', 'stance-lock']
  length_category: 'short' | 'medium' | 'long';
  has_few_shot_examples: boolean;
  has_explicit_format: boolean;      // JSON output format specified
  has_persona_grounding: boolean;    // references persona traits explicitly
}

// ─── Structural Feature Extractor (rule-based, no AI cost) ───────────────────

export function extractStructuralFeatures(template: string): PatternFeatures {
  const lower = template.toLowerCase();
  const wordCount = template.split(/\s+/).length;

  const structuralElements: string[] = [];
  if (/chain.of.thought|step.by.step|think through|reasoning chain/i.test(template)) structuralElements.push('chain-of-thought');
  if (/adversarial|counter|challenge|exploit|weakness/i.test(template)) structuralElements.push('adversarial framing');
  if (/example[s]?:|e\.g\.|for instance/i.test(template)) structuralElements.push('few-shot examples');
  if (/role.play|you are|act as|persona/i.test(template)) structuralElements.push('persona grounding');
  if (/do not repeat|avoid repetition|anti.repetition|never restate/i.test(template)) structuralElements.push('anti-repetition');
  if (/claim.+reasoning.+evidence|structure:.+argument|claim →/i.test(template)) structuralElements.push('structured argumentation');
  if (/safety|do not harm|do not produce|prohibited/i.test(template)) structuralElements.push('safety constraints');
  if (/escalate|sophisticated|complexity|depth/i.test(template)) structuralElements.push('escalation instruction');

  const toneModifiers: string[] = [];
  if (/socratic|question|inquiry/i.test(template)) toneModifiers.push('Socratic');
  if (/assertive|bold|forceful|unwilling to concede/i.test(template)) toneModifiers.push('assertive');
  if (/analytical|data.driven|evidence/i.test(template)) toneModifiers.push('analytical');
  if (/empathetic|compassionate|understand/i.test(template)) toneModifiers.push('empathetic');
  if (/concise|brief|2.4 sentences|short/i.test(template)) toneModifiers.push('brevity');

  const constraintTypes: string[] = [];
  if (/do not|never|must not|prohibited/i.test(template)) constraintTypes.push('negative constraints');
  if (/stance|position|do not concede|consistent/i.test(template)) constraintTypes.push('stance-lock');
  if (/json|schema|format:|return only/i.test(template)) constraintTypes.push('output format');
  if (/memory|past statement|context|history/i.test(template)) constraintTypes.push('context injection');

  return {
    structural_elements: structuralElements,
    tone_modifiers: toneModifiers,
    constraint_types: constraintTypes,
    length_category: wordCount < 80 ? 'short' : wordCount < 200 ? 'medium' : 'long',
    has_few_shot_examples: structuralElements.includes('few-shot examples'),
    has_explicit_format: constraintTypes.includes('output format'),
    has_persona_grounding: structuralElements.includes('persona grounding'),
  };
}

// ─── Pattern Discovery ────────────────────────────────────────────────────────
// Analyzes all promoted prompt versions to find which structural features
// correlate with higher composite scores. Uses Gemini to synthesize patterns.

export async function discoverPatterns(): Promise<{ discovered: number; patterns: string[] }> {
  // Fetch top-performing promoted prompts vs archived (failed) prompts
  const [winners, losers] = await Promise.all([
    pool.query(`
      SELECT task_type, template, composite_score, metrics
      FROM prompt_registry
      WHERE status = 'production' AND composite_score > 0.6 AND metrics->>'sample_count' IS NOT NULL
      ORDER BY composite_score DESC LIMIT 10
    `),
    pool.query(`
      SELECT task_type, template, composite_score, metrics
      FROM prompt_registry
      WHERE status = 'archived' AND composite_score < 0.4 AND composite_score > 0
      ORDER BY composite_score ASC LIMIT 10
    `),
  ]);

  if (winners.rows.length < 2) {
    return { discovered: 0, patterns: [] };
  }

  // Extract features from all prompts
  const winnerFeatures = winners.rows.map((r: any) => ({
    features: extractStructuralFeatures(r.template),
    score: parseFloat(r.composite_score),
    task_type: r.task_type,
  }));

  const loserFeatures = losers.rows.map((r: any) => ({
    features: extractStructuralFeatures(r.template),
    score: parseFloat(r.composite_score),
    task_type: r.task_type,
  }));

  // Find features that appear in winners but not in losers (discriminative features)
  const winnerElementSet = new Set(winnerFeatures.flatMap(f => f.features.structural_elements));
  const loserElementSet = new Set(loserFeatures.flatMap(f => f.features.structural_elements));
  const discriminative = [...winnerElementSet].filter(e => !loserElementSet.has(e));

  const winnerToneSet = new Set(winnerFeatures.flatMap(f => f.features.tone_modifiers));
  const loserToneSet = new Set(loserFeatures.flatMap(f => f.features.tone_modifiers));
  const discriminativeTone = [...winnerToneSet].filter(e => !loserToneSet.has(e));

  if (discriminative.length === 0 && discriminativeTone.length === 0) {
    return { discovered: 0, patterns: [] };
  }

  // Use Gemini to synthesize a human-readable pattern description
  try {
    const model = getModel();
    const avgWinScore = winnerFeatures.reduce((s, f) => s + f.score, 0) / winnerFeatures.length;

    const prompt = `You are analyzing AI prompt performance data to discover what makes prompts work better.

HIGH-PERFORMING PROMPTS (avg score: ${avgWinScore.toFixed(2)}) contained these structural elements:
- Structural: ${discriminative.join(', ') || 'none distinctive'}
- Tone modifiers: ${discriminativeTone.join(', ') || 'none distinctive'}

LOW-PERFORMING PROMPTS lacked these features.

Task types: ${[...new Set(winnerFeatures.map(f => f.task_type))].join(', ')}

Return ONLY valid JSON with no markdown:
{
  "patterns": [
    {
      "description": "one clear sentence describing what structural pattern improves performance",
      "elements": ["element1", "element2"],
      "estimated_lift": "XX% improvement in [metric]",
      "applicability": "which task types benefit most"
    }
  ]
}

Generate 1-3 patterns. Be specific about mechanisms, not vague generalizations.`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    const discovered: string[] = [];
    for (const p of (parsed.patterns || [])) {
      await upsertPattern({
        pattern_description: p.description,
        task_type: winnerFeatures[0].task_type,
        pattern_features: {
          structural_elements: p.elements || discriminative,
          tone_modifiers: discriminativeTone,
          constraint_types: [],
          length_category: 'medium',
          has_few_shot_examples: discriminative.includes('few-shot examples'),
          has_explicit_format: false,
          has_persona_grounding: discriminative.includes('persona grounding'),
        },
        avg_reward: avgWinScore,
        sample_count: winnerFeatures.length,
      });
      discovered.push(p.description);
    }

    return { discovered: discovered.length, patterns: discovered };
  } catch {
    return { discovered: 0, patterns: [] };
  }
}

// ─── Pattern Application ──────────────────────────────────────────────────────
// Given a base prompt template, apply the highest-scoring known pattern
// to generate a candidate improved version.

export async function applyBestPattern(
  taskType: string,
  baseTemplate: string
): Promise<{ applied: boolean; improved?: string; pattern?: string }> {
  const patterns = await pool.query(
    `SELECT * FROM prompt_patterns WHERE task_type = $1 ORDER BY avg_reward DESC LIMIT 3`,
    [taskType]
  );

  if (!patterns.rows.length) return { applied: false };

  const best: PromptPattern = patterns.rows[0];
  const features: PatternFeatures = best.pattern_features;

  try {
    const model = getModel();
    const elementsStr = features.structural_elements.join(', ');

    const prompt = `You are improving an AI prompt by applying a proven pattern.

PROVEN PATTERN: "${best.pattern_description}"
Structural elements to incorporate: ${elementsStr}
Tone modifiers: ${features.tone_modifiers.join(', ')}

BASE PROMPT:
"${baseTemplate.slice(0, 1000)}"

TASK: Rewrite the base prompt incorporating the proven pattern elements where natural.
Do NOT change the task purpose, safety constraints, or output format requirements.
Add or strengthen: ${elementsStr}

Return ONLY valid JSON with no markdown:
{
  "improved_template": "the full improved prompt text",
  "changes_made": "brief description of what was added or changed"
}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);

    if (!parsed.improved_template || parsed.improved_template.length < 50) return { applied: false };

    return {
      applied: true,
      improved: parsed.improved_template,
      pattern: best.pattern_description,
    };
  } catch {
    return { applied: false };
  }
}

// ─── Pattern Listing ──────────────────────────────────────────────────────────

export async function listPatterns(): Promise<PromptPattern[]> {
  const res = await pool.query(
    `SELECT * FROM prompt_patterns ORDER BY avg_reward DESC, sample_count DESC`
  );
  return res.rows;
}

// ─── Meta-Learning Summary (for observability) ────────────────────────────────

export async function getMetaLearningSummary(): Promise<{
  total_patterns: number;
  top_elements: { element: string; frequency: number }[];
  avg_pattern_reward: number;
  last_discovery: string | null;
}> {
  const res = await pool.query(`
    SELECT
      COUNT(*)::int as total,
      AVG(avg_reward) as avg_reward,
      MAX(discovered_at) as last_discovery,
      ARRAY_AGG(pattern_features) as all_features
    FROM prompt_patterns
  `);

  const r = res.rows[0];
  if (!r || !r.total) {
    return { total_patterns: 0, top_elements: [], avg_pattern_reward: 0, last_discovery: null };
  }

  // Aggregate structural elements across all patterns
  const elementCounts: Record<string, number> = {};
  for (const featureJson of (r.all_features || [])) {
    const f: PatternFeatures = featureJson;
    for (const el of (f.structural_elements || [])) {
      elementCounts[el] = (elementCounts[el] || 0) + 1;
    }
  }

  const topElements = Object.entries(elementCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([element, frequency]) => ({ element, frequency }));

  return {
    total_patterns: r.total,
    top_elements: topElements,
    avg_pattern_reward: parseFloat(r.avg_reward) || 0,
    last_discovery: r.last_discovery,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsertPattern(data: Omit<PromptPattern, 'id' | 'discovered_at' | 'last_seen_at'>): Promise<void> {
  await pool.query(`
    INSERT INTO prompt_patterns (pattern_description, task_type, pattern_features, avg_reward, sample_count, last_seen_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT DO NOTHING
  `, [data.pattern_description, data.task_type, JSON.stringify(data.pattern_features), data.avg_reward, data.sample_count]);
}
