import pool from '../db.js';
import { getModel } from './gemini.js';


// ─── Types ───────────────────────────────────────────────────────────────────

export interface CognitiveMetrics {
  thinking_style: 'analytical' | 'emotional' | 'persuasive' | 'intuitive';
  cognitive_biases: { name: string; confidence: number }[];
  argument_complexity: number;
  openness_score: number;
  certainty_score: number;
  emotional_intensity: number;
  explanation: string;
}

export interface Contradiction {
  claim_a: string;
  claim_b: string;
  type: 'direct' | 'contextual' | 'value-based';
  severity: number;
  explanation: string;
}

export interface LongitudinalInsight {
  trend_summary: string;
  key_changes: string[];
  growth_assessment: 'Early Stage' | 'Developing' | 'Maturing' | 'Highly Evolved';
  recommendations: string;
}

// ─── A. Cognitive Metrics ────────────────────────────────────────────────────

// Rule-based fallback — activates when LLM quota is exhausted (429)
function ruleBasedAnalysis(text: string): { metrics: CognitiveMetrics; claims: string[] } {
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).length;
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
  const avgSentLen = words / Math.max(sentences.length, 1);

  const reasoningWords = (lower.match(/\b(because|therefore|thus|hence|however|evidence|research|shows|demonstrates|analysis|consider|suggests|implies)\b/g) || []).length;
  const hedgeWords     = (lower.match(/\b(might|perhaps|possibly|may|could|arguably|often|typically|it seems|in some cases|some argue)\b/g) || []).length;
  const absoluteWords  = (lower.match(/\b(always|never|definitely|certainly|obviously|clearly|undoubtedly|must|everyone|no one|impossible)\b/g) || []).length;
  const emotionalWords = (lower.match(/\b(outrage|love|hate|fear|terrible|amazing|awful|fantastic|devastating|shocking|horrifying|injustice)\b/g) || []).length;
  const persuasiveWords = (lower.match(/\b(should|must|we need|it is essential|demand|require|it is vital|urgent|critical|imperative)\b/g) || []).length;
  const exclamations   = (text.match(/!/g) || []).length;

  const argument_complexity = Math.min(1, Math.max(0, (reasoningWords / Math.max(words, 1)) * 25 + (avgSentLen > 22 ? 0.25 : 0) + (avgSentLen > 30 ? 0.2 : 0)));
  const openness_score      = Math.min(1, Math.max(0, 0.5 + (hedgeWords - absoluteWords) * 0.08));
  const certainty_score     = Math.min(1, Math.max(0, 0.5 + absoluteWords * 0.1 - hedgeWords * 0.05));
  const emotional_intensity = Math.min(1, Math.max(0, emotionalWords * 0.18 + exclamations * 0.12));

  let thinking_style: 'analytical' | 'emotional' | 'persuasive' | 'intuitive' = 'analytical';
  if (emotional_intensity > 0.35)           thinking_style = 'emotional';
  else if (persuasiveWords > 1)             thinking_style = 'persuasive';
  else if (argument_complexity > 0.3 || avgSentLen > 20) thinking_style = 'analytical';
  else                                      thinking_style = 'intuitive';

  // Detect likely biases from content patterns
  const biases: { name: string; confidence: number }[] = [];
  if ((lower.match(/\b(always been|tradition|historically|has always)\b/g) || []).length > 0)
    biases.push({ name: 'status_quo_bias', confidence: 0.6 });
  if (absoluteWords > 2)
    biases.push({ name: 'confirmation_bias', confidence: Math.min(0.9, absoluteWords * 0.15) });
  if (persuasiveWords > 2)
    biases.push({ name: 'appeal_to_authority', confidence: 0.55 });

  const claims = sentences.filter(s => s.trim().length > 25).slice(0, 4).map(s => s.trim().slice(0, 120));

  return {
    metrics: {
      thinking_style,
      cognitive_biases: biases.slice(0, 3),
      argument_complexity: parseFloat(argument_complexity.toFixed(2)),
      openness_score:      parseFloat(openness_score.toFixed(2)),
      certainty_score:     parseFloat(certainty_score.toFixed(2)),
      emotional_intensity: parseFloat(emotional_intensity.toFixed(2)),
      explanation: 'Linguistic pattern analysis',
    },
    claims,
  };
}

