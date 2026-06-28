// Structured Request Logger — Middleware + Correlation IDs
//
// Every HTTP request gets a unique requestId propagated through the stack.
// On response finish: log structured JSON to stdout + async DB insert.
//
// requestId format: req_{timestamp_base36}_{random5}
// Example: req_lzx3f2k_a8b3c
//
// Structured log format (stdout):
// {"level":"info","requestId":"req_...","route":"/api/feed","method":"GET","latency_ms":82,"status":200,"userId":12}
//
// DB table: request_log(request_id, route, method, latency_ms, status_code, user_id, created_at)
//
// The middleware attaches req.requestId so downstream handlers can reference it.

import type { Request, Response, NextFunction } from 'express';
import pool from '../db.js';
import { recordHttpRequest } from './telemetry.js';

// ─── Augment Express Request ──────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      startTime: number;
    }
  }
}

// ─── ID Generation ────────────────────────────────────────────────────────────

function generateRequestId(): string {
  const ts  = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 7);
  return `req_${ts}_${rnd}`;
}

// ─── Normalise route path ─────────────────────────────────────────────────────
// Replace numeric segments with :id so logs group naturally.
// /api/personas/42/posts → /api/personas/:id/posts

function normalizePath(path: string): string {
  return path
    .replace(/\/\d+/g, '/:id')
    .replace(/\?.*$/, '');
}

// ─── Async DB Logger (fire-and-forget) ────────────────────────────────────────

const LOG_SAMPLE_RATE = 0.30;  // log 30% of requests to DB (reduce write volume)
const SKIP_ROUTES = new Set([
  '/metrics',
  '/:id/health',
  '/health',
  '/health/ready',
  '/health/live',
  '/observability/healthz',
  '/observability/metrics/summary',
  '/observability/metrics/slo',
  '/observability/metrics/latency',
]);

async function logToDb(entry: {
  request_id: string;
  route: string;
  method: string;
  latency_ms: number;
  status_code: number;
  user_id: number | null;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO request_log (request_id, route, method, latency_ms, status_code, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.request_id, entry.route, entry.method, entry.latency_ms, entry.status_code, entry.user_id]
    );
  } catch {
    // Never throw from logger
  }
}

// ─── Console Structured Logger ────────────────────────────────────────────────

function logToConsole(entry: Record<string, any>): void {
  // Use compact JSON, one line per request
  console.log(JSON.stringify({ level: 'info', ...entry }));
}

// ─── Express Middleware ───────────────────────────────────────────────────────

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = generateRequestId();
  const startTime = Date.now();

  req.requestId = requestId;
  req.startTime = startTime;

  // Propagate requestId to response headers (useful for client-side correlation)
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const latency_ms = Date.now() - startTime;
    const route      = normalizePath(req.path);
    const method     = req.method;
    const status     = res.statusCode;

    // Resolve userId from JWT middleware (if present)
    const userId: number | null = (req as any).userId ?? null;

    // Always record to telemetry
    recordHttpRequest(route, latency_ms, status);

    // Skip noisy health/metrics routes from console + DB
    if (SKIP_ROUTES.has(route)) return;

    // Structured console log
    logToConsole({
      requestId,
      route,
      method,
      latency_ms,
      status,
      ...(userId ? { userId } : {}),
    });

    // DB log — sampled
    if (Math.random() < LOG_SAMPLE_RATE) {
      logToDb({ request_id: requestId, route, method, latency_ms, status_code: status, user_id: userId });
    }
  });

  next();
}

// ─── Log Query Helpers ────────────────────────────────────────────────────────

export async function getRecentLogs(limit = 20): Promise<any[]> {
  const res = await pool.query(
    `SELECT * FROM request_log ORDER BY created_at DESC LIMIT $1`, [limit]
  );
  return res.rows;
}

export async function getRouteStats(hours = 1): Promise<any[]> {
  const res = await pool.query(
    `SELECT
       route,
       COUNT(*)::int               as request_count,
       ROUND(AVG(latency_ms))::int as avg_latency_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::int as p95_latency_ms,
       COUNT(*) FILTER (WHERE status_code >= 500)::int as error_count
     FROM request_log
     WHERE created_at >= NOW() - ($1 || ' hours')::interval
     GROUP BY route
     ORDER BY request_count DESC
     LIMIT 20`,
    [hours]
  );
  return res.rows;
}
