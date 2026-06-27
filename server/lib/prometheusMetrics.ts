// ─── Prometheus Metrics Registry ─────────────────────────────────────────────
// Pure-JS Prometheus exposition format — no extra dependencies needed.
// Exposes: HTTP request counters + histograms, AI latency, circuit breakers,
//          job queue depths, active WebSocket connections.

interface Counter {
  type: 'counter';
  help: string;
  labels: string[];
  values: Map<string, number>;
}

interface Gauge {
  type: 'gauge';
  help: string;
  labels: string[];
  values: Map<string, number>;
}

interface Histogram {
  type: 'histogram';
  help: string;
  labels: string[];
  buckets: number[];
  counts: Map<string, number[]>;  // label key → bucket counts
  sums: Map<string, number>;
  totals: Map<string, number>;
}

type Metric = Counter | Gauge | Histogram;

const registry = new Map<string, Metric>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
    .join(',');
}

function labelStr(labels: Record<string, string>): string {
  const k = labelKey(labels);
  return k ? `{${k}}` : '';
}

// ── Registration helpers ──────────────────────────────────────────────────────

export function registerCounter(name: string, help: string, labels: string[] = []): void {
  if (!registry.has(name)) {
    registry.set(name, { type: 'counter', help, labels, values: new Map() });
  }
}

export function registerGauge(name: string, help: string, labels: string[] = []): void {
  if (!registry.has(name)) {
    registry.set(name, { type: 'gauge', help, labels, values: new Map() });
  }
}

export function registerHistogram(
  name: string,
  help: string,
  labels: string[] = [],
  buckets: number[] = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
): void {
  if (!registry.has(name)) {
    registry.set(name, { type: 'histogram', help, labels, buckets, counts: new Map(), sums: new Map(), totals: new Map() });
  }
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

export function incCounter(name: string, labels: Record<string, string> = {}, by = 1): void {
  const m = registry.get(name) as Counter | undefined;
  if (!m || m.type !== 'counter') return;
  const k = labelKey(labels);
  m.values.set(k, (m.values.get(k) || 0) + by);
}

export function setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
  const m = registry.get(name) as Gauge | undefined;
  if (!m || m.type !== 'gauge') return;
  m.values.set(labelKey(labels), value);
}

export function incGauge(name: string, labels: Record<string, string> = {}, by = 1): void {
  const m = registry.get(name) as Gauge | undefined;
  if (!m || m.type !== 'gauge') return;
  const k = labelKey(labels);
  m.values.set(k, (m.values.get(k) || 0) + by);
}

export function decGauge(name: string, labels: Record<string, string> = {}, by = 1): void {
  incGauge(name, labels, -by);
}

export function observeHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
  const m = registry.get(name) as Histogram | undefined;
  if (!m || m.type !== 'histogram') return;
  const k = labelKey(labels);

  if (!m.counts.has(k)) {
    m.counts.set(k, new Array(m.buckets.length + 1).fill(0));
    m.sums.set(k, 0);
    m.totals.set(k, 0);
  }

  const counts = m.counts.get(k)!;
  for (let i = 0; i < m.buckets.length; i++) {
    if (value <= m.buckets[i]) counts[i]++;
  }
  counts[m.buckets.length]++; // +Inf bucket
  m.sums.set(k, (m.sums.get(k) || 0) + value);
  m.totals.set(k, (m.totals.get(k) || 0) + 1);
}

// ── Exposition (text format 0.0.4) ───────────────────────────────────────────

export function exposeMetrics(): string {
  const lines: string[] = [];

  for (const [name, m] of registry.entries()) {
    lines.push(`# HELP ${name} ${m.help}`);
    lines.push(`# TYPE ${name} ${m.type}`);

    if (m.type === 'counter' || m.type === 'gauge') {
      if (m.values.size === 0) {
        lines.push(`${name} 0`);
      } else {
        for (const [k, v] of m.values.entries()) {
          lines.push(`${name}${k ? `{${k}}` : ''} ${v}`);
        }
      }
    } else if (m.type === 'histogram') {
      for (const k of m.counts.keys()) {
        const counts = m.counts.get(k)!;
        const sum = m.sums.get(k) || 0;
        const total = m.totals.get(k) || 0;
        const labelPrefix = k ? `{${k},` : '{';
        const labelSuffix = k ? '}' : '';

        for (let i = 0; i < m.buckets.length; i++) {
          lines.push(`${name}_bucket${labelPrefix}le="${m.buckets[i]}"} ${counts[i]}`);
        }
        lines.push(`${name}_bucket${labelPrefix}le="+Inf"} ${counts[m.buckets.length]}`);
        lines.push(`${name}_sum${k ? `{${k}}` : ''} ${sum}`);
        lines.push(`${name}_count${k ? `{${k}}` : ''} ${total}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

// ── Define all platform metrics up-front ─────────────────────────────────────

// HTTP
registerCounter('http_requests_total', 'Total HTTP requests', ['method', 'route', 'status']);
registerHistogram('http_request_duration_ms', 'HTTP request duration in milliseconds', ['method', 'route', 'status']);
registerGauge('http_active_requests', 'Number of HTTP requests currently in flight');

// AI
registerCounter('ai_requests_total', 'Total AI (Gemini) requests', ['operation', 'status']);
registerHistogram('ai_request_duration_ms', 'AI generation latency in milliseconds', ['operation'],
  [100, 250, 500, 1000, 2000, 3000, 5000, 10000, 15000, 30000]);
registerCounter('ai_tokens_total', 'Total tokens generated by AI', ['operation']);
registerCounter('ai_fallbacks_total', 'Total AI calls that fell back to a cached/simplified response', ['operation']);

// Circuit Breakers
registerGauge('circuit_breaker_state', 'Circuit breaker state: 0=CLOSED 1=HALF_OPEN 2=OPEN', ['name']);
registerCounter('circuit_breaker_opens_total', 'Total number of times a circuit breaker opened', ['name']);
registerCounter('circuit_breaker_fallbacks_total', 'Total fallback calls via circuit breaker', ['name']);

// WebSocket / Debates
registerGauge('websocket_connections_active', 'Number of active WebSocket connections');
registerGauge('debate_rooms_active', 'Number of active debate Socket.io rooms');
registerCounter('debate_messages_total', 'Total debate messages processed', ['type']);

// Job Queue
registerGauge('job_queue_depth', 'Number of pending jobs in the queue', ['job_type']);
registerCounter('jobs_processed_total', 'Total jobs processed', ['job_type', 'status']);
registerHistogram('job_duration_ms', 'Job processing time in milliseconds', ['job_type']);

// Personalization
registerCounter('feed_requests_total', 'Total personalized feed requests', ['type']);
registerHistogram('feed_scoring_duration_ms', 'Feed scoring latency in milliseconds');

// Application
registerGauge('app_info', 'Application version info', ['version', 'node_version']);
registerGauge('app_uptime_seconds', 'Application uptime in seconds');

// Set static gauges
const startTime = Date.now();
setGauge('app_info', 1, { version: process.env.npm_package_version || '1.0.0', node_version: process.version });

// ── Uptime updater ────────────────────────────────────────────────────────────
setInterval(() => {
  setGauge('app_uptime_seconds', Math.floor((Date.now() - startTime) / 1000));
}, 5_000);
