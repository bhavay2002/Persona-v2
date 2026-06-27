// Resilience Layer — Circuit Breaker + Retry + Fallback
//
// Pattern: CLOSED → OPEN (>50% failure in 10-call window) → HALF_OPEN (after 30s) → CLOSED
//
// Each named circuit breaker has an independent sliding window and state machine.
// callWithResilience() is the single entry point — wraps any async fn with:
//   1. Chaos injection (if enabled)
//   2. Circuit breaker check (OPEN → fallback immediately)
//   3. Retry with exponential backoff (2 attempts)
//   4. Fallback on final failure

import pool from '../db.js';
import { injectAIChaos } from './chaosEngine.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const FAILURE_THRESHOLD = 0.50;  // 50% failure rate opens the circuit
const WINDOW_SIZE       = 10;    // sliding window of N most-recent calls
const MIN_CALLS         = 5;     // minimum calls before evaluating failure rate
const OPEN_TIMEOUT_MS   = 30_000; // 30s cooldown before HALF_OPEN test

// ─── Types ────────────────────────────────────────────────────────────────────

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerStatus {
  name: string;
  state: BreakerState;
  failures: number;
  successes: number;
  total_calls: number;
  fallback_calls: number;
  failure_rate: number;
  last_failure_at: number | null;
  opened_at: number | null;
  cooldown_remaining_ms: number;
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

class CircuitBreaker {
  private _state: BreakerState = 'CLOSED';
  private _window: boolean[] = [];
  private _failures = 0;
  private _successes = 0;
  private _totalCalls = 0;
  private _fallbackCalls = 0;
  private _lastFailureAt: number | null = null;
  private _openedAt: number | null = null;
  private _halfOpenTestInFlight = false;

  constructor(public readonly name: string) {}

  getStatus(): BreakerStatus {
    const now = Date.now();
    const failureCount = this._window.filter(x => !x).length;
    const failureRate = this._window.length > 0 ? failureCount / this._window.length : 0;
    const cooldown = this._state === 'OPEN' && this._openedAt
      ? Math.max(0, OPEN_TIMEOUT_MS - (now - this._openedAt))
      : 0;

    return {
      name: this.name,
      state: this._state,
      failures: this._failures,
      successes: this._successes,
      total_calls: this._totalCalls,
      fallback_calls: this._fallbackCalls,
      failure_rate: Math.round(failureRate * 1000) / 10,
      last_failure_at: this._lastFailureAt,
      opened_at: this._openedAt,
      cooldown_remaining_ms: cooldown,
    };
  }

  reset(): void {
    this._state = 'CLOSED';
    this._window = [];
    this._failures = 0;
    this._successes = 0;
    this._lastFailureAt = null;
    this._openedAt = null;
    this._halfOpenTestInFlight = false;
    // totalCalls / fallbackCalls kept for lifetime metrics
  }

  async execute<T>(fn: () => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
    const now = Date.now();

    if (this._state === 'OPEN') {
      if (this._openedAt && now - this._openedAt >= OPEN_TIMEOUT_MS) {
        this._state = 'HALF_OPEN';
        this._halfOpenTestInFlight = false;
        console.log(`[cb:${this.name}] OPEN → HALF_OPEN (cooldown elapsed)`);
      } else {
        this._fallbackCalls++;
        globalMetrics.fallbacks++;
        return fallback();
      }
    }

    if (this._state === 'HALF_OPEN' && this._halfOpenTestInFlight) {
      this._fallbackCalls++;
      globalMetrics.fallbacks++;
      return fallback();
    }

    if (this._state === 'HALF_OPEN') {
      this._halfOpenTestInFlight = true;
    }

    this._totalCalls++;
    globalMetrics.calls++;

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      this._fallbackCalls++;
      globalMetrics.fallbacks++;
      return fallback();
    }
  }

  private _onSuccess(): void {
    this._successes++;
    this._window.push(true);
    if (this._window.length > WINDOW_SIZE) this._window.shift();

    if (this._state === 'HALF_OPEN') {
      this._state = 'CLOSED';
      this._halfOpenTestInFlight = false;
      this._window = [];
      console.log(`[cb:${this.name}] HALF_OPEN → CLOSED`);
      _logEvent(this.name, 'recover', 'HALF_OPEN', 'CLOSED', 0).catch(() => {});
    }
  }

  private _onFailure(): void {
    this._failures++;
    this._lastFailureAt = Date.now();
    this._window.push(false);
    if (this._window.length > WINDOW_SIZE) this._window.shift();
    globalMetrics.failures++;

    if (this._state === 'HALF_OPEN') {
      this._state = 'OPEN';
      this._openedAt = Date.now();
      this._halfOpenTestInFlight = false;
      console.log(`[cb:${this.name}] HALF_OPEN → OPEN (test failed)`);
      _logEvent(this.name, 'open', 'HALF_OPEN', 'OPEN', 1.0).catch(() => {});
      return;
    }

    if (this._state === 'CLOSED' && this._window.length >= MIN_CALLS) {
      const fails = this._window.filter(x => !x).length;
      const rate = fails / this._window.length;
      if (rate >= FAILURE_THRESHOLD) {
        this._state = 'OPEN';
        this._openedAt = Date.now();
        globalMetrics.breakerOpens++;
        console.log(`[cb:${this.name}] CLOSED → OPEN (failure_rate=${Math.round(rate * 100)}%)`);
        _logEvent(this.name, 'open', 'CLOSED', 'OPEN', rate).catch(() => {});
      }
    }
  }
}

