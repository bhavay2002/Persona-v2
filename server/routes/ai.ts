import { Router } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import {
  compilePersonaPrompt,
  classifyIntent,
  buildExplanation,
  PersonaSchema,
} from '../lib/promptCompiler.js';
import {
  buildCounterargumentPrompt,
  buildOpeningPrompt,
  DebateParticipant,
} from '../lib/debateEngine.js';
import { evolvePersona } from '../lib/personaEvolution.js';
import { retrievePersonaContext, buildRAGPrompt } from '../lib/rag.js';
import { addJob } from '../lib/jobQueue.js';
import { getCachedAI, setCachedAI } from '../lib/cache.js';
import { regexFilter, moderateInput, moderateOutput } from '../lib/moderationPipeline.js';
import { getPromptVariantModifier } from '../lib/experimentEngine.js';
import { aiLatency } from '../lib/metrics.js';
import { getModel, GEMINI_MODEL } from '../lib/gemini.js';

const router = Router();

// ─── Per-persona in-memory rate limiter (20 calls / 60s per persona) ─────────
// Note: resets on restart and doesn't span replicas — sufficient for dev/single-node.

const rateLimitMap = new Map<number, { count: number; resetAt: number }>();
function checkRateLimit(personaId: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(personaId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(personaId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 20) return false;
  entry.count++;
  return true;
}

// ─── Helper: build PersonaSchema from a DB row ────────────────────────────────
function rowToSchema(p: any): PersonaSchema {
  return {
    name: p.name,
    archetype: p.archetype,
    tone: (p.tone_formality !== null && p.tone_formality !== undefined) ? {
      formality: parseFloat(p.tone_formality),
      emotionality: parseFloat(p.tone_emotionality),
      assertiveness: parseFloat(p.tone_assertiveness),
    } : undefined,
    beliefs: Array.isArray(p.beliefs) ? p.beliefs : (typeof p.beliefs === 'string' ? JSON.parse(p.beliefs) : (p.beliefs || [])),
    expertise: p.expertise || [],
    rhetorical_style: p.rhetorical_style || [],
    taboos: p.taboos || [],
    goals: p.goals || [],
    constraints_list: p.constraints_list || [],
    legacy_tone: p.tone,
    ideology: p.ideology,
  };
}

// ─── POST /ai/rewrite ─────────────────────────────────────────────────────────
// Rewrites user text in the voice of a given persona.

router.post('/rewrite', authenticateToken, async (req: AuthRequest, res) => {
  const end = aiLatency.startTimer({ operation: 'rewrite', model: GEMINI_MODEL });
  const { text, personaId } = req.body;
  if (!text || !personaId) return res.status(400).json({ error: 'text and personaId required' });
  if (!checkRateLimit(personaId)) return res.status(429).json({ error: 'Rate limit reached. Try again in a minute.' });

  const regexCheck = regexFilter(text);
  if (regexCheck.blocked) return res.status(400).json({ error: 'Content violates safety policy' });

  try {
    const inputMod = await moderateInput(text);
    if (inputMod.action === 'block') {
      end();
      return res.status(400).json({ error: 'Content flagged by safety filter', categories: inputMod.categories, severity: inputMod.severity });
    }

    const persona = await pool.query('SELECT * FROM personas WHERE id = $1', [personaId]);
    if (!persona.rows.length) { end(); return res.status(404).json({ error: 'Persona not found' }); }

    const schema = rowToSchema(persona.rows[0]);
    const compiled = compilePersonaPrompt(schema);
    const intent = classifyIntent(text);
    const ragContext = await retrievePersonaContext(personaId, text, 5);
    const taskInstruction = `INTENT ANALYSIS: This input is ${intent.type.toUpperCase()} in nature (${Math.round(intent.confidence * 100)}% confidence).
ADJUSTMENT: ${intent.adjustments}

TASK: Rewrite the following text in your persona's authentic voice. Keep it concise (2-4 sentences), impactful, and unmistakably "you".

USER INPUT: "${text}"

Respond with ONLY the rewritten text. No labels, no preamble, no explanation.`;

    const ragPrompt = buildRAGPrompt(compiled.full, ragContext, taskInstruction);
    const variantModifier = req.userId ? getPromptVariantModifier(req.userId) : '';
    const fullPrompt = ragPrompt + variantModifier;

    const result = await getModel().generateContent(fullPrompt);
    const rewritten = result.response.text().trim();

    const outputMod = await moderateOutput(rewritten);
    if (outputMod.action === 'block') {
      end();
      return res.status(400).json({ error: 'Generated content was blocked by output safety filter. Try rephrasing.' });
    }

    const explanation = buildExplanation(schema, intent, rewritten);
    await pool.query('UPDATE personas SET reputation_score = LEAST(100, reputation_score + 0.5) WHERE id = $1', [personaId]);
    addJob('evaluate-post-preview', { personaId, personaProfile: compiled.full, userInput: text, aiOutput: rewritten, pastContext: ragContext.pastPosts.slice(0, 3) });
    if (req.userId) {
      addJob('analytics-event', { experimentName: 'prompt-tone', userId: req.userId, eventType: 'rewrite', metricValue: 1, entityId: parseInt(personaId) });
    }

    res.json({
      rewritten, original: text,
      intent: { type: intent.type, confidence: intent.confidence },
      explanation,
      promptVersion: 'v2.1-rag',
      moderation: { inputAction: inputMod.action, outputAction: outputMod.action, toxicity: outputMod.toxicity },
      ragContext: { retrieved: ragContext.pastPosts.length, method: ragContext.retrievalMethod, summary: ragContext.contextSummary },
    });
  } catch (err) {
    console.error('AI rewrite error:', err);
    res.status(500).json({ error: 'AI service error' });
  } finally {
    end();
  }
});

// ─── POST /ai/generate-argument ───────────────────────────────────────────────
// Generates a debate argument for a persona, using prior debate history for context.

router.post('/generate-argument', authenticateToken, async (req: AuthRequest, res) => {
  const end = aiLatency.startTimer({ operation: 'debate', model: GEMINI_MODEL });
  const { topic, personaId, side, previousMessages = [], debateId } = req.body;
  if (!topic || !personaId) return res.status(400).json({ error: 'topic and personaId required' });

  try {
    const personaRes = await pool.query('SELECT * FROM personas WHERE id = $1', [personaId]);
    if (!personaRes.rows.length) return res.status(404).json({ error: 'Persona not found' });
    const persona = personaRes.rows[0];
    const schema = rowToSchema(persona);

    const participant: DebateParticipant = {
      personaId: parseInt(personaId),
      personaSchema: schema,
      stance: side || 'for',
    };

    const isOpening = !previousMessages || previousMessages.length === 0;
    const prompt = isOpening
      ? buildOpeningPrompt(participant, topic)
      : buildCounterargumentPrompt(
          participant,
          topic,
          previousMessages[previousMessages.length - 1]?.content || '',
          previousMessages.slice(-3)
        );

    const cacheKey = `debate:${personaId}:${topic}:${isOpening}`;
    const cached = getCachedAI(cacheKey);
    if (cached) return res.json({ argument: cached, cached: true });

    const result = await getModel().generateContent(prompt);
    const argument = result.response.text().trim();

    setCachedAI(cacheKey, argument);

    if (debateId) {
      addJob('extract-claims', { text: argument, personaId, debateMessageId: debateId });
    }

    res.json({ argument, personaName: persona.name, promptVersion: 'v2.1' });
  } catch (err) {
    console.error('generate-argument error:', err);
    res.status(500).json({ error: 'AI service error' });
  } finally {
    end();
  }
});

// ─── POST /ai/enhance-persona ─────────────────────────────────────────────────
// Uses AI to suggest improved beliefs, goals, and rhetorical style for a persona.

router.post('/enhance-persona', authenticateToken, async (req: AuthRequest, res) => {
  const end = aiLatency.startTimer({ operation: 'enhance', model: GEMINI_MODEL });
  const { name, archetype, ideology, tone, expertise, beliefs = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const prompt = `You are an AI character designer for a debate and identity platform.

Persona to enhance:
- Name: "${name}"
- Archetype: ${archetype || 'unknown'}
- Ideology: ${ideology || 'independent'}
- Tone: ${tone || 'balanced'}
- Expertise: ${Array.isArray(expertise) ? expertise.join(', ') : (expertise || 'general')}
- Current beliefs: ${beliefs.length > 0 ? JSON.stringify(beliefs.slice(0, 3)) : 'none'}

Generate enhanced persona attributes. Return ONLY valid JSON:
{
  "beliefs": [
    {"topic": "string", "stance": "string (1 sentence)", "strength": 0.0-1.0}
  ],
  "goals": ["goal 1", "goal 2", "goal 3"],
  "rhetorical_style": ["technique 1", "technique 2"],
  "taboos": ["what this persona never says or does"],
  "expertise": ["domain 1", "domain 2"],
  "evolution_summary": "One sentence describing what makes this persona distinctive"
}

Return 3 beliefs, 3 goals, 2 rhetorical styles, 2 taboos, 3 expertise domains.`;

    const result = await getModel().generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const enhanced = JSON.parse(raw);

    res.json({ enhanced, promptVersion: 'v2.1' });
  } catch (err) {
    console.error('enhance-persona error:', err);
    res.status(500).json({ error: 'AI service error' });
  } finally {
    end();
  }
});

// ─── POST /ai/suggest-persona ─────────────────────────────────────────────────
// Suggests a complete persona profile from a keyword or brief description.

router.post('/suggest-persona', authenticateToken, async (req: AuthRequest, res) => {
  const end = aiLatency.startTimer({ operation: 'suggest', model: GEMINI_MODEL });
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });

  try {
    const cacheKey = `suggest:${keyword.toLowerCase().slice(0, 50)}`;
    const cached = getCachedAI(cacheKey);
    if (cached) return res.json({ persona: JSON.parse(cached), cached: true });

    const prompt = `You are an AI character designer for a debate and opinion platform called Persona.

Create a compelling, opinionated persona based on this keyword/concept: "${keyword}"

Return ONLY valid JSON with no markdown:
{
  "name": "Creative persona name (2-3 words)",
  "archetype": "e.g. The Contrarian, The Pragmatist, The Idealist, The Technocrat",
  "ideology": "e.g. libertarian, progressive, conservative, centrist, techno-optimist",
  "tone": "e.g. analytical, passionate, sardonic, measured, provocative",
  "expertise": ["domain 1", "domain 2", "domain 3"],
  "beliefs": [
    {"topic": "governance", "stance": "one sentence", "strength": 0.0-1.0},
    {"topic": "economics", "stance": "one sentence", "strength": 0.0-1.0},
    {"topic": "technology", "stance": "one sentence", "strength": 0.0-1.0}
  ],
  "goals": ["goal 1", "goal 2"],
  "rhetorical_style": ["technique 1", "technique 2"],
  "evolution_summary": "What makes this persona distinctive in one sentence"
}`;

    const result = await getModel().generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const persona = JSON.parse(raw);

    setCachedAI(cacheKey, JSON.stringify(persona));
    res.json({ persona, promptVersion: 'v2.1' });
  } catch (err) {
    console.error('suggest-persona error:', err);
    res.status(500).json({ error: 'AI service error' });
  } finally {
    end();
  }
});