// Single combined LLM call — falls back to rule-based on quota/rate errors
export async function analyzePost(text: string): Promise<{ metrics: CognitiveMetrics; claims: string[] }> {
  try {
    const model = getModel();
    const prompt = `You are a cognitive analysis engine trained in psychology and argumentation theory.

Analyze this text and return ONLY valid JSON with no markdown, backticks, or extra text:

{"thinking_style":"analytical","cognitive_biases":[{"name":"confirmation_bias","confidence":0.78}],"argument_complexity":0.7,"openness_score":0.6,"certainty_score":0.8,"emotional_intensity":0.3,"explanation":"short explanation","claims":["core claim one","core claim two","core claim three"]}

Rules:
- thinking_style: exactly one of "analytical" | "emotional" | "persuasive" | "intuitive"
- argument_complexity: 0=simple assertion, 1=multi-step evidence-based reasoning with nuance
- openness_score: 0=rigid/absolute, 1=acknowledges uncertainty and opposing views
- certainty_score: 0=very uncertain language, 1=absolute confidence
- emotional_intensity: 0=purely factual, 1=highly emotionally charged
- cognitive_biases: up to 3 prominent biases (confirmation_bias, availability_bias, anchoring_bias, dunning_kruger_effect, appeal_to_authority, strawman, false_dilemma) with confidence 0-1
- claims: 3-5 complete standalone factual/value assertions from the text

Text: "${text.slice(0, 700).replace(/"/g, "'")}"`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);
    return {
      metrics: {
        thinking_style: parsed.thinking_style || 'analytical',
        cognitive_biases: parsed.cognitive_biases || [],
        argument_complexity: parseFloat(parsed.argument_complexity) || 0.5,
        openness_score:      parseFloat(parsed.openness_score) || 0.5,
        certainty_score:     parseFloat(parsed.certainty_score) || 0.5,
        emotional_intensity: parseFloat(parsed.emotional_intensity) || 0.5,
        explanation: parsed.explanation || '',
      },
      claims: parsed.claims || [],
    };
  } catch (err: any) {
    // On rate-limit (429), use rule-based analysis so the job still completes with real data
    if (err?.message?.includes('429') || err?.message?.includes('quota')) {
      return ruleBasedAnalysis(text);
    }
    throw err;
  }
}

// Kept for backwards compatibility — re-export as separate functions
export async function analyzeCognitive(text: string): Promise<CognitiveMetrics> {
  const { metrics } = await analyzePost(text);
  return metrics;
}

export async function extractClaims(text: string): Promise<string[]> {
  const { claims } = await analyzePost(text);
  return claims;
}

// ─── B. Longitudinal Analysis ────────────────────────────────────────────────

export async function generateLongitudinalInsight(timeseries: any[]): Promise<LongitudinalInsight> {
  if (timeseries.length < 2) {
    return {
      trend_summary: 'Insufficient data for trend analysis. Post more to unlock temporal insights.',
      key_changes: [],
      growth_assessment: 'Early Stage',
      recommendations: 'Continue posting across diverse topics to build a meaningful behavioral profile.',
    };
  }
  try {
    const model = getModel();
    const dataStr = timeseries.map((t: any) =>
      `Week of ${t.period_start}: complexity=${Math.round(parseFloat(t.avg_argument_complexity) * 100)}%, openness=${Math.round(parseFloat(t.avg_openness_score) * 100)}%, emotionality=${Math.round(parseFloat(t.avg_emotional_intensity) * 100)}%, certainty=${Math.round(parseFloat(t.avg_certainty_score) * 100)}%, style=${t.dominant_thinking_style || 'mixed'}, posts=${t.post_count}`
    ).join('\n');

    const prompt = `You are a behavioral analyst specializing in cognitive evolution patterns.

Weekly cognitive metrics for a persona:
${dataStr}

Identify trends and behavioral evolution. Return ONLY valid JSON with no markdown:
{"trend_summary":"1-2 sentence description of the overall cognitive evolution trend","key_changes":["specific measurable change 1","specific measurable change 2"],"growth_assessment":"Early Stage","recommendations":"one actionable sentence"}

growth_assessment must be exactly one of: "Early Stage" | "Developing" | "Maturing" | "Highly Evolved"
key_changes: list exactly 2-3 specific percentage-based changes you can observe`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);
    return {
      trend_summary: parsed.trend_summary || 'Stable cognitive pattern detected.',
      key_changes: parsed.key_changes || [],
      growth_assessment: parsed.growth_assessment || 'Developing',
      recommendations: parsed.recommendations || '',
    };
  } catch {
    return { trend_summary: 'Trend analysis temporarily unavailable.', key_changes: [], growth_assessment: 'Developing', recommendations: '' };
  }
}

