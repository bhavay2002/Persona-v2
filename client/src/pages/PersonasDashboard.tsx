import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth, useNav } from '../App';

const ARCHETYPE_OPTIONS = ['Advocate', 'Analyst', 'Challenger', 'Visionary', 'Pragmatist', 'Provocateur', 'Scholar', 'Empath', 'Realist', 'Idealist'];
const RHETORICAL_OPTIONS = ['moral framing', 'data-driven arguments', 'call-to-action', 'socratic questioning', 'analogy & metaphor', 'emotional appeals', 'logical syllogism', 'historical parallels', 'sarcasm', 'understatement'];
const EMOJI_OPTIONS = ['🎭', '💼', '🌿', '⚖️', '🔬', '🎨', '📰', '🏛️', '💡', '🔥', '🌍', '🤖', '✊', '🧠', '👑', '🦅', '🌱', '⚡', '🧬', '🦾'];
const STATUS_COLORS: Record<string, string> = {
  active: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  draft: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
  archived: 'text-text-dim bg-bg-elevated border-border-subtle',
};

interface Belief { topic: string; stance: string; strength: number; }
interface Persona {
  id: number; name: string; avatar_emoji: string;
  tone?: string; ideology?: string; archetype?: string;
  expertise?: string[]; rhetorical_style?: string[];
  tone_formality?: number; tone_emotionality?: number; tone_assertiveness?: number;
  beliefs?: Belief[]; taboos?: string[]; goals?: string[];
  status?: string; version?: number;
  consistency_score?: number; reputation_score?: number;
  post_count: number; debate_count: number;
  computed_post_count?: number; total_likes?: number;
  created_at: string;
}

const defaultForm = () => ({
  name: '', tone: '', ideology: '', expertiseStr: '', avatarEmoji: '🎭',
  archetype: '', toneFormality: 0.5, toneEmotionality: 0.5, toneAssertiveness: 0.5,
  beliefs: [] as Belief[], rhetoricalStyle: [] as string[],
  taboosStr: '', goalsStr: '', status: 'active',
});

function ToneSlider({ label, value, onChange, color }: { label: string; value: number; onChange: (v: number) => void; color: string }) {
  const pct = Math.round(value * 100);
  return (
    <div>
      <div className="flex justify-between mb-1.5">
        <span className="text-[10px] font-mono uppercase tracking-widest font-bold text-text-secondary">{label}</span>
        <span className={`text-[10px] font-mono font-bold ${color}`}>{pct}%</span>
      </div>
      <div className="relative h-2 bg-bg-elevated rounded-full overflow-visible">
        <div className={`h-full rounded-full transition-all`} style={{ width: `${pct}%`, background: 'var(--tw-gradient-to)' }} />
        <input
          type="range" min={0} max={1} step={0.05} value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white shadow-lg transition-all"
          style={{ left: `calc(${pct}% - 6px)`, background: color.includes('purple') ? '#8b5cf6' : color.includes('teal') ? '#14b8a6' : '#f59e0b' }}
        />
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[9px] font-mono text-text-dim uppercase">{label === 'FORMALITY' ? 'Casual' : label === 'EMOTIONALITY' ? 'Cold' : 'Tentative'}</span>
        <span className="text-[9px] font-mono text-text-dim uppercase">{label === 'FORMALITY' ? 'Formal' : label === 'EMOTIONALITY' ? 'Passionate' : 'Assertive'}</span>
      </div>
    </div>
  );
}

