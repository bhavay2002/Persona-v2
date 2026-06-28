import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import {
  listRegistry, getAllVersions, registerCandidate, evaluateAndPromote,
  evolvePrompt, updatePromptMetrics, getProductionPrompt,
} from '../lib/promptRegistry.js';
import {
  getExperimentSummary, listActiveExperiments, thompsonSelect,
  updateBanditReward, checkGuardrails,
} from '../lib/banditEngine.js';
import {
  getFeedbackStats, processDelayedRewards, logFeedbackEvent, computeReward,
} from '../lib/feedbackLoop.js';
import {
  listPatterns, discoverPatterns, getMetaLearningSummary, applyBestPattern, extractStructuralFeatures,
} from '../lib/metaLearner.js';
import pool from '../db.js';

const router = Router();

// ─── System Overview ──────────────────────────────────────────────────────────

router.get('/status', async (_req, res) => {
  try {
    const [registryRows, banditRows, feedbackStats, metaSummary, violationsRes] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int as total, COUNT(CASE WHEN status='production' THEN 1 END)::int as production, COUNT(CASE WHEN status='candidate' THEN 1 END)::int as candidates FROM prompt_registry`),
      pool.query(`SELECT COUNT(DISTINCT experiment_name)::int as experiments, SUM(impressions)::int as total_impressions FROM bandit_state`),
      getFeedbackStats(),
      getMetaLearningSummary(),
      pool.query(`SELECT COUNT(*)::int as total FROM guardrail_violations WHERE occurred_at > NOW() - INTERVAL '24 hours'`),
    ]);

    res.json({
      prompt_registry: registryRows.rows[0],
      bandit_engine: banditRows.rows[0],
      feedback_loop: {
        events_last_24h: feedbackStats.events_last_24h,
        avg_reward_last_24h: feedbackStats.avg_reward_last_24h,
        total_events: feedbackStats.total_events,
      },
      meta_learner: metaSummary,
      guardrails: {
        violations_last_24h: violationsRes.rows[0].total,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Prompt Registry ──────────────────────────────────────────────────────────

router.get('/prompts', async (_req, res) => {
  try {
    const registry = await listRegistry();
    res.json({ registry });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/prompts/:key', async (req, res) => {
  try {
    const versions = await getAllVersions(req.params.key);
    res.json({ versions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompts/:key/register', authenticateToken, async (req: AuthRequest, res) => {
  const { taskType, template, constraints } = req.body;
  if (!taskType || !template) return res.status(400).json({ error: 'taskType and template required' });
  try {
    const candidate = await registerCandidate(req.params.key, taskType, template, constraints || {});
    res.json({ candidate });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompts/:key/evaluate/:version', authenticateToken, async (req: AuthRequest, res) => {
  const version = parseInt(req.params.version);
  if (isNaN(version)) return res.status(400).json({ error: 'Invalid version' });
  try {
    const result = await evaluateAndPromote(req.params.key, version);
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompts/:key/evolve', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const result = await evolvePrompt(req.params.key);
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompts/:key/apply-pattern', authenticateToken, async (req: AuthRequest, res) => {
  const { taskType, baseTemplate } = req.body;
  if (!taskType || !baseTemplate) return res.status(400).json({ error: 'taskType and baseTemplate required' });
  try {
    const result = await applyBestPattern(taskType, baseTemplate);
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompts/:key/metrics', authenticateToken, async (req: AuthRequest, res) => {
  const { version, metrics } = req.body;
  if (!version || !metrics) return res.status(400).json({ error: 'version and metrics required' });
  try {
    await updatePromptMetrics(req.params.key, version, metrics);
    res.json({ updated: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/prompts/:key/features', async (req, res) => {
  try {
    const production = await getProductionPrompt(req.params.key);
    if (!production) return res.status(404).json({ error: 'No production prompt for this key' });
    const features = extractStructuralFeatures(production.template);
    res.json({ features, prompt_key: req.params.key, version: production.version });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bandit Engine ────────────────────────────────────────────────────────────

router.get('/bandits', async (_req, res) => {
  try {
    const experiments = await listActiveExperiments();
    const summaries = await Promise.all(experiments.map(e => getExperimentSummary(e)));
    res.json({ experiments: summaries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/bandits/:experiment', async (req, res) => {
  try {
    const summary = await getExperimentSummary(req.params.experiment);
    res.json({ summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bandits/:experiment/select', async (req, res) => {
  const { variants, contextKey } = req.body;
  if (!Array.isArray(variants) || variants.length === 0) {
    return res.status(400).json({ error: 'variants array required' });
  }
  try {
    const result = await thompsonSelect(req.params.experiment, variants, contextKey || 'global');
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bandits/:experiment/reward', async (req, res) => {
  const { variant, reward, contextKey } = req.body;
  if (!variant || reward === undefined) return res.status(400).json({ error: 'variant and reward required' });
  try {
    await updateBanditReward(req.params.experiment, variant, reward, contextKey || 'global');
    res.json({ updated: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bandits/:experiment/guardrails', async (req, res) => {
  const { metrics, config } = req.body;
  try {
    const result = await checkGuardrails(req.params.experiment, metrics || {}, config || {});
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/bandits/violations/recent', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM guardrail_violations ORDER BY occurred_at DESC LIMIT 50`
    );
    res.json({ violations: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Feedback Loop ────────────────────────────────────────────────────────────

router.get('/feedback', async (_req, res) => {
  try {
    const stats = await getFeedbackStats();
    res.json({ stats });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/feedback/events', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string || '50'), 200);
  try {
    const result = await pool.query(
      `SELECT fe.*, u.email, p.name as persona_name
       FROM feedback_events fe
       LEFT JOIN users u ON u.id = fe.user_id
       LEFT JOIN personas p ON p.id = fe.persona_id
       ORDER BY fe.occurred_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ events: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/feedback/process', authenticateToken, async (_req: AuthRequest, res) => {
  try {
    const result = await processDelayedRewards();
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/feedback/log', authenticateToken, async (req: AuthRequest, res) => {
  const { personaId, eventType, context } = req.body;
  if (!eventType) return res.status(400).json({ error: 'eventType required' });
  try {
    const reward = computeReward(eventType, context || {});
    await logFeedbackEvent({
      user_id: req.userId!,
      persona_id: personaId,
      event_type: eventType,
      reward,
      context,
    });
    res.json({ logged: true, reward });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Meta-Learning ────────────────────────────────────────────────────────────

router.get('/patterns', async (_req, res) => {
  try {
    const patterns = await listPatterns();
    const summary = await getMetaLearningSummary();
    res.json({ patterns, summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/patterns/discover', authenticateToken, async (_req: AuthRequest, res) => {
  try {
    const result = await discoverPatterns();
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
