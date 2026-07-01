import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth, useNav } from '../App';

const THINKING_STYLE_CONFIG: Record<string, { label: string; color: string; bar: string; icon: string; desc: string }> = {
  analytical: { label: 'Analytical', color: 'text-blue-400', bar: 'bg-blue-500/70', icon: '🔬', desc: 'Logical & structured' },
  emotional: { label: 'Emotional', color: 'text-pink-400', bar: 'bg-pink-500/70', icon: '💡', desc: 'Expressive & affect-driven' },
  persuasive: { label: 'Persuasive', color: 'text-accent-purple-light', bar: 'bg-accent-purple/70', icon: '🎯', desc: 'Argument-driven' },
  informative: { label: 'Informative', color: 'text-accent-teal-light', bar: 'bg-accent-teal/70', icon: '📊', desc: 'Factual & educational' },
};

const BIAS_COLORS: Record<string, string> = {
  left: 'text-blue-400', center: 'text-yellow-400', right: 'text-red-400', neutral: 'text-text-dim',
  positive: 'text-accent-teal-light', negative: 'text-red-400',
};

const TRAIT_COLORS: Record<string, string> = {
  Formal: 'text-accent-purple-light bg-accent-purple/10 border-accent-purple/20',
  Passionate: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
  Assertive: 'text-red-400 bg-red-500/10 border-red-500/20',
  Analytical: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  Measured: 'text-accent-teal-light bg-accent-teal/10 border-accent-teal/20',
};

function SectionHeader({ label }: { label: string }) {
  return <h2 className="text-[11px] font-mono uppercase tracking-widest font-bold text-text-dim mb-4">{label}</h2>;
}

