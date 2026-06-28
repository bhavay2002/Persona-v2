import { Router } from 'express';
import pool from '../db.js';
import { cacheStats } from '../lib/cache.js';
import { getQueueStats } from '../lib/jobQueue.js';

const router = Router();
const startTime = Date.now();

// GET /api/health — liveness probe (fast, minimal)
router.get('/', (_req, res) => {
  res.json({ status: 'ok', uptime_ms: Date.now() - startTime });
});

// GET /api/health/ready — readiness probe (checks DB + cache)
router.get('/ready', async (_req, res) => {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 3000)),
    ]);

    res.json({
      status: 'ready',
      uptime_ms: Date.now() - startTime,
      checks: {
        database: 'ok',
        cache: 'ok',
      },
    });
  } catch (err) {
    res.status(503).json({
      status: 'not_ready',
      checks: {
        database: 'error',
        error: String(err),
      },
    });
  }
});

// GET /api/health/live — deep status (for internal dashboards)
router.get('/live', async (_req, res) => {
  try {
    const [dbResult, queueStats] = await Promise.all([
      pool.query('SELECT NOW() as db_time, COUNT(*) as conn_count FROM pg_stat_activity'),
      getQueueStats().catch(() => null),
    ]);

    res.json({
      status: 'ok',
      uptime_ms: Date.now() - startTime,
      version: process.env.npm_package_version || '1.0.0',
      node_version: process.version,
      environment: process.env.NODE_ENV || 'development',
      database: {
        status: 'connected',
        server_time: dbResult.rows[0]?.db_time,
        active_connections: dbResult.rows[0]?.conn_count,
      },
      cache: cacheStats(),
      job_queue: queueStats,
      memory: {
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

export default router;
