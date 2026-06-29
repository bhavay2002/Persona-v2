import { Router } from 'express';
import { exposeMetrics } from '../lib/prometheusMetrics.js';
import { getPrometheusText } from '../lib/telemetry.js';

const router = Router();

// GET /metrics — Prometheus scrape endpoint
// Combines both the structured registry (HTTP counters/histograms, circuit breakers,
// job queue, WebSocket) with the in-process telemetry histograms (AI latency, cache).
router.get('/', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  // Merge both metric systems — Prometheus ignores duplicate HELP/TYPE lines
  res.send(exposeMetrics() + '\n' + getPrometheusText());
});

export default router;
