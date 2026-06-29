import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createServer } from 'http';
import pool from './db.js';
import authRouter from './routes/auth.js';
import personasRouter from './routes/personas.js';
import postsRouter from './routes/posts.js';
import debatesRouter from './routes/debates.js';
import aiRouter from './routes/ai.js';
import feedRouter from './routes/feed.js';
import insightsRouter from './routes/insights.js';
import activityRouter from './routes/activity.js';
import notificationsRouter from './routes/notifications.js';
import marketplaceRouter from './routes/marketplace.js';
import metricsRouter from './routes/metrics.js';
import researchRouter from './routes/research.js';
import { runAiDebate } from './lib/aiDebateEngine.js';
import { startWorker, cleanupOldJobs, getQueueStats } from './lib/jobQueue.js';
import { evaluateOutput } from './lib/evaluation.js';
import { classifyThinkingStyle, evolvePersona } from './lib/personaEvolution.js';
import { analyzeMessage, computeDebateQuality } from './lib/debateEngine.js';
import { cacheStats } from './lib/cache.js';
import { initSocket } from './lib/socket.js';
import { moderateOutput } from './lib/moderationPipeline.js';
import { analyzeBehavior, logModerationAction } from './lib/abuseDetector.js';
import { updatePersonaTrust, updateDebateTrust, applyTrustDecay } from './lib/trustEngine.js';
import { analyzePost, aggregateCognitiveTimeseries, detectContradictionsForUser, computeCDS, detectContradictions } from './lib/cognitiveAnalyzer.js';
import { processDelayedRewards, logFeedbackEvent, computeReward } from './lib/feedbackLoop.js';
import { discoverPatterns } from './lib/metaLearner.js';
import autonomyRouter from './routes/autonomy.js';
import knowledgeGraphRouter from './routes/knowledgeGraph.js';
import personalizationRouter from './routes/personalization.js';
import resilienceRouter from './routes/resilience.js';
import calibrationRouter from './routes/calibration.js';
import evaluationRouter from './routes/evaluation.js';
import observabilityRouter from './routes/observability.js';
import healthRouter from './routes/health.js';
import prometheusRouter from './routes/prometheus.js';
import { requestLoggerMiddleware } from './lib/requestLogger.js';
import { metricsMiddleware } from './middleware/metricsMiddleware.js';
import { extractClaims, buildEdgesForNewClaims } from './lib/knowledgeGraph.js';
import { analyzeArgument } from './lib/explainabilityEngine.js';
import {
  extractBehavioralFeatures, updateUserProfile, recordPostInteraction, recordDebateInteraction,
} from './lib/personalizationEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : true,
  credentials: true,
}));
app.use(express.json({ limit: '512kb' }));
app.use(requestLoggerMiddleware);
app.use(metricsMiddleware);

// Attach Socket.io to the HTTP server
initSocket(httpServer);

// API routes — mounted at both /api (legacy) and /api/v1 (versioned)
const apiRoutes = (app: express.Application, prefix: string) => {
  app.use(`${prefix}/auth`, authRouter);
  app.use(`${prefix}/personas`, personasRouter);
  app.use(`${prefix}/posts`, postsRouter);
  app.use(`${prefix}/debates`, debatesRouter);
  app.use(`${prefix}/ai`, aiRouter);
  app.use(`${prefix}/feed`, feedRouter);
  app.use(`${prefix}/insights`, insightsRouter);
  app.use(`${prefix}/activity`, activityRouter);
  app.use(`${prefix}/notifications`, notificationsRouter);
  app.use(`${prefix}/marketplace`, marketplaceRouter);
  app.use(`${prefix}/metrics`, metricsRouter);
  app.use(`${prefix}/research`, researchRouter);
  app.use(`${prefix}/autonomy`, autonomyRouter);
  app.use(`${prefix}/kg`, knowledgeGraphRouter);
  app.use(`${prefix}/personalization`, personalizationRouter);
  app.use(`${prefix}/resilience`, resilienceRouter);
  app.use(`${prefix}/calibration`, calibrationRouter);
  app.use(`${prefix}/eval`, evaluationRouter);
  app.use(`${prefix}/observability`, observabilityRouter);
};

