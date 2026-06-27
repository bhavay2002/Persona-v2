// In-Process Telemetry Engine
//
// Replaces the Prometheus stubs in metrics.ts with real, computed metrics.
// No external dependency — everything is computed in-process from ring buffers.
//
// Architecture:
//   LatencyHistogram  — ring buffer of last N samples, computes p50/p95/p99 in O(N log N)
//   Counter           — monotonically increasing integer
//   Gauge             — current value (connections, queue depth)
//   SLO               — evaluated against live histogram data
//
// Named metric buckets:
//   ai.generation     — full LLM call latency
//   ai.rerank         — RAG re-ranker call latency
//   ai.stream.ttft    — token streaming: time to first token
//   http.request      — per-route HTTP latency
//   ws.message        — WebSocket round-trip latency
//   queue.job         — background job execution latency
//   cache.ai          — AI cache lookup latency

// ─── Histogram ────────────────────────────────────────────────────────────────

class LatencyHistogram {
  private samples: number[] = [];
  private readonly maxSamples: number;

  constructor(max = 500) { this.maxSamples = max; }

  record(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil(sorted.length * p / 100) - 1);
    return Math.round(sorted[idx] ?? 0);
  }

  get count()  { return this.samples.length; }
  get mean()   { return this.samples.length ? Math.round(this.samples.reduce((a, b) => a + b, 0) / this.samples.length) : 0; }
  get p50()    { return this.percentile(50); }
  get p95()    { return this.percentile(95); }
  get p99()    { return this.percentile(99); }
  get latest() { return this.samples.length ? this.samples[this.samples.length - 1] : 0; }

  snapshot() {
    return { count: this.count, mean: this.mean, p50: this.p50, p95: this.p95, p99: this.p99, latest: this.latest };
  }
}

// ─── Counter ──────────────────────────────────────────────────────────────────

class Counter {
  private _value = 0;
  inc(by = 1) { this._value += by; }
  get value()  { return this._value; }
}

// ─── Gauge ────────────────────────────────────────────────────────────────────