export async function aggregateCognitiveTimeseries(personaId: number): Promise<void> {
  // Upsert weekly aggregated data
  await pool.query(
    `INSERT INTO persona_cognitive_timeseries
       (persona_id, period_start, period_end, avg_emotional_intensity, avg_argument_complexity, avg_openness_score, avg_certainty_score, dominant_thinking_style, post_count)
     SELECT
       p.persona_id,
       DATE_TRUNC('week', p.created_at)::date                            AS period_start,
       (DATE_TRUNC('week', p.created_at) + INTERVAL '6 days')::date     AS period_end,
       COALESCE(AVG((pts.cognitive_metrics->>'emotional_intensity')::numeric), 0),
       COALESCE(AVG((pts.cognitive_metrics->>'argument_complexity')::numeric), 0),
       COALESCE(AVG((pts.cognitive_metrics->>'openness_score')::numeric), 0),
       COALESCE(AVG((pts.cognitive_metrics->>'certainty_score')::numeric), 0),
       MODE() WITHIN GROUP (ORDER BY pts.thinking_style),
       COUNT(*)::int
     FROM posts p
     JOIN post_thinking_styles pts ON pts.post_id = p.id
     WHERE p.persona_id = $1 AND pts.cognitive_metrics IS NOT NULL
     GROUP BY p.persona_id, DATE_TRUNC('week', p.created_at)
     ON CONFLICT DO NOTHING`,
    [personaId]
  );

  // Compute and cache longitudinal insight if enough weeks
  const ts = await pool.query(
    'SELECT * FROM persona_cognitive_timeseries WHERE persona_id = $1 ORDER BY period_start ASC',
    [personaId]
  );
  if (ts.rows.length >= 2) {
    const insight = await generateLongitudinalInsight(ts.rows);
    await pool.query(
      'UPDATE personas SET longitudinal_insight = $1 WHERE id = $2',
      [JSON.stringify(insight), personaId]
    );
  }
}

// ─── C. Cross-Persona Contradiction Detection ─────────────────────────────

