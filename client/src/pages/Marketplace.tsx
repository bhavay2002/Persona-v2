import React, { useEffect, useState, useCallback } from 'react';
import { useAuth, useNav } from '../App';

const BASE = '/api';
function getToken() { return localStorage.getItem('persona_token'); }
function headers() {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) h['Authorization'] = `Bearer ${t}`;
  return h;
}
async function req(method: string, path: string, body?: any) {
  const res = await fetch(`${BASE}${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const SORT_OPTIONS = [
  { value: 'score', label: 'Top Score' },
  { value: 'downloads', label: 'Most Cloned' },
  { value: 'rating', label: 'Highest Rated' },
  { value: 'recent', label: 'Recent' },
  { value: 'debates', label: 'Most Active' },
];

function StarRating({ rating, onRate }: { rating: number; onRate?: (r: number) => void }) {
  const [hover, setHover] = useState(0);
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(s => (
        <button key={s}
          onClick={() => onRate?.(s)}
          onMouseEnter={() => onRate && setHover(s)}
          onMouseLeave={() => onRate && setHover(0)}
          className={`text-sm transition-colors ${(hover || rating) >= s ? 'text-yellow-400' : 'text-text-dim'} ${onRate ? 'cursor-pointer hover:scale-110' : 'cursor-default'}`}
        >★</button>
      ))}
    </div>
  );
}

function PersonaMarketCard({ persona, onClone, onRate, onOpposite }: {
  persona: any;
  onClone: (p: any) => void;
  onRate: (id: number, r: number) => void;
  onOpposite: (p: any) => void;
}) {
  const [cloning, setCloning] = useState(false);

  const handleClone = async () => {
    setCloning(true);
    await onClone(persona);
    setCloning(false);
  };

  const archetypeColors: Record<string, string> = {
    intellectual: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    activist: 'text-red-400 bg-red-500/10 border-red-500/20',
    authority: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    rebel: 'text-accent-purple-light bg-accent-purple/10 border-accent-purple/20',
    analyst: 'text-accent-teal-light bg-accent-teal/10 border-accent-teal/20',
    storyteller: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
  };
  const arcColor = archetypeColors[persona.archetype?.toLowerCase()] || 'text-text-dim bg-bg-elevated border-border-subtle';

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 flex flex-col gap-4 hover:border-border-mid transition-all hover:shadow-[0_0_20px_rgba(139,92,246,0.06)] group">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-bg-elevated border border-border-subtle flex items-center justify-center text-2xl shrink-0">
            {persona.avatar_emoji || '🎭'}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-text-primary truncate">{persona.name}</h3>
              {persona.featured && (
                <span className="text-[9px] font-mono font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/20">Featured</span>
              )}
            </div>
            {persona.archetype && (
              <span className={`text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-full border ${arcColor}`}>
                {persona.archetype}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] font-mono text-text-dim">Trust</div>
          <div className={`text-sm font-bold font-mono ${persona.trust_score >= 150 ? 'text-accent-teal-light' : persona.trust_score >= 100 ? 'text-text-secondary' : 'text-red-400'}`}>
            {Math.round(persona.trust_score || 100)}
          </div>
        </div>
      </div>

      {persona.description && (
        <p className="text-sm text-text-secondary line-clamp-2 leading-relaxed">{persona.description}</p>
      )}

      {(persona.ideology || persona.tone) && (
        <div className="flex gap-2 flex-wrap">
          {persona.ideology && <span className="text-[10px] px-2 py-0.5 rounded-full bg-bg-elevated border border-border-subtle text-text-dim font-mono">{persona.ideology}</span>}
          {persona.tone && <span className="text-[10px] px-2 py-0.5 rounded-full bg-bg-elevated border border-border-subtle text-text-dim font-mono">{persona.tone}</span>}
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2 py-3 border-y border-border-subtle">
        <div className="text-center">
          <div className="text-xs font-bold text-text-primary font-mono">{persona.downloads || 0}</div>
          <div className="text-[9px] font-mono uppercase text-text-dim tracking-widest">Clones</div>
        </div>
        <div className="text-center">
          <div className="text-xs font-bold text-text-primary font-mono">{persona.debate_count || 0}</div>
          <div className="text-[9px] font-mono uppercase text-text-dim tracking-widest">Debates</div>
        </div>
        <div className="text-center">
          <div className="text-xs font-bold text-text-primary font-mono">{persona.post_count || 0}</div>
          <div className="text-[9px] font-mono uppercase text-text-dim tracking-widest">Posts</div>
        </div>
      </div>

      {/* Rating */}
      <div className="flex items-center justify-between">
        <StarRating rating={Math.round(persona.rating || 0)} onRate={r => onRate(persona.id, r)} />
        <span className="text-[10px] font-mono text-text-dim">
          {persona.rating > 0 ? `${Number(persona.rating).toFixed(1)} (${persona.rating_count})` : 'No ratings'}
        </span>
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-auto pt-1">
        <button onClick={handleClone} disabled={cloning}
          className="flex-1 btn-primary py-2 text-sm disabled:opacity-60">
          {cloning ? 'Cloning...' : '⊕ Clone'}
        </button>
        <button onClick={() => onOpposite(persona)}
          className="px-3 py-2 text-sm border border-accent-purple/30 text-accent-purple-light hover:bg-accent-purple/10 rounded-xl transition-all font-medium"
          title="Generate your ideological opposite of this persona">
          ↯ Opposite
        </button>
      </div>

      {persona.tags?.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {persona.tags.map((t: string) => (
            <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-bg-elevated border border-border-subtle text-text-dim font-mono">#{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Marketplace() {
  const { user } = useAuth();
  const { navigate } = useNav();
  const [personas, setPersonas] = useState<any[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [myPersonas, setMyPersonas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('score');
  const [selectedTag, setSelectedTag] = useState('');
  const [publishModal, setPublishModal] = useState<any>(null);
  const [publishTags, setPublishTags] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [oppositeResult, setOppositeResult] = useState<any>(null);
  const [generatingOpposite, setGeneratingOpposite] = useState(false);
  const [savingOpposite, setSavingOpposite] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const loadMarketplace = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort });
      if (selectedTag) params.set('tag', selectedTag);
      const data = await req('GET', `/marketplace?${params}`);
      setPersonas(data.personas || []);
      setTags(data.tags || []);
    } catch {}
    setLoading(false);
  }, [sort, selectedTag]);

  useEffect(() => { loadMarketplace(); }, [loadMarketplace]);

  useEffect(() => {
    if (user) req('GET', '/personas').then((d: any[]) => setMyPersonas(d.filter((p: any) => (p.status || 'active') === 'active'))).catch(() => {});
  }, [user]);

  const handleClone = async (persona: any) => {
    if (!user) { navigate('login'); return; }
    try {
      await req('POST', `/marketplace/${persona.id}/clone`);
      showToast(`Cloned "${persona.name}" — find it in your Personas`);
      loadMarketplace();
    } catch (err: any) { showToast(err.message || 'Clone failed'); }
  };

  const handleRate = async (personaId: number, rating: number) => {
    if (!user) { navigate('login'); return; }
    try {
      await req('POST', `/marketplace/${personaId}/rate`, { rating });
      showToast('Rating submitted');
      loadMarketplace();
    } catch {}
  };

  const handlePublish = async () => {
    if (!publishModal) return;
    setPublishing(true);
    try {
      const tagArray = publishTags.split(',').map(t => t.trim()).filter(Boolean);
      await req('POST', `/marketplace/${publishModal.id}/publish`, { tags: tagArray });
      showToast(`"${publishModal.name}" published to marketplace`);
      setPublishModal(null);
      setPublishTags('');
      loadMarketplace();
      req('GET', '/personas').then((d: any[]) => setMyPersonas(d.filter((p: any) => (p.status || 'active') === 'active'))).catch(() => {});
    } catch (err: any) { showToast(err.message || 'Publish failed'); }
    setPublishing(false);
  };

  const handleUnpublish = async (persona: any) => {
    try {
      await req('DELETE', `/marketplace/${persona.id}/publish`);
      showToast(`"${persona.name}" removed from marketplace`);
      loadMarketplace();
      req('GET', '/personas').then((d: any[]) => setMyPersonas(d.filter((p: any) => (p.status || 'active') === 'active'))).catch(() => {});
    } catch (err: any) { showToast(err.message || 'Failed'); }
  };

  const handleOpposite = async (sourcePersona?: any) => {
    if (!user) { navigate('login'); return; }
    setGeneratingOpposite(true);
    setOppositeResult(null);
    try {
      const body = sourcePersona ? { sourcePersonaId: sourcePersona.id } : {};
      const result = await req('POST', '/ai/opposite-persona', body);
      setOppositeResult(result);
    } catch (err: any) { showToast(err.message || 'Generation failed'); }
    setGeneratingOpposite(false);
  };

  const handleSaveOpposite = async () => {
    if (!oppositeResult) return;
    setSavingOpposite(true);
    try {
      await req('POST', '/personas', {
        name: oppositeResult.name,
        avatar_emoji: oppositeResult.avatar_emoji,
        description: oppositeResult.description,
        tone: oppositeResult.tone,
        ideology: oppositeResult.ideology,
        archetype: oppositeResult.archetype,
        beliefs: oppositeResult.beliefs || [],
        traits: oppositeResult.traits || [],
      });
      showToast(`Persona "${oppositeResult.name}" created — find it in your Personas`);
      setOppositeResult(null);
    } catch (err: any) { showToast(err.message || 'Save failed'); }
    setSavingOpposite(false);
  };

  const publishedSet = new Set(myPersonas.filter((p: any) => p.is_public).map((p: any) => p.id));

  return (
    <div className="max-w-6xl mx-auto space-y-8 py-6">
      {/* Toast */}
      {toast && (
        <div className="fixed top-20 right-4 z-50 bg-accent-purple text-white px-4 py-3 rounded-xl shadow-lg text-sm font-medium animate-slide-up">
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-border-subtle pb-6">
        <div>
          <h1 className="text-3xl font-bold text-text-primary tracking-tight">Persona Marketplace</h1>
          <p className="text-text-secondary mt-1 text-sm">Discover, clone, and remix publicly shared identities</p>
          <div className="flex gap-4 mt-3">
            <span className="text-[10px] font-mono uppercase text-text-dim">
              <span className="text-accent-purple-light font-bold">{personas.length}</span> personas
            </span>
            <span className="text-[10px] font-mono uppercase text-text-dim">
              <span className="text-accent-teal-light font-bold">{personas.reduce((s, p) => s + (p.downloads || 0), 0)}</span> total clones
            </span>
          </div>
        </div>
        {user && (
          <button onClick={() => handleOpposite()} disabled={generatingOpposite}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-accent-purple/40 text-accent-purple-light hover:bg-accent-purple/10 transition-all font-medium text-sm disabled:opacity-60 shrink-0">
            <span className="text-lg">↯</span>
            {generatingOpposite ? 'Generating...' : 'Try Opposite You'}
          </button>
        )}
      </div>

      {/* "Try Opposite You" Result */}
      {oppositeResult && (
        <div className="bg-bg-surface border border-accent-purple/30 rounded-2xl p-6 animate-slide-up relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-accent-purple to-accent-teal"></div>
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-accent-purple-light mb-1">Your Ideological Opposite</div>
              <h3 className="text-xl font-bold text-text-primary flex items-center gap-3">
                <span className="text-3xl">{oppositeResult.avatar_emoji}</span>
                {oppositeResult.name}
              </h3>
            </div>
            <button onClick={() => setOppositeResult(null)} className="text-text-dim hover:text-text-primary p-1">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <p className="text-sm text-text-secondary mb-4 leading-relaxed">{oppositeResult.description}</p>
          <div className="flex gap-2 flex-wrap mb-4">
            {oppositeResult.ideology && <span className="text-[10px] px-2 py-1 rounded-full bg-bg-elevated border border-border-mid text-text-secondary font-mono">{oppositeResult.ideology}</span>}
            {oppositeResult.tone && <span className="text-[10px] px-2 py-1 rounded-full bg-bg-elevated border border-border-mid text-text-secondary font-mono">{oppositeResult.tone}</span>}
            {oppositeResult.archetype && <span className="text-[10px] px-2 py-1 rounded-full bg-accent-purple/10 border border-accent-purple/20 text-accent-purple-light font-mono">{oppositeResult.archetype}</span>}
          </div>
          {oppositeResult.beliefs?.length > 0 && (
            <div className="space-y-1 mb-5">
              {oppositeResult.beliefs.map((b: string, i: number) => (
                <div key={i} className="text-sm text-text-secondary flex items-start gap-2">
                  <span className="text-accent-purple mt-0.5 shrink-0">◆</span> {b}
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-3">
            <button onClick={handleSaveOpposite} disabled={savingOpposite}
              className="btn-primary px-6 py-2.5 disabled:opacity-60">
              {savingOpposite ? 'Saving...' : 'Save as Persona'}
            </button>
            <button onClick={() => setOppositeResult(null)} className="btn-secondary px-6 py-2.5">Discard</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Sidebar */}
        <aside className="lg:col-span-1 space-y-6">
          {/* Sort */}
          <div className="bg-bg-surface border border-border-subtle rounded-2xl p-4">
            <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-3">Sort By</div>
            <div className="space-y-1">
              {SORT_OPTIONS.map(o => (
                <button key={o.value} onClick={() => setSort(o.value)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all ${sort === o.value ? 'bg-accent-purple/10 text-accent-purple-light font-medium border border-accent-purple/20' : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* Tags */}
          {tags.length > 0 && (
            <div className="bg-bg-surface border border-border-subtle rounded-2xl p-4">
              <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-3">Filter by Tag</div>
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => setSelectedTag('')}
                  className={`text-[10px] px-2 py-1 rounded-full border font-mono transition-all ${!selectedTag ? 'bg-accent-purple/10 border-accent-purple/30 text-accent-purple-light' : 'border-border-subtle text-text-dim hover:border-border-mid'}`}>
                  All
                </button>
                {tags.map(t => (
                  <button key={t} onClick={() => setSelectedTag(selectedTag === t ? '' : t)}
                    className={`text-[10px] px-2 py-1 rounded-full border font-mono transition-all ${selectedTag === t ? 'bg-accent-purple/10 border-accent-purple/30 text-accent-purple-light' : 'border-border-subtle text-text-dim hover:border-border-mid'}`}>
                    #{t}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Publish Your Personas */}
          {user && myPersonas.length > 0 && (
            <div className="bg-bg-surface border border-border-subtle rounded-2xl p-4">
              <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-3">Your Personas</div>
              <div className="space-y-2">
                {myPersonas.map(p => (
                  <div key={p.id} className="flex items-center justify-between gap-2">
                    <span className="text-sm text-text-secondary truncate flex items-center gap-1.5">
                      <span>{p.avatar_emoji || '🎭'}</span>
                      <span className="truncate">{p.name}</span>
                    </span>
                    {publishedSet.has(p.id) ? (
                      <button onClick={() => handleUnpublish(p)}
                        className="text-[10px] px-2 py-1 rounded-lg bg-accent-teal/10 border border-accent-teal/20 text-accent-teal-light font-mono hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/20 transition-all shrink-0">
                        Listed
                      </button>
                    ) : (
                      <button onClick={() => setPublishModal(p)}
                        className="text-[10px] px-2 py-1 rounded-lg bg-bg-elevated border border-border-subtle text-text-dim hover:border-accent-purple/30 hover:text-accent-purple-light transition-all font-mono shrink-0">
                        Publish
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Main Grid */}
        <div className="lg:col-span-3">
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[1,2,3,4,5,6].map(i => <div key={i} className="bg-bg-surface border border-border-subtle rounded-2xl p-5 h-72 skeleton" />)}
            </div>
          ) : personas.length === 0 ? (
            <div className="text-center py-24 bg-bg-surface border border-border-subtle border-dashed rounded-3xl">
              <div className="text-5xl mb-6 opacity-50">🏪</div>
              <h3 className="text-xl font-bold text-text-primary mb-2">Marketplace is Empty</h3>
              <p className="text-text-secondary mb-6 max-w-sm mx-auto text-sm">No personas have been published yet. Be the first to share yours.</p>
              {user && myPersonas.length > 0 && (
                <button onClick={() => setPublishModal(myPersonas[0])} className="btn-primary">Publish a Persona</button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {personas.map(p => (
                <PersonaMarketCard
                  key={p.id}
                  persona={p}
                  onClone={handleClone}
                  onRate={handleRate}
                  onOpposite={handleOpposite}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Publish Modal */}
      {publishModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setPublishModal(null)}>
          <div className="bg-bg-surface border border-accent-purple/30 rounded-2xl p-6 w-full max-w-md shadow-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-text-primary mb-1">Publish to Marketplace</h2>
            <p className="text-sm text-text-secondary mb-5">
              Share <strong className="text-text-primary">{publishModal.avatar_emoji} {publishModal.name}</strong> with the community. Others can clone and remix it.
            </p>
            <div className="mb-5">
              <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Tags (comma-separated)</label>
              <input
                value={publishTags}
                onChange={e => setPublishTags(e.target.value)}
                placeholder="e.g. progressive, climate, debate"
                className="input-base"
              />
              <p className="text-[10px] text-text-dim mt-1.5 font-mono">Tags help others discover your persona</p>
            </div>
            <div className="flex gap-3">
              <button onClick={handlePublish} disabled={publishing} className="flex-1 btn-primary py-2.5 disabled:opacity-60">
                {publishing ? 'Publishing...' : 'Publish Persona'}
              </button>
              <button onClick={() => setPublishModal(null)} className="btn-secondary py-2.5 px-5">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