class Gauge {
  private _value = 0;
  set(v: number)  { this._value = v; }
  inc(by = 1)     { this._value += by; }
  dec(by = 1)     { this._value = Math.max(0, this._value - by); }
  get value()     { return this._value; }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const histograms: Record<string, LatencyHistogram> = {
  'ai.generation':  new LatencyHistogram(500),
  'ai.rerank':      new LatencyHistogram(200),
  'ai.stream.ttft': new LatencyHistogram(200),
  'http.request':   new LatencyHistogram(1000),
  'ws.message':     new LatencyHistogram(500),
  'queue.job':      new LatencyHistogram(200),
};

const counters: Record<string, Counter> = {
  'ai.calls':         new Counter(),
  'ai.errors':        new Counter(),
  'ai.fallbacks':     new Counter(),
  'ai.stream.tokens': new Counter(),
  'cache.hits':       new Counter(),
  'cache.misses':     new Counter(),
  'http.requests':    new Counter(),
  'http.errors':      new Counter(),
  'ws.connections':   new Counter(),
  'ws.messages':      new Counter(),
  'ws.stream.starts': new Counter(),
};

const gauges: Record<string, Gauge> = {
  'ws.active':      new Gauge(),
  'queue.depth':    new Gauge(),
};

// ─── Public Recording API ─────────────────────────────────────────────────────

export function recordAICall(operation: string, latencyMs: number, errored = false): void {
  const bucket = histograms['ai.generation'];
  if (bucket) bucket.record(latencyMs);
  counters['ai.calls'].inc();
  if (errored) counters['ai.errors'].inc();
}

export function recordAIRerank(latencyMs: number): void {
  histograms['ai.rerank']?.record(latencyMs);
}

export function recordStreamTTFT(latencyMs: number, tokenCount: number): void {
  histograms['ai.stream.ttft']?.record(latencyMs);
  counters['ai.stream.tokens'].inc(tokenCount);
  counters['ws.stream.starts'].inc();
}

export function recordHttpRequest(route: string, latencyMs: number, status: number): void {
  histograms['http.request']?.record(latencyMs);
  counters['http.requests'].inc();
  if (status >= 500) counters['http.errors'].inc();
}

export function recordWSMessage(latencyMs: number): void {
  histograms['ws.message']?.record(latencyMs);
  counters['ws.messages'].inc();
}

export function recordCacheEvent(hit: boolean): void {
  if (hit) counters['cache.hits'].inc();
  else counters['cache.misses'].inc();
}

export function recordQueueJob(latencyMs: number): void {
  histograms['queue.job']?.record(latencyMs);
}

export function setWSConnections(n: number): void {
  gauges['ws.active'].set(n);
}

export function setQueueDepth(n: number): void {
  gauges['queue.depth'].set(n);
}

export function recordAIFallback(): void {
  counters['ai.fallbacks'].inc();
}

// ─── Timer helpers (mirrors Prometheus startTimer pattern) ────────────────────

export function startAITimer(operation = 'generate'): (errored?: boolean) => void {
  const t0 = Date.now();
  return (errored = false) => recordAICall(operation, Date.now() - t0, errored);
}

export function startHttpTimer(): (status?: number) => void {
  const t0 = Date.now();
  return (status = 200) => recordHttpRequest('', Date.now() - t0, status);
}

// ─── SLO Definitions ──────────────────────────────────────────────────────────

export interface SLOResult {
  name: string;
  description: string;
  target: number;
  actual: number;
  unit: string;
  passing: boolean;
  margin: number;  // how far from the threshold (positive = headroom, negative = violation)
}

const SLO_TARGETS = [
  { name: 'AI p95 Latency',       key: 'ai.generation',  percentile: 95, target: 2500, unit: 'ms', lower_is_better: true,  desc: 'LLM call latency p95 < 2.5s' },
  { name: 'AI p99 Latency',       key: 'ai.generation',  percentile: 99, target: 5000, unit: 'ms', lower_is_better: true,  desc: 'LLM call latency p99 < 5s' },
  { name: 'HTTP p95 Latency',     key: 'http.request',   percentile: 95, target: 500,  unit: 'ms', lower_is_better: true,  desc: 'HTTP request p95 < 500ms' },
  { name: 'WS p95 Latency',       key: 'ws.message',     percentile: 95, target: 300,  unit: 'ms', lower_is_better: true,  desc: 'WebSocket message p95 < 300ms' },
  { name: 'Queue Job p95',        key: 'queue.job',       percentile: 95, target: 5000, unit: 'ms', lower_is_better: true,  desc: 'Queue job p95 < 5s' },
  { name: 'TTFT p95',             key: 'ai.stream.ttft', percentile: 95, target: 800,  unit: 'ms', lower_is_better: true,  desc: 'Streaming time-to-first-token p95 < 800ms' },
];

export function getSLOStatus(): SLOResult[] {
  const aiTotal = counters['ai.calls'].value + counters['ai.errors'].value || 1;
  const errorRatePct = Math.round((counters['ai.errors'].value / aiTotal) * 1000) / 10;
  const httpTotal = counters['http.requests'].value || 1;
  const httpErrorRatePct = Math.round((counters['http.errors'].value / httpTotal) * 1000) / 10;
  const cacheTotal = counters['cache.hits'].value + counters['cache.misses'].value || 1;
  const cacheHitPct = Math.round((counters['cache.hits'].value / cacheTotal) * 1000) / 10;

  const results: SLOResult[] = SLO_TARGETS.map(slo => {
    const hist = histograms[slo.key];
    const actual = hist ? hist.percentile(slo.percentile) : 0;
    const passing = slo.lower_is_better ? actual <= slo.target || hist!.count === 0 : actual >= slo.target;
    const margin = slo.lower_is_better ? slo.target - actual : actual - slo.target;
    return { name: slo.name, description: slo.desc, target: slo.target, actual, unit: slo.unit, passing, margin };
  });

  // Computed-metric SLOs
  results.push({
    name: 'AI Error Rate',
    description: 'AI error rate < 2%',
    target: 2, actual: errorRatePct, unit: '%',
    passing: errorRatePct <= 2 || counters['ai.errors'].value === 0,
    margin: 2 - errorRatePct,
  });

  results.push({
    name: 'Cache Hit Rate',
    description: 'AI cache hit rate > 30%',
    target: 30, actual: cacheHitPct, unit: '%',
    passing: cacheHitPct >= 30 || cacheTotal <= 5,
    margin: cacheHitPct - 30,
  });

  return results;
}

// ─── Metrics Summary ──────────────────────────────────────────────────────────

export function getMetricsSummary() {
  const aiTotal = counters['ai.calls'].value || 1;
  const cacheTotal = counters['cache.hits'].value + counters['cache.misses'].value || 1;
  const httpTotal = counters['http.requests'].value || 1;

  return {
    histograms: Object.fromEntries(
      Object.entries(histograms).map(([k, h]) => [k, h.snapshot()])
    ),
    counters: Object.fromEntries(
      Object.entries(counters).map(([k, c]) => [k, c.value])
    ),
    gauges: Object.fromEntries(
      Object.entries(gauges).map(([k, g]) => [k, g.value])
    ),
    computed: {
      ai_error_rate_pct:    Math.round((counters['ai.errors'].value / aiTotal) * 1000) / 10,
      ai_fallback_rate_pct: Math.round((counters['ai.fallbacks'].value / aiTotal) * 1000) / 10,
      cache_hit_rate_pct:   Math.round((counters['cache.hits'].value / cacheTotal) * 1000) / 10,
      http_error_rate_pct:  Math.round((counters['http.errors'].value / httpTotal) * 1000) / 10,
    },
    slos: getSLOStatus(),
    ws_active_connections: gauges['ws.active'].value,
    queue_depth: gauges['queue.depth'].value,
  };
}

// ─── Prometheus-compatible text format ────────────────────────────────────────
// Returns a minimal text/plain metrics page for /metrics

export function getPrometheusText(): string {
  const lines: string[] = [];
  const ts = Date.now();

  for (const [name, hist] of Object.entries(histograms)) {
    const safe = name.replace(/\./g, '_');
    if (hist.count === 0) continue;
    lines.push(`# HELP ${safe}_ms Latency histogram for ${name}`);
    lines.push(`# TYPE ${safe}_ms summary`);
    lines.push(`${safe}_ms{quantile="0.5"} ${hist.p50}`);
    lines.push(`${safe}_ms{quantile="0.95"} ${hist.p95}`);
    lines.push(`${safe}_ms{quantile="0.99"} ${hist.p99}`);
    lines.push(`${safe}_ms_sum ${hist.mean * hist.count}`);
    lines.push(`${safe}_ms_count ${hist.count}`);
  }

  for (const [name, counter] of Object.entries(counters)) {
    const safe = name.replace(/\./g, '_') + '_total';
    lines.push(`# TYPE ${safe} counter`);
    lines.push(`${safe} ${counter.value} ${ts}`);
  }

  for (const [name, gauge] of Object.entries(gauges)) {
    const safe = name.replace(/\./g, '_');
    lines.push(`# TYPE ${safe} gauge`);
    lines.push(`${safe} ${gauge.value} ${ts}`);
  }

  return lines.join('\n') + '\n';
}