export async function detectContradictions(
  personaAName: string, claimsA: string[],
  personaBName: string, claimsB: string[]
): Promise<{ contradictions: Contradiction[]; overall_conflict_score: number }> {
  if (claimsA.length === 0 || claimsB.length === 0) {
    return { contradictions: [], overall_conflict_score: 0 };
  }
  try {
    const model = getModel();
    const prompt = `You are a logical consistency analyzer. Identify genuine ideological contradictions between two personas.

Return ONLY valid JSON with no markdown:
{"contradictions":[{"claim_a":"exact quote","claim_b":"exact quote","type":"direct","severity":0.0,"explanation":"why they conflict"}],"overall_conflict_score":0.0}

type: "direct" (directly opposite claims) | "contextual" (conflict in specific context) | "value-based" (ethical/values inconsistency)
severity: 0.0-1.0, overall_conflict_score: 0.0-1.0
Return empty contradictions array if no real logical conflicts exist — different viewpoints alone are NOT contradictions.
Only flag genuine logical inconsistencies where both claims cannot simultaneously be true.

${personaAName} claims:
${claimsA.slice(0, 8).map((c, i) => `${i + 1}. ${c}`).join('\n')}

${personaBName} claims:
${claimsB.slice(0, 8).map((c, i) => `${i + 1}. ${c}`).join('\n')}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(raw);
    return {
      contradictions: parsed.contradictions || [],
      overall_conflict_score: parseFloat(parsed.overall_conflict_score) || 0,
    };
  } catch {
    return { contradictions: [], overall_conflict_score: 0 };
  }
}

// ─── D. Cognitive Dissonance Score (CDS) ─────────────────────────────────────
//
// Formal definition:  CDS(user) = (1/N) * Σ D(c_a, c_b)
// where D is the pairwise conflict_score from persona_contradictions,
// N is the number of cross-persona persona pairs with sufficient claim data.
//
// Returns a score in [0, 1] plus an interpretation and dominant conflict domains.

export interface CDSResult {
  user_id: number;
  cds_score: number;               // 0 = fully consistent, 1 = maximally dissonant
  interpretation: 'Low' | 'Moderate' | 'High' | 'Very High';
  dominant_conflict_domains: string[];
  persona_count: number;
  pair_count: number;
  conflict_pairs: Array<{ persona_a: string; persona_b: string; score: number; top_contradiction?: string }>;
  computed_at: string;
}

function interpretCDS(score: number): CDSResult['interpretation'] {
  if (score < 0.25) return 'Low';
  if (score < 0.45) return 'Moderate';
  if (score < 0.65) return 'High';
  return 'Very High';
}

export async function computeCDS(userId: number): Promise<CDSResult> {
  // 1. Fetch all cross-persona contradiction pairs for this user
  const pairsRes = await pool.query(
    `SELECT
       pc.persona_a_id, pc.persona_b_id, pc.conflict_score, pc.contradictions,
       pa.name AS name_a, pb.name AS name_b
     FROM persona_contradictions pc
     JOIN personas pa ON pa.id = pc.persona_a_id
     JOIN personas pb ON pb.id = pc.persona_b_id
     WHERE pc.user_id = $1`,
    [userId]
  );

  const personaCountRes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM personas WHERE user_id = $1 AND status != 'archived'`,
    [userId]
  );
  const personaCount: number = personaCountRes.rows[0]?.c || 0;

  if (pairsRes.rows.length === 0) {
    const empty: CDSResult = {
      user_id: userId, cds_score: 0, interpretation: 'Low',
      dominant_conflict_domains: [], persona_count: personaCount,
      pair_count: 0, conflict_pairs: [], computed_at: new Date().toISOString(),
    };
    await upsertCDS(userId, empty);
    return empty;
  }

  // 2. Compute CDS = mean conflict_score across all pairs (the contradiction function D)
  const scores = pairsRes.rows.map((r: any) => parseFloat(r.conflict_score) || 0);
  const cds_score = parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3));

  // 3. Extract dominant conflict domains from contradiction explanations
  const allExplanations: string[] = pairsRes.rows.flatMap((r: any) => {
    const contradictions = r.contradictions || [];
    return contradictions.map((c: any) => c.explanation || '');
  });
  const domainKeywords: Record<string, string[]> = {
    'AI ethics': ['ai', 'artificial intelligence', 'algorithm', 'automation', 'robot'],
    'economics': ['econom', 'market', 'capital', 'wealth', 'tax', 'fiscal', 'trade'],
    'politics': ['government', 'democrat', 'republican', 'policy', 'election', 'vote'],
    'environment': ['climate', 'environment', 'carbon', 'sustainable', 'fossil', 'energy'],
    'social justice': ['equity', 'race', 'gender', 'discriminat', 'justice', 'inequality'],
    'science': ['research', 'data', 'evidence', 'study', 'scientif', 'empirical'],
    'religion': ['faith', 'god', 'religious', 'spiritual', 'moral', 'ethics'],
    'technology': ['technolog', 'digital', 'privacy', 'data', 'platform', 'internet'],
  };
  const domainScores: Record<string, number> = {};
  const allText = allExplanations.join(' ').toLowerCase();
  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    const hits = keywords.filter(k => allText.includes(k)).length;
    if (hits > 0) domainScores[domain] = hits;
  }
  const dominant_conflict_domains = Object.entries(domainScores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([d]) => d);

  // 4. Build conflict pair summaries for UI
  const conflict_pairs = pairsRes.rows.map((r: any) => {
    const contras = r.contradictions || [];
    const top = contras.sort((a: any, b: any) => (b.severity || 0) - (a.severity || 0))[0];
    return {
      persona_a: r.name_a,
      persona_b: r.name_b,
      score: parseFloat(parseFloat(r.conflict_score).toFixed(3)),
      top_contradiction: top ? top.explanation : undefined,
    };
  }).sort((a: any, b: any) => b.score - a.score);

  const result: CDSResult = {
    user_id: userId,
    cds_score,
    interpretation: interpretCDS(cds_score),
    dominant_conflict_domains,
    persona_count: personaCount,
    pair_count: pairsRes.rows.length,
    conflict_pairs,
    computed_at: new Date().toISOString(),
  };

  await upsertCDS(userId, result);
  return result;
}

