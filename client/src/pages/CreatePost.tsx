import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth, useNav } from '../App';

export default function CreatePost() {
  const { user } = useAuth();
  const { navigate } = useNav();
  const [personas, setPersonas] = useState<any[]>([]);
  const [selectedPersona, setSelectedPersona] = useState<any>(null);
  const [rawText, setRawText] = useState('');
  const [rewrittenText, setRewrittenText] = useState('');
  const [tags, setTags] = useState('');
  const [rewriting, setRewriting] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [useAI, setUseAI] = useState(true);
  const [error, setError] = useState('');
  const [aiMeta, setAiMeta] = useState<{ intent?: string; confidence?: number; explanation?: string; } | null>(null);
  const lastUsedRef = useRef<number | null>(null);

  useEffect(() => {
    if (user) {
      api.getPersonas().then(data => {
        const active = data.filter((p: any) => (p.status || 'active') === 'active');
        setPersonas(active);
        // Restore last used persona
        const lastId = lastUsedRef.current || parseInt(localStorage.getItem('persona_last_used') || '0');
        const last = active.find((p: any) => p.id === lastId);
        if (last) setSelectedPersona(last);
        else if (active.length > 0) setSelectedPersona(active[0]);
      }).catch(() => {});
    }
  }, [user]);

  const handleSelectPersona = (p: any) => {
    setSelectedPersona(p);
    setRewrittenText('');
    setAiMeta(null);
    localStorage.setItem('persona_last_used', String(p.id));
    lastUsedRef.current = p.id;
  };

  const handleRewrite = async () => {
    if (!rawText.trim() || !selectedPersona) return;
    setRewriting(true);
    setIsStreaming(false);
    setRewrittenText('');
    setAiMeta(null);
    setError('');

    const abort = new AbortController();
    streamAbortRef.current = abort;

    try {
      const token = localStorage.getItem('persona_token');
      const response = await fetch('/api/ai/rewrite-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ text: rawText, personaId: selectedPersona.id }),
        signal: abort.signal,
      });

      if (!response.ok || !response.body) throw new Error('Stream unavailable');

      setIsStreaming(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break;
          if (payload.startsWith('[ERROR]')) throw new Error(payload.slice(8).trim());
          try {
            fullText += JSON.parse(payload);
            setRewrittenText(fullText);
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') { setRewriting(false); setIsStreaming(false); return; }
      // Fallback to non-streaming endpoint
      try {
        const res = await api.rewriteText(rawText, selectedPersona.id);
        setRewrittenText(res.rewritten);
        setAiMeta({ intent: res.intent?.type, confidence: res.intent?.confidence, explanation: res.explanation });
      } catch (e: any) {
        setError(e.message || 'Neural synthesis failed');
      }
    }

    setRewriting(false);
    setIsStreaming(false);
    streamAbortRef.current = null;
  };

  const handleCancelStream = () => {
    streamAbortRef.current?.abort();
  };

  const handlePost = async () => {
    const content = useAI ? (rewrittenText || rawText) : rawText;
    if (!content.trim() || !selectedPersona) return;
    setPosting(true);
    setError('');
    try {
      const tagsArr = tags.split(',').map(t => t.trim()).filter(Boolean);
      await api.createPost({
        personaId: selectedPersona.id,
        content,
        originalContent: rawText !== content ? rawText : undefined,
        topicTags: tagsArr,
        aiGenerated: useAI && !!rewrittenText,
      });
      setPosted(true);
    } catch (err: any) {
      setError(err.message || 'Failed to broadcast');
    }
    setPosting(false);
  };

  const INTENT_COLORS: Record<string, string> = {
    argumentative: 'text-red-400 bg-red-500/10 border-red-500/20',
    emotional: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
    informational: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    question: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    narrative: 'text-accent-teal-light bg-accent-teal/10 border-accent-teal/20',
  };

  if (!user) {
    return (
      <div className="max-w-2xl mx-auto py-24 text-center animate-fade-in">
        <div className="w-24 h-24 mx-auto bg-bg-surface border border-border-subtle rounded-3xl flex items-center justify-center text-5xl mb-8">✍️</div>
        <h2 className="text-3xl font-bold text-text-primary mb-4">Transmission Denied</h2>
        <p className="text-text-secondary mb-10 text-lg">Establish an operator session to deploy perspectives.</p>
        <button onClick={() => navigate('login')} className="btn-primary px-8">Initialize Session</button>
      </div>
    );
  }

  if (personas.length === 0) {
    return (
      <div className="max-w-2xl mx-auto py-24 text-center animate-fade-in">
        <div className="w-24 h-24 mx-auto bg-bg-surface border border-border-subtle rounded-3xl flex items-center justify-center text-5xl mb-8">🎭</div>
        <h2 className="text-3xl font-bold text-text-primary mb-4">No Active Entities Found</h2>
        <p className="text-text-secondary mb-10 text-lg">Synthesize and activate a persona before broadcasting.</p>
        <button onClick={() => navigate('personas')} className="btn-primary px-8">Synthesize Persona</button>
      </div>
    );
  }

  if (posted) {
    return (
      <div className="max-w-2xl mx-auto py-24 text-center animate-fade-in">
        <div className="w-24 h-24 mx-auto bg-accent-teal/10 border border-accent-teal/30 rounded-3xl flex items-center justify-center mb-8 relative overflow-hidden">
          <div className="absolute inset-0 border-2 border-accent-teal rounded-3xl animate-ping opacity-20"></div>
          <span className="text-accent-teal-light relative z-10">
            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
          </span>
        </div>
        <h2 className="text-3xl font-bold text-text-primary mb-4">Transmission Complete</h2>
        <p className="text-text-secondary mb-10 text-lg">Signal integrated as <strong className="text-text-primary">{selectedPersona?.name}</strong>.</p>
        <div className="flex gap-4 justify-center">
          <button onClick={() => navigate('feed')} className="btn-secondary px-8">Observe Feed</button>
          <button onClick={() => { setPosted(false); setRawText(''); setRewrittenText(''); setTags(''); setAiMeta(null); }} className="btn-primary px-8">New Transmission</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-6">
      <div className="border-b border-border-subtle pb-6">
        <h1 className="text-3xl font-bold text-text-primary tracking-tight">Construct Statement</h1>
        <p className="text-text-secondary mt-1 text-sm">Formulate a perspective to inject into the network stream</p>
      </div>

      {/* Active Persona Banner */}
      {selectedPersona && (
        <div className="flex items-center gap-3 bg-accent-purple/8 border border-accent-purple/30 rounded-xl px-5 py-3 shadow-[0_0_20px_rgba(139,92,246,0.06)]">
          <span className="text-xl">{selectedPersona.avatar_emoji}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-mono uppercase tracking-widest font-bold text-text-dim">Broadcasting as</span>
              <span className="text-sm font-bold text-text-primary">{selectedPersona.name}</span>
              {selectedPersona.archetype && <span className="text-[9px] font-mono uppercase text-accent-purple-light bg-accent-purple/10 border border-accent-purple/20 px-2 py-0.5 rounded-md">{selectedPersona.archetype}</span>}
            </div>
            {selectedPersona.tone_formality !== undefined && (
              <div className="flex gap-3 mt-1">
                {[
                  { k: 'F', v: selectedPersona.tone_formality },
                  { k: 'E', v: selectedPersona.tone_emotionality },
                  { k: 'A', v: selectedPersona.tone_assertiveness },
                ].map(({ k, v }) => (
                  <span key={k} className="text-[9px] font-mono text-text-dim">{k}:{Math.round((v ?? 0.5) * 100)}%</span>
                ))}
              </div>
            )}
          </div>
          <span className="text-[9px] font-mono text-text-dim uppercase tracking-widest">⚠ Your identity is masked</span>
        </div>
      )}

      {/* Persona Selector */}
      <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
        <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-3">Select Broadcasting Entity</label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {personas.map(p => (
            <button key={p.id} onClick={() => handleSelectPersona(p)}
              className={`flex items-center gap-2.5 p-3 rounded-xl border transition-all text-left ${
                selectedPersona?.id === p.id
                  ? 'border-accent-purple bg-accent-purple/10 shadow-[0_0_15px_rgba(139,92,246,0.1)]'
                  : 'border-border-subtle bg-bg-elevated hover:border-border-mid hover:bg-bg-surface'
              }`}
            >
              <div className="w-9 h-9 rounded-lg bg-bg-surface border border-border-subtle flex items-center justify-center text-lg flex-shrink-0">{p.avatar_emoji}</div>
              <div className="min-w-0 flex-1">
                <div className={`text-xs font-bold truncate ${selectedPersona?.id === p.id ? 'text-text-primary' : 'text-text-secondary'}`}>{p.name}</div>
                {p.archetype && <div className="text-[9px] font-mono uppercase text-text-dim truncate mt-0.5">{p.archetype}</div>}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        <div className="md:col-span-8 space-y-5">
          {/* Mode Toggle */}
          <div className="flex bg-bg-surface p-1 rounded-xl border border-border-subtle w-fit">
            {[
              { label: 'Neural Synthesis', val: true, color: 'text-accent-teal-light' },
              { label: 'Direct Manual', val: false, color: 'text-text-primary' },
            ].map(({ label, val, color }) => (
              <button key={label} onClick={() => setUseAI(val)}
                className={`px-5 py-2 rounded-lg text-xs font-mono font-bold tracking-wider uppercase transition-all flex items-center gap-2 ${
                  useAI === val ? `bg-bg-elevated ${color} shadow-sm border border-border-mid` : 'text-text-dim hover:text-text-secondary border border-transparent'
                }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${useAI === val ? 'bg-current animate-pulse-slow' : 'bg-transparent'}`}></span>
                {label}
              </button>
            ))}
          </div>

          {/* Text Input */}
          <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 relative overflow-hidden">
            <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-3">
              {useAI ? 'Raw Base Signal' : 'Payload Content'}
            </label>
            <textarea value={rawText} onChange={e => setRawText(e.target.value)}
              placeholder={useAI ? `Input core thought vector. ${selectedPersona?.name || 'Your persona'} will adapt the voice...` : `Construct statement as ${selectedPersona?.name}...`}
              rows={5}
              className="w-full bg-bg-elevated/50 border border-border-mid rounded-xl px-4 py-3 text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/30 transition-all resize-none text-[15px] leading-relaxed" />
            {useAI && (
              <div className="mt-4 flex items-center justify-between gap-3">
                {isStreaming && (
                  <div className="flex items-center gap-2 text-accent-teal-light text-[10px] font-mono uppercase tracking-widest animate-pulse-slow">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-teal animate-ping"></span>
                    Streaming tokens...
                  </div>
                )}
                {!isStreaming && <div />}
                <div className="flex gap-2">
                  {isStreaming && (
                    <button onClick={handleCancelStream}
                      className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-mono font-bold tracking-wider uppercase rounded-xl border border-red-500/20 transition-all">
                      ✕ Cancel
                    </button>
                  )}
                  <button onClick={handleRewrite} disabled={!rawText.trim() || rewriting || !selectedPersona}
                    className="px-5 py-2.5 bg-accent-teal/10 hover:bg-accent-teal/20 text-accent-teal-light text-xs font-mono font-bold tracking-wider uppercase rounded-xl border border-accent-teal/30 disabled:opacity-50 transition-all flex items-center gap-2">
                    {rewriting && !isStreaming
                      ? <><span className="w-4 h-4 border-2 border-accent-teal-light/30 border-t-accent-teal-light rounded-full animate-spin"></span>Connecting...</>
                      : rewriting && isStreaming
                      ? <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>Synthesizing...</>
                      : <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>Execute Synthesis</>}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* AI Output + Explainability */}
          {useAI && rewrittenText && (
            <div className="space-y-3 animate-slide-up">
              <div className="bg-bg-surface border border-accent-teal/30 rounded-2xl p-5 shadow-[0_0_25px_rgba(20,184,166,0.05)] relative">
                <div className="absolute top-0 left-0 w-1 h-full bg-accent-teal rounded-l-2xl"></div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-mono font-bold tracking-wider uppercase text-accent-teal-light flex items-center gap-2">
                    <span className="text-lg">{selectedPersona?.avatar_emoji}</span>
                    Synthesized Output
                    {isStreaming && <span className="inline-block w-0.5 h-3.5 bg-accent-teal-light animate-[blink_0.8s_step-end_infinite]" />}
                  </span>
                  {!isStreaming && <button onClick={() => { setRewrittenText(''); setAiMeta(null); }} className="text-[10px] font-mono uppercase tracking-widest text-text-dim hover:text-red-400 transition-colors">Discard</button>}
                </div>
                <textarea value={rewrittenText} onChange={e => setRewrittenText(e.target.value)} rows={4}
                  readOnly={isStreaming}
                  className={`w-full bg-bg-elevated/30 border border-transparent hover:border-border-mid rounded-xl px-4 py-3 text-text-primary focus:outline-none focus:border-accent-teal focus:ring-1 focus:ring-accent-teal/30 transition-all resize-none text-[15px] leading-relaxed ${isStreaming ? 'opacity-90' : ''}`} />
              </div>

              {/* Explainability Panel */}
              {aiMeta && (
                <div className="bg-bg-elevated border border-border-subtle rounded-xl p-4 space-y-3">
                  <p className="text-[10px] font-mono uppercase tracking-widest font-bold text-text-dim">AI Analysis Layer</p>
                  <div className="flex flex-wrap gap-2">
                    {aiMeta.intent && (
                      <span className={`text-[10px] font-mono uppercase tracking-wider font-bold px-2.5 py-1 rounded-lg border ${INTENT_COLORS[aiMeta.intent] || 'text-text-dim border-border-subtle bg-bg-surface'}`}>
                        {aiMeta.intent} intent
                      </span>
                    )}
                    {aiMeta.confidence && (
                      <span className="text-[10px] font-mono uppercase tracking-wider font-bold text-text-dim bg-bg-surface border border-border-subtle px-2.5 py-1 rounded-lg">
                        {Math.round(aiMeta.confidence * 100)}% confidence
                      </span>
                    )}
                  </div>
                  {aiMeta.explanation && (
                    <div className="flex gap-2.5 items-start">
                      <span className="text-accent-purple-light mt-0.5 flex-shrink-0">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                      </span>
                      <p className="text-xs text-text-secondary leading-relaxed font-mono italic">"{aiMeta.explanation}"</p>
                    </div>
                  )}
                  <p className="text-[9px] font-mono text-text-dim uppercase tracking-widest">Manual edits permitted before transmission</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="md:col-span-4 space-y-4">
          <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 sticky top-4">
            <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-3">Topic Vectors</label>
            <input value={tags} onChange={e => setTags(e.target.value)} placeholder="climate, AI, policy..." className="input-base font-mono text-sm" />
            <p className="text-[9px] font-mono uppercase tracking-widest text-text-dim mt-2">Comma separated tags</p>

            {error && <div className="mt-4 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-red-400 text-xs font-mono">{error}</div>}

            <button onClick={handlePost}
              disabled={posting || !rawText.trim() || (useAI && !rewrittenText)}
              className="w-full btn-primary mt-5 py-4 flex flex-col items-center gap-1 shadow-[0_0_20px_rgba(139,92,246,0.15)]">
              <span className="font-bold tracking-wide uppercase text-sm">{posting ? 'Broadcasting...' : 'Initiate Transmission'}</span>
              <span className="text-[9px] font-mono opacity-70">as {selectedPersona?.name}</span>
            </button>

            {useAI && !rewrittenText && rawText && (
              <p className="text-[9px] font-mono text-text-dim text-center mt-3 uppercase tracking-widest">Execute synthesis before transmitting</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