export default function Insights() {
  const { user } = useAuth();
  const { navigate } = useNav();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [evolvingId, setEvolvingId] = useState<number | null>(null);
  const [evolveResults, setEvolveResults] = useState<Record<number, any>>({});

  useEffect(() => {
    if (user) {
      api.getInsights().then(setData).catch(() => {}).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [user]);

  const handleEvolve = async (personaId: number) => {
    setEvolvingId(personaId);
    try {
      const result = await api.evolvePersona(personaId);
      setEvolveResults(prev => ({ ...prev, [personaId]: result }));
      // Refresh data
      const fresh = await api.getInsights();
      setData(fresh);
    } catch (err: any) {
      setEvolveResults(prev => ({ ...prev, [personaId]: { error: err.message } }));
    }
    setEvolvingId(null);
  };

  if (!user) {
    return (
      <div className="max-w-2xl mx-auto py-24 text-center animate-fade-in">
        <div className="w-24 h-24 mx-auto bg-bg-surface border border-border-subtle rounded-3xl flex items-center justify-center text-5xl mb-8 shadow-xl">📊</div>
        <h2 className="text-3xl font-bold text-text-primary mb-4 tracking-tight">Telemetry Encrypted</h2>
        <p className="text-text-secondary mb-10">Initialize an operator session to decrypt your psychological analytics.</p>
        <button onClick={() => navigate('login')} className="btn-primary px-8">Initialize Session</button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6 pt-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">{[1,2,3,4].map(i => <div key={i} className="h-28 bg-bg-surface rounded-2xl skeleton" />)}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">{[1,2,3,4].map(i => <div key={i} className="h-56 bg-bg-surface rounded-2xl skeleton" />)}</div>
      </div>
    );
  }

  if (!data || data.personaCount === 0) {
    return (
      <div className="max-w-2xl mx-auto py-24 text-center animate-fade-in">
        <div className="w-24 h-24 mx-auto bg-bg-surface border border-border-subtle border-dashed rounded-3xl flex items-center justify-center text-5xl mb-8 opacity-50">📉</div>
        <h2 className="text-3xl font-bold text-text-primary mb-4 tracking-tight">Insufficient Data Density</h2>
        <p className="text-text-secondary mb-10">Synthesize entities and deploy statements to populate your telemetry matrix.</p>
        <button onClick={() => navigate('personas')} className="btn-primary px-8">Synthesize Entity</button>
      </div>
    );
  }

  const maxTone = Math.max(...(data.toneBreakdown?.map((t: any) => t.count) || [1]));
  const maxIdeology = Math.max(...(data.ideologyBreakdown?.map((t: any) => t.count) || [1]));
  const thinkingTotal = Object.values(data.thinkingDistribution || {}).reduce((s: any, v: any) => s + v, 0) as number;

  return (
    <div className="max-w-5xl mx-auto space-y-8 py-6 pb-12">
      <div className="border-b border-border-subtle pb-6">
        <h1 className="text-3xl font-bold text-text-primary tracking-tight">Operator Telemetry</h1>
        <p className="text-text-secondary mt-1 text-sm">Behavioral intelligence — thinking patterns, bias analysis, and adaptive persona evolution</p>
      </div>

      {/* Top stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Active Nodes', value: data.personaCount, color: 'text-accent-purple-light', icon: '🎭' },
          { label: 'Statements', value: data.totalPosts, color: 'text-text-primary', icon: '📝' },
          { label: 'Conflicts', value: data.totalDebates, color: 'text-accent-teal-light', icon: '⚔️' },
          { label: 'Perspective Diversity', value: `${data.diversityScore}%`, color: 'text-yellow-400', icon: '🌈' },
        ].map((s, i) => (
          <div key={s.label} className="bg-bg-surface border border-border-subtle rounded-2xl p-5 card-hover relative overflow-hidden animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
            <div className="absolute -right-3 -bottom-3 text-5xl opacity-5 grayscale select-none">{s.icon}</div>
            <div className={`text-3xl font-black font-mono tracking-tighter ${s.color} mb-1`}>{s.value}</div>
            <div className="text-[10px] font-mono uppercase tracking-widest font-bold text-text-secondary">{s.label}</div>
          </div>
        ))}
      </div>

      {/* AI Narrative Insights */}
      {data.narrativeInsights && (
        <div className="bg-bg-surface border border-accent-purple/30 rounded-3xl p-6 relative overflow-hidden shadow-[0_0_30px_rgba(139,92,246,0.05)]">
          <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-accent-purple to-accent-teal rounded-full"></div>
          <div className="flex items-start gap-4 pl-4">
            <div className="w-10 h-10 rounded-xl bg-accent-purple/15 border border-accent-purple/30 flex items-center justify-center text-xl flex-shrink-0 mt-0.5">🧠</div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest font-bold text-accent-purple-light mb-2">AI Behavioral Analysis</div>
              <p className="text-text-primary text-sm leading-relaxed">{data.narrativeInsights}</p>
              {data.analyzedPostCount > 0 && (
                <p className="text-[10px] font-mono text-text-dim mt-2 uppercase tracking-wider">Based on {data.analyzedPostCount} classified posts</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Thinking Style + Bias Analysis row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Thinking Style Distribution */}
        <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6">
          <SectionHeader label="Thinking Style Classification" />
          {thinkingTotal > 0 ? (
            <div className="space-y-3">
              {Object.entries(THINKING_STYLE_CONFIG).map(([style, cfg]) => {
                const pct = data.thinkingDistribution?.[style] || 0;
                return (
                  <div key={style} className="group">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-base">{cfg.icon}</span>
                        <span className={`text-xs font-mono font-bold uppercase tracking-wider ${cfg.color}`}>{cfg.label}</span>
                        <span className="text-[9px] font-mono text-text-dim hidden group-hover:block">{cfg.desc}</span>
                      </div>
                      <span className={`text-xs font-mono font-bold ${cfg.color}`}>{pct}%</span>
                    </div>
                    <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-700 ${cfg.bar}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-text-dim">
              <p className="text-sm font-mono">Analyzing posts...</p>
              <p className="text-[10px] mt-1 text-text-dim uppercase tracking-wider">Classification runs in background</p>
            </div>
          )}
        </div>

        {/* Bias Analysis */}
        <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6">
          <SectionHeader label="Bias Analysis Engine" />
          <div className="grid grid-cols-1 gap-4">
            {/* Political bias */}
            <div className="bg-bg-elevated/60 border border-border-subtle rounded-2xl p-4">
              <div className="text-[9px] font-mono uppercase text-text-dim mb-2 tracking-wider">Political Lean</div>
              <div className="flex items-center gap-3">
                <div className="flex-1 flex gap-1 h-3">
                  {['left', 'center', 'neutral', 'right'].map(b => (
                    <div key={b} className={`flex-1 rounded-sm transition-all ${data.biasProfile?.dominantPolitical === b ? 'opacity-100 scale-y-110' : 'opacity-20'} ${
                      b === 'left' ? 'bg-blue-500' : b === 'center' ? 'bg-yellow-500' : b === 'right' ? 'bg-red-500' : 'bg-text-dim'
                    }`} />
                  ))}
                </div>
                <span className={`text-xs font-mono font-bold uppercase ${BIAS_COLORS[data.biasProfile?.dominantPolitical] || 'text-text-dim'}`}>
                  {data.biasProfile?.dominantPolitical || 'neutral'}
                </span>
              </div>
            </div>

            {/* Emotional bias */}
            <div className="bg-bg-elevated/60 border border-border-subtle rounded-2xl p-4">
              <div className="text-[9px] font-mono uppercase text-text-dim mb-2 tracking-wider">Emotional Valence</div>
              <div className="flex items-center justify-between">
                <div className="flex gap-2">
                  {['positive', 'neutral', 'negative'].map(e => (
                    <span key={e} className={`text-[10px] font-mono px-2 py-0.5 rounded-md border transition-all ${
                      data.biasProfile?.dominantEmotional === e
                        ? `font-bold border-current ${BIAS_COLORS[e]}`
                        : 'text-text-dim border-border-subtle opacity-40'
                    }`}>{e}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Extremity score */}
            <div className="bg-bg-elevated/60 border border-border-subtle rounded-2xl p-4">
              <div className="flex justify-between mb-1.5">
                <span className="text-[9px] font-mono uppercase text-text-dim tracking-wider">Extremity Score</span>
                <span className={`text-[10px] font-mono font-bold ${
                  (data.biasProfile?.avgExtremity || 0) > 60 ? 'text-red-400' :
                  (data.biasProfile?.avgExtremity || 0) > 30 ? 'text-yellow-400' : 'text-accent-teal-light'
                }`}>{data.biasProfile?.avgExtremity || 0}%</span>
              </div>
              <div className="h-2 bg-bg-surface rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-700 ${
                  (data.biasProfile?.avgExtremity || 0) > 60 ? 'bg-red-500/70' :
                  (data.biasProfile?.avgExtremity || 0) > 30 ? 'bg-yellow-500/70' : 'bg-accent-teal/70'
                }`} style={{ width: `${data.biasProfile?.avgExtremity || 0}%` }} />
              </div>
            </div>

            {/* Debate intelligence */}
            {(data.debateIntelligence?.avgLogic > 0 || data.debateIntelligence?.avgPersuasion > 0) && (
              <div className="bg-bg-elevated/60 border border-border-subtle rounded-2xl p-4">
                <div className="text-[9px] font-mono uppercase text-text-dim mb-2 tracking-wider">Debate Intelligence</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="text-center">
                    <div className="text-xl font-black font-mono text-blue-400">{data.debateIntelligence.avgLogic}</div>
                    <div className="text-[9px] font-mono uppercase text-text-dim">Avg Logic</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xl font-black font-mono text-accent-purple-light">{data.debateIntelligence.avgPersuasion}</div>
                    <div className="text-[9px] font-mono uppercase text-text-dim">Avg Persuasion</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Perspective Diversity + Top Topics */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 space-y-5">
          {/* Diversity gauge */}
          <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6 relative overflow-hidden">
            <SectionHeader label="Perspective Variance Matrix" />
            <div className="flex flex-col items-center text-center">
              <div className="relative w-28 h-28 mb-4">
                <svg className="w-full h-full -rotate-90 drop-shadow-[0_0_12px_rgba(139,92,246,0.25)]" viewBox="0 0 36 36">
                  <circle cx="18" cy="18" r="15.9" fill="none" stroke="rgba(31,31,46,0.5)" strokeWidth="2.5" />
                  <circle cx="18" cy="18" r="15.9" fill="none" stroke="url(#divGrad)" strokeWidth="3"
                    strokeDasharray={`${data.diversityScore} ${100 - data.diversityScore}`} strokeLinecap="round" />
                  <defs>
                    <linearGradient id="divGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#8b5cf6" /><stop offset="100%" stopColor="#14b8a6" />
                    </linearGradient>
                  </defs>
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-xl font-black font-mono text-transparent bg-clip-text bg-gradient-to-br from-accent-purple-light to-accent-teal-light">{data.diversityScore}%</span>
                </div>
              </div>
              <p className="text-sm text-text-secondary leading-relaxed bg-bg-elevated/50 border border-border-subtle rounded-xl p-3">
                {data.diversityScore >= 70 ? 'Highly divergent matrix. Exceptional capacity for contradictory frameworks.'
                  : data.diversityScore >= 40 ? 'Moderate variance. Consider deploying opposing perspectives.'
                  : 'Convergent matrix. Heavily anchored to a central ideological core.'}
              </p>
            </div>
          </div>

          {/* Top topics */}
          {data.topTopics?.length > 0 && (
            <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6">
              <SectionHeader label="Dominant Themes" />
              <div className="flex flex-wrap gap-2">
                {data.topTopics.map((topic: string, i: number) => (
                  <span key={topic} className={`px-3 py-1.5 rounded-xl text-xs font-mono font-bold uppercase border transition-all ${
                    i === 0 ? 'text-accent-purple-light bg-accent-purple/15 border-accent-purple/30'
                    : i === 1 ? 'text-accent-teal-light bg-accent-teal/10 border-accent-teal/20'
                    : 'text-text-secondary bg-bg-elevated border-border-subtle'
                  }`}>
                    #{topic}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-7 space-y-5">
          {/* Linguistic distribution */}
          {data.toneBreakdown?.length > 0 && (
            <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6">
              <SectionHeader label="Linguistic Distribution" />
              <div className="space-y-3">
                {data.toneBreakdown.map((t: any, i: number) => (
                  <div key={t.tone} className="group">
                    <div className="flex justify-between text-xs font-mono font-bold uppercase tracking-wider mb-1">
                      <span className="text-text-primary group-hover:text-accent-purple-light transition-colors">{t.tone}</span>
                      <span className="text-accent-purple-light">{Math.round((t.count / maxTone) * 100)}%</span>
                    </div>
                    <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-accent-purple/60 to-accent-purple rounded-full transition-all duration-700"
                        style={{ width: `${(t.count / maxTone) * 100}%`, transitionDelay: `${i * 80}ms` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.ideologyBreakdown?.length > 0 && (
            <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6">
              <SectionHeader label="Ideological Spectrum" />
              <div className="space-y-3">
                {data.ideologyBreakdown.map((t: any, i: number) => (
                  <div key={t.ideology} className="group">
                    <div className="flex justify-between text-xs font-mono font-bold uppercase tracking-wider mb-1">
                      <span className="text-text-primary group-hover:text-accent-teal-light transition-colors">{t.ideology}</span>
                      <span className="text-accent-teal-light">{Math.round((t.count / maxIdeology) * 100)}%</span>
                    </div>
                    <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-accent-teal/60 to-accent-teal rounded-full transition-all duration-700"
                        style={{ width: `${(t.count / maxIdeology) * 100}%`, transitionDelay: `${i * 80}ms` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Entity Performance Matrix with Drift + Evolution */}
      {data.personaStats?.length > 0 && (
        <div>
          <SectionHeader label="Entity Performance Matrix + Adaptive Evolution" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.personaStats.map((p: any, i: number) => {
              const evolveResult = evolveResults[p.id];
              return (
                <div key={p.id} className="bg-bg-surface border border-border-subtle rounded-2xl p-5 relative overflow-hidden group animate-slide-up" style={{ animationDelay: `${i * 60}ms` }}>
                  <div className="absolute top-0 right-0 w-24 h-24 bg-accent-purple/5 rounded-full blur-2xl group-hover:bg-accent-purple/10 transition-colors pointer-events-none"></div>

                  <div className="flex items-start gap-3 mb-4 relative z-10">
                    <div className="w-11 h-11 rounded-xl bg-bg-elevated border border-border-subtle flex items-center justify-center text-xl flex-shrink-0">{p.avatar_emoji}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                        <span className="text-sm font-bold text-text-primary truncate">{p.name}</span>
                        {p.archetype && <span className="text-[9px] font-mono uppercase text-accent-purple-light bg-accent-purple/10 border border-accent-purple/20 px-1.5 py-0.5 rounded-md">{p.archetype}</span>}
                        {p.dominantTrait && (
                          <span className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-md border ${TRAIT_COLORS[p.dominantTrait] || 'text-text-dim border-border-subtle'}`}>{p.dominantTrait}</span>
                        )}
                        <span className="text-[9px] font-mono font-bold text-text-dim">v{p.version}</span>
                      </div>
                      <div className="flex gap-2 text-[9px] font-mono text-text-dim uppercase">
                        <span>{p.postCount} stmts</span>
                        <span>{p.debateCount} conflicts</span>
                        {p.totalLikes > 0 && <span className="text-accent-purple-light">♥ {p.totalLikes}</span>}
                      </div>
                    </div>
                  </div>

                  {/* Tone bars */}
                  <div className="space-y-1.5 mb-4 relative z-10">
                    {[
                      { label: 'Formality', val: p.toneFormality ?? 0.5, color: 'bg-accent-purple/60' },
                      { label: 'Emotionality', val: p.toneEmotionality ?? 0.5, color: 'bg-pink-500/60' },
                      { label: 'Assertiveness', val: p.toneAssertiveness ?? 0.5, color: 'bg-yellow-500/60' },
                    ].map(({ label, val, color }) => (
                      <div key={label}>
                        <div className="flex justify-between mb-0.5">
                          <span className="text-[9px] font-mono text-text-dim uppercase">{label}</span>
                          <span className="text-[9px] font-mono text-text-dim">{Math.round(val * 100)}%</span>
                        </div>
                        <div className="h-1 bg-bg-elevated rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${val * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Scores + Drift */}
                  <div className="flex gap-2 mb-3 relative z-10">
                    <div className="flex-1 bg-bg-elevated border border-border-subtle rounded-xl p-2.5 text-center">
                      <div className="text-base font-black font-mono text-text-primary">{Math.round(p.consistencyScore ?? 100)}</div>
                      <div className="text-[8px] font-mono uppercase text-text-dim">Consistency</div>
                    </div>
                    <div className="flex-1 bg-bg-elevated border border-border-subtle rounded-xl p-2.5 text-center">
                      <div className="text-base font-black font-mono text-accent-purple-light">{Math.round(p.reputationScore ?? 100)}</div>
                      <div className="text-[8px] font-mono uppercase text-text-dim">Reputation</div>
                    </div>
                    <div className="flex-1 bg-bg-elevated border border-border-subtle rounded-xl p-2.5 text-center">
                      <div className={`text-base font-black font-mono ${p.driftColor || 'text-accent-teal-light'}`}>
                        {Math.round((p.driftScore || 0) * 100)}%
                      </div>
                      <div className="text-[8px] font-mono uppercase text-text-dim">{p.driftLabel || 'Stable'}</div>
                    </div>
                  </div>

                  {/* Trust Score Panel */}
                  {(() => {
                    const score = Math.round(p.trustScore ?? 100);
                    const tier = score >= 75 ? 'high' : score >= 40 ? 'medium' : 'low';
                    const tierConfig = {
                      high:   { label: 'Trusted',    color: 'text-accent-teal-light',   bar: 'bg-accent-teal/70',   border: 'border-accent-teal/25',   bg: 'bg-accent-teal/8'   },
                      medium: { label: 'Neutral',     color: 'text-yellow-400',           bar: 'bg-yellow-500/70',    border: 'border-yellow-500/25',    bg: 'bg-yellow-500/8'    },
                      low:    { label: 'Restricted',  color: 'text-red-400',              bar: 'bg-red-500/70',       border: 'border-red-500/25',       bg: 'bg-red-500/8'       },
                    }[tier];
                    const transparency =
                      p.shadowBanned ? 'This persona has been shadow-banned due to severe abuse signals.' :
                      p.abuseFlags > 2 ? `Trust reduced: ${p.abuseFlags} abuse flag${p.abuseFlags > 1 ? 's' : ''} detected.` :
                      tier === 'low' ? 'Low trust reduces post visibility in feeds. Improve quality and reduce toxicity.' :
                      tier === 'medium' ? 'Building trust. High-quality posts and debate wins will boost your score.' :
                      'High trust grants feed priority and advanced AI features.';
                    return (
                      <div className={`mb-3 px-3 py-2.5 rounded-xl border relative z-10 ${tierConfig.bg} ${tierConfig.border}`}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[9px] font-mono uppercase text-text-dim tracking-wider">Trust Score</span>
                          <div className="flex items-center gap-1.5">
                            {p.shadowBanned && (
                              <span className="text-[8px] font-mono uppercase text-red-400 bg-red-500/15 border border-red-500/25 px-1.5 py-0.5 rounded">
                                Shadow-banned
                              </span>
                            )}
                            <span className={`text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border ${tierConfig.color} ${tierConfig.border} bg-transparent`}>
                              {tierConfig.label}
                            </span>
                            <span className={`text-sm font-black font-mono ${tierConfig.color}`}>{score}</span>
                          </div>
                        </div>
                        <div className="h-1 bg-bg-surface rounded-full overflow-hidden mb-1.5">
                          <div className={`h-full rounded-full transition-all duration-700 ${tierConfig.bar}`} style={{ width: `${Math.min(100, score / 2)}%` }} />
                        </div>
                        <p className="text-[10px] text-text-dim leading-snug font-mono">{transparency}</p>
                      </div>
                    );
                  })()}

                  {/* Evolution summary */}
                  {p.evolutionSummary && (
                    <div className="mb-3 px-3 py-2 bg-accent-teal/8 border border-accent-teal/20 rounded-xl relative z-10">
                      <p className="text-[10px] font-mono text-accent-teal-light uppercase tracking-wider mb-0.5">Last Evolution</p>
                      <p className="text-[11px] text-text-secondary leading-relaxed">{p.evolutionSummary}</p>
                    </div>
                  )}

                  {/* Evolve result */}
                  {evolveResult && !evolveResult.error && (
                    <div className="mb-3 px-3 py-2 bg-accent-purple/10 border border-accent-purple/25 rounded-xl relative z-10 animate-slide-up">
                      <p className="text-[10px] font-mono text-accent-purple-light uppercase tracking-wider mb-0.5">Evolution Applied ✓</p>
                      <p className="text-[11px] text-text-secondary leading-relaxed">{evolveResult.changesExplained}</p>
                      <p className="text-[9px] font-mono text-text-dim mt-0.5">Confidence: {Math.round((evolveResult.confidence || 0) * 100)}% · Drift: {Math.round((evolveResult.driftScore || 0) * 100)}%</p>
                    </div>
                  )}
                  {evolveResult?.error && (
                    <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-xl relative z-10">
                      <p className="text-[10px] font-mono text-red-400">{evolveResult.error}</p>
                    </div>
                  )}

                  {/* Evolve button */}
                  <button
                    onClick={() => handleEvolve(p.id)}
                    disabled={evolvingId === p.id}
                    className="w-full relative z-10 py-2 px-4 text-[10px] font-mono font-bold uppercase tracking-widest rounded-xl border transition-all disabled:opacity-40
                      border-accent-teal/30 text-accent-teal-light hover:bg-accent-teal/10 flex items-center justify-center gap-2"
                  >
                    {evolvingId === p.id
                      ? <><span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin"></span>Analyzing behavior...</>
                      : <>⚡ Run Adaptive Evolution</>}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Cognitive Intelligence Matrix ─────────────────────────────── */}
      {data.cognitiveProfiles?.length > 0 && (
        <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6">
          <SectionHeader label="Cognitive Intelligence Matrix" />
          <p className="text-xs text-text-dim font-mono mb-5">Multi-dimensional cognitive profiling derived from argument structure, bias patterns and rhetorical signals</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.cognitiveProfiles.map((cp: any) => {
              const persona = data.personaStats?.find((p: any) => p.id === cp.persona_id);
              const styleConfig: Record<string, { color: string; bg: string; border: string }> = {
                analytical:  { color: 'text-blue-400',            bg: 'bg-blue-500/10',         border: 'border-blue-500/25' },
                emotional:   { color: 'text-pink-400',            bg: 'bg-pink-500/10',         border: 'border-pink-500/25' },
                persuasive:  { color: 'text-accent-purple-light', bg: 'bg-accent-purple/10',    border: 'border-accent-purple/25' },
                intuitive:   { color: 'text-yellow-400',          bg: 'bg-yellow-500/10',       border: 'border-yellow-500/25' },
              };
              const sc = styleConfig[cp.dominant_style] || styleConfig.analytical;
              return (
                <div key={cp.persona_id} className="bg-bg-elevated rounded-2xl p-4 border border-border-subtle">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-9 h-9 rounded-xl bg-bg-surface border border-border-mid flex items-center justify-center text-lg flex-shrink-0">
                      {persona?.avatar_emoji || '🎭'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-text-primary truncate">{persona?.name || 'Persona'}</div>
                      <span className={`text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border ${sc.color} ${sc.bg} ${sc.border}`}>
                        {cp.dominant_style}
                      </span>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-[9px] font-mono text-text-dim">{cp.analyzed_count} posts</div>
                      <div className="text-[9px] font-mono text-text-dim">analyzed</div>
                    </div>
                  </div>
                  <div className="space-y-2.5">
                    {([
                      { label: 'Argument Complexity', key: 'avg_complexity',   color: 'bg-blue-500/70',           tip: 'Multi-step reasoning & evidence use' },
                      { label: 'Openness Score',       key: 'avg_openness',    color: 'bg-accent-teal/70',        tip: 'Acknowledges uncertainty & other views' },
                      { label: 'Certainty Level',      key: 'avg_certainty',   color: 'bg-accent-purple/70',      tip: 'Confidence in stated positions' },
                      { label: 'Emotional Intensity',  key: 'avg_emotionality',color: 'bg-pink-500/70',           tip: 'Affective charge in language' },
                    ] as const).map(({ label, key, color, tip }) => {
                      const val = parseFloat(cp[key]) || 0;
                      return (
                        <div key={label}>
                          <div className="flex justify-between items-center mb-1">
                            <div>
                              <span className="text-[9px] font-mono text-text-dim uppercase">{label}</span>
                              <span className="text-[8px] text-text-dim ml-1.5 opacity-60">{tip}</span>
                            </div>
                            <span className="text-[9px] font-mono font-bold text-text-secondary">{Math.round(val * 100)}%</span>
                          </div>
                          <div className="h-1.5 bg-bg-surface rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${val * 100}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Temporal Evolution ─────────────────────────────────────────── */}
      {data.timeseries && Object.keys(data.timeseries).length > 0 && (
        <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6">
          <SectionHeader label="Temporal Evolution" />
          <p className="text-xs text-text-dim font-mono mb-5">Weekly cognitive metric trends — tracking how each persona's reasoning style evolves over time</p>
          <div className="space-y-8">
            {Object.entries(data.timeseries).map(([personaIdStr, ts]: [string, any]) => {
              const persona = data.personaStats?.find((p: any) => p.id === parseInt(personaIdStr));
              if (!persona || !ts?.weeks?.length) return null;
              const weeks = ts.weeks.slice(-8);
              const assessmentColors: Record<string, string> = {
                'Highly Evolved': 'text-accent-teal-light border-accent-teal/25 bg-accent-teal/8',
                'Maturing':       'text-accent-purple-light border-accent-purple/25 bg-accent-purple/8',
                'Developing':     'text-yellow-400 border-yellow-500/25 bg-yellow-500/8',
                'Early Stage':    'text-text-dim border-border-subtle bg-bg-elevated',
              };
              const ac = assessmentColors[ts.insight?.growth_assessment || 'Early Stage'] || assessmentColors['Early Stage'];
              return (
                <div key={personaIdStr}>
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <span className="text-base">{persona.avatar_emoji}</span>
                    <span className="text-sm font-bold text-text-primary">{persona.name}</span>
                    {ts.insight?.growth_assessment && (
                      <span className={`text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border ${ac}`}>
                        {ts.insight.growth_assessment}
                      </span>
                    )}
                    <span className="text-[9px] font-mono text-text-dim">{weeks.length} week{weeks.length !== 1 ? 's' : ''} of data</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    {([
                      { label: 'Complexity',    key: 'avg_complexity',   color: 'bg-blue-500',         border: 'border-blue-500/20' },
                      { label: 'Openness',      key: 'avg_openness',     color: 'bg-accent-teal',      border: 'border-accent-teal/20' },
                      { label: 'Emotionality',  key: 'avg_emotionality', color: 'bg-pink-500',         border: 'border-pink-500/20' },
                    ] as const).map(({ label, key, color, border }) => {
                      const vals = weeks.map((w: any) => parseFloat(w[key]) || 0);
                      const maxV = Math.max(...vals, 0.01);
                      const start = Math.round(vals[0] * 100);
                      const end   = Math.round(vals[vals.length - 1] * 100);
                      const delta = end - start;
                      return (
                        <div key={label} className={`bg-bg-elevated rounded-xl p-3 border ${border}`}>
                          <div className="text-[9px] font-mono uppercase text-text-dim mb-2">{label}</div>
                          <div className="flex items-end gap-px h-10 mb-2">
                            {vals.map((v: number, i: number) => (
                              <div key={i} className={`flex-1 rounded-t-sm ${color} opacity-70 transition-all`}
                                style={{ height: `${(v / maxV) * 100}%`, minHeight: '3px' }} />
                            ))}
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-[8px] font-mono text-text-dim">{start}%</span>
                            <span className={`text-[8px] font-mono font-bold ${delta > 0 ? 'text-accent-teal-light' : delta < 0 ? 'text-red-400' : 'text-text-dim'}`}>
                              {delta > 0 ? '↑' : delta < 0 ? '↓' : '→'}{Math.abs(delta)}%
                            </span>
                            <span className="text-[8px] font-mono text-text-dim">{end}%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {ts.insight?.trend_summary && (
                    <div className="px-4 py-3 bg-bg-elevated/60 border border-border-subtle rounded-xl">
                      <p className="text-[11px] text-text-secondary leading-relaxed">{ts.insight.trend_summary}</p>
                      {ts.insight.key_changes?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {ts.insight.key_changes.map((ch: string, i: number) => (
                            <span key={i} className="text-[9px] font-mono text-text-dim bg-bg-surface border border-border-subtle px-2 py-0.5 rounded-lg">
                              {ch}
                            </span>
                          ))}
                        </div>
                      )}
                      {ts.insight.recommendations && (
                        <p className="text-[10px] text-accent-purple-light font-mono mt-2">→ {ts.insight.recommendations}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Ideological Conflict Map ───────────────────────────────────── */}
      {data.contradictions?.length > 0 && (
        <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6">
          <SectionHeader label="Ideological Conflict Map" />
          <p className="text-xs text-text-dim font-mono mb-5">Cross-persona belief contradictions detected by logical consistency analysis — where your own personas hold irreconcilable views</p>
          <div className="space-y-4">
            {data.contradictions.map((c: any) => (
              <div key={c.id} className="border border-border-subtle rounded-2xl overflow-hidden">
                {/* Pair header */}
                <div className="flex items-center gap-3 px-4 py-3 bg-bg-elevated/50">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="text-lg flex-shrink-0">{c.persona_a_emoji}</span>
                    <span className="text-xs font-bold text-text-primary truncate">{c.persona_a_name}</span>
                    <svg className="w-3 h-3 text-text-dim flex-shrink-0 mx-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                    <span className="text-xs font-bold text-text-primary truncate">{c.persona_b_name}</span>
                    <span className="text-lg flex-shrink-0">{c.persona_b_emoji}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="w-20 h-1.5 bg-bg-surface rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-700 ${
                        c.conflict_score > 0.7 ? 'bg-red-500' : c.conflict_score > 0.4 ? 'bg-yellow-500' : 'bg-accent-teal'
                      }`} style={{ width: `${c.conflict_score * 100}%` }} />
                    </div>
                    <span className={`text-[10px] font-mono font-bold ${
                      c.conflict_score > 0.7 ? 'text-red-400' : c.conflict_score > 0.4 ? 'text-yellow-400' : 'text-accent-teal-light'
                    }`}>{Math.round(c.conflict_score * 100)}%</span>
                    <span className="text-[9px] font-mono text-text-dim whitespace-nowrap">
                      {c.contradictions?.length || 0} conflict{(c.contradictions?.length || 0) !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
                {/* Individual contradictions */}
                {c.contradictions?.length > 0 && (
                  <div className="divide-y divide-border-subtle">
                    {c.contradictions.slice(0, 3).map((con: any, i: number) => {
                      const typeStyle: Record<string, string> = {
                        direct:       'text-red-400 border-red-500/25 bg-red-500/8',
                        contextual:   'text-blue-400 border-blue-500/25 bg-blue-500/8',
                        'value-based':'text-yellow-400 border-yellow-500/25 bg-yellow-500/8',
                      };
                      const ts2 = typeStyle[con.type] || typeStyle.contextual;
                      return (
                        <div key={i} className="px-4 py-3">
                          <div className="flex items-center gap-2 mb-2">
                            <span className={`text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border ${ts2}`}>
                              {con.type}
                            </span>
                            <span className="text-[9px] font-mono text-text-dim">{Math.round((con.severity || 0) * 100)}% severity</span>
                          </div>
                          <div className="space-y-1 mb-1.5">
                            <p className="text-[11px] text-text-secondary leading-relaxed">
                              <span className="text-accent-purple-light font-bold">{c.persona_a_name}:</span>{' '}
                              &ldquo;{String(con.claim_a || '').slice(0, 100)}&rdquo;
                            </p>
                            <p className="text-[11px] text-text-secondary leading-relaxed">
                              <span className="text-accent-teal-light font-bold">{c.persona_b_name}:</span>{' '}
                              &ldquo;{String(con.claim_b || '').slice(0, 100)}&rdquo;
                            </p>
                          </div>
                          <p className="text-[10px] text-text-dim italic">{con.explanation}</p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Evolution History Log */}
      {data.evolutionLog?.length > 0 && (
        <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6">
          <SectionHeader label="Persona Evolution History" />
          <div className="space-y-3">
            {data.evolutionLog.map((log: any, i: number) => (
              <div key={log.id} className="flex items-start gap-3 p-3 bg-bg-elevated/60 rounded-xl border border-border-subtle">
                <div className="w-8 h-8 rounded-lg bg-accent-purple/10 border border-accent-purple/20 flex items-center justify-center text-sm flex-shrink-0 mt-0.5">
                  {log.avatar_emoji}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-xs font-bold text-text-primary">{log.persona_name}</span>
                    <span className="text-[9px] font-mono text-text-dim">v{log.version_before} → v{log.version_after}</span>
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded-md border ${
                      (log.drift_score || 0) > 0.5 ? 'text-red-400 bg-red-500/10 border-red-500/20'
                      : (log.drift_score || 0) > 0.2 ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
                      : 'text-accent-teal-light bg-accent-teal/10 border-accent-teal/20'
                    }`}>
                      drift {Math.round((log.drift_score || 0) * 100)}%
                    </span>
                  </div>
                  <p className="text-[11px] text-text-secondary">{log.changes_explained}</p>
                </div>
                <div className="text-[9px] font-mono text-text-dim flex-shrink-0">{new Date(log.created_at).toLocaleDateString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top persona card */}
      {data.topPersona && (
        <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6 md:p-8 relative overflow-hidden">
          <div className="absolute top-0 right-0 bottom-0 w-1/3 bg-gradient-to-l from-bg-elevated to-transparent pointer-events-none"></div>
          <SectionHeader label="Primary Broadcasting Node" />
          <div className="flex flex-col md:flex-row md:items-center gap-6 relative z-10">
            <div className="w-20 h-20 rounded-[2rem] bg-bg-elevated border border-border-mid flex items-center justify-center text-4xl shadow-inner flex-shrink-0">
              {data.topPersona.avatar_emoji}
            </div>
            <div className="flex-1">
              <div className="text-2xl font-bold text-text-primary mb-1 tracking-tight">{data.topPersona.name}</div>
              <div className="flex flex-wrap gap-2 mb-4">
                {data.topPersona.archetype && <span className="text-[10px] font-mono uppercase text-accent-purple-light bg-accent-purple/10 border border-accent-purple/20 px-2.5 py-1 rounded-lg">{data.topPersona.archetype}</span>}
                {data.topPersona.tone && <span className="text-[10px] font-mono uppercase text-text-secondary bg-bg-elevated border border-border-subtle px-2.5 py-1 rounded-lg">{data.topPersona.tone}</span>}
                {data.topPersona.ideology && <span className="text-[10px] font-mono uppercase text-text-secondary bg-bg-elevated border border-border-subtle px-2.5 py-1 rounded-lg">{data.topPersona.ideology}</span>}
              </div>
              <div className="flex flex-wrap gap-4 sm:gap-8">
                {[
                  { label: 'Statements', val: data.topPersona.postCount, color: 'text-text-primary' },
                  { label: 'Conflicts', val: data.topPersona.debateCount, color: 'text-text-primary' },
                  { label: 'Resonance', val: data.topPersona.totalLikes, color: 'text-accent-purple-light' },
                ].map((s, i) => (
                  <React.Fragment key={s.label}>
                    {i > 0 && <div className="hidden sm:block w-px h-8 bg-border-subtle my-auto"></div>}
                    <div className="flex flex-col">
                      <span className={`text-2xl font-black font-mono tracking-tighter ${s.color}`}>{s.val}</span>
                      <span className="text-[10px] font-mono uppercase tracking-widest text-text-dim">{s.label}</span>
                    </div>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