export default function PersonasDashboard() {
  const { user } = useAuth();
  const { navigate } = useNav();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(defaultForm());
  const [submitting, setSubmitting] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [enhancedProfile, setEnhancedProfile] = useState('');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'config' | 'tone' | 'beliefs' | 'advanced'>('config');
  const [newBelief, setNewBelief] = useState<Belief>({ topic: '', stance: '', strength: 0.8 });
  const [cloning, setCloning] = useState<number | null>(null);
  const [statusChanging, setStatusChanging] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'draft' | 'archived'>('all');

  useEffect(() => { if (user) loadPersonas(); }, [user]);

  const loadPersonas = async () => {
    setLoading(true);
    try { setPersonas(await api.getPersonas()); } catch {}
    setLoading(false);
  };

  const resetForm = () => { setForm(defaultForm()); setEnhancedProfile(''); setEditingId(null); setShowForm(false); setError(''); setActiveTab('config'); };

  const startEdit = (p: Persona) => {
    setForm({
      name: p.name, tone: p.tone || '', ideology: p.ideology || '',
      expertiseStr: (p.expertise || []).join(', '), avatarEmoji: p.avatar_emoji,
      archetype: p.archetype || '',
      toneFormality: p.tone_formality ?? 0.5,
      toneEmotionality: p.tone_emotionality ?? 0.5,
      toneAssertiveness: p.tone_assertiveness ?? 0.5,
      beliefs: Array.isArray(p.beliefs) ? p.beliefs : [],
      rhetoricalStyle: p.rhetorical_style || [],
      taboosStr: (p.taboos || []).join(', '),
      goalsStr: (p.goals || []).join(', '),
      status: p.status || 'active',
    });
    setEditingId(p.id); setShowForm(true); setEnhancedProfile('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSuggest = async () => {
    if (!form.name.trim()) return;
    setSuggesting(true);
    try {
      const res = await api.suggestPersona(form.name);
      const s = res.suggestion;
      setForm(f => ({
        ...f,
        tone: s.tone || f.tone,
        ideology: s.ideology || f.ideology,
        archetype: s.archetype || f.archetype,
        expertiseStr: (s.expertise || []).join(', ') || f.expertiseStr,
        rhetoricalStyle: s.rhetorical_style || f.rhetoricalStyle,
        toneFormality: s.tone_formality ?? f.toneFormality,
        toneEmotionality: s.tone_emotionality ?? f.toneEmotionality,
        toneAssertiveness: s.tone_assertiveness ?? f.toneAssertiveness,
        beliefs: s.beliefs || f.beliefs,
        goalsStr: (s.goals || []).join(', ') || f.goalsStr,
        taboosStr: (s.taboos || []).join(', ') || f.taboosStr,
        avatarEmoji: s.avatar_emoji || f.avatarEmoji,
      }));
      if (s.profile) setEnhancedProfile(s.profile);
    } catch {}
    setSuggesting(false);
  };

  const handleEnhance = async () => {
    if (!form.name) return;
    setEnhancing(true);
    try {
      const res = await api.enhancePersona({
        name: form.name, tone: form.tone, ideology: form.ideology, archetype: form.archetype,
        expertise: form.expertiseStr.split(',').map(s => s.trim()).filter(Boolean),
        beliefs: form.beliefs, rhetoricalStyle: form.rhetoricalStyle,
      });
      setEnhancedProfile(res.profile);
    } catch {}
    setEnhancing(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Identifier is required'); return; }
    setSubmitting(true); setError('');
    try {
      const payload = {
        name: form.name.trim(), tone: form.tone, ideology: form.ideology,
        expertise: form.expertiseStr.split(',').map(s => s.trim()).filter(Boolean),
        avatarEmoji: form.avatarEmoji, archetype: form.archetype,
        toneFormality: form.toneFormality, toneEmotionality: form.toneEmotionality,
        toneAssertiveness: form.toneAssertiveness, beliefs: form.beliefs,
        rhetoricalStyle: form.rhetoricalStyle,
        taboos: form.taboosStr.split(',').map(s => s.trim()).filter(Boolean),
        goals: form.goalsStr.split(',').map(s => s.trim()).filter(Boolean),
        status: form.status,
      };
      if (editingId) { await api.updatePersona(editingId, payload); } else { await api.createPersona(payload); }
      await loadPersonas(); resetForm();
    } catch (err: any) { setError(err.message || 'Failed to sync persona'); }
    setSubmitting(false);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Purge this entity? All associated data will be destroyed.')) return;
    try { await api.deletePersona(id); setPersonas(prev => prev.filter(p => p.id !== id)); } catch (err: any) { alert(err.message); }
  };

  const handleClone = async (id: number) => {
    setCloning(id);
    try { await api.clonePersona(id); await loadPersonas(); } catch (err: any) { alert(err.message); }
    setCloning(null);
  };

  const handleStatusChange = async (id: number, status: 'draft' | 'active' | 'archived') => {
    setStatusChanging(id);
    try { await api.setPersonaStatus(id, status); await loadPersonas(); } catch {}
    setStatusChanging(null);
  };

  const toggleRhetoricalStyle = (style: string) => {
    setForm(f => ({
      ...f,
      rhetoricalStyle: f.rhetoricalStyle.includes(style)
        ? f.rhetoricalStyle.filter(s => s !== style)
        : [...f.rhetoricalStyle, style],
    }));
  };

  const addBelief = () => {
    if (!newBelief.topic || !newBelief.stance) return;
    setForm(f => ({ ...f, beliefs: [...f.beliefs, { ...newBelief }] }));
    setNewBelief({ topic: '', stance: '', strength: 0.8 });
  };

  const removeBelief = (i: number) => setForm(f => ({ ...f, beliefs: f.beliefs.filter((_, idx) => idx !== i) }));

  const filteredPersonas = personas.filter(p => filterStatus === 'all' || (p.status || 'active') === filterStatus);

  if (!user) {
    return (
      <div className="max-w-2xl mx-auto py-24 text-center animate-fade-in">
        <div className="w-24 h-24 mx-auto bg-bg-surface border border-border-subtle rounded-3xl flex items-center justify-center text-5xl mb-8 shadow-xl">🎭</div>
        <h2 className="text-3xl font-bold text-text-primary mb-4 tracking-tight">Identity Synthesis Offline</h2>
        <p className="text-text-secondary mb-10 text-lg">Authenticate to construct your network of specialized perspectives.</p>
        <div className="flex gap-4 justify-center">
          <button onClick={() => navigate('login')} className="btn-secondary px-8">Initialize Session</button>
          <button onClick={() => navigate('register')} className="btn-primary px-8">Establish Operator</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-8 py-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 border-b border-border-subtle pb-6">
        <div>
          <h1 className="text-3xl font-bold text-text-primary tracking-tight">Entity Matrix</h1>
          <p className="text-text-secondary mt-1 text-sm">Manage your synthesized identity network — tone, beliefs, archetypes, lifecycle</p>
        </div>
        {!showForm && (
          <button onClick={() => { setShowForm(true); setEditingId(null); setEnhancedProfile(''); }} className="btn-primary flex items-center gap-2 whitespace-nowrap">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            Synthesize Persona
          </button>
        )}
      </div>

      {/* Create/Edit Form */}
      {showForm && (
        <div className="bg-bg-surface border border-accent-purple/30 rounded-2xl shadow-[0_0_50px_rgba(139,92,246,0.06)] animate-slide-up relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-accent-purple"></div>

          {/* Form Header */}
          <div className="px-6 pt-6 pb-4 border-b border-border-subtle">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-text-primary">{editingId ? 'Reconfigure Entity' : 'Synthesize New Entity'}</h2>
              <button onClick={resetForm} className="text-text-dim hover:text-text-primary transition-colors p-1">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="flex border-b border-border-subtle px-6">
            {(['config', 'tone', 'beliefs', 'advanced'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-3 text-[11px] font-mono uppercase tracking-widest font-bold border-b-2 transition-all ${
                  activeTab === tab ? 'border-accent-purple text-accent-purple-light' : 'border-transparent text-text-dim hover:text-text-secondary'
                }`}
              >
                {tab === 'config' ? 'Identity' : tab === 'tone' ? 'Tone Calibration' : tab === 'beliefs' ? 'Belief System' : 'Constraints'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-6">
            {/* TAB: Identity */}
            {activeTab === 'config' && (
              <div className="space-y-6">
                {/* Emoji Picker */}
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-3">Visual Protocol</label>
                  <div className="flex flex-wrap gap-2">
                    {EMOJI_OPTIONS.map(e => (
                      <button key={e} type="button" onClick={() => setForm(f => ({ ...f, avatarEmoji: e }))}
                        className={`w-11 h-11 rounded-xl text-xl flex items-center justify-center transition-all ${
                          form.avatarEmoji === e ? 'bg-accent-purple-dim border-2 border-accent-purple scale-110 shadow-[0_0_12px_rgba(139,92,246,0.3)]' : 'bg-bg-elevated border border-border-subtle hover:border-border-mid'
                        }`}>{e}</button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {/* Name + AI Suggest */}
                  <div className="md:col-span-2">
                    <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Entity Identifier *</label>
                    <div className="flex gap-2">
                      <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                        placeholder="e.g. Climate Activist, Cyber-Stoic..." className="input-base flex-1" />
                      <button type="button" onClick={handleSuggest} disabled={suggesting || !form.name}
                        className="px-4 py-2.5 text-xs font-mono tracking-wider font-bold bg-accent-purple/10 hover:bg-accent-purple/20 text-accent-purple-light rounded-xl border border-accent-purple/30 transition-all disabled:opacity-50 whitespace-nowrap flex items-center gap-2">
                        {suggesting ? <><span className="w-3 h-3 border border-accent-purple-light border-t-transparent rounded-full animate-spin"></span>AI...</> : '✨ AI Fill'}
                      </button>
                    </div>
                    <p className="text-[10px] font-mono text-text-dim mt-1.5">Tip: type a role and hit "AI Fill" — the system will configure all fields</p>
                  </div>

                  <div>
                    <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Archetype</label>
                    <div className="relative">
                      <select value={form.archetype} onChange={e => setForm(f => ({ ...f, archetype: e.target.value }))} className="input-base appearance-none pr-10">
                        <option value="">Select archetype...</option>
                        {ARCHETYPE_OPTIONS.map(a => <option key={a} value={a}>{a}</option>)}
                      </select>
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-text-dim">▾</div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Ideological Framework</label>
                    <input value={form.ideology} onChange={e => setForm(f => ({ ...f, ideology: e.target.value }))}
                      placeholder="e.g. libertarian, socialist..." className="input-base" />
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Knowledge Domains</label>
                    <input value={form.expertiseStr} onChange={e => setForm(f => ({ ...f, expertiseStr: e.target.value }))}
                      placeholder="climate policy, renewables, macroeconomics (comma separated)" className="input-base font-mono text-sm" />
                  </div>

                  <div>
                    <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Lifecycle Status</label>
                    <div className="flex gap-2">
                      {(['draft', 'active', 'archived'] as const).map(s => (
                        <button key={s} type="button" onClick={() => setForm(f => ({ ...f, status: s }))}
                          className={`flex-1 py-2 text-[10px] font-mono uppercase tracking-widest font-bold rounded-lg border transition-all ${
                            form.status === s ? STATUS_COLORS[s] : 'text-text-dim border-border-subtle hover:border-border-mid'
                          }`}>{s}</button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* AI Profile Section */}
                <div className="bg-bg-elevated border border-accent-teal/20 rounded-xl p-5 group relative overflow-hidden">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2 text-sm font-bold text-accent-teal-light uppercase tracking-wider font-mono">
                      <span className="w-2 h-2 rounded-full bg-accent-teal-light animate-pulse-slow"></span>
                      LLM Profile Synthesis
                    </div>
                    <button type="button" onClick={handleEnhance} disabled={enhancing || !form.name}
                      className="px-4 py-1.5 text-xs font-mono tracking-wider font-bold bg-accent-teal/10 hover:bg-accent-teal/20 text-accent-teal-light rounded-lg border border-accent-teal/30 transition-all disabled:opacity-50">
                      {enhancing ? 'PROCESSING...' : 'GENERATE PROFILE'}
                    </button>
                  </div>
                  {enhancedProfile ? (
                    <div className="bg-bg-surface/50 border border-border-subtle rounded-lg p-4">
                      <p className="text-[13px] text-text-primary leading-relaxed font-mono">"{enhancedProfile}"</p>
                    </div>
                  ) : (
                    <p className="text-xs text-text-secondary max-w-xl">Generate a psychological profile based on all configured parameters.</p>
                  )}
                </div>
              </div>
            )}

            {/* TAB: Tone Calibration */}
            {activeTab === 'tone' && (
              <div className="space-y-8">
                <div className="bg-bg-elevated border border-border-subtle rounded-xl p-5">
                  <p className="text-[11px] font-mono uppercase tracking-widest font-bold text-text-dim mb-6">Tone Sliders — Shape how this persona communicates</p>
                  <div className="space-y-7">
                    <ToneSlider label="FORMALITY" value={form.toneFormality} onChange={v => setForm(f => ({ ...f, toneFormality: v }))} color="text-accent-purple-light" />
                    <ToneSlider label="EMOTIONALITY" value={form.toneEmotionality} onChange={v => setForm(f => ({ ...f, toneEmotionality: v }))} color="text-accent-teal-light" />
                    <ToneSlider label="ASSERTIVENESS" value={form.toneAssertiveness} onChange={v => setForm(f => ({ ...f, toneAssertiveness: v }))} color="text-yellow-400" />
                  </div>
                </div>

                {/* Live preview */}
                <div className="bg-bg-elevated border border-border-subtle rounded-xl p-5">
                  <p className="text-[11px] font-mono uppercase tracking-widest font-bold text-text-dim mb-3">Compiled Tone Profile</p>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    {[
                      { label: 'FORMALITY', val: form.toneFormality, low: 'Casual', high: 'Formal', color: 'border-accent-purple/30 text-accent-purple-light' },
                      { label: 'EMOTION', val: form.toneEmotionality, low: 'Cold', high: 'Passionate', color: 'border-accent-teal/30 text-accent-teal-light' },
                      { label: 'ASSERT', val: form.toneAssertiveness, low: 'Tentative', high: 'Bold', color: 'border-yellow-500/30 text-yellow-400' },
                    ].map(item => (
                      <div key={item.label} className={`border rounded-xl p-4 ${item.color}`}>
                        <div className="text-2xl font-black font-mono">{Math.round(item.val * 100)}</div>
                        <div className="text-[9px] font-mono uppercase tracking-widest mt-1 opacity-70">{item.label}</div>
                        <div className="text-[9px] font-mono mt-1 opacity-60">{item.val > 0.5 ? item.high : item.low}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Rhetorical Style */}
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-3">Rhetorical Style (select all that apply)</label>
                  <div className="flex flex-wrap gap-2">
                    {RHETORICAL_OPTIONS.map(style => (
                      <button key={style} type="button" onClick={() => toggleRhetoricalStyle(style)}
                        className={`px-3 py-1.5 text-[11px] font-mono rounded-lg border transition-all ${
                          form.rhetoricalStyle.includes(style)
                            ? 'bg-accent-purple/15 border-accent-purple/50 text-accent-purple-light'
                            : 'border-border-subtle text-text-dim hover:border-border-mid hover:text-text-secondary bg-bg-elevated'
                        }`}>{style}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* TAB: Belief System */}
            {activeTab === 'beliefs' && (
              <div className="space-y-6">
                <div className="bg-bg-elevated border border-border-subtle rounded-xl p-5">
                  <p className="text-[11px] font-mono uppercase tracking-widest font-bold text-text-dim mb-4">Add Core Belief</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                    <input value={newBelief.topic} onChange={e => setNewBelief(b => ({ ...b, topic: e.target.value }))}
                      placeholder="Topic (e.g. climate)" className="input-base text-sm" />
                    <input value={newBelief.stance} onChange={e => setNewBelief(b => ({ ...b, stance: e.target.value }))}
                      placeholder="Stance (e.g. pro-regulation)" className="input-base text-sm" />
                    <div className="flex gap-2 items-center">
                      <div className="flex-1">
                        <div className="flex justify-between mb-1">
                          <span className="text-[10px] font-mono text-text-dim uppercase">Conviction</span>
                          <span className="text-[10px] font-mono text-accent-purple-light">{Math.round(newBelief.strength * 100)}%</span>
                        </div>
                        <input type="range" min={0} max={1} step={0.05} value={newBelief.strength}
                          onChange={e => setNewBelief(b => ({ ...b, strength: parseFloat(e.target.value) }))}
                          className="w-full cursor-pointer" />
                      </div>
                      <button type="button" onClick={addBelief} disabled={!newBelief.topic || !newBelief.stance}
                        className="px-4 py-2.5 text-xs font-mono font-bold bg-accent-purple/15 hover:bg-accent-purple/25 text-accent-purple-light rounded-xl border border-accent-purple/30 disabled:opacity-40 transition-all whitespace-nowrap">
                        + Add
                      </button>
                    </div>
                  </div>
                </div>

                {form.beliefs.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-[10px] font-mono uppercase tracking-widest font-bold text-text-dim">Active Beliefs ({form.beliefs.length})</p>
                    {form.beliefs.map((b, i) => (
                      <div key={i} className="flex items-center gap-3 bg-bg-elevated border border-border-subtle rounded-xl px-4 py-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono font-bold text-text-primary uppercase">{b.topic}</span>
                            <span className="text-text-dim">→</span>
                            <span className="text-xs font-mono text-accent-teal-light">{b.stance}</span>
                          </div>
                          <div className="mt-1.5 h-1 bg-bg-surface rounded-full overflow-hidden">
                            <div className="h-full bg-accent-purple/60 rounded-full" style={{ width: `${b.strength * 100}%` }} />
                          </div>
                        </div>
                        <span className="text-[10px] font-mono text-text-dim">{Math.round(b.strength * 100)}%</span>
                        <button type="button" onClick={() => removeBelief(i)} className="text-text-dim hover:text-red-400 transition-colors text-lg leading-none">×</button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-10 border border-dashed border-border-subtle rounded-xl">
                    <p className="text-text-dim font-mono text-sm">No beliefs configured. This persona will respond from a neutral stance.</p>
                  </div>
                )}
              </div>
            )}

            {/* TAB: Advanced */}
            {activeTab === 'advanced' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Communication Goals</label>
                    <textarea value={form.goalsStr} onChange={e => setForm(f => ({ ...f, goalsStr: e.target.value }))}
                      placeholder="raise awareness, shift public opinion, expose hypocrisy (comma separated)"
                      rows={3} className="input-base resize-none text-sm font-mono" />
                    <p className="text-[10px] font-mono text-text-dim mt-1">What this persona wants to achieve</p>
                  </div>
                  <div>
                    <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Taboos & Constraints</label>
                    <textarea value={form.taboosStr} onChange={e => setForm(f => ({ ...f, taboosStr: e.target.value }))}
                      placeholder="hate speech, personal attacks, profanity (comma separated)"
                      rows={3} className="input-base resize-none text-sm font-mono" />
                    <p className="text-[10px] font-mono text-text-dim mt-1">Content this persona will never produce</p>
                  </div>
                </div>

                <div className="bg-bg-elevated border border-yellow-500/20 rounded-xl p-5">
                  <p className="text-[11px] font-mono uppercase tracking-widest font-bold text-yellow-400 mb-3">⚠ Safety Layer (Always Active)</p>
                  <p className="text-xs font-mono text-text-secondary leading-relaxed">
                    All personas automatically include safety guardrails: no harmful content, no hate speech, no illegal content. This cannot be disabled — it is injected into every prompt compilation regardless of settings above.
                  </p>
                </div>
              </div>
            )}

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex gap-3 items-center">
                <span className="text-red-400 text-sm">⚠</span>
                <p className="text-red-400 text-sm font-medium">{error}</p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-border-subtle">
              <button type="submit" disabled={submitting} className="flex-1 btn-primary py-3">
                {submitting ? 'COMMITTING...' : editingId ? 'DEPLOY CONFIGURATION' : 'INITIALIZE ENTITY'}
              </button>
              <button type="button" onClick={resetForm} className="btn-secondary py-3 sm:w-28">ABORT</button>
            </div>
          </form>
        </div>
      )}

      {/* Filter Tabs */}
      {!showForm && personas.length > 0 && (
        <div className="flex gap-1 bg-bg-surface border border-border-subtle rounded-xl p-1 w-fit">
          {(['all', 'active', 'draft', 'archived'] as const).map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={`px-4 py-1.5 text-[10px] font-mono uppercase tracking-widest font-bold rounded-lg transition-all ${
                filterStatus === s ? 'bg-bg-elevated text-text-primary border border-border-mid' : 'text-text-dim hover:text-text-secondary'
              }`}>{s}</button>
          ))}
        </div>
      )}

      {/* Personas Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-bg-surface border border-border-subtle rounded-2xl p-6">
              <div className="flex gap-4"><div className="w-14 h-14 skeleton rounded-2xl flex-shrink-0" /><div className="flex-1 space-y-3"><div className="h-5 skeleton rounded w-1/2" /><div className="h-4 skeleton rounded w-3/4" /></div></div>
            </div>
          ))}
        </div>
      ) : filteredPersonas.length === 0 ? (
        <div className="text-center py-24 bg-bg-surface border border-border-subtle border-dashed rounded-3xl animate-fade-in">
          <div className="text-5xl mb-6 opacity-50">🎭</div>
          <h3 className="text-xl font-bold text-text-primary mb-2">
            {filterStatus !== 'all' ? `No ${filterStatus} personas` : 'Matrix is Empty'}
          </h3>
          <p className="text-text-secondary mb-8 max-w-md mx-auto">Synthesize your first identity vector to begin broadcasting.</p>
          {filterStatus === 'all' && <button onClick={() => setShowForm(true)} className="btn-primary">Synthesize Entity</button>}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {filteredPersonas.map((p, i) => (
            <div key={p.id} className="bg-bg-surface border border-border-subtle rounded-2xl p-5 card-hover relative overflow-hidden group animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
              <div className="absolute top-0 right-0 w-32 h-32 bg-accent-purple/5 rounded-full blur-3xl group-hover:bg-accent-purple/10 transition-colors pointer-events-none"></div>

              {/* Header row */}
              <div className="flex items-start justify-between mb-4 relative z-10">
                <div className="flex items-center gap-3">
                  <div className="w-13 h-13 w-12 h-12 rounded-xl bg-bg-elevated flex items-center justify-center text-2xl border border-border-subtle">
                    {p.avatar_emoji}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base font-bold text-text-primary group-hover:text-accent-purple-light transition-colors leading-tight">{p.name}</h3>
                      {p.status && p.status !== 'active' && (
                        <span className={`text-[9px] font-mono uppercase tracking-widest font-bold px-2 py-0.5 rounded-md border ${STATUS_COLORS[p.status]}`}>{p.status}</span>
                      )}
                    </div>
                    <div className="flex gap-3 mt-1 text-[10px] uppercase tracking-widest font-mono text-text-dim font-bold">
                      <span>{p.computed_post_count ?? p.post_count} STMTS</span>
                      <span>{p.debate_count} NFLCTS</span>
                      {p.total_likes ? <span className="text-accent-purple-light">♥ {p.total_likes}</span> : null}
                    </div>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex gap-1.5">
                  <button onClick={() => handleClone(p.id)} disabled={cloning === p.id}
                    className="p-1.5 text-text-dim hover:text-accent-teal-light hover:bg-accent-teal/10 rounded-lg transition-colors border border-transparent hover:border-accent-teal/20" title="Fork persona">
                    {cloning === p.id ? <span className="w-3.5 h-3.5 block border border-accent-teal-light border-t-transparent rounded-full animate-spin" /> : <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>}
                  </button>
                  <button onClick={() => startEdit(p)} className="p-1.5 text-text-dim hover:text-text-primary hover:bg-bg-elevated rounded-lg transition-colors border border-transparent hover:border-border-mid" title="Configure">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  </button>
                  <button onClick={() => handleDelete(p.id)} className="p-1.5 text-text-dim hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors border border-transparent hover:border-red-500/20" title="Purge">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              </div>

              {/* Tone bars */}
              {(p.tone_formality !== undefined && p.tone_formality !== null) && (
                <div className="mb-4 space-y-1.5 relative z-10">
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: 'F', val: p.tone_formality, color: 'bg-accent-purple/60', title: 'Formality' },
                      { label: 'E', val: p.tone_emotionality, color: 'bg-accent-teal/60', title: 'Emotionality' },
                      { label: 'A', val: p.tone_assertiveness, color: 'bg-yellow-500/60', title: 'Assertiveness' },
                    ].map(({ label, val, color, title }) => (
                      <div key={label} title={title}>
                        <div className="flex justify-between mb-0.5">
                          <span className="text-[9px] font-mono text-text-dim uppercase">{title}</span>
                          <span className="text-[9px] font-mono text-text-dim">{Math.round((val ?? 0.5) * 100)}%</span>
                        </div>
                        <div className="h-1 bg-bg-elevated rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${color}`} style={{ width: `${(val ?? 0.5) * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tags row */}
              <div className="flex flex-wrap gap-1.5 relative z-10">
                {p.archetype && <span className="text-[9px] uppercase font-mono tracking-wider font-bold text-accent-purple-light bg-accent-purple/10 px-2 py-0.5 rounded-md border border-accent-purple/20">{p.archetype}</span>}
                {p.tone && <span className="text-[9px] uppercase font-mono tracking-wider font-bold text-text-secondary bg-bg-elevated px-2 py-0.5 rounded-md border border-border-subtle">{p.tone}</span>}
                {p.ideology && <span className="text-[9px] uppercase font-mono tracking-wider font-bold text-text-secondary bg-bg-elevated px-2 py-0.5 rounded-md border border-border-subtle">{p.ideology}</span>}
                {(p.expertise || []).slice(0, 2).map(ex => (
                  <span key={ex} className="text-[9px] uppercase font-mono tracking-wider font-bold text-accent-teal-light bg-accent-teal/10 px-2 py-0.5 rounded-md border border-accent-teal/20">{ex}</span>
                ))}
                {Array.isArray(p.beliefs) && p.beliefs.length > 0 && (
                  <span className="text-[9px] uppercase font-mono tracking-wider font-bold text-yellow-400 bg-yellow-500/10 px-2 py-0.5 rounded-md border border-yellow-500/20">{p.beliefs.length} beliefs</span>
                )}
              </div>

              {/* Lifecycle controls */}
              <div className="mt-4 pt-3 border-t border-border-subtle flex items-center justify-between relative z-10">
                <div className="flex gap-1">
                  {(['draft', 'active', 'archived'] as const).filter(s => s !== (p.status || 'active')).map(s => (
                    <button key={s} onClick={() => handleStatusChange(p.id, s)} disabled={statusChanging === p.id}
                      className={`text-[9px] font-mono uppercase tracking-widest px-2 py-1 rounded-md border transition-all ${STATUS_COLORS[s]} opacity-60 hover:opacity-100`}>
                      → {s}
                    </button>
                  ))}
                </div>
                {p.version && p.version > 1 && (
                  <span className="text-[9px] font-mono text-text-dim">v{p.version}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
