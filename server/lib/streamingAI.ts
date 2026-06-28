// AI Token Streaming — Gemini generateContentStream() over WebSocket
//
// Architecture:
//   Client → WS emit('ai_stream', {prompt, requestId})
//   Server → Gemini streaming API
//          → WS emit('token', {token, requestId, index})   (per chunk)
//          → WS emit('stream_done', {requestId, total_tokens, latency_ms})
//          → WS emit('stream_error', {requestId, error, fallback})
//
// Backpressure:
//   Track pendingTokens per socket. If > MAX_BUFFER, coalesce chunks instead of
//   emitting individually. Drop if socket is gone.
//
// Resilience:
//   Wraps in circuit breaker (getBreaker).
//   On OPEN circuit: immediately emit fallback, no streaming.
//   On mid-stream error: emit stream_error with partial + fallback.
//
// Telemetry:
//   Records TTFT (time to first token) and total token count.
//   Circuit breaker: 'gemini-stream'

import { getModel } from './gemini.js';
import type { Socket } from 'socket.io';
import { getBreaker } from './resilience.js';
import { recordStreamTTFT, recordAIFallback } from './telemetry.js';
import { getCachedAI, setCachedAI } from './cache.js';


// ─── Backpressure Tracking ────────────────────────────────────────────────────
// pendingTokens[socketId] = number of tokens buffered but not yet ACKed
// We use a simple coalesce strategy: if buffer > MAX, merge next N tokens into one emit

const pendingTokens = new Map<string, number>();
const MAX_BUFFER = 12;        // tokens
const COALESCE_THRESHOLD = 8; // above this, merge into 3-token chunks

function trackSocket(socketId: string): void {
  if (!pendingTokens.has(socketId)) pendingTokens.set(socketId, 0);
}

function releaseSocket(socketId: string): void {
  pendingTokens.delete(socketId);
}

function shouldCoalesce(socketId: string): boolean {
  return (pendingTokens.get(socketId) ?? 0) > COALESCE_THRESHOLD;
}

// ─── Static Fallbacks ─────────────────────────────────────────────────────────

const FALLBACK_TEMPLATES: Record<string, string> = {
  debate:    'I understand your point. The evidence suggests a more nuanced view is warranted here.',
  suggest:   'Consider strengthening your argument by citing specific data or examples.',
  analyze:   'Analysis unavailable — AI service temporarily degraded. Please retry in a moment.',
  default:   'The AI service is temporarily unavailable. Your request has been queued.',
};

function getFallback(context: string): string {
  for (const [key, msg] of Object.entries(FALLBACK_TEMPLATES)) {
    if (context.toLowerCase().includes(key)) return msg;
  }
  return FALLBACK_TEMPLATES.default;
}

// ─── Main Streaming Function ──────────────────────────────────────────────────

export interface StreamOptions {
  breakerName?: string;
  context?: string;       // for fallback selection
  cacheKey?: string;      // if set, cache the completed response
  maxTokens?: number;     // soft limit before cutting off stream
}