async function upsertCDS(userId: number, result: CDSResult): Promise<void> {
  await pool.query(
    `INSERT INTO user_cds_scores
       (user_id, cds_score, interpretation, dominant_conflict_domains, persona_count, pair_count, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       cds_score = EXCLUDED.cds_score,
       interpretation = EXCLUDED.interpretation,
       dominant_conflict_domains = EXCLUDED.dominant_conflict_domains,
       persona_count = EXCLUDED.persona_count,
       pair_count = EXCLUDED.pair_count,
       computed_at = NOW()`,
    [userId, result.cds_score, result.interpretation,
     result.dominant_conflict_domains, result.persona_count, result.pair_count]
  );
}

export async function detectContradictionsForUser(userId: number, personaIds: number[]): Promise<void> {
  if (personaIds.length < 2) return;

  // Build claim sets per persona (from post_thinking_styles.claims)
  const claimsMap: Record<number, { name: string; claims: string[] }> = {};
  for (const pid of personaIds.slice(0, 5)) {
    const [pRes, claimsRes] = await Promise.all([
      pool.query('SELECT name FROM personas WHERE id = $1', [pid]),
      pool.query(
        `SELECT pts.claims FROM post_thinking_styles pts
         JOIN posts p ON pts.post_id = p.id
         WHERE p.persona_id = $1 AND pts.claims IS NOT NULL
         ORDER BY p.created_at DESC LIMIT 10`,
        [pid]
      ),
    ]);
    if (!pRes.rows.length) continue;
    const allClaims: string[] = claimsRes.rows.flatMap((r: any) => r.claims || []).slice(0, 12);
    if (allClaims.length > 0) {
      claimsMap[pid] = { name: pRes.rows[0].name, claims: allClaims };
    }
  }

  const pids = Object.keys(claimsMap).map(Number);
  if (pids.length < 2) return;

  // Pairwise contradiction detection
  for (let i = 0; i < pids.length - 1; i++) {
    for (let j = i + 1; j < pids.length; j++) {
      const [pidA, pidB] = [pids[i], pids[j]];
      const { contradictions, overall_conflict_score } = await detectContradictions(
        claimsMap[pidA].name, claimsMap[pidA].claims,
        claimsMap[pidB].name, claimsMap[pidB].claims
      );
      await pool.query(
        `INSERT INTO persona_contradictions
           (user_id, persona_a_id, persona_b_id, contradictions, conflict_score, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (persona_a_id, persona_b_id) DO UPDATE SET
           contradictions = EXCLUDED.contradictions,
           conflict_score = EXCLUDED.conflict_score,
           updated_at     = NOW()`,
        [userId, pidA, pidB, JSON.stringify(contradictions), overall_conflict_score]
      );
    }
  }
}
