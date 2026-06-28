import { Router } from 'express';
import {
  calibrate, storeEvaluation, submitHumanLabel, getCalibrationStatus,
  getEvaluationQueue, getEvaluationStats, metricsToFeatures,
} from '../lib/truthCalibration.js';
import { runMultiTaskAnalysis, getTaskPerformanceSummary } from '../lib/multiTaskAnalyzer.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import pool from '../db.js';

const router = Router();

function requireAdmin(req: AuthRequest, res: any, next: any) {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ─── Calibration Status ───────────────────────────────────────────────────────

router.get('/status', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const [status, stats] = await Promise.all([getCalibrationStatus(), getEvaluationStats()]);
    res.json({ status, stats });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Reliability Curve ────────────────────────────────────────────────────────

router.get('/reliability-curve', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const status = await getCalibrationStatus();
    res.json({ curve: status.reliability_curve, brier_score: status.brier_score, n_labeled: status.n_labeled });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Human Evaluation Queue ───────────────────────────────────────────────────

router.get('/queue', authenticateToken, requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string || '20'), 50);
  try {
    const queue = await getEvaluationQueue(limit);
    res.json({ queue });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/label', authenticateToken, async (req: AuthRequest, res) => {
  const { evaluation_id, label, reason } = req.body;
  if (typeof evaluation_id !== 'number') return res.status(400).json({ error: 'evaluation_id required' });
  if (label !== 0 && label !== 1) return res.status(400).json({ error: 'label must be 0 or 1' });

  try {
    const result = await submitHumanLabel(evaluation_id, label, reason);
    res.json({ ...result, message: `Label submitted. Brier contribution: ${result.brier_contribution.toFixed(4)}` });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Calibrate Text Directly ──────────────────────────────────────────────────

router.post('/evaluate', authenticateToken, async (req: AuthRequest, res) => {
  const { text, post_id } = req.body;
  if (!text || text.length < 10) return res.status(400).json({ error: 'text required' });

  try {
    // Run multi-task analysis first to get feature signals
    const mtResult = await runMultiTaskAnalysis(text, {
      inferenceMode: 'factcheck',
      sourceId: post_id || undefined,
      sourceType: post_id ? 'post' : undefined,
    });

    // Build feature vector from multi-task outputs + shared features
    const features = {
      reasoning_score: mtResult.tasks.reasoning_score,
      bias_score:      mtResult.tasks.bias_score,
      emotion_score:   mtResult.tasks.emotion_score,
      coherence_score: mtResult.shared_features.logical_coherence,
      novelty_score:   mtResult.shared_features.information_density,
      source_confidence: mtResult.shared_features.source_quality,
    };

    const calibResult = await calibrate(features);

    // Store for future labeling
    const evalId = await storeEvaluation(features, calibResult, { postId: post_id || undefined });

    res.json({
      evaluation_id: evalId,
      truth_probability: calibResult.calibrated_prob,
      confidence_interval: [calibResult.confidence_low, calibResult.confidence_high],
      uncertainty: calibResult.uncertainty,
      raw_composite: calibResult.raw_composite,
      features,
      multi_task: {
        bias_score:     mtResult.tasks.bias_score,
        emotion_score:  mtResult.tasks.emotion_score,
        reasoning_score: mtResult.tasks.reasoning_score,
        weights:        mtResult.weights,
        drift:          mtResult.drift,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Multi-Task Analysis ──────────────────────────────────────────────────────

router.post('/multi-task', async (req, res) => {
  const { text, inference_mode = 'balanced', source_id, source_type } = req.body;
  if (!text || text.length < 10) return res.status(400).json({ error: 'text required' });

  try {
    const result = await runMultiTaskAnalysis(text, {
      inferenceMode: inference_mode,
      sourceId: source_id,
      sourceType: source_type,
    });
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Task Performance ─────────────────────────────────────────────────────────

router.get('/tasks', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string || '50'), 200);
  try {
    const summary = await getTaskPerformanceSummary(limit);
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Recent evaluations ───────────────────────────────────────────────────────

router.get('/evaluations', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string || '30'), 100);
  try {
    const res2 = await pool.query(
      `SELECT te.id, te.post_id, te.raw_composite, te.calibrated_prob,
         te.confidence_low, te.confidence_high, te.human_label,
         te.brier_contribution, te.created_at,
         LEFT(p.content, 120) as post_preview
       FROM truth_evaluations te
       LEFT JOIN posts p ON te.post_id = p.id
       ORDER BY te.created_at DESC LIMIT $1`, [limit]
    );
    res.json({ evaluations: res2.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk calibrate existing posts (admin utility) ────────────────────────────

router.post('/bulk-calibrate', authenticateToken, requireAdmin, async (req, res) => {
  const { limit = 20 } = req.body;
  try {
    const posts = await pool.query(
      `SELECT p.id, p.content, p.ai_metrics FROM posts
       WHERE p.ai_metrics IS NOT NULL
         AND p.id NOT IN (SELECT post_id FROM truth_evaluations WHERE post_id IS NOT NULL)
       ORDER BY p.created_at DESC LIMIT $1`,
      [Math.min(parseInt(limit), 50)]
    );

    let processed = 0;
    for (const post of posts.rows) {
      try {
        const m = post.ai_metrics || {};
        const features = metricsToFeatures({
          reasoning_quality: m.reasoning_quality || 0.65,
          coherence:         m.coherence || 0.70,
          novelty:           m.novelty || 0.60,
          redundancy:        m.redundancy || 0.20,
          toxicity:          m.toxicity || 0.02,
          persona_match:     m.persona_match || 0.65,
        });
        const calibResult = await calibrate(features);
        await storeEvaluation(features, calibResult, { postId: post.id });
        processed++;
      } catch {}
    }

    res.json({ processed, total: posts.rows.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
