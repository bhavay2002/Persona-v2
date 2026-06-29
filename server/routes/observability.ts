import { Router } from 'express';
import { register } from '../lib/metrics.js';
import {
  getMetricsSummary, getSLOStatus, getPrometheusText,
} from '../lib/telemetry.js';
import { getRecentLogs, getRouteStats } from '../lib/requestLogger.js';
import { cacheStats } from '../lib/cache.js';

const router = Router();

// ─── Prometheus-format scrape endpoint ────────────────────────────────────────

router.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ─── Health probe ─────────────────────────────────────────────────────────────

router.get('/healthz', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ─── Full metrics summary ─────────────────────────────────────────────────────
// Returns histograms, counters, gauges, computed rates, SLOs

router.get('/metrics/summary', (_req, res) => {
  try {
    const summary = getMetricsSummary();
    const cache   = cacheStats();
    res.json({ ...summary, cache });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SLO status ───────────────────────────────────────────────────────────────

router.get('/metrics/slo', (_req, res) => {
  try {
    const slos = getSLOStatus();
    const passing = slos.filter(s => s.passing).length;
    res.json({
      slos,
      summary: {
        total: slos.length,
        passing,
        failing: slos.length - passing,
        health: passing === slos.length ? 'green' : passing >= slos.length * 0.7 ? 'yellow' : 'red',
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Latency breakdown ────────────────────────────────────────────────────────

router.get('/metrics/latency', (_req, res) => {
  try {
    const summary = getMetricsSummary();
    res.json({
      histograms: summary.histograms,
      computed:   summary.computed,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Request log ─────────────────────────────────────────────────────────────

router.get('/logs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string || '20'), 100);
  try {
    const [logs, routes] = await Promise.all([
      getRecentLogs(limit),
      getRouteStats(parseInt(req.query.hours as string || '1')),
    ]);
    res.json({ logs, route_stats: routes });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
