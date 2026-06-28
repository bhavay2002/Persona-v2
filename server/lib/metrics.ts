// Metrics — delegates to real in-process telemetry engine
// Preserves the original stub interface so all existing callers still compile.

import {
  startAITimer, startHttpTimer, recordQueueJob,
  getPrometheusText, getMetricsSummary,
} from './telemetry.js';

// Prometheus-compatible register (text format via getPrometheusText)
export const register = {
  contentType: 'text/plain; version=0.0.4',
  metrics: async () => getPrometheusText(),
};

// AI latency timer — stub interface, now records to real histogram
export const aiLatency = {
  startTimer: (labels: { operation?: string; model?: string }) => {
    const end = startAITimer(labels.operation || 'generate');
    return (endLabels?: { error?: string }) => end(!!endLabels?.error);
  },
};

// AI error counter — stub interface, now recorded inside startAITimer
export const aiErrors = {
  inc: (_labels: { operation?: string; reason?: string }) => {
    // Errors recorded via startAITimer(op, true) — no-op here to avoid double-counting
  },
};

// HTTP latency timer
export const httpDuration = {
  startTimer: (_labels: { method?: string; route?: string }) => {
    const end = startHttpTimer();
    return (endLabels?: { status?: number }) => end(endLabels?.status ?? 200);
  },
};

// Queue job duration timer
export const queueDuration = {
  startTimer: (_labels: { queue?: string; job?: string }) => {
    const t0 = Date.now();
    return (_endLabels?: any) => recordQueueJob(Date.now() - t0);
  },
};

// RAG recall gauge (for observabilityHooks compat)
export const ragRecall = {
  set: (_labels: { persona_scope?: string }, _value: number) => {},
};

// Debate generation timer
export const debateGen = {
  startTimer: (_labels: { model?: string }) => {
    const end = startAITimer('debate');
    return (_endLabels?: any) => end();
  },
};

export { getMetricsSummary };