// ─── POST /ai/evolve-persona ──────────────────────────────────────────────────
// Triggers AI-driven persona evolution based on posting/debate history.

router.post('/evolve-persona', authenticateToken, async (req: AuthRequest, res) => {
  const end = aiLatency.startTimer({ operation: 'evolve', model: GEMINI_MODEL });
  const { personaId } = req.body;
  if (!personaId) return res.status(400).json({ error: 'personaId required' });

  try {
    const personaCheck = await pool.query('SELECT user_id FROM personas WHERE id = $1', [personaId]);
    if (!personaCheck.rows.length) return res.status(404).json({ error: 'Persona not found' });
    if (personaCheck.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your persona' });

    const result = await evolvePersona(personaId);
    await pool.query('UPDATE personas SET last_evolved_at = NOW() WHERE id = $1', [personaId]);

    res.json({ evolved: true, ...result });
  } catch (err) {
    console.error('evolve-persona error:', err);
    res.status(500).json({ error: 'AI service error' });
  } finally {
    end();
  }
});

// ─── POST /ai/opposite-persona ────────────────────────────────────────────────
// Generates a persona that is the ideological/rhetorical opposite of a given one.

router.post('/opposite-persona', authenticateToken, async (req: AuthRequest, res) => {
  const end = aiLatency.startTimer({ operation: 'opposite', model: GEMINI_MODEL });
  const { sourcePersonaId } = req.body;

  try {
    let sourceContext = '';

    if (sourcePersonaId) {
      const sourceRes = await pool.query('SELECT * FROM personas WHERE id = $1', [sourcePersonaId]);
      if (sourceRes.rows.length) {
        const src = sourceRes.rows[0];
        const srcBeliefs = Array.isArray(src.beliefs)
          ? src.beliefs
          : (typeof src.beliefs === 'string' ? JSON.parse(src.beliefs || '[]') : []);
        sourceContext = `
Source Persona to oppose:
- Name: "${src.name}"
- Archetype: ${src.archetype || 'unknown'}
- Ideology: ${src.ideology || 'unknown'}
- Tone: ${src.tone || 'balanced'}
- Beliefs: ${JSON.stringify(srcBeliefs.slice(0, 2))}`;
      }
    }

    const prompt = `You are an AI character designer for a debate platform.

Create a persona that is the ideological and rhetorical OPPOSITE of the source persona below.
The opposite persona should disagree on core issues, use contrasting rhetoric, and have an opposing worldview.
${sourceContext || 'Source: A centrist, analytical, measured debater.'}

Return ONLY valid JSON:
{
  "name": "Creative name (2-3 words)",
  "archetype": "opposing archetype",
  "ideology": "opposing ideology",
  "tone": "contrasting tone",
  "expertise": ["domain 1", "domain 2"],
  "beliefs": [
    {"topic": "governance", "stance": "contrasting stance", "strength": 0.85},
    {"topic": "economics", "stance": "contrasting stance", "strength": 0.80}
  ],
  "goals": ["opposing goal 1", "opposing goal 2"],
  "rhetorical_style": ["contrasting technique"],
  "evolution_summary": "What makes this the perfect opponent"
}`;

    const result = await getModel().generateContent(prompt);
    const raw = result.response.text().trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const persona = JSON.parse(raw);

    res.json({ persona, promptVersion: 'v2.1' });
  } catch (err) {
    console.error('opposite-persona error:', err);
    res.status(500).json({ error: 'AI service error' });
  } finally {
    end();
  }
});

export default router;
