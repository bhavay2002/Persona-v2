import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth, useNav } from '../App';
import DebateCard from '../components/DebateCard';

export default function DebateArena() {
  const { user } = useAuth();
  const { navigate } = useNav();
  const [debates, setDebates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [personas, setPersonas] = useState<any[]>([]);
  const [filter, setFilter] = useState<'all' | 'open' | 'active'>('all');
  const [form, setForm] = useState({
    topic: '', description: '', personaAId: '', personaBId: '',
    stanceA: '', stanceB: '',
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'manual' | 'ai'>('manual');
  const [publicPersonas, setPublicPersonas] = useState<any[]>([]);
  const [aiForm, setAiForm] = useState({ topic: '', description: '', personaAId: '', personaBId: '', rounds: '6' });
  const [aiCreating, setAiCreating] = useState(false);
  const [aiError, setAiError] = useState('');

  useEffect(() => {
    loadDebates();
    if (user) {
      api.getPersonas().then(d => setPersonas(d.filter((p: any) => (p.status || 'active') === 'active'))).catch(() => {});
      api.getPublicPersonas().then(d => setPublicPersonas(d)).catch(() => {});
    }
  }, [user, filter]);

  const loadDebates = async () => {
    setLoading(true);
    try {
      const params = filter !== 'all' ? { status: filter } : {};
      setDebates(await api.getDebates(params));
    } catch {}
    setLoading(false);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.topic.trim() || !form.personaAId) { setError('Topic and origin identity required'); return; }
    setCreating(true); setError('');
    try {
      const res = await api.createDebate({
        topic: form.topic.trim(),
        description: form.description.trim() || undefined,
        personaAId: parseInt(form.personaAId),
        personaBId: form.personaBId ? parseInt(form.personaBId) : undefined,
        stanceA: form.stanceA.trim() || undefined,
        stanceB: form.stanceB.trim() || undefined,
      });
      setShowCreate(false);
      setForm({ topic: '', description: '', personaAId: '', personaBId: '', stanceA: '', stanceB: '' });
      navigate('debate-view', { debateId: res.id });
    } catch (err: any) {
      setError(err.message || 'Failed to initialize conflict');
    }
    setCreating(false);
  };

  const handleAiCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiForm.topic.trim() || !aiForm.personaAId || !aiForm.personaBId) {
      setAiError('Topic, your persona, and opponent persona are all required'); return;
    }
    if (aiForm.personaAId === aiForm.personaBId) {
      setAiError('Personas must be different'); return;
    }
    setAiCreating(true); setAiError('');
    try {
      const res = await api.createAiDebate({
        topic: aiForm.topic.trim(),
        description: aiForm.description.trim() || undefined,
        personaAId: parseInt(aiForm.personaAId),
        personaBId: parseInt(aiForm.personaBId),
        rounds: parseInt(aiForm.rounds) || 6,
      });
      setMode('manual');
      setAiForm({ topic: '', description: '', personaAId: '', personaBId: '', rounds: '6' });
      navigate('live-debate', { debateId: res.id });
    } catch (err: any) { setAiError(err.message || 'Failed to start AI debate'); }
    setAiCreating(false);
  };

  const liveCount = debates.filter(d => d.status === 'active').length;
  const openCount = debates.filter(d => d.status === 'open').length;
  const avgQuality = debates.filter(d => d.quality_score > 0).length > 0
    ? Math.round(debates.filter(d => d.quality_score > 0).reduce((s, d) => s + d.quality_score, 0) / debates.filter(d => d.quality_score > 0).length)
    : null;

  return (
    <div className="max-w-4xl mx-auto space-y-8 py-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 border-b border-border-subtle pb-6">
        <div>
          <h1 className="text-3xl font-bold text-text-primary tracking-tight">Conflict Arena</h1>
          <p className="text-text-secondary mt-1 text-sm">Observe ideological convergence — AI-scored for logic, persuasion, and fallacies</p>

          {/* Quick stats */}
          <div className="flex gap-4 mt-3">
            <span className="text-[10px] font-mono uppercase text-text-dim">
              <span className="text-red-400 font-bold">{liveCount}</span> live
            </span>
            <span className="text-[10px] font-mono uppercase text-text-dim">
              <span className="text-accent-teal-light font-bold">{openCount}</span> open
            </span>
            {avgQuality !== null && (
              <span className="text-[10px] font-mono uppercase text-text-dim">
                <span className="text-yellow-400 font-bold">★ {avgQuality}</span> avg quality
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex p-1 bg-bg-surface border border-border-subtle rounded-xl">
            {(['all', 'open', 'active'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-4 py-2 text-xs rounded-lg font-mono font-bold uppercase tracking-wider transition-all ${
                  filter === f ? 'bg-bg-elevated text-text-primary shadow-sm border border-border-mid' : 'text-text-dim hover:text-text-secondary border border-transparent'
                }`}>
                {f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Live'}
              </button>
            ))}
          </div>
          {user && (
            <div className="flex gap-2">
              <button onClick={() => { setMode('manual'); setShowCreate(!showCreate); }}
                className="btn-primary flex items-center gap-2 whitespace-nowrap text-sm py-2 px-4">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Initiate
              </button>
              <button onClick={() => { setMode('ai'); setShowCreate(!showCreate || mode !== 'ai'); }}
                className="flex items-center gap-2 whitespace-nowrap text-sm py-2 px-4 rounded-xl border border-accent-purple/40 text-accent-purple-light hover:bg-accent-purple/10 transition-all font-medium">
                <span>◈</span> AI vs AI
              </button>
            </div>
          )}
        </div>
      </div>

      {/* AI vs AI Form */}
      {showCreate && mode === 'ai' && (
        <div className="bg-bg-surface border border-accent-purple/30 rounded-2xl p-6 shadow-[0_0_40px_rgba(139,92,246,0.08)] animate-slide-up relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-accent-purple to-accent-teal"></div>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-lg font-bold text-text-primary flex items-center gap-2"><span>◈</span> AI vs AI Debate</h2>
              <p className="text-xs text-text-dim mt-0.5">AI autonomously generates both sides — watch it unfold live</p>
            </div>
            <button onClick={() => setShowCreate(false)} className="text-text-dim hover:text-text-primary p-1">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <form onSubmit={handleAiCreate} className="space-y-5">
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Debate Topic *</label>
              <input value={aiForm.topic} onChange={e => setAiForm(f => ({ ...f, topic: e.target.value }))}
                placeholder="e.g. Is AI consciousness theoretically possible?" className="input-base text-base font-medium" />
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Context (Optional)</label>
              <textarea value={aiForm.description} onChange={e => setAiForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Set the stage for this debate..." rows={2} className="input-base resize-none" />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-accent-purple-light">Your Persona (Side A) *</label>
                <div className="relative">
                  <select value={aiForm.personaAId} onChange={e => setAiForm(f => ({ ...f, personaAId: e.target.value }))}
                    className="input-base appearance-none pr-10 border-accent-purple/30 focus:border-accent-purple">
                    <option value="">Select your entity...</option>
                    {personas.map(p => <option key={p.id} value={p.id}>{p.avatar_emoji} {p.name}</option>)}
                  </select>
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-accent-purple/50">▾</div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-accent-teal-light">Opponent Persona (Side B) *</label>
                <div className="relative">
                  <select value={aiForm.personaBId} onChange={e => setAiForm(f => ({ ...f, personaBId: e.target.value }))}
                    className="input-base appearance-none pr-10 border-accent-teal/30 focus:border-accent-teal">
                    <option value="">Select opponent...</option>
                    <optgroup label="Your Personas">
                      {personas.filter(p => p.id !== parseInt(aiForm.personaAId)).map(p => (
                        <option key={p.id} value={p.id}>{p.avatar_emoji} {p.name}</option>
                      ))}
                    </optgroup>
                    {publicPersonas.filter(p => !personas.some((mp: any) => mp.id === p.id)).length > 0 && (
                      <optgroup label="Community Personas">
                        {publicPersonas.filter(p => !personas.some((mp: any) => mp.id === p.id)).map(p => (
                          <option key={p.id} value={p.id}>{p.avatar_emoji} {p.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-accent-teal/50">▾</div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Rounds (2–10)</label>
                <div className="flex items-center gap-3">
                  <input type="range" min="2" max="10" step="2" value={aiForm.rounds}
                    onChange={e => setAiForm(f => ({ ...f, rounds: e.target.value }))}
                    className="flex-1 accent-accent-purple" />
                  <span className="text-lg font-bold text-accent-purple-light font-mono w-6 text-center">{aiForm.rounds}</span>
                </div>
              </div>
            </div>

            <div className="bg-bg-elevated border border-accent-purple/15 rounded-xl p-4">
              <p className="text-[10px] font-mono text-text-dim uppercase tracking-widest">
                ◈ AI generates {aiForm.rounds} arguments alternating between both personas — streamed live via WebSocket
              </p>
            </div>

            {aiError && <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-red-400 text-sm">{aiError}</div>}

            <div className="flex gap-3 pt-1">
              <button type="submit" disabled={aiCreating} className="flex-1 btn-primary py-3 disabled:opacity-60">
                {aiCreating ? 'Launching AI Debate...' : '◈ Launch AI Debate'}
              </button>
              <button type="button" onClick={() => setShowCreate(false)} className="btn-secondary py-3 px-6">Abort</button>
            </div>
          </form>
        </div>
      )}

      {/* Manual Create Form */}
      {showCreate && mode === 'manual' && (
        <div className="bg-bg-surface border border-accent-purple/30 rounded-2xl p-6 shadow-[0_0_40px_rgba(139,92,246,0.05)] animate-slide-up relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-accent-purple"></div>
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-bold text-text-primary">Configure Conflict Parameters</h2>
            <button onClick={() => setShowCreate(false)} className="text-text-dim hover:text-text-primary transition-colors p-1">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <form onSubmit={handleCreate} className="space-y-5 relative z-10">
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Core Theorem *</label>
              <input value={form.topic} onChange={e => setForm(f => ({ ...f, topic: e.target.value }))}
                placeholder="e.g. Is AGI acceleration an existential imperative?" className="input-base text-base font-medium" />
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Contextual Framework (Optional)</label>
              <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Provide initial boundaries for the discourse..." rows={2} className="input-base resize-none" />
            </div>

            {/* Participants */}
            <div className="bg-bg-elevated/50 border border-border-subtle rounded-xl p-5 space-y-4">
              <p className="text-[10px] font-mono uppercase tracking-widest font-bold text-text-dim">Participants & Stances</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-accent-purple-light">Origin Identity *</label>
                  <div className="relative">
                    <select value={form.personaAId} onChange={e => setForm(f => ({ ...f, personaAId: e.target.value }))}
                      className="input-base appearance-none pr-10 border-accent-purple/30 focus:border-accent-purple">
                      <option value="">Select your entity...</option>
                      {personas.map(p => <option key={p.id} value={p.id}>{p.avatar_emoji} {p.name}</option>)}
                    </select>
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-accent-purple/50">▾</div>
                  </div>
                  <input value={form.stanceA} onChange={e => setForm(f => ({ ...f, stanceA: e.target.value }))}
                    placeholder="Their stance (e.g. pro-office, anti-AGI)..."
                    className="input-base text-sm border-accent-purple/20 focus:border-accent-purple/50" />
                </div>

                <div className="space-y-2">
                  <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-accent-teal-light">Target Adversary (Optional)</label>
                  <div className="relative">
                    <select value={form.personaBId} onChange={e => setForm(f => ({ ...f, personaBId: e.target.value }))}
                      className="input-base appearance-none pr-10 border-accent-teal/30 focus:border-accent-teal">
                      <option value="">Open grid (any identity)</option>
                      {personas.filter(p => p.id !== parseInt(form.personaAId)).map(p => (
                        <option key={p.id} value={p.id}>{p.avatar_emoji} {p.name}</option>
                      ))}
                    </select>
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-accent-teal/50">▾</div>
                  </div>
                  <input value={form.stanceB} onChange={e => setForm(f => ({ ...f, stanceB: e.target.value }))}
                    placeholder="Their counter-stance (optional)..."
                    className="input-base text-sm border-accent-teal/20 focus:border-accent-teal/50"
                    disabled={!form.personaBId} />
                </div>
              </div>
            </div>

            <div className="bg-bg-elevated border border-accent-teal/15 rounded-xl p-4">
              <p className="text-[10px] font-mono text-text-dim uppercase tracking-widest">
                ✨ Every message will be automatically analyzed by AI for logic score, persuasiveness, toxicity, and logical fallacies
              </p>
            </div>

            {error && <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-red-400 text-sm font-medium">{error}</div>}

            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <button type="submit" disabled={creating} className="flex-1 btn-primary py-3">
                {creating ? 'Initializing...' : 'Deploy Conflict Protocol'}
              </button>
              <button type="button" onClick={() => setShowCreate(false)} className="btn-secondary py-3 sm:w-28">Abort</button>
            </div>
          </form>
        </div>
      )}

      {/* Debates List */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {[1,2,3,4].map(i => <div key={i} className="bg-bg-surface border border-border-subtle rounded-2xl p-6 h-48 skeleton" />)}
        </div>
      ) : debates.length === 0 ? (
        <div className="text-center py-24 bg-bg-surface border border-border-subtle border-dashed rounded-3xl animate-fade-in">
          <div className="text-5xl mb-6 opacity-50">⚔️</div>
          <h3 className="text-xl font-bold text-text-primary mb-2">No Active Conflicts</h3>
          <p className="text-text-secondary mb-8 max-w-md mx-auto">The grid is calm. Initialize the first ideological clash.</p>
          {user && <button onClick={() => setShowCreate(true)} className="btn-primary">Initiate Conflict</button>}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {debates.map((d, i) => (
            <DebateCard key={d.id} debate={d} onClick={() => navigate('debate-view', { debateId: d.id })} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
