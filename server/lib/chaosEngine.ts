// Chaos Engine — Controlled Failure Injection for Resilience Testing
//
// Injects controlled failures and artificial latency into AI calls.
// Activated only when chaos mode is explicitly enabled via the /api/resilience/chaos endpoint.
//
// This demonstrates professional-grade resilience testing (Chaos Engineering).
// Chaos is NEVER active in production unless explicitly toggled via the API.

interface ChaosConfig {
  enabled: boolean;
  ai_failure_probability: number;   // 0.0-1.0
  ai_latency_probability: number;   // 0.0-1.0
  ai_latency_ms: number;
  db_failure_probability: number;   // 0.0-1.0
  injection_count: number;
  failure_injections: number;
  latency_injections: number;
  last_injected_at: number | null;
  enabled_since: number | null;
}

let _config: ChaosConfig = {
  enabled: false,
  ai_failure_probability: 0.10,
  ai_latency_probability: 0.15,
  ai_latency_ms: 2_000,
  db_failure_probability: 0.00,  // off by default — DB chaos is destructive
  injection_count: 0,
  failure_injections: 0,
  latency_injections: 0,
  last_injected_at: null,
  enabled_since: null,
};

export function getChaosConfig(): Omit<ChaosConfig, never> {
  return { ..._config };
}

export function setChaosConfig(
  updates: Partial<Pick<ChaosConfig,
    'enabled' | 'ai_failure_probability' | 'ai_latency_probability' |
    'ai_latency_ms' | 'db_failure_probability'
  >>
): void {
  const wasEnabled = _config.enabled;

  if ('ai_failure_probability' in updates) {
    _config.ai_failure_probability = Math.max(0, Math.min(1, updates.ai_failure_probability!));
  }
  if ('ai_latency_probability' in updates) {
    _config.ai_latency_probability = Math.max(0, Math.min(1, updates.ai_latency_probability!));
  }
  if ('ai_latency_ms' in updates) {
    _config.ai_latency_ms = Math.max(0, Math.min(10_000, updates.ai_latency_ms!));
  }
  if ('db_failure_probability' in updates) {
    _config.db_failure_probability = Math.max(0, Math.min(0.5, updates.db_failure_probability!)); // max 50% DB chaos
  }
  if ('enabled' in updates) {
    _config.enabled = updates.enabled!;
    if (updates.enabled && !wasEnabled) {
      _config.enabled_since = Date.now();
      console.warn('[chaos] ⚠  Chaos mode ENABLED — resilience testing active');
    } else if (!updates.enabled && wasEnabled) {
      console.log(`[chaos] Chaos mode DISABLED — ${_config.injection_count} total injections`);
    }
  }
}

export function isChaosEnabled(): boolean {
  return _config.enabled;
}

// Called inside callWithResilience() before each AI request.
// Throws to simulate failure, or delays to simulate latency.
export async function injectAIChaos(): Promise<void> {
  if (!_config.enabled) return;

  // Failure injection — throws, triggering the circuit breaker
  if (Math.random() < _config.ai_failure_probability) {
    _config.injection_count++;
    _config.failure_injections++;
    _config.last_injected_at = Date.now();
    console.warn(`[chaos] 💥 AI failure injected (injection #${_config.injection_count})`);
    throw new Error('[CHAOS] Simulated AI failure — resilience test');
  }

  // Latency injection — delays but does not fail
  if (Math.random() < _config.ai_latency_probability) {
    _config.injection_count++;
    _config.latency_injections++;
    _config.last_injected_at = Date.now();
    console.warn(`[chaos] 🐢 AI latency injected: ${_config.ai_latency_ms}ms (injection #${_config.injection_count})`);
    await new Promise(r => setTimeout(r, _config.ai_latency_ms));
  }
}

// Called in DB middleware (optional — higher risk, use sparingly)
export async function injectDBChaos(): Promise<void> {
  if (!_config.enabled || _config.db_failure_probability <= 0) return;

  if (Math.random() < _config.db_failure_probability) {
    _config.injection_count++;
    _config.failure_injections++;
    _config.last_injected_at = Date.now();
    console.warn(`[chaos] 💥 DB failure injected`);
    throw new Error('[CHAOS] Simulated DB failure — resilience test');
  }
}
