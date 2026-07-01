// Observability Panel — SLOs, Latency Histograms, WS Stats, Cache, Request Log, Streaming Tester
// Embedded inside SystemHealth.tsx as a separate component file for cleanliness.

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { io as socketIO } from 'socket.io-client';
import { api } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SLO {
  name: string;
  description: string;
  target: number;
  actual: number;
  unit: string;
  passing: boolean;
  margin: number;
}

interface HistSnapshot {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  latest: number;
}

interface MetricsSummary {
  histograms: Record<string, HistSnapshot>;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  computed: {
    ai_error_rate_pct: number;
    ai_fallback_rate_pct: number;
    cache_hit_rate_pct: number;
    http_error_rate_pct: number;
  };
  slos: SLO[];
  ws_active_connections: number;
  cache?: {
    feed: { hits: number; misses: number; keys: number };
    persona: { hits: number; misses: number; keys: number };
    ai: { hits: number; misses: number; keys: number };
  };
}

interface RequestLog {
  id: number;
  request_id: string;
  route: string;
  method: string;
  latency_ms: number;
  status_code: number;
  user_id: number | null;
  created_at: string;
}

interface StreamToken {
  token: string;
  index: number;
  from_cache?: boolean;
  is_fallback?: boolean;
  coalesced?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sloColor(passing: boolean, margin: number) {
  if (passing && margin > 500)  return { dot: '#10b981', label: '#10b981', bg: 'rgba(16,185,129,0.07)' };
  if (passing)                  return { dot: '#10b981', label: '#10b981', bg: 'rgba(16,185,129,0.07)' };
  if (Math.abs(margin) < 100)   return { dot: '#f59e0b', label: '#f59e0b', bg: 'rgba(245,158,11,0.07)' };
  return                               { dot: '#ef4444', label: '#ef4444', bg: 'rgba(239,68,68,0.07)' };
}

function statusLight(passing: boolean) {
  return passing ? '●' : '●';
}

function fmtMs(ms: number) {
  if (ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pctBar(value: number, max: number, color: string, height = 'h-1.5') {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={`${height} bg-bg-elevated rounded-full overflow-hidden`}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

// ─── SLO Traffic Lights ───────────────────────────────────────────────────────

function SLOPanel({ slos }: { slos: SLO[] }) {
  const passing = slos.filter(s => s.passing).length;

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-text-primary">Service Level Objectives</h3>
          <p className="text-[10px] text-text-dim mt-0.5">{passing}/{slos.length} SLOs passing</p>
        </div>
        <div className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded ${
          passing === slos.length ? 'text-emerald-400 bg-emerald-400/10' :
          passing >= slos.length * 0.7 ? 'text-yellow-400 bg-yellow-400/10' :
          'text-red-400 bg-red-400/10'
        }`}>
          {passing === slos.length ? 'ALL GREEN' : passing >= slos.length * 0.7 ? 'DEGRADED' : 'FAILING'}
        </div>
      </div>

      <div className="space-y-2">
        {slos.map(slo => {
          const color = sloColor(slo.passing, slo.margin);
          return (
            <div key={slo.name} className="rounded-xl p-3 border" style={{ background: color.bg, borderColor: `${color.dot}22` }}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] shrink-0" style={{ color: color.dot }}>
                    {statusLight(slo.passing)}
                  </span>
                  <span className="text-[10px] font-mono text-text-primary truncate">{slo.name}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0 text-[10px] font-mono">
                  <span style={{ color: color.label }} className="font-bold">
                    {slo.actual > 0 ? `${slo.actual.toLocaleString()}${slo.unit}` : 'no data'}
                  </span>
                  <span className="text-text-dim">/ {slo.target}{slo.unit}</span>
                </div>
              </div>
              {slo.actual > 0 && (
                <div className="mt-1.5">
                  {pctBar(
                    Math.min(slo.actual, slo.target * 1.5),
                    slo.target * 1.5,
                    color.dot
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Latency Histograms ───────────────────────────────────────────────────────

const HIST_CONFIG: Record<string, { label: string; color: string; slo?: number }> = {
  'ai.generation':  { label: 'AI Generation',  color: '#8b5cf6', slo: 2500 },
  'ai.stream.ttft': { label: 'Stream TTFT',     color: '#14b8a6', slo: 800  },
  'http.request':   { label: 'HTTP Request',    color: '#3b82f6', slo: 500  },
  'ws.message':     { label: 'WS Message',      color: '#f59e0b', slo: 300  },
  'queue.job':      { label: 'Queue Job',        color: '#ec4899', slo: 5000 },
};

function LatencyPanel({ histograms }: { histograms: Record<string, HistSnapshot> }) {
  return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 space-y-4">
      <div>
        <h3 className="text-sm font-bold text-text-primary">Latency Distribution</h3>
        <p className="text-[10px] text-text-dim mt-0.5">p50 / p95 / p99 — last N samples</p>
      </div>

      <div className="space-y-4">
        {Object.entries(HIST_CONFIG).map(([key, cfg]) => {
          const h = histograms[key];
          if (!h || h.count === 0) return (
            <div key={key}>
              <div className="flex justify-between mb-1">
                <span className="text-[10px] font-mono text-text-dim">{cfg.label}</span>
                <span className="text-[9px] font-mono text-text-dim">no data</span>
              </div>
              <div className="h-1.5 bg-bg-elevated rounded-full opacity-30" />
            </div>
          );

          const maxP = cfg.slo ? Math.max(h.p99, cfg.slo) : Math.max(h.p99, 100);

          return (
            <div key={key}>
              <div className="flex justify-between mb-1">
                <span className="text-[10px] font-mono text-text-secondary">{cfg.label}</span>
                <span className="text-[9px] font-mono text-text-dim">{h.count} samples</span>
              </div>
              {/* p50 bar */}
              <div className="space-y-1">
                {[
                  { label: 'p50', val: h.p50, opacity: '100' },
                  { label: 'p95', val: h.p95, opacity: '70'  },
                  { label: 'p99', val: h.p99, opacity: '40'  },
                ].map(({ label, val, opacity }) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="text-[8px] font-mono text-text-dim w-5 shrink-0">{label}</span>
                    <div className="flex-1 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${Math.min(100, (val / maxP) * 100)}%`,
                          background: cfg.color,
                          opacity: parseInt(opacity) / 100,
                        }} />
                    </div>
                    <span className={`text-[9px] font-mono w-12 text-right shrink-0 ${
                      cfg.slo && val > cfg.slo ? 'text-red-400' : 'text-text-dim'
                    }`}>{fmtMs(val)}</span>
                  </div>
                ))}
              </div>
              {cfg.slo && (
                <div className="mt-1 text-[8px] font-mono text-text-dim">SLO: &lt; {fmtMs(cfg.slo)}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── System Counters ──────────────────────────────────────────────────────────

function CountersPanel({ summary }: { summary: MetricsSummary }) {
  const { counters, computed, ws_active_connections, cache } = summary;

  const cacheHitPct = computed.cache_hit_rate_pct;
  const nodeAiHits  = cache?.ai ? Math.round((cache.ai.hits / Math.max(cache.ai.hits + cache.ai.misses, 1)) * 100) : 0;

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 space-y-4">
      <h3 className="text-sm font-bold text-text-primary">Live Counters</h3>

      {/* WS */}
      <div>
        <p className="text-[9px] font-mono uppercase text-text-dim tracking-wider mb-2">WebSocket</p>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Active',    value: ws_active_connections,      color: '#14b8a6' },
            { label: 'Messages',  value: counters['ws.messages'] ?? 0, color: '#e2e8f0' },
            { label: 'Streams',   value: counters['ws.stream.starts'] ?? 0, color: '#8b5cf6' },
          ].map(m => (
            <div key={m.label} className="text-center bg-bg-elevated rounded-xl p-2">
              <div className="text-base font-bold font-mono" style={{ color: m.color }}>{m.value.toLocaleString()}</div>
              <div className="text-[8px] font-mono uppercase text-text-dim">{m.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* AI */}
      <div>
        <p className="text-[9px] font-mono uppercase text-text-dim tracking-wider mb-2">AI Calls</p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: 'Total',     value: counters['ai.calls'] ?? 0,     color: '#e2e8f0' },
            { label: 'Errors',    value: counters['ai.errors'] ?? 0,    color: (counters['ai.errors'] ?? 0) > 0 ? '#ef4444' : '#6b7280' },
            { label: 'Fallbacks', value: counters['ai.fallbacks'] ?? 0, color: (counters['ai.fallbacks'] ?? 0) > 0 ? '#f59e0b' : '#6b7280' },
            { label: 'Tokens',    value: counters['ai.stream.tokens'] ?? 0, color: '#8b5cf6' },
          ].map(m => (
            <div key={m.label} className="flex items-center justify-between bg-bg-elevated rounded-lg px-3 py-2">
              <span className="text-[9px] font-mono text-text-dim">{m.label}</span>
              <span className="text-sm font-bold font-mono" style={{ color: m.color }}>{m.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
        {/* Error/Fallback rates */}
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[8px] font-mono text-text-dim w-20 shrink-0">Error Rate</span>
            {pctBar(computed.ai_error_rate_pct, 10, computed.ai_error_rate_pct > 2 ? '#ef4444' : '#10b981')}
            <span className={`text-[9px] font-mono w-8 text-right shrink-0 ${computed.ai_error_rate_pct > 2 ? 'text-red-400' : 'text-emerald-400'}`}>
              {computed.ai_error_rate_pct}%
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[8px] font-mono text-text-dim w-20 shrink-0">Fallback Rate</span>
            {pctBar(computed.ai_fallback_rate_pct, 20, computed.ai_fallback_rate_pct > 5 ? '#f59e0b' : '#10b981')}
            <span className={`text-[9px] font-mono w-8 text-right shrink-0 ${computed.ai_fallback_rate_pct > 5 ? 'text-yellow-400' : 'text-emerald-400'}`}>
              {computed.ai_fallback_rate_pct}%
            </span>
          </div>
        </div>
      </div>

      {/* Cache */}
      <div>
        <p className="text-[9px] font-mono uppercase text-text-dim tracking-wider mb-2">Cache Hit Rates</p>
        <div className="space-y-1.5">
          {[
            { label: 'AI Cache (telemetry)', pct: cacheHitPct, color: '#8b5cf6' },
            { label: 'AI Cache (NodeCache)',  pct: nodeAiHits, color: '#14b8a6' },
            { label: 'Feed Cache', pct: cache?.feed ? Math.round((cache.feed.hits / Math.max(cache.feed.hits + cache.feed.misses, 1)) * 100) : 0, color: '#3b82f6' },
            { label: 'Persona Cache', pct: cache?.persona ? Math.round((cache.persona.hits / Math.max(cache.persona.hits + cache.persona.misses, 1)) * 100) : 0, color: '#f59e0b' },
          ].map(c => (
            <div key={c.label} className="flex items-center gap-2">
              <span className="text-[8px] font-mono text-text-dim w-28 shrink-0">{c.label}</span>
              {pctBar(c.pct, 100, c.color)}
              <span className="text-[9px] font-mono w-8 text-right shrink-0" style={{ color: c.pct > 30 ? c.color : '#6b7280' }}>
                {c.pct}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Request Log ──────────────────────────────────────────────────────────────

function RequestLogPanel({ logs }: { logs: RequestLog[] }) {
  if (!logs.length) return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
      <h3 className="text-sm font-bold text-text-primary mb-2">Request Log</h3>
      <p className="text-[10px] text-text-dim">No recent requests logged (sampling is active — logs accumulate over time).</p>
    </div>
  );

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 space-y-3">
      <h3 className="text-sm font-bold text-text-primary">Recent Request Log</h3>
      <div className="space-y-1.5 max-h-56 overflow-y-auto">
        {logs.map(log => (
          <div key={log.id} className="flex items-center gap-3 text-[9px] font-mono py-1 border-b border-border-subtle/50 last:border-0">
            <span className={`shrink-0 px-1 py-0.5 rounded text-[8px] font-bold ${
              log.method === 'GET'    ? 'text-emerald-400 bg-emerald-400/10' :
              log.method === 'POST'  ? 'text-blue-400 bg-blue-400/10' :
              log.method === 'PATCH' ? 'text-yellow-400 bg-yellow-400/10' :
              'text-text-dim bg-bg-elevated'
            }`}>{log.method}</span>
            <span className="text-text-secondary flex-1 truncate">{log.route}</span>
            <span className={`shrink-0 ${log.status_code >= 500 ? 'text-red-400' : log.status_code >= 400 ? 'text-yellow-400' : 'text-text-dim'}`}>
              {log.status_code}
            </span>
            <span className={`shrink-0 w-12 text-right ${log.latency_ms > 1000 ? 'text-yellow-400' : log.latency_ms > 3000 ? 'text-red-400' : 'text-text-dim'}`}>
              {fmtMs(log.latency_ms)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── AI Streaming Tester ──────────────────────────────────────────────────────

function StreamingTester() {
  const [prompt, setPrompt]             = useState('Explain the relationship between democracy and free speech in three sentences.');
  const [tokens, setTokens]             = useState<StreamToken[]>([]);
  const [status, setStatus]             = useState<'idle' | 'connecting' | 'streaming' | 'done' | 'error'>('idle');
  const [meta, setMeta]                 = useState<{ total?: number; latency?: number; ttft?: number; from_cache?: boolean; is_fallback?: boolean } | null>(null);
  const [errorMsg, setErrorMsg]         = useState<string | null>(null);
  const socketRef                       = useRef<ReturnType<typeof socketIO> | null>(null);
  const requestIdRef                    = useRef<string>('');
  const outputRef                       = useRef<HTMLDivElement>(null);

  const cleanup = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [tokens]);

  function startStream() {
    if (status === 'streaming') {
      // Cancel
      socketRef.current?.emit('ai_stream_cancel', { requestId: requestIdRef.current });
      cleanup();
      setStatus('idle');
      return;
    }

    cleanup();
    setTokens([]);
    setMeta(null);
    setErrorMsg(null);
    setStatus('connecting');

    const requestId = `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    requestIdRef.current = requestId;

    const socket = socketIO({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setStatus('streaming');
      socket.emit('ai_stream', {
        prompt,
        requestId,
        context: 'analyze',
      });
    });

    socket.on('token', (data: StreamToken) => {
      setTokens(prev => [...prev, data]);
    });

    socket.on('stream_done', (data: { total_tokens: number; latency_ms: number; ttft_ms?: number; from_cache?: boolean; is_fallback?: boolean; cancelled?: boolean }) => {
      setMeta({
        total: data.total_tokens,
        latency: data.latency_ms,
        ttft: data.ttft_ms,
        from_cache: data.from_cache,
        is_fallback: data.is_fallback,
      });
      setStatus(data.cancelled ? 'idle' : 'done');
      cleanup();
    });

    socket.on('stream_error', (data: { error: string; fallback?: string }) => {
      setErrorMsg(data.error);
      if (data.fallback) {
        setTokens([{ token: data.fallback, index: 0, is_fallback: true }]);
      }
      setStatus('error');
      cleanup();
    });

    socket.on('connect_error', () => {
      setErrorMsg('WebSocket connection failed');
      setStatus('error');
      cleanup();
    });
  }

  const renderedText = tokens.map(t => t.token).join('');

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 space-y-4">
      <div>
        <h3 className="text-sm font-bold text-text-primary">AI Token Streaming Tester</h3>
        <p className="text-[10px] text-text-dim mt-0.5">
          Tests the live WebSocket streaming pipeline end-to-end — Gemini → token events → client render
        </p>
      </div>

      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        disabled={status === 'streaming'}
        rows={3}
        className="w-full bg-bg-elevated border border-border-subtle rounded-xl px-3 py-2.5 text-xs font-mono text-text-primary resize-none focus:outline-none focus:border-border-mid disabled:opacity-50"
        placeholder="Enter prompt to stream..."
      />

      <div className="flex items-center gap-3">
        <button
          onClick={startStream}
          disabled={!prompt.trim() || status === 'connecting'}
          className={`px-4 py-2 rounded-xl text-[10px] font-mono font-bold uppercase tracking-wider transition-all ${
            status === 'streaming'
              ? 'bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30'
              : 'bg-accent-purple/20 border border-accent-purple/40 text-accent-purple hover:bg-accent-purple/30 disabled:opacity-40 disabled:cursor-not-allowed'
          }`}
        >
          {status === 'connecting' ? '⟳ Connecting…' : status === 'streaming' ? '■ Stop' : '▶ Stream'}
        </button>

        {status === 'streaming' && (
          <span className="text-[9px] font-mono text-accent-teal-light animate-pulse">
            ● Receiving tokens ({tokens.length})
          </span>
        )}

        {status === 'done' && meta && (
          <div className="flex items-center gap-3 text-[9px] font-mono text-text-dim">
            <span className="text-emerald-400 font-bold">✓ Done</span>
            <span>{meta.total} tokens</span>
            <span>{fmtMs(meta.latency ?? 0)} total</span>
            {meta.ttft && <span>TTFT: {fmtMs(meta.ttft)}</span>}
            {meta.from_cache && <span className="text-yellow-400">from cache</span>}
            {meta.is_fallback && <span className="text-orange-400">fallback</span>}
          </div>
        )}

        {status === 'error' && errorMsg && (
          <span className="text-[9px] font-mono text-red-400">✗ {errorMsg}</span>
        )}
      </div>

      {/* Token output */}
      {(tokens.length > 0 || status === 'streaming') && (
        <div
          ref={outputRef}
          className="bg-bg-elevated rounded-xl p-4 min-h-[80px] max-h-48 overflow-y-auto font-mono text-xs text-text-primary leading-relaxed whitespace-pre-wrap"
        >
          {renderedText || <span className="text-text-dim animate-pulse">Waiting for first token…</span>}
          {status === 'streaming' && (
            <span className="inline-block w-1.5 h-3.5 bg-accent-purple ml-0.5 animate-pulse rounded-sm" />
          )}
        </div>
      )}

      {/* Token timeline */}
      {tokens.length > 0 && status === 'done' && (
        <div className="space-y-1">
          <p className="text-[8px] font-mono uppercase text-text-dim tracking-wider">Token timeline</p>
          <div className="flex flex-wrap gap-0.5">
            {tokens.slice(0, 80).map((t, i) => (
              <span
                key={i}
                className={`text-[7px] font-mono px-0.5 py-0.5 rounded ${
                  t.is_fallback ? 'text-orange-400 bg-orange-400/10' :
                  t.from_cache  ? 'text-yellow-400 bg-yellow-400/10' :
                  t.coalesced   ? 'text-blue-400 bg-blue-400/10' :
                  'text-text-dim bg-bg-elevated'
                }`}
                title={`Token #${t.index}: "${t.token}"`}
              >
                {t.token.slice(0, 6)}
              </span>
            ))}
            {tokens.length > 80 && (
              <span className="text-[7px] font-mono text-text-dim">+{tokens.length - 80} more</span>
            )}
          </div>
          <p className="text-[8px] font-mono text-text-dim">
            Purple=normal · Blue=coalesced · Yellow=cache · Orange=fallback
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Main Observability Panel ─────────────────────────────────────────────────

export default function ObservabilityPanel() {
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [logs, setLogs]       = useState<RequestLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState<'slo' | 'latency' | 'counters' | 'logs' | 'stream'>('slo');

  const load = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([
        api.getMetricsSummary().catch(() => null),
        api.getRequestLogs(20, 1).catch(() => ({ logs: [] })),
      ]);
      if (s) setSummary(s);
      setLogs(l?.logs ?? []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-5 h-5 border-2 border-accent-purple border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const TABS = [
    { id: 'slo' as const,      label: 'SLOs',         count: summary?.slos?.filter(s => !s.passing).length || 0 },
    { id: 'latency' as const,  label: 'Latency',      count: 0 },
    { id: 'counters' as const, label: 'Counters',     count: 0 },
    { id: 'logs' as const,     label: 'Request Log',  count: logs.length },
    { id: 'stream' as const,   label: 'Stream Test',  count: 0 },
  ];

  return (
    <div className="space-y-4">
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 bg-bg-elevated rounded-xl p-1 w-fit">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all ${
              tab === t.id
                ? 'bg-bg-surface text-text-primary shadow-sm'
                : 'text-text-dim hover:text-text-secondary'
            }`}
          >
            {t.label}
            {t.count > 0 && (
              <span className={`text-[8px] px-1 rounded ${t.id === 'slo' ? 'bg-red-400/20 text-red-400' : 'bg-bg-surface text-text-dim'}`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
        <button onClick={load} className="ml-1 px-2 py-1.5 text-[9px] font-mono text-text-dim hover:text-text-secondary transition-colors">
          ↺
        </button>
      </div>

      {tab === 'slo' && summary && (
        <SLOPanel slos={summary.slos} />
      )}

      {tab === 'latency' && summary && (
        <LatencyPanel histograms={summary.histograms} />
      )}

      {tab === 'counters' && summary && (
        <CountersPanel summary={summary} />
      )}

      {tab === 'logs' && (
        <RequestLogPanel logs={logs} />
      )}

      {tab === 'stream' && (
        <StreamingTester />
      )}

      {!summary && tab !== 'stream' && tab !== 'logs' && (
        <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 text-center">
          <p className="text-text-dim text-sm">Failed to load observability metrics. Is the server running?</p>
        </div>
      )}
    </div>
  );
}