export async function streamAIResponse(
  socket: Socket,
  prompt: string,
  requestId: string,
  opts: StreamOptions = {}
): Promise<void> {
  const {
    breakerName = 'gemini-stream',
    context = 'default',
    cacheKey,
    maxTokens = 600,
  } = opts;

  const breaker = getBreaker(breakerName);
  const status = breaker.getStatus();
  trackSocket(socket.id);

  // ── Circuit OPEN: immediate fallback, no streaming ───────────────────────
  if (status.state === 'OPEN') {
    recordAIFallback();
    const fallback = cacheKey ? (getCachedAI(cacheKey) ?? getFallback(context)) : getFallback(context);
    socket.emit('stream_error', {
      requestId,
      error: `Circuit breaker OPEN (${Math.round(status.cooldown_remaining_ms / 1000)}s cooldown)`,
      fallback,
      from_cache: !!getCachedAI(cacheKey ?? ''),
    });
    releaseSocket(socket.id);
    return;
  }

  // ── Check cache first ─────────────────────────────────────────────────────
  if (cacheKey) {
    const cached = getCachedAI(cacheKey);
    if (cached) {
      // Simulate token streaming from cache (25ms between tokens for UX)
      const words = cached.split(/\s+/);
      const t0 = Date.now();
      for (let i = 0; i < words.length; i++) {
        if (!socket.connected) break;
        await new Promise(r => setTimeout(r, 15));
        socket.emit('token', { token: (i === 0 ? '' : ' ') + words[i], requestId, index: i, from_cache: true });
      }
      socket.emit('stream_done', {
        requestId, total_tokens: words.length,
        latency_ms: Date.now() - t0, from_cache: true,
      });
      releaseSocket(socket.id);
      return;
    }
  }

  // ── Real streaming via Gemini ─────────────────────────────────────────────
  const model = getModel();
  const t0 = Date.now();
  let firstTokenAt: number | null = null;
  let tokenIndex = 0;
  let fullResponse = '';
  let coalesceBuffer = '';

  const flushCoalesce = () => {
    if (coalesceBuffer && socket.connected) {
      socket.emit('token', { token: coalesceBuffer, requestId, index: tokenIndex++, coalesced: true });
      const n = pendingTokens.get(socket.id) ?? 0;
      pendingTokens.set(socket.id, Math.max(0, n - 3));
      coalesceBuffer = '';
    }
  };

  try {
    const stream = await model.generateContentStream(prompt);

    for await (const chunk of stream.stream) {
      if (!socket.connected) break;

      const text = chunk.text();
      if (!text) continue;

      fullResponse += text;

      // Track time to first token
      if (firstTokenAt === null) {
        firstTokenAt = Date.now();
        recordStreamTTFT(firstTokenAt - t0, 0);
      }

      // Soft token limit
      if (tokenIndex > maxTokens) {
        socket.emit('token', { token: '…', requestId, index: tokenIndex++ });
        break;
      }

      // Backpressure: coalesce if buffer is too full
      const pending = pendingTokens.get(socket.id) ?? 0;
      if (pending > MAX_BUFFER) {
        // Drop — client is too far behind
        continue;
      }

      if (shouldCoalesce(socket.id)) {
        coalesceBuffer += text;
        if (coalesceBuffer.length >= 20) flushCoalesce();
      } else {
        flushCoalesce(); // flush any pending coalesced
        socket.emit('token', { token: text, requestId, index: tokenIndex++ });
        pendingTokens.set(socket.id, pending + 1);
      }
    }

    flushCoalesce();

    const totalMs = Date.now() - t0;
    recordStreamTTFT(firstTokenAt ? firstTokenAt - t0 : totalMs, tokenIndex);

    // Cache completed response
    if (cacheKey && fullResponse.length > 20) {
      setCachedAI(cacheKey, fullResponse);
    }

    if (socket.connected) {
      socket.emit('stream_done', {
        requestId,
        total_tokens: tokenIndex,
        latency_ms: totalMs,
        ttft_ms: firstTokenAt ? firstTokenAt - t0 : null,
        from_cache: false,
      });
    }
  } catch (err: any) {
    const fallback = getFallback(context);
    recordAIFallback();

    if (socket.connected) {
      socket.emit('stream_error', {
        requestId,
        error: err?.message || 'Stream failed',
        fallback,
        partial: fullResponse.slice(0, 200) || null,
      });
    }

    // Emit fallback as complete stream so client still gets something
    if (socket.connected && fullResponse.length === 0) {
      const words = fallback.split(/\s+/);
      for (let i = 0; i < words.length; i++) {
        if (!socket.connected) break;
        await new Promise(r => setTimeout(r, 30));
        socket.emit('token', { token: (i === 0 ? '' : ' ') + words[i], requestId, index: i, is_fallback: true });
      }
      socket.emit('stream_done', {
        requestId, total_tokens: words.length,
        latency_ms: Date.now() - t0, is_fallback: true,
      });
    }
  } finally {
    releaseSocket(socket.id);
  }
}

// ─── Simple non-streaming AI call with cache + fallback chain ─────────────────
// Level 1: Gemini 2.5 Flash
// Level 2: Cached response (if key provided)
// Level 3: Template string

export async function callAIWithFallback(
  prompt: string,
  opts: { cacheKey?: string; context?: string; breakerName?: string } = {}
): Promise<{ text: string; level: 'primary' | 'cache' | 'template'; latency_ms: number }> {
  const { cacheKey, context = 'default', breakerName = 'gemini-generate' } = opts;
  const t0 = Date.now();

  // Level 2: cache hit (check before circuit breaker to avoid unnecessary trips)
  if (cacheKey) {
    const cached = getCachedAI(cacheKey);
    if (cached) {
      return { text: cached, level: 'cache', latency_ms: Date.now() - t0 };
    }
  }

  const breaker = getBreaker(breakerName);

  try {
    const model = getModel();

    const result = await breaker.execute(
      async () => {
        const r = await model.generateContent(prompt);
        return r.response.text();
      },
      () => Promise.reject(new Error('circuit_open'))
    );

    const latency_ms = Date.now() - t0;
    if (cacheKey) setCachedAI(cacheKey, result);
    return { text: result, level: 'primary', latency_ms };
  } catch {
    // Level 3: template fallback
    recordAIFallback();
    return { text: getFallback(context), level: 'template', latency_ms: Date.now() - t0 };
  }
}
