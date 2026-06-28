import type { Request, Response, NextFunction } from 'express';
import {
  incCounter, observeHistogram, incGauge, decGauge,
} from '../lib/prometheusMetrics.js';

// Normalize route for cardinality control (avoid label explosion from IDs)
function normalizeRoute(path: string): string {
  return path
    .replace(/\/\d+/g, '/:id')
    .replace(/\?.*$/, '')
    .substring(0, 80) || '/';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  incGauge('http_active_requests');

  res.on('finish', () => {
    const duration = Date.now() - start;
    const route = normalizeRoute(req.path);
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };

    incCounter('http_requests_total', labels);
    observeHistogram('http_request_duration_ms', duration, labels);
    decGauge('http_active_requests');
  });

  next();
}
