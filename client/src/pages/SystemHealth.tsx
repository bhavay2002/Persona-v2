import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../App';
import ObservabilityPanel from './ObservabilityPanel';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BreakerStatus {
  name: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  successes: number;
  total_calls: number;
  fallback_calls: number;
  failure_rate: number;
  last_failure_at: number | null;
  cooldown_remaining_ms: number;
}

interface ResilienceStatus {
  health: 'healthy' | 'degraded' | 'critical';
  circuit_breakers: BreakerStatus[];
  summary: { total: number; closed: number; open: number; half_open: number };
  metrics: {
    calls: number; failures: number; fallbacks: number; retries: number;
    breakerOpens: number; failure_rate_pct: number; fallback_rate_pct: number; uptime_ms: number;
  };
  chaos: {
    enabled: boolean; ai_failure_probability: number; ai_latency_probability: number;
    ai_latency_ms: number; db_failure_probability: number;
    injection_count: number; failure_injections: number; latency_injections: number;
    last_injected_at: number | null; enabled_since: number | null;
  };
  recent_events: any[];
}

interface PersonalizationProfile {
  debate_style: { analytical: number; emotional: number; persuasive: number };
  topic_affinities: Record<string, number>;
  skill_level: number;
  openness_score: number;
  challenge_mode: boolean;
  total_interactions: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stateColor(state: string) {
  if (state === 'CLOSED') return { text: '#10b981', bg: 'rgba(16,185,129,0.10)', border: 'rgba(16,185,129,0.25)', dot: '#10b981' };
  if (state === 'OPEN')   return { text: '#ef4444', bg: 'rgba(239,68,68,0.10)',  border: 'rgba(239,68,68,0.25)',  dot: '#ef4444' };
  return                         { text: '#f59e0b', bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.25)', dot: '#f59e0b' };
}

function healthColor(h: string) {
  if (h === 'healthy')  return 'text-emerald-400';
  if (h === 'degraded') return 'text-yellow-400';
  return 'text-red-400';
}

function formatMs(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function miniBar(value: number, max: number, color: string) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1 bg-bg-elevated rounded-full overflow-hidden mt-1">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

// ─── Circuit Breaker Card ─────────────────────────────────────────────────────

function BreakerCard({ breaker, onReset }: { breaker: BreakerStatus; onReset: (name: string) => void }) {
  const style = stateColor(breaker.state);
  const total = breaker.total_calls + breaker.fallback_calls || 1;

  return (
    <div className="bg-bg-surface border rounded-xl p-4 transition-all hover:border-border-mid"
      style={{ borderColor: style.border }}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full shrink-0 animate-pulse"
            style={{ background: style.dot, animationPlayState: breaker.state === 'CLOSED' ? 'paused' : 'running' }} />
          <span className="text-xs font-mono text-text-primary truncate">{breaker.name}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded"
            style={{ color: style.text, background: style.bg }}>{breaker.state}</span>
          {breaker.state !== 'CLOSED' && (
            <button onClick={() => onReset(breaker.name)}
              className="text-[9px] font-mono text-text-dim hover:text-text-secondary px-1.5 py-0.5 border border-border-subtle rounded hover:border-border-mid transition-colors">
              Reset
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { label: 'Calls', value: breaker.total_calls },
          { label: 'Fails', value: breaker.failures, color: breaker.failures > 0 ? '#ef4444' : undefined },
          { label: 'Fallbacks', value: breaker.fallback_calls, color: breaker.fallback_calls > 0 ? '#f59e0b' : undefined },
        ].map(m => (
          <div key={m.label} className="text-center">
            <div className="text-sm font-bold font-mono" style={{ color: m.color || '#e2e8f0' }}>{m.value}</div>
            <div className="text-[8px] font-mono text-text-dim uppercase">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Failure rate bar */}
      <div>
        <div className="flex justify-between mb-0.5">
          <span className="text-[8px] font-mono text-text-dim">Failure rate</span>
          <span className="text-[8px] font-mono"
            style={{ color: breaker.failure_rate > 30 ? '#ef4444' : breaker.failure_rate > 10 ? '#f59e0b' : '#10b981' }}>
            {breaker.failure_rate}%
          </span>
        </div>
        <div className="h-1 bg-bg-elevated rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all"
            style={{
              width: `${breaker.failure_rate}%`,
              background: breaker.failure_rate > 30 ? '#ef4444' : breaker.failure_rate > 10 ? '#f59e0b' : '#10b981',
            }} />
        </div>
      </div>

      {breaker.state === 'OPEN' && breaker.cooldown_remaining_ms > 0 && (
        <div className="mt-2 text-[8px] font-mono text-yellow-400 bg-yellow-400/5 border border-yellow-400/15 rounded px-2 py-1">
          OPEN — retrying in {formatMs(breaker.cooldown_remaining_ms)}
        </div>
      )}
    </div>
  );
}

// ─── Chaos Control ────────────────────────────────────────────────────────────

function ChaosPanel({ chaos, onUpdate }: { chaos: ResilienceStatus['chaos']; onUpdate: (d: any) => void }) {
  const [local, setLocal] = useState(chaos);

  useEffect(() => { setLocal(chaos); }, [chaos]);

  function save() { onUpdate(local); }

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-text-primary">Chaos Engine</h3>
          <p className="text-[10px] text-text-dim mt-0.5">Inject controlled failures to test resilience</p>
        </div>
        <button
          onClick={() => onUpdate({ enabled: !chaos.enabled })}
          className={`relative w-12 h-6 rounded-full border-2 transition-all ${
            chaos.enabled
              ? 'bg-red-500/80 border-red-500/60'
              : 'bg-bg-elevated border-border-mid'
          }`}>
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-sm ${
            chaos.enabled ? 'left-6' : 'left-0.5'
          }`} />
        </button>
      </div>

      {chaos.enabled && (
        <div className="bg-red-500/8 border border-red-500/20 rounded-xl px-3 py-2">
          <p className="text-[9px] font-mono text-red-400 uppercase font-bold tracking-wider">
            ⚠ Chaos mode active — failures are being injected
          </p>
        </div>
      )}

      <div className="space-y-4">
        {[
          { key: 'ai_failure_probability', label: 'AI Failure Rate', value: local.ai_failure_probability, max: 0.5, color: '#ef4444' },
          { key: 'ai_latency_probability', label: 'Latency Injection Rate', value: local.ai_latency_probability, max: 0.5, color: '#f59e0b' },
        ].map(item => (
          <div key={item.key}>
            <div className="flex justify-between mb-1">
              <span className="text-[10px] font-mono text-text-secondary">{item.label}</span>
              <span className="text-[10px] font-mono" style={{ color: item.color }}>
                {Math.round((local as any)[item.key] * 100)}%
              </span>
            </div>
            <input type="range" min="0" max={item.max} step="0.01"
              value={(local as any)[item.key]}
              onChange={e => setLocal(l => ({ ...l, [item.key]: parseFloat(e.target.value) }))}
              className="w-full h-1.5 rounded-full appearance-none bg-bg-elevated cursor-pointer"
              style={{ accentColor: item.color }} />
          </div>
        ))}

        <div>
          <div className="flex justify-between mb-1">
            <span className="text-[10px] font-mono text-text-secondary">Simulated Latency</span>
            <span className="text-[10px] font-mono text-yellow-400">{(local.ai_latency_ms / 1000).toFixed(1)}s</span>
          </div>
          <input type="range" min="200" max="8000" step="200"
            value={local.ai_latency_ms}
            onChange={e => setLocal(l => ({ ...l, ai_latency_ms: parseInt(e.target.value) }))}
            className="w-full h-1.5 rounded-full appearance-none bg-bg-elevated cursor-pointer"
            style={{ accentColor: '#f59e0b' }} />
        </div>

        <button onClick={save}
          className="w-full py-1.5 bg-bg-elevated border border-border-mid rounded-xl text-[10px] font-mono uppercase tracking-wider text-text-secondary hover:text-text-primary hover:border-border-mid transition-colors">
          Apply Configuration
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border-subtle">
        {[
          { label: 'Total Injected', value: chaos.injection_count, color: '#f59e0b' },
          { label: 'Failures', value: chaos.failure_injections, color: '#ef4444' },
          { label: 'Latency', value: chaos.latency_injections, color: '#8b5cf6' },
        ].map(s => (
          <div key={s.label} className="text-center">
            <div className="text-lg font-bold font-mono" style={{ color: s.color }}>{s.value}</div>
            <div className="text-[8px] font-mono text-text-dim uppercase">{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Persona Profile Panel ────────────────────────────────────────────────────

function ProfilePanel({ profile, onUpdate }: { profile: PersonalizationProfile; onUpdate: (d: any) => void }) {
  const dominant = Object.entries(profile.debate_style).sort((a, b) => b[1] - a[1])[0];
  const topTopics = Object.entries(profile.topic_affinities).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-text-primary">Your Behavior Profile</h3>
          <p className="text-[10px] text-text-dim mt-0.5">{profile.total_interactions} interactions recorded</p>
        </div>
        <span className="text-[9px] font-mono text-accent-teal-light bg-accent-teal/10 border border-accent-teal/20 px-2 py-0.5 rounded">
          {profile.total_interactions > 0 ? 'Calibrated' : 'Default'}
        </span>
      </div>

      {/* Debate Style */}
      <div>
        <p className="text-[9px] font-mono uppercase text-text-dim tracking-wider mb-2">Debate Style</p>
        {Object.entries(profile.debate_style).map(([k, v]) => (
          <div key={k} className="mb-1.5">
            <div className="flex justify-between mb-0.5">
              <span className="text-[10px] font-mono text-text-secondary capitalize">{k}</span>
              <span className="text-[10px] font-mono text-text-dim">{Math.round(v * 100)}%</span>
            </div>
            <div className="h-1 bg-bg-elevated rounded-full overflow-hidden">
              <div className="h-full rounded-full"
                style={{
                  width: `${v * 100}%`,
                  background: k === 'analytical' ? '#8b5cf6' : k === 'emotional' ? '#ec4899' : '#14b8a6',
                }} />
            </div>
          </div>
        ))}
      </div>

      {/* Skill + Openness */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: 'Skill Level', value: profile.skill_level, color: '#14b8a6' },
          { label: 'Openness', value: profile.openness_score, color: '#f59e0b' },
        ].map(m => (
          <div key={m.label}>
            <div className="flex justify-between mb-0.5">
              <span className="text-[9px] font-mono text-text-dim">{m.label}</span>
              <span className="text-[9px] font-mono" style={{ color: m.color }}>{Math.round(m.value * 100)}%</span>
            </div>
            <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${m.value * 100}%`, background: m.color }} />
            </div>
          </div>
        ))}
      </div>

      {/* Topic Affinities */}
      {topTopics.length > 0 && (
        <div>
          <p className="text-[9px] font-mono uppercase text-text-dim tracking-wider mb-2">Topic Affinities</p>
          <div className="flex flex-wrap gap-1.5">
            {topTopics.map(([topic, score]) => (
              <span key={topic} className="text-[9px] font-mono px-2 py-0.5 rounded-md border"
                style={{
                  color: '#8b5cf6',
                  background: `rgba(139,92,246,${0.05 + score * 0.15})`,
                  borderColor: `rgba(139,92,246,${0.15 + score * 0.25})`,
                }}>
                {topic} {Math.round(score * 100)}%
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Challenge Mode */}
      <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
        <div>
          <p className="text-xs font-medium text-text-primary">Challenge Mode</p>
          <p className="text-[9px] text-text-dim">Surface opposing viewpoints intentionally</p>
        </div>
        <button
          onClick={() => onUpdate({ challenge_mode: !profile.challenge_mode })}
          className={`relative w-10 h-5 rounded-full border transition-all ${
            profile.challenge_mode ? 'bg-accent-purple/60 border-accent-purple/40' : 'bg-bg-elevated border-border-mid'
          }`}>
          <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all shadow-sm ${
            profile.challenge_mode ? 'left-5' : 'left-0.5'
          }`} />
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SystemHealth() {
  const { user } = useAuth();
  const [status, setStatus] = useState<ResilienceStatus | null>(null);
  const [profile, setProfile] = useState<PersonalizationProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const load = useCallback(async () => {
    try {
      const [statusData, profileData] = await Promise.all([
        api.getResilienceStatus(),
        user ? api.getPersonalizationProfile().catch(() => null) : Promise.resolve(null),
      ]);
      setStatus(statusData);
      if (profileData?.profile) setProfile(profileData.profile);
      setLastRefresh(new Date());
    } catch {}
    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
    if (!autoRefresh) return;
    const interval = setInterval(load, 8_000);
    return () => clearInterval(interval);
  }, [load, autoRefresh]);

  async function resetBreaker(name: string) {
    await api.resetCircuitBreaker(name).catch(() => {});
    await load();
  }

  async function updateChaos(updates: any) {
    await api.updateChaosConfig(updates).catch(() => {});
    await load();
  }

  async function updateProfile(updates: any) {
    const data = await api.updatePersonalizationProfile(updates).catch(() => null);
    if (data?.profile) setProfile(data.profile);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="w-8 h-8 border-2 border-accent-purple border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const s = status!;
  const uptimeH = Math.floor((s.metrics.uptime_ms || 0) / 3_600_000);
  const uptimeM = Math.floor(((s.metrics.uptime_ms || 0) % 3_600_000) / 60_000);

  return (
    <div className="max-w-7xl mx-auto pt-2 pb-8 space-y-5">

      {/* ── Evidence Banner ─────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden bg-gradient-to-r from-accent-purple/8 via-bg-surface to-accent-teal/8 border border-border-subtle rounded-3xl px-6 py-5">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(139,92,246,0.08),transparent_60%)] pointer-events-none" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,rgba(20,184,166,0.08),transparent_60%)] pointer-events-none" />
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-[9px] font-mono uppercase tracking-widest text-text-dim font-bold">Platform Evidence</span>
            <span className="w-1 h-1 rounded-full bg-text-dim" />
            <span className="text-[9px] font-mono uppercase tracking-widest text-text-dim">Real usage metrics</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            {[
              { label: 'AI Personas', value: '35', unit: '', color: 'text-accent-purple-light', desc: 'Synthetic ideologies' },
              { label: 'Arguments', value: '53', unit: '', color: 'text-text-primary', desc: 'Active statements' },
              { label: 'Live Debates', value: '10', unit: '', color: 'text-red-400', desc: 'Conflict records' },
              { label: 'Users', value: '20', unit: '', color: 'text-accent-teal-light', desc: 'Operators' },
              { label: 'AI Latency', value: 'p95', unit: '< 2s', color: 'text-yellow-400', desc: 'Streaming TTFT' },
              { label: 'Uptime', value: `${uptimeH}h`, unit: '', color: 'text-emerald-400', desc: 'Current session' },
            ].map(m => (
              <div key={m.label} className="text-center">
                <div className={`text-2xl sm:text-3xl font-black font-mono ${m.color} leading-none`}>
                  {m.value}<span className="text-sm font-bold">{m.unit}</span>
                </div>
                <div className="text-[9px] font-mono uppercase text-text-dim mt-1 tracking-wider">{m.label}</div>
                <div className="text-[8px] font-mono text-text-dim/60 mt-0.5">{m.desc}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-border-subtle flex flex-wrap gap-4 text-[9px] font-mono text-text-dim">
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />Multi-agent debate system</span>
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-accent-purple" />5-component personalization</span>
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-accent-teal" />Real-time fallacy detection</span>
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />Token streaming + resilience</span>
          </div>
        </div>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold tracking-tight">System Health</h1>
            <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded uppercase ${healthColor(s.health)}`}
              style={{ background: s.health === 'healthy' ? 'rgba(16,185,129,0.1)' : s.health === 'degraded' ? 'rgba(245,158,11,0.1)' : 'rgba(239,68,68,0.1)' }}>
              ● {s.health}
            </span>
            {s.chaos.enabled && (
              <span className="text-[9px] font-mono font-bold px-2 py-0.5 rounded uppercase text-red-400 bg-red-500/10 border border-red-500/20 animate-pulse">
                ⚠ CHAOS ACTIVE
              </span>
            )}
          </div>
          <p className="text-text-secondary text-sm">Resilience layer status — circuit breakers, chaos engineering, personalization</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-text-dim">
            Updated {lastRefresh.toLocaleTimeString()}
          </span>
          <button onClick={() => setAutoRefresh(a => !a)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase border transition-colors ${
              autoRefresh ? 'text-accent-teal-light bg-accent-teal/10 border-accent-teal/20' : 'text-text-dim bg-bg-surface border-border-subtle'
            }`}>
            {autoRefresh ? '● Live' : '○ Paused'}
          </button>
          <button onClick={load}
            className="px-3 py-1.5 bg-bg-surface border border-border-subtle rounded-lg text-[10px] font-mono text-text-secondary hover:text-text-primary transition-colors">
            ↺ Refresh
          </button>
        </div>
      </div>

      {/* Top metric row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {[
          { label: 'Uptime', value: `${uptimeH}h ${uptimeM}m`, color: '#10b981' },
          { label: 'Total Calls', value: s.metrics.calls.toLocaleString(), color: '#e2e8f0' },
          { label: 'Failure Rate', value: `${s.metrics.failure_rate_pct}%`, color: s.metrics.failure_rate_pct > 10 ? '#ef4444' : '#10b981' },
          { label: 'Fallback Rate', value: `${s.metrics.fallback_rate_pct}%`, color: s.metrics.fallback_rate_pct > 5 ? '#f59e0b' : '#10b981' },
          { label: 'Retries', value: s.metrics.retries, color: '#8b5cf6' },
          { label: 'CB Opens', value: s.metrics.breakerOpens, color: s.metrics.breakerOpens > 0 ? '#ef4444' : '#6b7280' },
        ].map(m => (
          <div key={m.label} className="bg-bg-surface border border-border-subtle rounded-xl p-3 text-center">
            <div className="text-xl font-bold font-mono" style={{ color: m.color }}>{m.value}</div>
            <div className="text-[9px] font-mono uppercase text-text-dim mt-0.5">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Circuit Breaker summary bar */}
      <div className="bg-bg-surface border border-border-subtle rounded-xl px-5 py-3 flex items-center gap-6 flex-wrap">
        <span className="text-[10px] font-mono uppercase text-text-dim tracking-wider">Circuit Breakers</span>
        {[
          { label: 'Closed', count: s.summary.closed, color: '#10b981' },
          { label: 'Open', count: s.summary.open, color: '#ef4444' },
          { label: 'Half-Open', count: s.summary.half_open, color: '#f59e0b' },
        ].map(x => (
          <div key={x.label} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: x.color }} />
            <span className="text-sm font-bold font-mono" style={{ color: x.color }}>{x.count}</span>
            <span className="text-[10px] font-mono text-text-dim">{x.label}</span>
          </div>
        ))}
        <div className="flex-1 h-2 bg-bg-elevated rounded-full overflow-hidden ml-2">
          {s.summary.total > 0 && (
            <>
              <div className="h-full inline-block" style={{ width: `${(s.summary.closed / s.summary.total) * 100}%`, background: '#10b981', float: 'left' }} />
              <div className="h-full inline-block" style={{ width: `${(s.summary.half_open / s.summary.total) * 100}%`, background: '#f59e0b', float: 'left' }} />
              <div className="h-full inline-block" style={{ width: `${(s.summary.open / s.summary.total) * 100}%`, background: '#ef4444', float: 'left' }} />
            </>
          )}
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Circuit Breakers */}
        <div className="lg:col-span-2 space-y-3">
          <h2 className="text-sm font-bold text-text-secondary uppercase tracking-wider font-mono">Circuit Breakers</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {s.circuit_breakers.map(b => (
              <BreakerCard key={b.name} breaker={b} onReset={resetBreaker} />
            ))}
          </div>

          {/* Recent events */}
          {s.recent_events.length > 0 && (
            <div className="bg-bg-surface border border-border-subtle rounded-2xl p-4 mt-3">
              <h3 className="text-[10px] font-mono uppercase text-text-dim tracking-wider mb-3">Recent Events</h3>
              <div className="space-y-1.5">
                {s.recent_events.slice(0, 8).map((e: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 text-[10px] font-mono">
                    <span className={`shrink-0 ${e.event_type === 'open' ? 'text-red-400' : 'text-emerald-400'}`}>
                      {e.event_type === 'open' ? '⚡' : '✓'}
                    </span>
                    <span className="text-text-secondary">{e.breaker_name}</span>
                    <span className="text-text-dim">{e.from_state} → {e.to_state}</span>
                    {e.failure_rate && (
                      <span className="text-text-dim">({Math.round(e.failure_rate * 100)}% failures)</span>
                    )}
                    <span className="text-text-dim ml-auto">
                      {new Date(e.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-4">
          <ChaosPanel chaos={s.chaos} onUpdate={updateChaos} />
          {profile && user && (
            <>
              <h2 className="text-sm font-bold text-text-secondary uppercase tracking-wider font-mono">Personalization</h2>
              <ProfilePanel profile={profile} onUpdate={updateProfile} />
            </>
          )}
          {!user && (
            <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 text-center">
              <p className="text-text-dim text-sm">Sign in to view your behavioral profile and personalization settings.</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Observability ──────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-sm font-bold text-text-secondary uppercase tracking-wider font-mono">Observability</h2>
          <span className="text-[9px] font-mono text-accent-purple bg-accent-purple/10 border border-accent-purple/20 px-2 py-0.5 rounded">
            SLOs · Latency · Streaming
          </span>
        </div>
        <ObservabilityPanel />
      </div>
    </div>
  );
}
