import React, { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth, useNav } from '../App';
import { connectSocket, getSocket } from '../lib/socket';
import { timeAgo } from '../lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DebatePersona {
  name: string;
  emoji: string;
  id: number;
}

interface TurnScore {
  logic_score: number;
  persuasiveness: number;
  clarity: number;
  emotional_intensity: number;
  overall: number;
}

interface Fallacy {
  type: string;
  text_span?: string;
  severity: number;
  explanation: string;
}

interface CompletedTurn {
  side: 'a' | 'b';
  personaName: string;
  content: string;
  msgId: number;
  score: TurnScore | null;
  fallacies: Fallacy[];
  turnNum: number;
  isHumanTurn: boolean;
}

type ArenaPhase = 'connecting' | 'waiting' | 'thinking' | 'speaking' | 'scoring' | 'human_turn' | 'complete';

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.round(value * 100);
  const barColor = color === 'purple' ? '#8b5cf6' : color === 'teal' ? '#14b8a6' : '#f59e0b';
  return (
    <div>
      <div className="flex justify-between mb-0.5">
        <span className="text-[9px] font-mono uppercase text-text-dim tracking-wider">{label}</span>
        <span className="text-[9px] font-mono font-bold" style={{ color: barColor }}>{pct}%</span>
      </div>
      <div className="h-1 bg-bg-surface rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${pct}%`, background: barColor }} />
      </div>
    </div>
  );
}

function RunningScore({ label, score, color, isLeading }: { label: string; score: number; color: string; isLeading: boolean }) {
  const barColor = color === 'purple' ? 'bg-accent-purple' : 'bg-accent-teal';
  const textColor = color === 'purple' ? 'text-accent-purple-light' : 'text-accent-teal-light';
  const borderColor = color === 'purple' ? 'border-accent-purple/30' : 'border-accent-teal/30';
  return (
    <div className={`flex flex-col items-center gap-1 px-5 py-3 rounded-2xl border ${borderColor} ${isLeading ? 'ring-1 ring-offset-0' : ''}`}
      style={{ ringColor: color === 'purple' ? 'rgba(139,92,246,0.4)' : 'rgba(20,184,166,0.4)' }}>
      <div className={`text-3xl font-black font-mono ${textColor} transition-all duration-500`}>{score}</div>
      <div className="text-[9px] font-mono uppercase tracking-widest text-text-dim">{label}</div>
      {isLeading && score > 0 && (
        <div className={`text-[8px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${barColor}/20 ${textColor}`}>
          leading
        </div>
      )}
    </div>
  );
}

function FallacyToast({ fallacy, side, onDismiss }: { fallacy: Fallacy; side: 'a' | 'b'; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="animate-slide-up flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 shadow-[0_0_20px_rgba(239,68,68,0.1)]">
      <span className="text-red-400 text-base mt-0.5">⚠</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-mono font-bold text-red-400 uppercase tracking-wider">
            {side === 'a' ? 'Side A' : 'Side B'}: {fallacy.type}
          </span>
          <span className="text-[9px] font-mono text-red-400/60">
            severity {Math.round(fallacy.severity * 100)}%
          </span>
        </div>
        <p className="text-[11px] text-text-secondary leading-snug">{fallacy.explanation}</p>
      </div>
      <button onClick={onDismiss} className="text-text-dim hover:text-text-secondary text-xs mt-0.5">✕</button>
    </div>
  );
}