apiRoutes(app, '/api');
apiRoutes(app, '/api/v1');

// Health + Prometheus metrics endpoints (mounted before API routes for speed)
app.use('/api/health', healthRouter);
app.use('/metrics', prometheusRouter);

// System monitoring endpoint
app.get('/api/system/status', async (_req, res) => {
  try {
    const [queueStats, dbCheck] = await Promise.all([
      getQueueStats(),
      pool.query('SELECT NOW() as time'),
    ]);
    res.json({
      status: 'ok',
      db: 'connected',
      dbTime: dbCheck.rows[0].time,
      jobQueue: queueStats,
      cache: cacheStats(),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

// Job handlers — one function per job type
const jobHandlers = {
  // Debate message analysis: scores logic, persuasiveness, toxicity, detects fallacies
  'analyze-debate-message': async (payload: any) => {
    const { messageId, content, debateId } = payload;
    const scores = await analyzeMessage(content);

    await pool.query(
      `UPDATE debate_messages SET
        logic_score = $1, toxicity_score = $2, persuasiveness_score = $3, fallacies = $4
       WHERE id = $5`,
      [scores.logicScore, scores.toxicityScore, scores.persuasivenessScore,
       JSON.stringify(scores.fallacies), messageId]
    );

    if (scores.compositeScore > 0.7) {
      await pool.query(
        'UPDATE debate_messages SET is_strongest = true WHERE id = $1',
        [messageId]
      );
    }

    const allMsgs = await pool.query(
      'SELECT logic_score, persuasiveness_score, toxicity_score FROM debate_messages WHERE debate_id = $1',
      [debateId]
    );
    const quality = computeDebateQuality(allMsgs.rows);
    await pool.query('UPDATE debates SET quality_score = $1 WHERE id = $2', [quality, debateId]);
  },

  // Post evaluation: 6-metric quality assessment stored in ai_metrics
  'evaluate-post': async (payload: any) => {
    const { postId, personaProfile, userInput, aiOutput, pastContext } = payload;
    const metrics = await evaluateOutput(personaProfile, userInput, aiOutput, pastContext || []);
    await pool.query(
      'UPDATE posts SET ai_metrics = $1 WHERE id = $2',
      [JSON.stringify(metrics), postId]
    );
  },

  // Debate message evaluation (same metrics, different table)
  'evaluate-debate-message': async (payload: any) => {
    const { messageId, personaProfile, userInput, aiOutput } = payload;
    const metrics = await evaluateOutput(personaProfile, userInput, aiOutput);
    await pool.query(
      'UPDATE debate_messages SET ai_metrics = $1 WHERE id = $2',
      [JSON.stringify(metrics), messageId]
    );
  },

  // Thinking style classification
  'classify-thinking-style': async (payload: any) => {
    const { postId, content } = payload;
    const style = await classifyThinkingStyle(content);
    await pool.query(
      `INSERT INTO post_thinking_styles (post_id, thinking_style, confidence, political_bias, emotional_bias, extremity_score)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (post_id) DO NOTHING`,
      [postId, style.thinking_style, style.confidence, style.political_bias, style.emotional_bias, style.extremity_score]
    );
  },

  // Rewrite preview evaluation — adjusts persona reputation
  'evaluate-post-preview': async (payload: any) => {
    const { personaId, personaProfile, userInput, aiOutput, pastContext } = payload;
    const metrics = await evaluateOutput(personaProfile, userInput, aiOutput, pastContext || []);
    if (!metrics.flagged && metrics.composite > 0.7) {
      await pool.query(
        'UPDATE personas SET reputation_score = LEAST(100, reputation_score + 0.3) WHERE id = $1',
        [personaId]
      );
    } else if (metrics.flagged) {
      await pool.query(
        'UPDATE personas SET reputation_score = GREATEST(0, reputation_score - 1) WHERE id = $1',
        [personaId]
      );
    }
  },

  // Automation-triggered persona evolution
  'evolve-persona-auto': async (payload: any) => {
    const { personaId } = payload;
    await evolvePersona(personaId);
    await pool.query(
      'UPDATE personas SET last_evolved_at = NOW() WHERE id = $1',
      [personaId]
    );
  },

  // Post output moderation: classify content, attach moderation JSONB, shadow-ban if critical
  'moderate-post': async (payload: any) => {
    const { postId, content } = payload;
    const result = await moderateOutput(content);
    await pool.query(
      'UPDATE posts SET moderation = $1 WHERE id = $2',
      [JSON.stringify(result), postId]
    );
    if (result.action === 'block') {
      await pool.query('UPDATE posts SET shadow_banned = true WHERE id = $1', [postId]);
      await logModerationAction('post', postId, 'shadow_ban', `Post auto-blocked: toxicity=${result.toxicity.toFixed(2)}`, JSON.stringify(result));
    } else if (result.action === 'warn') {
      await logModerationAction('post', postId, 'warn', `Post flagged: toxicity=${result.toxicity.toFixed(2)}`, JSON.stringify(result));
    }
  },

  // Behavioral abuse detection: compute signals and apply risk action if needed
  'check-persona-abuse': async (payload: any) => {
    const { personaId } = payload;
    try {
      await analyzeBehavior(personaId);
    } catch {
      // Persona may not exist yet — silently skip
    }
  },

  // Recompute persona trust score from behavioral + quality signals
  'update-persona-trust': async (payload: any) => {
    const { personaId } = payload;
    await updatePersonaTrust(personaId);
  },

  // Recompute debate trust score from message quality signals
  'update-debate-trust': async (payload: any) => {
    const { debateId } = payload;
    await updateDebateTrust(debateId);
  },

  // Deep cognitive analysis: single LLM call returns metrics + claims, then updates timeseries
  'cognitive-analysis': async (payload: any) => {
    const { postId, content, personaId } = payload;
    const { metrics, claims } = await analyzePost(content);
    await pool.query(
      `INSERT INTO post_thinking_styles (post_id, thinking_style, cognitive_metrics, claims)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (post_id) DO UPDATE SET
         cognitive_metrics = EXCLUDED.cognitive_metrics,
         claims = EXCLUDED.claims,
         thinking_style = COALESCE(post_thinking_styles.thinking_style, EXCLUDED.thinking_style)`,
      [postId, metrics.thinking_style, JSON.stringify(metrics), JSON.stringify(claims)]
    );
    await aggregateCognitiveTimeseries(personaId);
    // Look up user_id + all their active personas for cross-persona analysis
    const pRow = await pool.query('SELECT user_id FROM personas WHERE id = $1', [personaId]);
    if (pRow.rows.length) {
      const userId = pRow.rows[0].user_id;
      const allP = await pool.query(
        `SELECT id FROM personas WHERE user_id = $1 AND status != 'archived'`, [userId]
      );
      const personaIds = allP.rows.map((r: any) => r.id);
      await detectContradictionsForUser(userId, personaIds);
      await computeCDS(userId);
    }
  },

  // Record A/B experiment event (fire-and-forget from AI routes)
  'analytics-event': async (payload: any) => {
    const { experimentName, userId, eventType, metricValue, entityId } = payload;
    if (!userId) return;
    const { getVariant } = await import('./lib/experimentEngine.js');
    const variant = getVariant(userId, experimentName);
    await pool.query(
      `INSERT INTO experiment_results (experiment_name, user_id, variant, event_type, metric_value, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [experimentName, userId, variant, eventType, metricValue ?? 1, entityId ?? null]
    );
  },

  // AI debate generation — background job
  'generate-ai-debate': async (payload: any) => {
    const { debateId } = payload;
    await runAiDebate(debateId);
  },

  // Autonomy: aggregate feedback_events → update bandit + prompt metrics
  'process-delayed-rewards': async (_payload: any) => {
    const { processed } = await processDelayedRewards();
    console.log(`[autonomy] Processed ${processed} delayed reward updates`);
  },

  // Autonomy: log a structured feedback event from within a job context
  'log-feedback-event': async (payload: any) => {
    const { userId, personaId, eventType, context, experimentName, variant, promptKey, promptVersion } = payload;
    if (!userId || !eventType) return;
    const reward = computeReward(eventType, context || {});
    await logFeedbackEvent({ user_id: userId, persona_id: personaId, event_type: eventType, reward, experiment_name: experimentName, variant, prompt_key: promptKey, prompt_version: promptVersion, context });
  },

  // Autonomy: meta-learner pattern discovery (run periodically)
  'discover-patterns': async (_payload: any) => {
    const { discovered, patterns } = await discoverPatterns();
    if (discovered > 0) console.log(`[autonomy] Meta-learner discovered ${discovered} pattern(s):`, patterns);
  },

  // Autonomy: trust decay — keeps persona trust scores from going stale
  'trust-decay': async (_payload: any) => {
    await applyTrustDecay();
  },

  // Knowledge Graph: extract claims from a post or debate message + build edges
  'extract-claims': async (payload: any) => {
    const { text, personaId, postId, debateMessageId } = payload;
    if (!text || text.length < 20) return;
    const claims = await extractClaims(text, { personaId, postId, debateMessageId });
    if (claims.length > 0) {
      await buildEdgesForNewClaims(claims.map((c: any) => c.id));
    }
    console.log(`[kg] Extracted ${claims.length} claims from ${postId ? 'post' : 'message'} ${postId || debateMessageId}`);
  },

  // Knowledge Graph: analyze argument structure + store for the explainability panel
  'analyze-argument': async (payload: any) => {
    const { text, personaId, postId, debateMessageId } = payload;
    if (!text || text.length < 10) return;
    await analyzeArgument(text, { personaId, postId, debateMessageId });
    console.log(`[kg] Argument analyzed for ${postId ? 'post' : 'message'} ${postId || debateMessageId}`);
  },

  // Cross-persona contradiction detection (triggered from insights route)
  'detect-contradictions': async (payload: any) => {
    const { userId, personaIds } = payload;
    if (!userId || !Array.isArray(personaIds) || personaIds.length < 2) return;
    await detectContradictionsForUser(userId, personaIds);
    await computeCDS(userId);
    console.log(`[cognitive] Contradiction scan done for user ${userId} (${personaIds.length} personas)`);
  },

  // Personalization: extract behavioral features from user text and update their profile
  'update-behavior-profile': async (payload: any) => {
    const { userId, text, topicTags } = payload;
    if (!userId) return;
    try {
      const features = await extractBehavioralFeatures(text || '');
      if (topicTags?.length) {
        const affinities: Record<string, number> = {};
        for (const t of topicTags) affinities[t.toLowerCase()] = 0.7;
        features.topic_affinities = { ...(features.topic_affinities || {}), ...affinities };
      }
      await updateUserProfile(userId, features);
      console.log(`[personalization] Profile updated for user ${userId}`);
    } catch (err) {
      console.error(`[personalization] Profile update failed for user ${userId}:`, err);
    }
  },
};

startWorker(jobHandlers);
cleanupOldJobs().catch(() => {});

// Global error handler — prevents raw stack traces from leaking to clients
app.use((err: any, _req: any, res: any, _next: any) => {
  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? (err.message || 'Bad request') : 'Internal server error';
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: message });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Persona server running on port ${PORT}`);
});