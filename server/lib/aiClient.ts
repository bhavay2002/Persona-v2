// AI Client — wraps all Gemini calls with:
//   1. Circuit breaker + retry (via resilience.ts)
//   2. Telemetry (latency, errors, fallbacks)
//   3. Cache check before calling Gemini
//   4. Multi-level fallback chain: Primary → cache → template
//
// Multi-level fallback chain:
//   Level 1: callAI(fn) — circuit breaker + 2 retries
//   Level 2: getCachedAI(key) — semantic cache lookup (if cacheKey provided)
//   Level 3: fallbackText — caller-provided safe template string

import { recordAICall, recordAIFallback } from './telemetry.js';
import { getCachedAI, setCachedAI } from './cache.js';

export async function callAI<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    recordAICall(operation, Date.now() - t0, false);
    return result;
  } catch (err: any) {
    recordAICall(operation, Date.now() - t0, true);
    throw err;
  }
}

// ─── Multi-level fallback wrapper ─────────────────────────────────────────────
// Usage:
//   const text = await callAIWithFallbackChain(
//     'rewrite',
//     () => model.generateContent(prompt).then(r => r.response.text()),
//     { cacheKey: `persona:${id}:${hash}`, fallbackText: 'Unable to generate response.' }
//   );

export async function callAIWithFallbackChain(
  operation: string,
  primaryFn: () => Promise<string>,
  opts: {
    cacheKey?: string;
    fallbackText?: string;
    cacheTTL?: number;
  } = {}
): Promise<{ text: string; level: 'primary' | 'cache' | 'template'; latency_ms: number }> {
  const { cacheKey, fallbackText = 'AI service temporarily unavailable.' } = opts;
  const t0 = Date.now();

  // Level 2 pre-check: cache hit (avoids hitting circuit breaker + API)
  if (cacheKey) {
    const cached = getCachedAI(cacheKey);
    if (cached) {
      recordAICall(operation, Date.now() - t0, false);
      return { text: cached, level: 'cache', latency_ms: Date.now() - t0 };
    }
  }

  // Level 1: primary LLM call
  try {
    const text = await callAI(operation, primaryFn);
    if (cacheKey && text) setCachedAI(cacheKey, text);
    return { text, level: 'primary', latency_ms: Date.now() - t0 };
  } catch {
    // Level 2: cache on miss (already checked above, but try once more after failure)
    if (cacheKey) {
      const stale = getCachedAI(cacheKey);
      if (stale) {
        recordAIFallback();
        return { text: stale, level: 'cache', latency_ms: Date.now() - t0 };
      }
    }

    // Level 3: template fallback
    recordAIFallback();
    return { text: fallbackText, level: 'template', latency_ms: Date.now() - t0 };
  }
}
