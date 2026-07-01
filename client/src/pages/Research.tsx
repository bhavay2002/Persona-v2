import React, { useEffect, useState, useCallback } from 'react';
import { useAuth, useNav } from '../App';
import { getToken } from '../lib/auth';

const BASE = '/api';
async function authReq(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${getToken()}`, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreGauge({ score, interpretation }: { score: number; interpretation: string }) {
  const pct = Math.round(score * 100);
  const color =
    score < 0.25 ? '#14b8a6' :
    score < 0.45 ? '#a78bfa' :
    score < 0.65 ? '#f59e0b' : '#ef4444';

  const interpretationDesc: Record<string, string> = {
    Low: 'Highly consistent belief system across personas',
    Moderate: 'Some productive tension between perspectives',
    High: 'Significant internal contradictions — rich multi-perspective thinker',
    'Very High': 'Maximum cognitive tension — deeply contradictory worldviews',
  };

  // SVG arc gauge
  const r = 60;
  const cx = 80;
  const cy = 80;
  const startAngle = -210;
  const endAngle = 30;
  const totalArc = endAngle - startAngle;
  const scoreArc = startAngle + totalArc * score;

  function polarToCartesian(angle: number) {
    const rad = (angle * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(start: number, end: number) {
    const s = polarToCartesian(start);
    const e = polarToCartesian(end);
    const large = end - start > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <svg width="160" height="120" viewBox="0 0 160 120">
        {/* Track */}
        <path d={describeArc(startAngle, endAngle)} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" strokeLinecap="round" />
        {/* Score arc */}
        <path d={describeArc(startAngle, scoreArc)} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
        {/* Center label */}
        <text x={cx} y={cy - 4} textAnchor="middle" fill="white" fontSize="26" fontWeight="700" fontFamily="monospace">{pct}</text>
        <text x={cx} y={cy + 16} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="11" fontFamily="monospace">/ 100</text>
      </svg>
      <div className="text-center">
        <span className="px-3 py-1 rounded-full text-xs font-mono font-semibold tracking-wider"
          style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}>
          {interpretation} Dissonance
        </span>
        <p className="text-text-dim text-xs mt-2 max-w-[220px]">{interpretationDesc[interpretation] || ''}</p>
      </div>
    </div>
  );
}

function BarRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 text-xs text-text-dim truncate shrink-0">{label}</div>
      <div className="flex-1 h-2 bg-bg-elevated rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="w-12 text-xs font-mono text-right" style={{ color }}>{(value * 100).toFixed(0)}%</div>
    </div>
  );
}

function StatCard({ label, value, sub, color = 'text-text-primary' }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-2">{label}</div>
      <div className={`text-2xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-text-dim mt-1">{sub}</div>}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Research() {
  const { user } = useAuth();
  const { navigate } = useNav();

  const [cds, setCds] = useState<any>(null);
  const [insights, setInsights] = useState<any>(null);
  const [cdsLoading, setCdsLoading] = useState(true);
  const [insightsLoading, setInsightsLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [activeTab, setActiveTab] = useState<'personal' | 'population'>('personal');

  const loadCDS = useCallback(() => {
    setCdsLoading(true);
    authReq('/research/cds').then(setCds).catch(() => setCds(null)).finally(() => setCdsLoading(false));
  }, []);

  const loadInsights = useCallback(() => {
    setInsightsLoading(true);
    authReq('/research/insights').then(setInsights).catch(() => setInsights(null)).finally(() => setInsightsLoading(false));
  }, []);

  useEffect(() => { loadCDS(); loadInsights(); }, []);

  const recompute = async () => {
    setRecomputing(true);
    try {
      const result = await authReq('/research/cds/recompute', { method: 'POST' });
      setCds(result);
    } catch {}
    setRecomputing(false);
  };

  const exportCSV = async () => {
    try {
      const token = getToken();
      const res = await fetch(`${BASE}/research/export`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'persona-research-data.csv';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {}
  };

  if (!user) return (
    <div className="max-w-2xl mx-auto py-20 text-center">
      <div className="text-text-dim text-sm">Sign in to view your research profile</div>
      <button onClick={() => navigate('login')} className="mt-4 px-6 py-2 bg-accent-purple rounded-xl text-white text-sm">Sign in</button>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto space-y-8 py-6">

      {/* Header */}
      <div className="border-b border-border-subtle pb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent-teal-light mb-2">Research Layer</div>
          <h1 className="text-3xl font-bold text-text-primary tracking-tight">Cognitive Dissonance</h1>
          <p className="text-text-secondary mt-1 text-sm max-w-xl">
            Your <span className="text-accent-purple-light font-medium">Cognitive Dissonance Score (CDS)</span> measures how internally inconsistent your belief system is across all personas you operate.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={exportCSV}
            className="px-4 py-2 text-xs font-mono uppercase tracking-wider border border-border-mid text-text-secondary hover:text-text-primary hover:border-border-subtle rounded-xl transition-all"
          >
            Export CSV
          </button>
          <button
            onClick={recompute}
            disabled={recomputing}
            className="px-4 py-2 text-xs font-mono uppercase tracking-wider bg-accent-purple/10 border border-accent-purple/30 text-accent-purple-light hover:bg-accent-purple/20 rounded-xl transition-all disabled:opacity-50"
          >
            {recomputing ? 'Computing...' : 'Recompute'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-bg-surface/50 p-1 rounded-xl border border-border-subtle w-fit">
        {(['personal', 'population'] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition-all ${
              activeTab === t
                ? 'bg-accent-purple/10 text-accent-purple-light shadow-[0_0_15px_rgba(139,92,246,0.1)]'
                : 'text-text-secondary hover:text-text-primary'
            }`}>
            {t === 'personal' ? 'Your CDS' : 'Population Insights'}
          </button>
        ))}
      </div>

      {/* ── Personal Tab ── */}
      {activeTab === 'personal' && (
        <>
          {cdsLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-border-subtle border-t-accent-purple rounded-full animate-spin" />
            </div>
          ) : !cds ? (
            <div className="bg-bg-surface border border-border-subtle rounded-2xl p-8 text-center">
              <div className="text-2xl mb-3">🧠</div>
              <p className="text-text-secondary text-sm">No CDS data yet. Create multiple personas, post content, and let the system analyze cross-persona contradictions.</p>
            </div>
          ) : (
            <>
              {/* Score + stats */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="md:col-span-1 bg-bg-surface border border-border-subtle rounded-2xl p-6 flex flex-col items-center justify-center gap-2">
                  <ScoreGauge score={cds.cds_score ?? 0} interpretation={cds.interpretation ?? 'Low'} />
                </div>
                <div className="md:col-span-2 grid grid-cols-2 gap-4">
                  <StatCard label="CDS Score" value={(parseFloat(cds.cds_score) * 100).toFixed(1)} sub="out of 100" color={
                    cds.interpretation === 'Low' ? 'text-accent-teal-light' :
                    cds.interpretation === 'Moderate' ? 'text-accent-purple-light' :
                    cds.interpretation === 'High' ? 'text-yellow-400' : 'text-red-400'
                  } />
                  <StatCard label="Personas" value={cds.persona_count ?? 0} sub="active identities" color="text-accent-purple-light" />
                  <StatCard label="Conflict Pairs" value={cds.pair_count ?? 0} sub="persona pairs analyzed" />
                  <StatCard label="Last Computed" value={cds.computed_at ? new Date(cds.computed_at).toLocaleDateString() : '—'} sub="auto-updates on new posts" />
                </div>
              </div>

              {/* Formal definition */}
              <div className="bg-bg-surface border border-border-subtle rounded-2xl p-6">
                <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-3">Formal Definition (Paper-Grade)</div>
                <div className="font-mono text-sm text-text-secondary bg-bg-elevated rounded-xl p-4 border border-border-subtle">
                  <div className="text-accent-teal-light">CDS(user) = (1/N) × Σ D(c_a, c_b)</div>
                  <div className="text-text-dim mt-2 text-xs space-y-1">
                    <div>• <span className="text-text-secondary">N</span> = cross-persona claim pairs</div>
                    <div>• <span className="text-text-secondary">D(c_a, c_b)</span> = hybrid contradiction score ∈ [0,1]</div>
                    <div>• Pairs drawn from <span className="text-text-secondary">different personas</span> of the same user</div>
                    <div>• <span className="text-text-secondary">Your score: {cds.cds_score}</span> ({cds.interpretation} internal contradiction)</div>
                  </div>
                </div>
              </div>

              {/* Dominant conflict domains */}
              {cds.dominant_conflict_domains?.length > 0 && (
                <div className="bg-bg-surface border border-border-subtle rounded-2xl p-6">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-4">Dominant Conflict Domains</div>
                  <div className="flex flex-wrap gap-2">
                    {cds.dominant_conflict_domains.map((d: string, i: number) => (
                      <span key={d} className="px-3 py-1 rounded-full text-xs font-medium border"
                        style={{
                          background: ['rgba(139,92,246,0.1)', 'rgba(20,184,166,0.1)', 'rgba(245,158,11,0.1)'][i % 3],
                          borderColor: ['rgba(139,92,246,0.3)', 'rgba(20,184,166,0.3)', 'rgba(245,158,11,0.3)'][i % 3],
                          color: ['#a78bfa', '#5eead4', '#fcd34d'][i % 3],
                        }}>
                        {d}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Conflict pair heatmap */}
              {cds.conflict_pairs?.length > 0 && (
                <div className="bg-bg-surface border border-border-subtle rounded-2xl p-6">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-4">Contradiction Heatmap — Persona Pairs</div>
                  <div className="space-y-3">
                    {cds.conflict_pairs.map((pair: any, i: number) => (
                      <div key={i} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-text-secondary font-medium">{pair.persona_a} <span className="text-text-dim mx-1">vs</span> {pair.persona_b}</span>
                          <span className="font-mono text-xs" style={{
                            color: pair.score < 0.25 ? '#14b8a6' : pair.score < 0.5 ? '#a78bfa' : pair.score < 0.75 ? '#f59e0b' : '#ef4444'
                          }}>{(pair.score * 100).toFixed(0)}%</span>
                        </div>
                        <div className="h-2 bg-bg-elevated rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-700" style={{
                            width: `${pair.score * 100}%`,
                            background: pair.score < 0.25 ? '#14b8a6' : pair.score < 0.5 ? '#8b5cf6' : pair.score < 0.75 ? '#f59e0b' : '#ef4444',
                            boxShadow: `0 0 8px ${pair.score < 0.25 ? '#14b8a6' : pair.score < 0.5 ? '#8b5cf6' : pair.score < 0.75 ? '#f59e0b' : '#ef4444'}60`,
                          }} />
                        </div>
                        {pair.top_contradiction && (
                          <p className="text-[11px] text-text-dim pl-1 italic">"{pair.top_contradiction}"</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Population Tab ── */}
      {activeTab === 'population' && (
        <>
          {insightsLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-border-subtle border-t-accent-purple rounded-full animate-spin" />
            </div>
          ) : !insights ? (
            <div className="bg-bg-surface border border-border-subtle rounded-2xl p-8 text-center">
              <p className="text-text-secondary text-sm">Population data unavailable</p>
            </div>
          ) : (
            <>
              {/* Population stats */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <StatCard label="Users Analyzed" value={insights.population?.users_with_cds ?? 0} color="text-accent-teal-light" />
                <StatCard label="Mean CDS" value={insights.population?.mean_cds ?? '—'} sub={`median: ${insights.population?.median_cds ?? '—'}`} color="text-accent-purple-light" />
                <StatCard label="Std Deviation" value={insights.population?.stddev_cds ?? '—'} sub={`range: ${insights.population?.min_cds ?? 0} – ${insights.population?.max_cds ?? 0}`} />
              </div>

              {/* Pearson correlations */}
              <div className="bg-bg-surface border border-border-subtle rounded-2xl p-6">
                <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-4">Statistical Correlations (Pearson r)</div>
                <div className="space-y-4">
                  {insights.correlations?.cds_vs_argument_complexity !== null ? (
                    <BarRow
                      label="CDS × Complexity"
                      value={Math.abs(insights.correlations.cds_vs_argument_complexity)}
                      max={1}
                      color={insights.correlations.cds_vs_argument_complexity >= 0 ? '#8b5cf6' : '#ef4444'}
                    />
                  ) : (
                    <p className="text-text-dim text-xs">Insufficient data for correlation analysis</p>
                  )}
                </div>
                <p className="text-text-dim text-[11px] mt-3">
                  r = Pearson correlation coefficient ∈ [-1, 1]. Values near ±1 indicate strong relationship.
                </p>
              </div>

              {/* CDS distribution */}
              {insights.cds_distribution?.length > 0 && (
                <div className="bg-bg-surface border border-border-subtle rounded-2xl p-6">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-4">CDS Distribution Across Users</div>
                  <div className="space-y-3">
                    {insights.cds_distribution.map((row: any) => (
                      <BarRow
                        key={row.bucket}
                        label={row.bucket}
                        value={parseFloat(row.avg_cds)}
                        max={1}
                        color="#8b5cf6"
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* CDS vs complexity correlation table */}
              {insights.cds_vs_complexity?.length > 0 && (
                <div className="bg-bg-surface border border-border-subtle rounded-2xl p-6 overflow-x-auto">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-4">CDS vs Argument Complexity</div>
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="border-b border-border-subtle text-text-dim">
                        <th className="text-left py-2 font-normal">CDS Band</th>
                        <th className="text-right py-2 font-normal">Avg Complexity</th>
                        <th className="text-right py-2 font-normal">Avg Openness</th>
                        <th className="text-right py-2 font-normal">Posts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insights.cds_vs_complexity.map((row: any, i: number) => (
                        <tr key={i} className="border-b border-border-subtle/50 hover:bg-bg-elevated/50">
                          <td className="py-2 text-text-secondary">{row.cds_bin}</td>
                          <td className="py-2 text-right text-accent-purple-light">{(parseFloat(row.avg_complexity) * 100).toFixed(1)}%</td>
                          <td className="py-2 text-right text-accent-teal-light">{(parseFloat(row.avg_openness) * 100).toFixed(1)}%</td>
                          <td className="py-2 text-right text-text-dim">{row.post_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Key findings */}
              <div className="bg-bg-surface border border-border-subtle rounded-2xl p-6">
                <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-4">Key Research Findings</div>
                <div className="space-y-3">
                  {insights.key_findings?.map((finding: string, i: number) => (
                    <div key={i} className="flex gap-3">
                      <div className="w-5 h-5 rounded-full bg-accent-purple/10 border border-accent-purple/30 flex items-center justify-center shrink-0 mt-0.5">
                        <span className="text-accent-purple-light text-[10px] font-mono">{i + 1}</span>
                      </div>
                      <p className="text-sm text-text-secondary leading-relaxed">{finding}</p>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
