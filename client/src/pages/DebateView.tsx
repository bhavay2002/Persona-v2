import React, { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth, useNav } from '../App';
import { timeAgo } from '../lib/utils';
import { getSocket, connectSocket } from '../lib/socket';

const MSG_TYPE_STYLES: Record<string, string> = {
  argument: 'text-accent-purple-light bg-accent-purple/10 border-accent-purple/20',
  rebuttal: 'text-red-400 bg-red-500/10 border-red-500/20',
  summary: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between mb-0.5">
        <span className="text-[9px] font-mono uppercase text-text-dim">{label}</span>
        <span className={`text-[9px] font-mono font-bold ${color}`}>{Math.round(value * 100)}%</span>
      </div>
      <div className="h-1 bg-bg-surface rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${value * 100}%`, background: color.includes('purple') ? '#8b5cf6' : color.includes('teal') ? '#14b8a6' : '#f59e0b' }} />
      </div>
    </div>
  );
}

function LiveScoreBar({ label, value, color, prev }: { label: string; value: number; color: string; prev: number }) {
  const delta = value - prev;
  const arrow = delta > 0.03 ? '↑' : delta < -0.03 ? '↓' : '';
  const arrowColor = delta > 0.03 ? 'text-emerald-400' : 'text-red-400';
  const filled = Math.round(value * 8);
  const blocks = Array.from({ length: 8 }, (_, i) => i < filled);

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[9px] font-mono uppercase text-text-dim w-14 shrink-0">{label}</span>
      <div className="flex gap-0.5">
        {blocks.map((on, i) => (
          <div key={i} className={`w-2 h-2.5 rounded-sm transition-all duration-500 ${on ? 'opacity-100' : 'opacity-10'}`}
            style={{ background: on ? (color.includes('purple') ? '#8b5cf6' : color.includes('teal') ? '#14b8a6' : '#f59e0b') : '#444' }} />
        ))}
      </div>
      <span className={`text-[9px] font-mono font-bold ${color} w-8`}>{Math.round(value * 100)}</span>
      {arrow && <span className={`text-[9px] font-mono font-bold ${arrowColor}`}>{arrow}</span>}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DebateView({ debateId }: { debateId: number }) {
  const { user } = useAuth();
  const { navigate } = useNav();

  // Debate state
  const [debate, setDebate] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [myPersonas, setMyPersonas] = useState<any[]>([]);
  const [selectedPersona, setSelectedPersona] = useState<any>(null);
  const [message, setMessage] = useState('');
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [voting, setVoting] = useState(false);
  const [hasVoted, setHasVoted] = useState(false);
  const [expandedScores, setExpandedScores] = useState<Set<number>>(new Set());
  const [stanceInput, setStanceInput] = useState('');
  const [viewerCount, setViewerCount] = useState(0);
  const [peerTyping, setPeerTyping] = useState<string | null>(null);

  // ── A. Co-Debate Suggestion state ──
  const [suggestion, setSuggestion] = useState<{
    continuation: string; counter: string; improvement: string; toneNote: string;
  } | null>(null);
  const [suggestionLoading, setSuggestionLoading] = useState(false);

  // ── B. Live Score state ──
  const [liveScore, setLiveScore] = useState<{
    logic_score: number; persuasiveness: number; clarity: number;
    emotional_intensity: number; overall: number;
  } | null>(null);
  const [prevLiveScore, setPrevLiveScore] = useState<typeof liveScore>(null);
  const [scoreLoading, setScoreLoading] = useState(false);

  // ── C. Adaptive Opponent state ──
  const [behaviorProfile, setBehaviorProfile] = useState<{
    dominantStyle: string; repetitionScore: number;
    avgLogic: number; avgPersuasion: number;
    strategyLabel: string; strategy: string; messageCount: number;
  } | null>(null);
  const [showStrategy, setShowStrategy] = useState(false);

  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scoreDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadDebate();
    if (user) api.getPersonas().then(d => setMyPersonas(d.filter((p: any) => (p.status || 'active') === 'active'))).catch(() => {});
  }, [debateId, user]);

  // ── Socket setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    const s = connectSocket();
    s.emit('join-debate', debateId);

    s.on('new-message', (msg: any) => {
      setDebate((prev: any) => {
        if (!prev) return prev;
        if (prev.messages?.some((m: any) => m.id === msg.id)) return prev;
        return { ...prev, messages: [...(prev.messages || []), msg] };
      });
    });

    s.on('vote-update', (votes: { votes_a: number; votes_b: number }) => {
      setDebate((prev: any) => prev ? { ...prev, ...votes } : prev);
    });

    s.on('viewer-count', ({ count }: { count: number }) => setViewerCount(count));

    s.on('debate-started', () => {
      setDebate((prev: any) => prev ? { ...prev, is_live: true, status: 'active' } : prev);
    });

    s.on('debate-complete', () => {
      setDebate((prev: any) => prev ? { ...prev, status: 'completed', is_live: false } : prev);
      loadDebate();
    });

    s.on('peer-typing', ({ personaName }: { personaName: string }) => {
      setPeerTyping(personaName);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => setPeerTyping(null), 2500);
    });

    // ── A. Co-Debate Suggestions ──
    s.on('suggestion', (data: any) => {
      setSuggestionLoading(false);
      if (data && (data.continuation || data.counter || data.improvement)) {
        setSuggestion(data);
      }
    });

    // ── B. Live Score ──
    s.on('score_update', (data: any) => {
      setScoreLoading(false);
      if (data && typeof data.logic_score === 'number') {
        setPrevLiveScore(prev => prev);
        setLiveScore(prev => {
          setPrevLiveScore(prev);
          return data;
        });
      }
    });

    // ── C. Behavior / Adaptive Opponent ──
    s.on('behavior_update', (data: any) => {
      if (data) setBehaviorProfile(data);
    });

    return () => {
      s.off('new-message');
      s.off('vote-update');
      s.off('viewer-count');
      s.off('debate-started');
      s.off('debate-complete');
      s.off('peer-typing');
      s.off('suggestion');
      s.off('score_update');
      s.off('behavior_update');
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      if (suggestDebounceRef.current) clearTimeout(suggestDebounceRef.current);
      if (scoreDebounceRef.current) clearTimeout(scoreDebounceRef.current);
      s.emit('leave-debate', debateId);
    };
  }, [debateId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [debate?.messages]);

  // Fetch existing behavior profile on persona selection
  useEffect(() => {
    const persona = selectedPersona || getMyDebatePersona();
    if (!persona) return;
    const s = getSocket();
    if (s) s.emit('get_behavior_profile', { debateId, personaId: persona.id });
  }, [selectedPersona, debate?.persona_a_id, debate?.persona_b_id]);

  const loadDebate = async () => {
    setLoading(true);
    try { setDebate(await api.getDebate(debateId)); } catch {}
    setLoading(false);
  };

  const canParticipate = () => {
    if (!user || !debate) return false;
    const ids = myPersonas.map(p => p.id);
    return ids.includes(debate.persona_a_id) || ids.includes(debate.persona_b_id);
  };

  const getMyDebatePersona = () => {
    if (!debate) return null;
    const ids = myPersonas.map(p => p.id);
    if (ids.includes(debate.persona_a_id)) return myPersonas.find(p => p.id === debate.persona_a_id);
    if (ids.includes(debate.persona_b_id)) return myPersonas.find(p => p.id === debate.persona_b_id);
    return null;
  };

  const activePersona = selectedPersona || getMyDebatePersona();

  // ── Debounced real-time handlers ──────────────────────────────────────────
  const handleMessageChange = useCallback((text: string) => {
    setMessage(text);
    setSuggestion(null);

    const s = getSocket();
    if (!s || !activePersona || !debate) return;

    // Typing indicator (immediate)
    if (text.trim()) s.emit('typing', { debateId, personaName: activePersona.name });

    // Co-debate suggestion (300ms debounce, min 10 chars)
    if (suggestDebounceRef.current) clearTimeout(suggestDebounceRef.current);
    if (text.trim().length >= 10) {
      setSuggestionLoading(true);
      suggestDebounceRef.current = setTimeout(() => {
        const myStance = debate.persona_a_id === activePersona.id ? debate.stance_a : debate.stance_b;
        s.emit('co_debate_suggest', {
          text,
          personaId: activePersona.id,
          personaName: activePersona.name,
          personaTone: activePersona.tone || '',
          topic: debate.topic || '',
          stance: myStance || '',
        });
      }, 300);
    } else {
      setSuggestionLoading(false);
    }

    // Live scoring (600ms debounce, min 4 words)
    if (scoreDebounceRef.current) clearTimeout(scoreDebounceRef.current);
    if (text.trim().split(/\s+/).length >= 4) {
      setScoreLoading(true);
      scoreDebounceRef.current = setTimeout(() => {
        s.emit('live_score', {
          text,
          debateId,
          personaId: activePersona.id,
        });
      }, 600);
    } else {
      setScoreLoading(false);
      if (text.trim().length === 0) setLiveScore(null);
    }
  }, [activePersona, debate, debateId]);

  const handleGenerate = async () => {
    if (!activePersona || !debate) return;
    setGenerating(true);
    try {
      const res = await api.generateArgument(
        debate.topic, activePersona.id, undefined, debate.messages?.slice(-6), debateId
      );
      setMessage(res.argument);
      // Trigger suggestion + scoring on the generated text
      handleMessageChange(res.argument);
    } catch {}
    setGenerating(false);
  };

  const handleSend = async () => {
    if (!message.trim() || !activePersona || sending) return;
    setSending(true);
    setSuggestion(null);
    setLiveScore(null);
    try {
      const msg = await api.sendDebateMessage(debateId, {
        personaId: activePersona.id,
        content: message.trim(),
        aiGenerated: false,
      });
      setDebate((prev: any) => ({ ...prev, messages: [...(prev.messages || []), msg] }));
      setMessage('');
    } catch (err: any) { alert(err.message); }
    setSending(false);
  };

  const handleVote = async (side: 'a' | 'b') => {
    if (!user || hasVoted || voting) return;
    setVoting(true);
    try {
      const res = await api.voteDebate(debateId, side);
      setHasVoted(true);
      setDebate((prev: any) => ({ ...prev, votes_a: res.votes.votes_a, votes_b: res.votes.votes_b }));
    } catch (err: any) { if (err.message.includes('Already voted')) setHasVoted(true); }
    setVoting(false);
  };

  const handleJoin = async () => {
    if (!selectedPersona || !debate) return;
    try {
      await api.joinDebate(debateId, { personaBId: selectedPersona.id, stanceB: stanceInput || undefined });
      await loadDebate();
    } catch (err: any) { alert(err.message); }
  };

  const toggleScores = (msgId: number) => {
    setExpandedScores(prev => {
      const next = new Set(prev);
      next.has(msgId) ? next.delete(msgId) : next.add(msgId);
      return next;
    });
  };

  const acceptSuggestion = (text: string) => {
    const newMsg = message.trim() ? `${message.trim()} ${text}` : text;
    setMessage(newMsg);
    setSuggestion(null);
    handleMessageChange(newMsg);
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto space-y-6 pt-6">
        <div className="h-4 w-32 skeleton rounded"></div>
        <div className="h-64 bg-bg-surface border border-border-subtle rounded-2xl skeleton" />
        <div className="h-[400px] bg-bg-surface border border-border-subtle rounded-2xl skeleton" />
      </div>
    );
  }

  if (!debate) {
    return (
      <div className="max-w-2xl mx-auto py-24 text-center">
        <div className="text-5xl mb-6 opacity-50">📡</div>
        <h2 className="text-2xl font-bold text-text-primary mb-2">Signal Lost</h2>
        <p className="text-text-secondary mb-8">This conflict record could not be retrieved.</p>
        <button onClick={() => navigate('debates')} className="btn-secondary px-8">Return to Grid</button>
      </div>
    );
  }

  const totalVotes = (debate.votes_a || 0) + (debate.votes_b || 0);
  const pctA = totalVotes > 0 ? Math.round((debate.votes_a / totalVotes) * 100) : 50;
  const pctB = 100 - pctA;

  const strongestId = debate.messages?.reduce((best: any, m: any) => {
    const score = (m.logic_score || 0) * 0.4 + (m.persuasiveness_score || 0) * 0.4 - (m.toxicity_score || 0) * 0.2;
    const bestScore = (best?.logic_score || 0) * 0.4 + (best?.persuasiveness_score || 0) * 0.4;
    return score > bestScore ? m : best;
  }, null)?.id;

  const isParticipating = canParticipate() && debate.status === 'active';
  const styleColor = behaviorProfile?.dominantStyle === 'emotional' ? 'text-orange-400'
    : behaviorProfile?.dominantStyle === 'logical' ? 'text-accent-teal-light'
    : 'text-accent-purple-light';

  return (
    <div className="max-w-4xl mx-auto space-y-6 pt-4 pb-8">
      <button onClick={() => navigate('debates')}
        className="group flex items-center gap-2 text-xs font-mono uppercase tracking-widest font-bold text-text-dim hover:text-text-primary transition-colors">
        <svg className="w-4 h-4 group-hover:-translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16l-4-4m0 0l4-4m-4 4h18" />
        </svg>
        Return to Grid
      </button>

      {/* Debate Header */}
      <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6 md:p-8 relative overflow-hidden shadow-[0_0_40px_rgba(0,0,0,0.5)]">
        <div className="absolute top-0 left-0 bottom-0 w-1/2 bg-gradient-to-r from-accent-purple/10 to-transparent pointer-events-none"></div>
        <div className="absolute top-0 right-0 bottom-0 w-1/2 bg-gradient-to-l from-accent-teal/10 to-transparent pointer-events-none"></div>

        <div className="relative z-10 flex flex-col items-center text-center mb-8">
          <div className="flex items-center gap-3 mb-5 flex-wrap justify-center">
            <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-widest font-bold border ${
              debate.status === 'active' ? 'text-red-400 bg-red-500/10 border-red-500/30 shadow-[0_0_12px_rgba(239,68,68,0.15)]'
              : debate.status === 'open' ? 'text-accent-teal-light bg-accent-teal/10 border-accent-teal/30'
              : debate.status === 'pending' ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30'
              : 'text-text-dim bg-bg-elevated border-border-subtle'
            }`}>
              {(debate.status === 'active' || debate.is_live) && <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse-slow"></span>}
              {debate.status === 'active' ? 'Live Conflict'
                : debate.status === 'open' ? 'Awaiting Adversary'
                : debate.status === 'pending' ? 'Generating…'
                : 'Resolved'}
            </span>

            {(debate.status === 'active' || debate.is_live) && viewerCount > 0 && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-widest font-bold border text-red-400 bg-red-500/10 border-red-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse-slow"></span>
                {viewerCount} watching
              </span>
            )}

            {debate.is_ai_generated && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-widest font-bold border text-accent-purple-light bg-accent-purple/10 border-accent-purple/30">
                ◈ AI vs AI
              </span>
            )}

            {debate.quality_score > 0 && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-widest font-bold border text-yellow-400 bg-yellow-500/10 border-yellow-500/30">
                ★ {debate.quality_score}/100 Quality
              </span>
            )}
          </div>

          {debate.is_ai_generated && debate.rounds_total > 0 && (
            <div className="w-full max-w-xs mb-5">
              <div className="flex justify-between mb-1">
                <span className="text-[9px] font-mono uppercase text-text-dim tracking-widest">Round Progress</span>
                <span className="text-[9px] font-mono text-text-secondary">{debate.rounds_completed}/{debate.rounds_total}</span>
              </div>
              <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-accent-purple to-accent-teal rounded-full transition-all duration-1000"
                  style={{ width: `${Math.round((debate.rounds_completed / debate.rounds_total) * 100)}%` }} />
              </div>
            </div>
          )}

          <h1 className="text-2xl md:text-3xl font-bold text-text-primary tracking-tight leading-tight max-w-2xl">{debate.topic}</h1>
          {debate.description && <p className="text-text-secondary text-sm mt-3 max-w-xl">{debate.description}</p>}
        </div>

        {/* VS Layout */}
        <div className="relative z-10 flex flex-col md:flex-row items-stretch justify-between gap-6 md:gap-4 px-2 md:px-8">
          <div className="flex flex-col items-center w-full md:w-2/5 text-center">
            <div className="w-20 h-20 rounded-3xl bg-bg-elevated border border-accent-purple/30 shadow-[0_0_25px_rgba(139,92,246,0.12)] flex items-center justify-center text-4xl mb-3 hover:scale-105 transition-transform">
              {debate.persona_a_emoji}
            </div>
            <div className="font-bold text-base text-text-primary">{debate.persona_a_name}</div>
            {debate.persona_a_archetype && (
              <span className="text-[9px] font-mono uppercase text-accent-purple-light bg-accent-purple/10 border border-accent-purple/20 px-2 py-0.5 rounded-md mt-1">{debate.persona_a_archetype}</span>
            )}
            {debate.stance_a && (
              <div className="mt-2 px-3 py-2 bg-accent-purple/10 border border-accent-purple/20 rounded-xl max-w-xs">
                <div className="text-[9px] font-mono uppercase text-text-dim mb-0.5">Stance</div>
                <div className="text-xs text-accent-purple-light font-medium italic">"{debate.stance_a}"</div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-center">
            <div className="w-10 h-10 rounded-full bg-bg-elevated border border-border-mid flex items-center justify-center">
              <span className="font-black text-transparent bg-clip-text bg-gradient-to-br from-text-dim to-text-secondary text-xs tracking-widest">VS</span>
            </div>
          </div>

          <div className="flex flex-col items-center w-full md:w-2/5 text-center">
            {debate.persona_b_name ? (
              <>
                <div className="w-20 h-20 rounded-3xl bg-bg-elevated border border-accent-teal/30 shadow-[0_0_25px_rgba(20,184,166,0.12)] flex items-center justify-center text-4xl mb-3 hover:scale-105 transition-transform">
                  {debate.persona_b_emoji}
                </div>
                <div className="font-bold text-base text-text-primary">{debate.persona_b_name}</div>
                {debate.persona_b_archetype && (
                  <span className="text-[9px] font-mono uppercase text-accent-teal-light bg-accent-teal/10 border border-accent-teal/20 px-2 py-0.5 rounded-md mt-1">{debate.persona_b_archetype}</span>
                )}
                {debate.stance_b && (
                  <div className="mt-2 px-3 py-2 bg-accent-teal/10 border border-accent-teal/20 rounded-xl max-w-xs">
                    <div className="text-[9px] font-mono uppercase text-text-dim mb-0.5">Stance</div>
                    <div className="text-xs text-accent-teal-light font-medium italic">"{debate.stance_b}"</div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="w-20 h-20 rounded-3xl bg-bg-elevated border-2 border-dashed border-accent-teal/30 flex items-center justify-center text-3xl mb-3 opacity-50">❓</div>
                <div className="font-bold text-text-dim text-sm">Unclaimed Node</div>
                <div className="text-[9px] font-mono uppercase text-accent-teal/50 mt-1">Awaiting Integration</div>
              </>
            )}
          </div>
        </div>

        {/* Vote Bar */}
        <div className="relative z-10 mt-8 max-w-2xl mx-auto bg-bg-elevated/50 rounded-2xl p-4 md:p-5 border border-border-subtle">
          <div className="mb-4">
            <div className="flex justify-between text-xs font-mono uppercase tracking-wider font-bold mb-2">
              <span className="text-accent-purple-light">{pctA}%</span>
              <span className="text-text-dim">Network Consensus · {totalVotes} votes</span>
              <span className="text-accent-teal-light">{pctB}%</span>
            </div>
            <div className="h-3 bg-bg-surface rounded-full overflow-hidden flex border border-border-subtle">
              <div className="h-full bg-accent-purple transition-all duration-1000 ease-out" style={{ width: `${pctA}%` }} />
              <div className="h-full bg-accent-teal transition-all duration-1000 ease-out" style={{ width: `${pctB}%` }} />
            </div>
          </div>
          {user && !hasVoted && debate.status === 'active' && (
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => handleVote('a')} disabled={voting}
                className="py-2.5 px-4 text-xs font-mono font-bold tracking-wider uppercase rounded-xl border border-accent-purple/40 text-accent-purple-light hover:bg-accent-purple/10 transition-all disabled:opacity-50">
                ▲ {debate.persona_a_name}
              </button>
              {debate.persona_b_name
                ? <button onClick={() => handleVote('b')} disabled={voting}
                    className="py-2.5 px-4 text-xs font-mono font-bold tracking-wider uppercase rounded-xl border border-accent-teal/40 text-accent-teal-light hover:bg-accent-teal/10 transition-all disabled:opacity-50">
                    ▲ {debate.persona_b_name}
                  </button>
                : <div className="py-2.5 text-xs font-mono text-text-dim text-center rounded-xl border border-border-subtle opacity-50 flex items-center justify-center">Awaiting Opponent</div>
              }
            </div>
          )}
          {hasVoted && (
            <div className="text-center text-accent-teal-light text-xs font-mono font-bold tracking-widest uppercase flex items-center justify-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              Vote Registered
            </div>
          )}
        </div>
      </div>

      {/* ── C. Adaptive Opponent Strategy Panel ── */}
      {isParticipating && behaviorProfile && behaviorProfile.messageCount >= 2 && (
        <div className="bg-bg-surface border border-border-subtle rounded-2xl overflow-hidden">
          <button
            onClick={() => setShowStrategy(s => !s)}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-bg-elevated/50 transition-colors">
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono uppercase tracking-widest text-text-dim">◈ Adaptive Opponent Intelligence</span>
              <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded-md border ${
                behaviorProfile.dominantStyle === 'emotional'
                  ? 'text-orange-400 bg-orange-500/10 border-orange-500/20'
                  : behaviorProfile.dominantStyle === 'logical'
                  ? 'text-accent-teal-light bg-accent-teal/10 border-accent-teal/20'
                  : 'text-accent-purple-light bg-accent-purple/10 border-accent-purple/20'
              } uppercase`}>
                {behaviorProfile.dominantStyle} style
              </span>
            </div>
            <span className="text-text-dim text-[10px] font-mono">{showStrategy ? '▲' : '▼'}</span>
          </button>
          {showStrategy && (
            <div className="px-5 pb-4 space-y-3 border-t border-border-subtle pt-4 animate-slide-up">
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-bg-elevated rounded-xl p-3 text-center">
                  <div className="text-[9px] font-mono uppercase text-text-dim mb-1">Avg Logic</div>
                  <div className="text-lg font-bold text-accent-purple-light">{Math.round(behaviorProfile.avgLogic * 100)}</div>
                </div>
                <div className="bg-bg-elevated rounded-xl p-3 text-center">
                  <div className="text-[9px] font-mono uppercase text-text-dim mb-1">Avg Persuasion</div>
                  <div className="text-lg font-bold text-accent-teal-light">{Math.round(behaviorProfile.avgPersuasion * 100)}</div>
                </div>
                <div className="bg-bg-elevated rounded-xl p-3 text-center">
                  <div className="text-[9px] font-mono uppercase text-text-dim mb-1">Repetition</div>
                  <div className={`text-lg font-bold ${behaviorProfile.repetitionScore > 0.4 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {Math.round(behaviorProfile.repetitionScore * 100)}%
                  </div>
                </div>
              </div>
              <div className="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
                <div className="text-[9px] font-mono uppercase text-text-dim mb-2">AI Opponent Strategy</div>
                <p className="text-xs font-mono font-bold text-yellow-400 mb-1">{behaviorProfile.strategyLabel}</p>
                <p className="text-[11px] text-text-secondary leading-relaxed">{behaviorProfile.strategy}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Messages Thread */}
      <div className="bg-bg-surface border border-border-subtle rounded-3xl overflow-hidden shadow-xl flex flex-col">
        <div className="p-4 md:p-5 border-b border-border-subtle bg-bg-elevated/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-xs uppercase tracking-widest font-bold text-text-secondary">Discourse Log</h2>
            {debate.messages?.length > 0 && (
              <span className="text-[10px] font-mono text-text-dim">{debate.messages.length} exchanges</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {debate.fallacies_detected?.length > 0 && (
              <span className="text-[9px] font-mono text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-md uppercase tracking-wider">
                ⚠ Fallacies Detected
              </span>
            )}
            <div className="flex gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-border-bright"></div>
              <div className="w-1.5 h-1.5 rounded-full bg-border-bright"></div>
              <div className="w-1.5 h-1.5 rounded-full bg-border-bright"></div>
            </div>
          </div>
        </div>

        <div className="p-4 md:p-8 space-y-5 min-h-[300px] max-h-[600px] overflow-y-auto scroll-smooth">
          {debate.messages?.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center py-16 text-text-dim">
              <svg className="w-10 h-10 mb-4 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z" />
              </svg>
              <p className="font-mono text-sm tracking-wider uppercase">Log is empty. Awaiting transmissions.</p>
            </div>
          ) : (
            debate.messages?.map((msg: any, i: number) => {
              const isSideA = msg.persona_id === debate.persona_a_id;
              const isStrongest = msg.id === strongestId && debate.messages.length >= 4;
              const hasScores = msg.logic_score !== null && msg.logic_score !== undefined;
              const showScores = expandedScores.has(msg.id);
              const hasFallacies = Array.isArray(msg.fallacies) && msg.fallacies.length > 0;
              const msgType = msg.msg_type || 'argument';

              return (
                <div key={msg.id} className={`flex gap-3 w-full animate-slide-up ${isSideA ? 'justify-start' : 'justify-end'}`}
                  style={{ animationDelay: `${Math.min(i * 40, 400)}ms` }}>
                  {isSideA && (
                    <div className="w-10 h-10 rounded-xl bg-bg-elevated flex items-center justify-center text-xl border border-accent-purple/20 flex-shrink-0 mt-1">
                      {msg.avatar_emoji}
                    </div>
                  )}
                  <div className={`max-w-[82%] flex flex-col ${isSideA ? 'items-start' : 'items-end'}`}>
                    <div className={`flex items-center gap-2 mb-1.5 flex-wrap ${isSideA ? 'flex-row' : 'flex-row-reverse'}`}>
                      <span className="text-xs font-bold text-text-primary">{msg.persona_name}</span>
                      <span className="text-[9px] font-mono text-text-dim">{timeAgo(msg.created_at)}</span>
                      <span className={`text-[9px] font-mono uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md border ${MSG_TYPE_STYLES[msgType] || MSG_TYPE_STYLES.argument}`}>
                        {msgType}
                      </span>
                      {msg.ai_generated && (
                        <span title="AI Synthesized" className="flex h-4 w-4 items-center justify-center rounded-full bg-accent-teal/10 border border-accent-teal/30 text-accent-teal-light text-[8px]">✨</span>
                      )}
                      {isStrongest && (
                        <span className="text-[9px] font-mono text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-1.5 py-0.5 rounded-md uppercase tracking-wider">★ Strongest</span>
                      )}
                    </div>

                    <div className={`relative px-4 py-3 text-[14px] leading-relaxed shadow-sm ${
                      isStrongest ? 'ring-1 ring-yellow-500/30 ' : ''
                    }${isSideA
                      ? 'bg-accent-purple/10 border border-accent-purple/20 text-text-primary rounded-2xl rounded-tl-sm'
                      : 'bg-accent-teal/10 border border-accent-teal/20 text-text-primary rounded-2xl rounded-tr-sm text-right'
                    }`}>
                      {msg.content}
                    </div>

                    {hasFallacies && (
                      <div className={`mt-1.5 px-3 py-2 bg-red-500/8 border border-red-500/20 rounded-xl max-w-xs ${isSideA ? '' : 'text-right'}`}>
                        <p className="text-[10px] font-mono text-red-400 uppercase tracking-wider font-bold mb-1">⚠ Fallacy detected</p>
                        {msg.fallacies.slice(0, 2).map((f: any, fi: number) => (
                          <p key={fi} className="text-[10px] font-mono text-text-secondary">
                            <span className="text-red-400 font-bold">{f.name}:</span> {f.explanation}
                          </p>
                        ))}
                      </div>
                    )}

                    {hasScores && (
                      <button onClick={() => toggleScores(msg.id)}
                        className="mt-1.5 text-[9px] font-mono text-text-dim hover:text-text-secondary uppercase tracking-widest transition-colors flex items-center gap-1">
                        {showScores ? '▲ Hide analysis' : '▼ View scores'}
                      </button>
                    )}

                    {showScores && hasScores && (
                      <div className={`mt-2 w-48 bg-bg-elevated border border-border-subtle rounded-xl p-3 space-y-2 animate-slide-up ${isSideA ? '' : 'ml-auto'}`}>
                        <p className="text-[9px] font-mono uppercase text-text-dim mb-2">Argument Analysis</p>
                        <ScoreBar label="Logic" value={msg.logic_score || 0} color="text-accent-purple-light" />
                        <ScoreBar label="Persuasion" value={msg.persuasiveness_score || 0} color="text-accent-teal-light" />
                        {(msg.toxicity_score || 0) > 0.1 && (
                          <ScoreBar label="Toxicity" value={msg.toxicity_score || 0} color="text-red-400" />
                        )}
                      </div>
                    )}
                  </div>

                  {!isSideA && (
                    <div className="w-10 h-10 rounded-xl bg-bg-elevated flex items-center justify-center text-xl border border-accent-teal/20 flex-shrink-0 mt-1">
                      {msg.avatar_emoji}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {peerTyping && (
            <div className="flex items-center gap-2 px-2 py-1 animate-fade-in">
              <div className="flex gap-0.5 items-end h-4">
                <span className="w-1 h-1 rounded-full bg-accent-teal/60 animate-[bounce_1.0s_ease-in-out_infinite]" style={{ animationDelay: '0ms' }}></span>
                <span className="w-1 h-1 rounded-full bg-accent-teal/60 animate-[bounce_1.0s_ease-in-out_infinite]" style={{ animationDelay: '160ms' }}></span>
                <span className="w-1 h-1 rounded-full bg-accent-teal/60 animate-[bounce_1.0s_ease-in-out_infinite]" style={{ animationDelay: '320ms' }}></span>
              </div>
              <span className="text-[10px] font-mono text-text-dim">{peerTyping} is composing...</span>
            </div>
          )}
          <div ref={messagesEndRef} className="h-1" />
        </div>

        {/* Input Area */}
        <div className="bg-bg-elevated/80 border-t border-border-subtle p-4 md:p-5">
          {isParticipating && (
            <div className="flex flex-col gap-3">
              {/* Persona + generate row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-bg-surface border border-border-subtle flex items-center justify-center text-base">{activePersona?.avatar_emoji}</div>
                  <span className="text-xs font-mono font-bold tracking-widest uppercase text-text-secondary">{activePersona?.name}</span>
                  {(debate.stance_a || debate.stance_b) && (
                    <span className="text-[9px] font-mono text-text-dim hidden sm:block">
                      {debate.persona_a_id === activePersona?.id ? debate.stance_a : debate.stance_b}
                    </span>
                  )}
                </div>
                <button onClick={handleGenerate} disabled={generating}
                  className="px-4 py-1.5 bg-accent-teal/10 hover:bg-accent-teal/20 border border-accent-teal/30 rounded-lg text-accent-teal-light text-[10px] font-mono font-bold uppercase tracking-widest transition-colors flex items-center gap-2 disabled:opacity-50">
                  {generating
                    ? <><span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin"></span>Synthesizing...</>
                    : <>✨ AI Generate</>}
                </button>
              </div>

              {/* Textarea */}
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex-1 flex flex-col gap-1">
                  <textarea value={message}
                    onChange={e => handleMessageChange(e.target.value)}
                    placeholder="Input tactical response..."
                    rows={3}
                    className="w-full bg-bg-surface border border-border-mid rounded-xl px-4 py-3 text-text-primary focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/30 transition-all resize-none text-[14px] leading-relaxed"
                    onKeyDown={e => {
                      if (e.key === 'Enter' && e.ctrlKey) handleSend();
                      // Tab to accept continuation suggestion
                      if (e.key === 'Tab' && suggestion?.continuation) {
                        e.preventDefault();
                        acceptSuggestion(suggestion.continuation);
                      }
                    }}
                  />

                  {/* ── B. Live Score Bars ── */}
                  {(liveScore || scoreLoading) && (
                    <div className="bg-bg-surface border border-border-subtle rounded-xl px-4 py-3 animate-slide-up">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[9px] font-mono uppercase tracking-widest text-text-dim">Live Analysis</span>
                        {scoreLoading && (
                          <span className="w-2.5 h-2.5 border border-accent-purple/60 border-t-transparent rounded-full animate-spin"></span>
                        )}
                        {liveScore && !scoreLoading && (
                          <span className={`text-[9px] font-mono font-bold ${liveScore.overall > 0.65 ? 'text-emerald-400' : liveScore.overall > 0.4 ? 'text-yellow-400' : 'text-red-400'}`}>
                            {Math.round(liveScore.overall * 100)} overall
                          </span>
                        )}
                      </div>
                      {liveScore && (
                        <div className="space-y-1.5">
                          <LiveScoreBar label="Logic" value={liveScore.logic_score} color="text-accent-purple-light" prev={prevLiveScore?.logic_score || 0} />
                          <LiveScoreBar label="Persuasion" value={liveScore.persuasiveness} color="text-accent-teal-light" prev={prevLiveScore?.persuasiveness || 0} />
                          <LiveScoreBar label="Clarity" value={liveScore.clarity} color="text-yellow-400" prev={prevLiveScore?.clarity || 0} />
                          <LiveScoreBar label="Emotion" value={liveScore.emotional_intensity} color="text-orange-400" prev={prevLiveScore?.emotional_intensity || 0} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── A. Co-Debate Suggestions Panel ── */}
                  {(suggestionLoading || suggestion) && (
                    <div className="bg-bg-surface border border-border-subtle rounded-xl px-4 py-3 space-y-2 animate-slide-up">
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] font-mono uppercase tracking-widest text-accent-purple-light">◈ AI Co-Pilot</span>
                        {suggestionLoading && (
                          <span className="w-2.5 h-2.5 border border-accent-purple/60 border-t-transparent rounded-full animate-spin"></span>
                        )}
                        {suggestion && !suggestionLoading && (
                          <button onClick={() => setSuggestion(null)} className="text-[9px] font-mono text-text-dim hover:text-text-secondary">✕</button>
                        )}
                      </div>
                      {suggestion && !suggestionLoading && (
                        <>
                          {suggestion.continuation && (
                            <div className="group cursor-pointer" onClick={() => acceptSuggestion(suggestion.continuation)} title="Click or Tab to accept">
                              <div className="text-[8px] font-mono uppercase text-text-dim mb-0.5">Continue → <span className="text-accent-purple/60">Tab</span></div>
                              <div className="text-xs text-accent-purple-light bg-accent-purple/8 border border-accent-purple/20 rounded-lg px-3 py-2 group-hover:bg-accent-purple/15 transition-colors leading-snug">
                                …{suggestion.continuation}
                              </div>
                            </div>
                          )}
                          {suggestion.counter && (
                            <div>
                              <div className="text-[8px] font-mono uppercase text-text-dim mb-0.5">Expect Counter</div>
                              <div className="text-xs text-red-400/80 bg-red-500/5 border border-red-500/15 rounded-lg px-3 py-2 leading-snug italic">
                                "{suggestion.counter}"
                              </div>
                            </div>
                          )}
                          {suggestion.improvement && (
                            <div>
                              <div className="text-[8px] font-mono uppercase text-text-dim mb-0.5">Improvement</div>
                              <div className="text-xs text-yellow-400/80 bg-yellow-500/5 border border-yellow-500/15 rounded-lg px-3 py-2 leading-snug">
                                {suggestion.improvement}
                              </div>
                            </div>
                          )}
                          {suggestion.toneNote && (
                            <p className="text-[9px] font-mono text-text-dim italic">{suggestion.toneNote}</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                <button onClick={handleSend} disabled={sending || !message.trim()}
                  className="btn-primary sm:w-28 flex items-center justify-center self-start mt-0">
                  {sending ? '...' : 'Transmit'}
                </button>
              </div>
              <p className="text-[9px] font-mono text-text-dim uppercase tracking-widest">
                Ctrl+Enter to send · Tab accepts AI continuation · Live scores update as you type
              </p>
            </div>
          )}

          {debate.status === 'open' && user && !canParticipate() && myPersonas.length > 0 && (
            <div className="flex flex-col gap-4">
              <span className="text-xs font-mono font-bold tracking-widest uppercase text-text-secondary block">Claim Open Node As:</span>
              <div className="flex flex-wrap gap-2">
                {myPersonas.map(p => (
                  <button key={p.id} onClick={() => setSelectedPersona(p)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${
                      selectedPersona?.id === p.id
                        ? 'border-accent-teal bg-accent-teal/10 text-accent-teal-light'
                        : 'border-border-mid bg-bg-surface text-text-secondary hover:border-accent-teal/50'
                    }`}>{p.avatar_emoji} {p.name}</button>
                ))}
              </div>
              {selectedPersona && (
                <div className="flex gap-2">
                  <input value={stanceInput} onChange={e => setStanceInput(e.target.value)}
                    placeholder={`${selectedPersona.name}'s stance on this topic (optional)...`}
                    className="flex-1 input-base text-sm" />
                  <button onClick={handleJoin} className="btn-primary whitespace-nowrap px-5">Enter Conflict</button>
                </div>
              )}
            </div>
          )}

          {debate.status === 'open' && !user && (
            <div className="text-center py-3">
              <p className="text-text-dim text-sm mb-2">Operator authentication required.</p>
              <button onClick={() => navigate('login')} className="text-accent-purple hover:text-accent-purple-light text-xs font-mono uppercase tracking-widest font-bold">Initialize Session →</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