// ─── Global Registry ──────────────────────────────────────────────────────────

const _registry = new Map<string, CircuitBreaker>();

export function getBreaker(name: string): CircuitBreaker {
  if (!_registry.has(name)) _registry.set(name, new CircuitBreaker(name));
  return _registry.get(name)!;
}

export function getAllBreakerStatuses(): BreakerStatus[] {
  return [..._registry.values()].map(b => b.getStatus());
}

export function resetBreaker(name: string): boolean {
  const b = _registry.get(name);
  if (!b) return false;
  b.reset();
  return true;
}

// Pre-initialize well-known breakers so they appear in the dashboard immediately
['gemini-rewrite', 'gemini-debate', 'gemini-suggest', 'gemini-analyze', 'gemini-kg', 'gemini-explain'].forEach(name =>
  getBreaker(name)
);

// ─── Resilience Metrics ───────────────────────────────────────────────────────

interface GlobalMetrics {
  calls: number;
  failures: number;
  fallbacks: number;
  retries: number;
  breakerOpens: number;
  startTime: number;
}

const globalMetrics: GlobalMetrics = {
  calls: 0,
  failures: 0,
  fallbacks: 0,
  retries: 0,
  breakerOpens: 0,
  startTime: Date.now(),
};

export function getResilienceMetrics() {
  const total = globalMetrics.calls || 1;
  const uptimeMs = Date.now() - globalMetrics.startTime;
  return {
    ...globalMetrics,
    failure_rate_pct: Math.round((globalMetrics.failures / total) * 1000) / 10,
    fallback_rate_pct: Math.round((globalMetrics.fallbacks / total) * 1000) / 10,
    uptime_ms: uptimeMs,
  };
}

// ─── DB Event Log ─────────────────────────────────────────────────────────────

async function _logEvent(
  breakerName: string, eventType: string,
  fromState: string, toState: string, failureRate: number
): Promise<void> {
  await pool.query(
    `INSERT INTO resilience_events (breaker_name, event_type, from_state, to_state, failure_rate)
     VALUES ($1, $2, $3, $4, $5)`,
    [breakerName, eventType, fromState, toState, failureRate]
  ).catch(() => {});
}

// ─── Main Entry: Protected Async Call ─────────────────────────────────────────
// This is the single public API — wrap any async fn for full protection.

export async function callWithResilience<T>(
  breakerName: string,
  fn: () => Promise<T>,
  fallbackValue: T,
  opts: { retries?: number; baseRetryMs?: number; chaos?: boolean } = {}
): Promise<{ value: T; wasFallback: boolean; wasRetried: boolean; retryCount: number }> {
  const { retries = 2, baseRetryMs = 250, chaos = true } = opts;
  const breaker = getBreaker(breakerName);

  let wasFallback = false;
  let wasRetried = false;
  let retryCount = 0;

  const value = await breaker.execute(
    async () => {
      // Chaos injection (only if enabled globally)
      if (chaos) await injectAIChaos();

      let lastErr: unknown;
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          lastErr = err;
          if (attempt > 0) { wasRetried = true; globalMetrics.retries++; }
          retryCount = attempt + 1;
          if (attempt < retries - 1) {
            await new Promise(r => setTimeout(r, baseRetryMs * Math.pow(2, attempt)));
          }
        }
      }
      globalMetrics.failures++;
      throw lastErr;
    },
    () => {
      wasFallback = true;
      return Promise.resolve(fallbackValue);
    }
  );

  return { value, wasFallback, wasRetried, retryCount };
}
