import { Router } from 'express';
import {
  getAllBreakerStatuses, getResilienceMetrics, resetBreaker, getBreaker,
} from '../lib/resilience.js';
import { getChaosConfig, setChaosConfig, isChaosEnabled } from '../lib/chaosEngine.js';
import pool from '../db.js';

const router = Router();

// ─── System Status ────────────────────────────────────────────────────────────

router.get('/status', async (_req, res) => {
  try {
    const [breakers, metrics, chaos, recent] = await Promise.all([
      getAllBreakerStatuses(),
      getResilienceMetrics(),
      getChaosConfig(),
      pool.query(
        `SELECT * FROM resilience_events ORDER BY created_at DESC LIMIT 20`
      ).then(r => r.rows).catch(() => []),
    ]);

    const openBreakers = breakers.filter(b => b.state === 'OPEN').length;
    const halfOpen = breakers.filter(b => b.state === 'HALF_OPEN').length;

    res.json({
      health: openBreakers === 0 ? 'healthy' : openBreakers <= 2 ? 'degraded' : 'critical',
      circuit_breakers: breakers,
      summary: {
        total: breakers.length,
        closed: breakers.filter(b => b.state === 'CLOSED').length,
        open: openBreakers,
        half_open: halfOpen,
      },
      metrics,
      chaos,
      recent_events: recent,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Circuit Breaker Controls ─────────────────────────────────────────────────

router.get('/circuit', (_req, res) => {
  res.json({ breakers: getAllBreakerStatuses() });
});

router.post('/circuit/:name/reset', async (req, res) => {
  const { name } = req.params;
  const ok = resetBreaker(name);
  if (!ok) return res.status(404).json({ error: `No breaker named '${name}'` });
  res.json({ message: `Circuit breaker '${name}' reset to CLOSED`, breaker: getBreaker(name).getStatus() });
});

// Manually open a breaker (for chaos testing)
router.post('/circuit/:name/open', async (req, res) => {
  const { name } = req.params;
  const breaker = getBreaker(name);
  // Force open by simulating max failures
  for (let i = 0; i < 6; i++) {
    await breaker.execute(
      () => Promise.reject(new Error('forced')),
      () => Promise.resolve(null)
    ).catch(() => {});
  }
  res.json({ message: `Circuit breaker '${name}' forced OPEN`, breaker: breaker.getStatus() });
});

// ─── Metrics ──────────────────────────────────────────────────────────────────

router.get('/metrics', async (_req, res) => {
  try {
    const [metrics, eventSummary] = await Promise.all([
      getResilienceMetrics(),
      pool.query(`
        SELECT
          breaker_name,
          COUNT(*) FILTER (WHERE event_type = 'open')::int as open_count,
          COUNT(*) FILTER (WHERE event_type = 'recover')::int as recover_count,
          MAX(created_at) as last_event
        FROM resilience_events
        GROUP BY breaker_name
        ORDER BY open_count DESC
      `).then(r => r.rows).catch(() => []),
    ]);

    res.json({ metrics, event_summary: eventSummary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Chaos Engine ─────────────────────────────────────────────────────────────

router.get('/chaos', (_req, res) => {
  res.json({ chaos: getChaosConfig() });
});

router.post('/chaos', (req, res) => {
  const { enabled, ai_failure_probability, ai_latency_probability, ai_latency_ms, db_failure_probability } = req.body;
  try {
    setChaosConfig({
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(typeof ai_failure_probability === 'number' ? { ai_failure_probability } : {}),
      ...(typeof ai_latency_probability === 'number' ? { ai_latency_probability } : {}),
      ...(typeof ai_latency_ms === 'number' ? { ai_latency_ms } : {}),
      ...(typeof db_failure_probability === 'number' ? { db_failure_probability } : {}),
    });
    res.json({ chaos: getChaosConfig(), message: enabled ? '⚠ Chaos mode enabled' : 'Chaos mode updated' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── History ──────────────────────────────────────────────────────────────────

router.get('/events', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string || '50'), 200);
    const res2 = await pool.query(
      `SELECT * FROM resilience_events ORDER BY created_at DESC LIMIT $1`, [limit]
    );
    res.json({ events: res2.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
