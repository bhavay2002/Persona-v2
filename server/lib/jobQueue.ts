// PostgreSQL-backed Job Queue
// Production-grade replacement for fire-and-forget async patterns.
// Features: atomic job claiming (SKIP LOCKED), exponential backoff, retry, cleanup.
// No Redis required — PostgreSQL handles atomicity and persistence.

import pool from '../db.js';
import { startQueueTimer } from './observabilityHooks.js';

export type JobHandler = (payload: any) => Promise<void>;
export type JobHandlerMap = Record<string, JobHandler>;

let workerInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;
const BATCH_SIZE = 5;
const WORKER_INTERVAL_MS = 5000;

export async function addJob(
  type: string,
  payload: any,
  opts: { processAfterMs?: number; maxAttempts?: number } = {}
): Promise<number> {
  const processAfter = new Date(Date.now() + (opts.processAfterMs || 0));
  const maxAttempts = opts.maxAttempts ?? 3;
  try {
    const result = await pool.query(
      `INSERT INTO job_queue (type, payload, max_attempts, process_after)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [type, JSON.stringify(payload), maxAttempts, processAfter]
    );
    return result.rows[0].id;
  } catch (err) {
    console.warn('Failed to enqueue job:', type, err);
    return -1;
  }
}

async function processBatch(handlers: JobHandlerMap): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  const end = startQueueTimer('job_queue', 'batch');

  try {
    const jobs = await pool.query(
      `UPDATE job_queue
       SET status = 'processing', updated_at = NOW(), attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM job_queue
         WHERE status = 'pending'
           AND process_after <= NOW()
           AND attempts < max_attempts
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [BATCH_SIZE]
    );

    for (const job of jobs.rows) {
      const handler = handlers[job.type];
      if (!handler) {
        await pool.query(
          `UPDATE job_queue SET status = 'failed', error = $1, updated_at = NOW() WHERE id = $2`,
          [`No handler registered for job type: ${job.type}`, job.id]
        );
        continue;
      }

      try {
        const jobEnd = startQueueTimer(job.type, 'run');
        await handler(job.payload);
        jobEnd();
        await pool.query(
          `UPDATE job_queue SET status = 'completed', updated_at = NOW() WHERE id = $1`,
          [job.id]
        );
      } catch (err: any) {
        const nextAttempt = job.attempts;
        const shouldRetry = nextAttempt < job.max_attempts;
        const backoffMs = Math.pow(2, nextAttempt) * 2000;
        await pool.query(
          `UPDATE job_queue
           SET status = $1, error = $2, updated_at = NOW(),
               process_after = NOW() + ($3 * INTERVAL '1 millisecond')
           WHERE id = $4`,
          [
            shouldRetry ? 'pending' : 'failed',
            (err.message || 'Unknown error').slice(0, 500),
            backoffMs,
            job.id,
          ]
        );
        if (!shouldRetry) {
          console.error(`Job ${job.id} (${job.type}) permanently failed after ${nextAttempt} attempts`);
        }
      }
    }
  } catch (err) {
    console.error('Job queue batch error:', err);
  } finally {
    end();
    isProcessing = false;
  }
}

export function startWorker(handlers: JobHandlerMap): void {
  if (workerInterval) return;
  console.log('Job queue worker started (PostgreSQL-backed, 5s polling)');
  processBatch(handlers).catch(() => {});
  workerInterval = setInterval(() => processBatch(handlers).catch(() => {}), WORKER_INTERVAL_MS);
}

export function stopWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}

export async function getQueueStats(): Promise<Record<string, number>> {
  const result = await pool.query(
    `SELECT status, COUNT(*)::int as count FROM job_queue GROUP BY status`
  );
  const stats: Record<string, number> = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of result.rows) stats[row.status] = row.count;
  return stats;
}

export async function cleanupOldJobs(olderThanDays = 7): Promise<void> {
  const result = await pool.query(
    `DELETE FROM job_queue
     WHERE status IN ('completed', 'failed')
       AND updated_at < NOW() - ($1 * INTERVAL '1 day')`,
    [olderThanDays]
  );
  if (result.rowCount && result.rowCount > 0) {
    console.log(`Cleaned up ${result.rowCount} old jobs`);
  }
}