function ThinkingDots({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 animate-fade-in">
      <div className="flex gap-1 items-end">
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-[bounce_1.0s_ease-in-out_infinite] opacity-60" style={{ animationDelay: '0ms' }}></span>
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-[bounce_1.0s_ease-in-out_infinite] opacity-60" style={{ animationDelay: '160ms' }}></span>
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-[bounce_1.0s_ease-in-out_infinite] opacity-60" style={{ animationDelay: '320ms' }}></span>
      </div>
      <span className="text-[11px] font-mono text-text-dim">{name} is formulating…</span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function LiveDebateArena({ debateId }: { debateId: number }) {
  const { user } = useAuth();
  const { navigate } = useNav();

  const [debate, setDebate] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<ArenaPhase>('connecting');
  const [activeSide, setActiveSide] = useState<'a' | 'b' | null>(null);
  const [activePersonaName, setActivePersonaName] = useState('');
  const [turnNum, setTurnNum] = useState(0);
  const [totalTurns, setTotalTurns] = useState(6);

  // Streaming token buffer for current turn
  const [streamingText, setStreamingText] = useState('');

  // Completed turns for the transcript
  const [turns, setTurns] = useState<CompletedTurn[]>([]);

  // Running scores
  const [scoreA, setScoreA] = useState(0);
  const [scoreB, setScoreB] = useState(0);

  // Fallacy toasts
  const [fallacyAlerts, setFallacyAlerts] = useState<Array<{ id: number; fallacy: Fallacy; side: 'a' | 'b' }>>([]);
  const fallacyCounter = useRef(0);

  // Human takeover state
  const [humanSide, setHumanSide] = useState<'a' | 'b' | null>(null);
  const [humanTurnActive, setHumanTurnActive] = useState(false);
  const [humanMessage, setHumanMessage] = useState('');
  const [sendingHuman, setSendingHuman] = useState(false);

  // Winner
  const [winner, setWinner] = useState<{ side: 'a' | 'b' | 'draw'; scoreA: number; scoreB: number; nameA: string; nameB: string } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, streamingText]);

  // Load debate info
  useEffect(() => {
    api.getDebate(debateId)
      .then(d => { setDebate(d); setTotalTurns(d.rounds_total || 6); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [debateId]);

  // WebSocket setup + auto-start
  useEffect(() => {
    const s = connectSocket();
    s.emit('join-debate', debateId);

    // ── Autonomous debate events ─────────────────────────────────────────────

    s.on('auto_start', (data: any) => {
      setPhase('waiting');
      setTotalTurns(data.totalTurns || 6);
    });

    s.on('auto_turn_start', (data: { side: 'a' | 'b'; personaName: string; turnNum: number; totalTurns: number }) => {
      setPhase('thinking');
      setActiveSide(data.side);
      setActivePersonaName(data.personaName);
      setTurnNum(data.turnNum);
      setTotalTurns(data.totalTurns);
      setStreamingText('');
    });

    s.on('auto_token', (data: { side: 'a' | 'b'; token: string; index: number }) => {
      setPhase('speaking');
      setActiveSide(data.side);
      setStreamingText(prev => prev + data.token);
    });

    s.on('auto_turn_end', (data: {
      side: 'a' | 'b'; personaName: string; content: string; msgId: number;
      score: TurnScore | null; fallacies: Fallacy[];
      runningScoreA: number; runningScoreB: number;
      turnNum: number; isHumanTurn: boolean;
    }) => {
      setPhase('scoring');
      setStreamingText('');
      setActiveSide(null);

      setTurns(prev => [...prev, {
        side: data.side,
        personaName: data.personaName,
        content: data.content,
        msgId: data.msgId,
        score: data.score,
        fallacies: data.fallacies || [],
        turnNum: data.turnNum,
        isHumanTurn: data.isHumanTurn,
      }]);

      setScoreA(data.runningScoreA);
      setScoreB(data.runningScoreB);

      // Show fallacy alerts
      (data.fallacies || []).slice(0, 2).forEach((f: Fallacy) => {
        if (f.severity >= 0.4) {
          const id = ++fallacyCounter.current;
          setFallacyAlerts(prev => [...prev, { id, fallacy: f, side: data.side }]);
        }
      });
    });

    s.on('auto_human_joined', (data: { side: 'a' | 'b' }) => {
      setHumanSide(data.side);
    });

    s.on('auto_human_turn_request', (data: { side: 'a' | 'b'; personaName: string; turnNum: number }) => {
      setPhase('human_turn');
      setActiveSide(data.side);
      setActivePersonaName(data.personaName);
      setTurnNum(data.turnNum);
      setHumanTurnActive(true);
      setHumanMessage('');
    });

    s.on('auto_complete', (data: { winner: 'a' | 'b' | 'draw'; scoreA: number; scoreB: number; personaAName: string; personaBName: string }) => {
      setPhase('complete');
      setWinner({
        side: data.winner,
        scoreA: data.scoreA,
        scoreB: data.scoreB,
        nameA: data.personaAName,
        nameB: data.personaBName,
      });
    });

    // Also listen for the old new-message event (for messages saved to DB)
    s.on('debate-started', () => setPhase('waiting'));

    return () => {
      s.off('auto_start');
      s.off('auto_turn_start');
      s.off('auto_token');
      s.off('auto_turn_end');
      s.off('auto_human_joined');
      s.off('auto_human_turn_request');
      s.off('auto_complete');
      s.off('debate-started');
      s.emit('leave-debate', debateId);
    };
  }, [debateId]);

  // Trigger live-start once on mount (after debate loads)
  useEffect(() => {
    if (!debate || startedRef.current || !user) return;
    startedRef.current = true;
    api.startLiveDebate(debateId).catch(() => {});
  }, [debate, user, debateId]);

  // ── Human takeover handlers ─────────────────────────────────────────────────

  const handleJumpIn = useCallback((side: 'a' | 'b') => {
    const s = getSocket();
    if (!s || !user) return;
    setHumanSide(side);
    s.emit('auto_human_join', { debateId, side });
  }, [debateId, user]);

  const handleHumanSend = useCallback(() => {
    if (!humanMessage.trim() || sendingHuman) return;
    setSendingHuman(true);
    const s = getSocket();
    if (s) {
      s.emit('auto_human_turn', { debateId, content: humanMessage.trim() });
    }
    setHumanTurnActive(false);
    setHumanMessage('');
    setSendingHuman(false);
  }, [humanMessage, sendingHuman, debateId]);

  // ── Render helpers ─────────────────────────────────────────────────────────

  const dismissFallacy = (id: number) => {
    setFallacyAlerts(prev => prev.filter(a => a.id !== id));
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto pt-10 space-y-4">
        <div className="h-10 w-64 skeleton rounded-xl" />
        <div className="h-[600px] bg-bg-surface border border-border-subtle rounded-3xl skeleton" />
      </div>
    );
  }

  if (!debate) {
    return (
      <div className="max-w-2xl mx-auto py-24 text-center">
        <div className="text-5xl mb-6 opacity-50">📡</div>
        <h2 className="text-2xl font-bold text-text-primary mb-2">Signal Lost</h2>
        <p className="text-text-secondary mb-8">Debate not found.</p>
        <button onClick={() => navigate('debates')} className="btn-secondary px-8">Return to Arena</button>
      </div>
    );
  }

  const progressPct = totalTurns > 0 ? Math.round((turns.length / totalTurns) * 100) : 0;
  const leadingA = scoreA > scoreB;
  const leadingB = scoreB > scoreA;

  return (
    <div className="max-w-5xl mx-auto py-4 pb-10 space-y-5">

      {/* Back navigation */}
      <button onClick={() => navigate('debates')}
        className="group flex items-center gap-2 text-xs font-mono uppercase tracking-widest font-bold text-text-dim hover:text-text-primary transition-colors">
        <svg className="w-4 h-4 group-hover:-translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16l-4-4m0 0l4-4m-4 4h18" />
        </svg>
        Return to Grid
      </button>

      {/* Header */}
      <div className="bg-bg-surface border border-border-subtle rounded-3xl p-6 relative overflow-hidden shadow-[0_0_60px_rgba(0,0,0,0.4)]">
        <div className="absolute top-0 left-0 bottom-0 w-1/2 bg-gradient-to-r from-accent-purple/8 to-transparent pointer-events-none" />
        <div className="absolute top-0 right-0 bottom-0 w-1/2 bg-gradient-to-l from-accent-teal/8 to-transparent pointer-events-none" />

        {/* Status badges */}
        <div className="relative z-10 flex flex-wrap items-center gap-2 mb-4">
          {phase !== 'complete' ? (
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-widest font-bold text-red-400 bg-red-500/10 border border-red-500/30 shadow-[0_0_12px_rgba(239,68,68,0.15)]">
              <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse-slow" />
              Live AI Arena
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-widest font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30">
              ✓ Concluded
            </span>
          )}

          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-widest font-bold border text-accent-purple-light bg-accent-purple/10 border-accent-purple/30">
            ◈ AI vs AI
          </span>

          {humanSide && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-widest font-bold border text-yellow-400 bg-yellow-500/10 border-yellow-500/30">
              ⚡ Human on Side {humanSide.toUpperCase()}
            </span>
          )}

          <span className="ml-auto text-[10px] font-mono text-text-dim uppercase">
            Turn {Math.min(turns.length + (phase === 'speaking' ? 1 : 0), totalTurns)} / {totalTurns}
          </span>
        </div>

        {/* Topic */}
        <div className="relative z-10 text-center mb-5">
          <h1 className="text-2xl md:text-3xl font-bold text-text-primary tracking-tight leading-tight max-w-2xl mx-auto">
            {debate.topic}
          </h1>
          {debate.description && (
            <p className="text-text-secondary text-sm mt-2 max-w-xl mx-auto">{debate.description}</p>
          )}
        </div>

        {/* VS layout with live scores */}
        <div className="relative z-10 flex items-stretch justify-center gap-6 md:gap-8">
          {/* Side A */}
          <div className="flex flex-col items-center gap-3 flex-1 max-w-[200px]">
            <div className={`w-16 h-16 rounded-2xl bg-bg-elevated flex items-center justify-center text-3xl border transition-all duration-300 ${
              activeSide === 'a' && phase !== 'scoring' ? 'border-accent-purple shadow-[0_0_20px_rgba(139,92,246,0.3)] scale-105' : 'border-accent-purple/20'
            }`}>
              {debate.persona_a_emoji}
            </div>
            <div className="text-center">
              <div className="font-bold text-sm text-text-primary">{debate.persona_a_name}</div>
              {debate.persona_a_archetype && (
                <div className="text-[9px] font-mono uppercase text-accent-purple-light mt-0.5">{debate.persona_a_archetype}</div>
              )}
            </div>
            <RunningScore label="Score" score={scoreA} color="purple" isLeading={leadingA} />

            {/* Jump In button — Side A */}
            {user && phase !== 'complete' && humanSide !== 'a' && (
              <button onClick={() => handleJumpIn('a')}
                className="text-[9px] font-mono uppercase tracking-widest font-bold px-3 py-1.5 rounded-lg border border-accent-purple/30 text-accent-purple-light hover:bg-accent-purple/10 transition-all">
                ⚡ Take Over
              </button>
            )}
            {humanSide === 'a' && (
              <span className="text-[9px] font-mono text-yellow-400 uppercase tracking-wider">You (Side A)</span>
            )}
          </div>

          {/* Center — VS + progress */}
          <div className="flex flex-col items-center justify-center gap-3 min-w-[60px]">
            <div className="w-10 h-10 rounded-full bg-bg-elevated border border-border-mid flex items-center justify-center">
              <span className="font-black text-[9px] tracking-widest text-text-dim">VS</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <div className="h-20 w-1 bg-bg-elevated rounded-full overflow-hidden relative">
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-accent-purple to-accent-teal rounded-full transition-all duration-700 ease-out"
                  style={{ height: `${progressPct}%` }} />
              </div>
              <span className="text-[9px] font-mono text-text-dim">{progressPct}%</span>
            </div>
          </div>

          {/* Side B */}
          <div className="flex flex-col items-center gap-3 flex-1 max-w-[200px]">
            <div className={`w-16 h-16 rounded-2xl bg-bg-elevated flex items-center justify-center text-3xl border transition-all duration-300 ${
              activeSide === 'b' && phase !== 'scoring' ? 'border-accent-teal shadow-[0_0_20px_rgba(20,184,166,0.3)] scale-105' : 'border-accent-teal/20'
            }`}>
              {debate.persona_b_emoji}
            </div>
            <div className="text-center">
              <div className="font-bold text-sm text-text-primary">{debate.persona_b_name}</div>
              {debate.persona_b_archetype && (
                <div className="text-[9px] font-mono uppercase text-accent-teal-light mt-0.5">{debate.persona_b_archetype}</div>
              )}
            </div>
            <RunningScore label="Score" score={scoreB} color="teal" isLeading={leadingB} />

            {/* Jump In button — Side B */}
            {user && phase !== 'complete' && humanSide !== 'b' && (
              <button onClick={() => handleJumpIn('b')}
                className="text-[9px] font-mono uppercase tracking-widest font-bold px-3 py-1.5 rounded-lg border border-accent-teal/30 text-accent-teal-light hover:bg-accent-teal/10 transition-all">
                ⚡ Take Over
              </button>
            )}
            {humanSide === 'b' && (
              <span className="text-[9px] font-mono text-yellow-400 uppercase tracking-wider">You (Side B)</span>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="relative z-10 mt-5 pt-4 border-t border-border-subtle">
          <div className="flex justify-between text-[9px] font-mono text-text-dim uppercase tracking-widest mb-1.5">
            <span>Round Progress</span>
            <span>{turns.length} / {totalTurns} completed</span>
          </div>
          <div className="h-1 bg-bg-elevated rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-accent-purple to-accent-teal rounded-full transition-all duration-700"
              style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      </div>

      {/* Fallacy alert toasts */}
      {fallacyAlerts.length > 0 && (
        <div className="space-y-2">
          {fallacyAlerts.map(a => (
            <FallacyToast key={a.id} fallacy={a.fallacy} side={a.side} onDismiss={() => dismissFallacy(a.id)} />
          ))}
        </div>
      )}

      {/* Winner panel */}
      {phase === 'complete' && winner && (
        <div className={`relative overflow-hidden rounded-3xl border p-8 text-center animate-slide-up shadow-[0_0_60px_rgba(0,0,0,0.4)] ${
          winner.side === 'a' ? 'border-accent-purple/40 bg-accent-purple/5' :
          winner.side === 'b' ? 'border-accent-teal/40 bg-accent-teal/5' :
          'border-yellow-500/30 bg-yellow-500/5'
        }`}>
          <div className="text-5xl mb-4">{winner.side === 'draw' ? '🤝' : '🏆'}</div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-2">Debate Concluded</div>
          <h2 className="text-2xl font-bold text-text-primary mb-1">
            {winner.side === 'draw' ? 'Draw — Evenly Matched' :
             winner.side === 'a' ? `${winner.nameA} Wins` : `${winner.nameB} Wins`}
          </h2>
          <div className="flex justify-center gap-8 mt-4">
            <div className="text-center">
              <div className="text-2xl font-black text-accent-purple-light font-mono">{winner.scoreA}</div>
              <div className="text-[9px] font-mono uppercase text-text-dim mt-0.5">{winner.nameA}</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-black text-accent-teal-light font-mono">{winner.scoreB}</div>
              <div className="text-[9px] font-mono uppercase text-text-dim mt-0.5">{winner.nameB}</div>
            </div>
          </div>
          <div className="flex justify-center gap-3 mt-6">
            <button onClick={() => navigate('debates')} className="btn-secondary px-6">Back to Arena</button>
            <button onClick={() => navigate('debate-view', { debateId })} className="btn-primary px-6">View Full Transcript</button>
          </div>
        </div>
      )}

      {/* Main discourse log + live stream */}
      <div className="bg-bg-surface border border-border-subtle rounded-3xl overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle bg-bg-elevated/50">
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-xs uppercase tracking-widest font-bold text-text-secondary">Live Discourse</h2>
            <span className="text-[10px] font-mono text-text-dim">{turns.length} exchanges</span>
          </div>
          {(phase === 'thinking' || phase === 'speaking') && (
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse-slow" />
              <span className="text-[10px] font-mono uppercase text-red-400 tracking-wider font-bold">Streaming</span>
            </div>
          )}
        </div>

        <div className="p-4 md:p-6 space-y-5 min-h-[400px] max-h-[600px] overflow-y-auto scroll-smooth">

          {/* Completed turns */}
          {turns.map((turn, i) => {
            const isA = turn.side === 'a';
            return (
              <div key={turn.msgId || i} className={`flex gap-3 w-full animate-slide-up ${isA ? 'justify-start' : 'justify-end'}`}
                style={{ animationDelay: `${Math.min(i * 30, 200)}ms` }}>
                {isA && (
                  <div className="w-10 h-10 rounded-xl bg-bg-elevated flex items-center justify-center text-xl border border-accent-purple/20 flex-shrink-0 mt-1">
                    {debate.persona_a_emoji}
                  </div>
                )}
                <div className={`max-w-[80%] flex flex-col ${isA ? 'items-start' : 'items-end'}`}>
                  <div className={`flex items-center gap-2 mb-1.5 flex-wrap ${isA ? 'flex-row' : 'flex-row-reverse'}`}>
                    <span className="text-xs font-bold text-text-primary">{turn.personaName}</span>
                    <span className="text-[9px] font-mono text-text-dim">Turn {turn.turnNum}</span>
                    {turn.isHumanTurn && (
                      <span className="text-[9px] font-mono text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-1.5 py-0.5 rounded-md uppercase tracking-wider">⚡ Human</span>
                    )}
                    {!turn.isHumanTurn && (
                      <span className="text-[9px] font-mono text-accent-teal-light bg-accent-teal/10 border border-accent-teal/20 px-1.5 py-0.5 rounded-md uppercase tracking-wider">◈ AI</span>
                    )}
                  </div>

                  <div className={`px-4 py-3 text-[14px] leading-relaxed rounded-2xl ${isA
                    ? 'bg-accent-purple/10 border border-accent-purple/20 text-text-primary rounded-tl-sm'
                    : 'bg-accent-teal/10 border border-accent-teal/20 text-text-primary rounded-tr-sm text-right'
                  }`}>
                    {turn.content}
                  </div>

                  {/* Score mini-bar */}
                  {turn.score && (
                    <div className={`mt-2 w-52 bg-bg-elevated border border-border-subtle rounded-xl p-3 space-y-1.5 ${isA ? '' : 'ml-auto'}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] font-mono uppercase text-text-dim">Argument Analysis</span>
                        <span className={`text-[9px] font-mono font-bold ${turn.score.overall > 0.65 ? 'text-emerald-400' : turn.score.overall > 0.4 ? 'text-yellow-400' : 'text-red-400'}`}>
                          {Math.round(turn.score.overall * 100)} overall
                        </span>
                      </div>
                      <ScoreBar label="Logic" value={turn.score.logic_score} color="purple" />
                      <ScoreBar label="Persuasion" value={turn.score.persuasiveness} color="teal" />
                      <ScoreBar label="Clarity" value={turn.score.clarity} color="yellow" />
                    </div>
                  )}

                  {/* Fallacy badges */}
                  {turn.fallacies?.length > 0 && (
                    <div className={`mt-1.5 px-3 py-2 bg-red-500/8 border border-red-500/20 rounded-xl max-w-xs ${isA ? '' : 'ml-auto text-right'}`}>
                      <p className="text-[10px] font-mono text-red-400 uppercase tracking-wider font-bold mb-1">⚠ {turn.fallacies.length} fallacy detected</p>
                      {turn.fallacies.slice(0, 1).map((f, fi) => (
                        <p key={fi} className="text-[10px] text-text-secondary">
                          <span className="text-red-400 font-bold">{f.type}:</span> {f.explanation}
                        </p>
                      ))}
                    </div>
                  )}
                </div>

                {!isA && (
                  <div className="w-10 h-10 rounded-xl bg-bg-elevated flex items-center justify-center text-xl border border-accent-teal/20 flex-shrink-0 mt-1">
                    {debate.persona_b_emoji}
                  </div>
                )}
              </div>
            );
          })}

          {/* Live streaming turn */}
          {(phase === 'thinking' || phase === 'speaking') && activeSide && (
            <div className={`flex gap-3 w-full animate-fade-in ${activeSide === 'a' ? 'justify-start' : 'justify-end'}`}>
              {activeSide === 'a' && (
                <div className="w-10 h-10 rounded-xl bg-bg-elevated border border-accent-purple/40 flex items-center justify-center text-xl flex-shrink-0 mt-1 shadow-[0_0_12px_rgba(139,92,246,0.2)]">
                  {debate.persona_a_emoji}
                </div>
              )}
              <div className={`max-w-[80%] flex flex-col ${activeSide === 'a' ? 'items-start' : 'items-end'}`}>
                <div className={`flex items-center gap-2 mb-1.5 ${activeSide === 'b' ? 'flex-row-reverse' : ''}`}>
                  <span className="text-xs font-bold text-text-primary">
                    {activeSide === 'a' ? debate.persona_a_name : debate.persona_b_name}
                  </span>
                  <span className="text-[9px] font-mono text-text-dim">Turn {turnNum}</span>
                  <span className="text-[9px] font-mono text-accent-purple-light bg-accent-purple/10 border border-accent-purple/20 px-1.5 py-0.5 rounded-md uppercase tracking-wider">
                    {phase === 'thinking' ? '◌ thinking' : '◈ speaking'}
                  </span>
                </div>

                <div className={`px-4 py-3 text-[14px] leading-relaxed rounded-2xl min-h-[52px] min-w-[80px] ${activeSide === 'a'
                  ? 'bg-accent-purple/15 border border-accent-purple/30 text-text-primary rounded-tl-sm'
                  : 'bg-accent-teal/15 border border-accent-teal/30 text-text-primary rounded-tr-sm text-right'
                }`}>
                  {phase === 'thinking' ? (
                    <ThinkingDots name={activePersonaName} />
                  ) : (
                    <span>
                      {streamingText}
                      <span className="inline-block w-0.5 h-4 bg-current ml-0.5 animate-[pulse_0.8s_ease-in-out_infinite] align-middle opacity-80" />
                    </span>
                  )}
                </div>
              </div>
              {activeSide === 'b' && (
                <div className="w-10 h-10 rounded-xl bg-bg-elevated border border-accent-teal/40 flex items-center justify-center text-xl flex-shrink-0 mt-1 shadow-[0_0_12px_rgba(20,184,166,0.2)]">
                  {debate.persona_b_emoji}
                </div>
              )}
            </div>
          )}

          {/* Human turn input */}
          {phase === 'human_turn' && humanTurnActive && (
            <div className={`flex gap-3 w-full animate-slide-up ${activeSide === 'a' ? 'justify-start' : 'justify-end'}`}>
              {activeSide === 'a' && (
                <div className="w-10 h-10 rounded-xl bg-bg-elevated border border-yellow-500/40 flex items-center justify-center text-xl flex-shrink-0 mt-1">
                  {debate.persona_a_emoji}
                </div>
              )}
              <div className={`max-w-[80%] flex-1 flex flex-col ${activeSide === 'a' ? 'items-start' : 'items-end'}`}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[9px] font-mono text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 px-2 py-1 rounded-lg uppercase tracking-wider font-bold">
                    ⚡ Your Turn — Turn {turnNum}
                  </span>
                </div>
                <div className="w-full bg-bg-elevated border border-yellow-500/20 rounded-2xl p-3 space-y-2">
                  <textarea
                    autoFocus
                    value={humanMessage}
                    onChange={e => setHumanMessage(e.target.value)}
                    placeholder="Type your argument here…"
                    rows={4}
                    className="w-full bg-bg-surface border border-border-mid rounded-xl px-3 py-2 text-text-primary text-[14px] leading-relaxed focus:outline-none focus:border-yellow-500/40 resize-none"
                    onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleHumanSend(); }}
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] font-mono text-text-dim">Ctrl+Enter to send</span>
                    <button onClick={handleHumanSend} disabled={!humanMessage.trim() || sendingHuman}
                      className="btn-primary py-1.5 px-5 text-sm disabled:opacity-50">
                      Send Argument
                    </button>
                  </div>
                </div>
              </div>
              {activeSide === 'b' && (
                <div className="w-10 h-10 rounded-xl bg-bg-elevated border border-yellow-500/40 flex items-center justify-center text-xl flex-shrink-0 mt-1">
                  {debate.persona_b_emoji}
                </div>
              )}
            </div>
          )}

          {/* Waiting state */}
          {phase === 'connecting' && turns.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
              <div className="w-12 h-12 border-2 border-accent-purple/40 border-t-accent-purple rounded-full animate-spin mb-4" />
              <p className="font-mono text-sm text-text-dim uppercase tracking-widest">Initializing AI Arena…</p>
            </div>
          )}

          {phase === 'waiting' && turns.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
              <div className="w-10 h-10 rounded-full border border-accent-purple/30 flex items-center justify-center mb-4">
                <span className="text-accent-purple-light text-lg">◈</span>
              </div>
              <p className="font-mono text-sm text-text-dim uppercase tracking-widest">Arena is live — first argument loading…</p>
            </div>
          )}

          <div ref={messagesEndRef} className="h-1" />
        </div>
      </div>

      {/* Intelligence overlay legend */}
      {turns.length > 0 && (
        <div className="bg-bg-surface border border-border-subtle rounded-2xl px-5 py-4">
          <div className="flex flex-wrap gap-5 items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono uppercase tracking-widest text-text-dim font-bold">Intelligence Overlay</span>
            </div>
            <div className="flex flex-wrap gap-4 text-[9px] font-mono uppercase tracking-wider text-text-dim">
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-accent-purple inline-block" /> Logic (L)</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-accent-teal inline-block" /> Persuasion (P)</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /> Clarity (C)</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> ⚠ Fallacy alert</span>
            </div>
            <div className="text-[9px] font-mono text-text-dim">
              {turns.filter(t => t.fallacies?.length > 0).length} fallacies detected across {turns.length} arguments
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
