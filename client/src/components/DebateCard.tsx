import React from 'react';
import { timeAgo } from '../lib/utils';

interface Debate {
  id: number;
  topic: string;
  description?: string;
  status: string;
  votes_a: number;
  votes_b: number;
  persona_a_name: string;
  persona_a_emoji: string;
  persona_a_archetype?: string;
  persona_b_name?: string;
  persona_b_emoji?: string;
  persona_b_archetype?: string;
  message_count?: number;
  created_at: string;
  quality_score?: number;
  stance_a?: string;
  stance_b?: string;
}

export default function DebateCard({ debate, onClick, index = 0 }: { debate: Debate; onClick: () => void; index?: number }) {
  const total = (debate.votes_a || 0) + (debate.votes_b || 0);
  const pctA = total > 0 ? Math.round((debate.votes_a / total) * 100) : 50;
  const pctB = 100 - pctA;

  return (
    <div
      onClick={onClick}
      className="bg-bg-surface border border-border-subtle rounded-2xl p-5 card-hover cursor-pointer group relative overflow-hidden animate-slide-up"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="absolute -top-20 -right-20 w-40 h-40 bg-accent-purple/5 rounded-full blur-3xl group-hover:bg-accent-purple/8 transition-colors duration-500 pointer-events-none"></div>

      {/* Header row */}
      <div className="flex justify-between items-start mb-3 relative z-10">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] uppercase font-mono tracking-widest font-bold border ${
            debate.status === 'active' ? 'text-red-400 bg-red-500/10 border-red-500/20'
            : debate.status === 'open' ? 'text-accent-teal-light bg-accent-teal/10 border-accent-teal/20'
            : 'text-text-dim bg-bg-elevated border-border-subtle'
          }`}>
            {debate.status === 'active' && <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse-slow"></span>}
            {debate.status === 'active' ? 'Live' : debate.status === 'open' ? 'Open' : 'Ended'}
          </span>

          {(debate.quality_score || 0) > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-mono tracking-wider font-bold border text-yellow-400 bg-yellow-500/10 border-yellow-500/20"
              title="AI-computed debate quality score">
              ★ {debate.quality_score}
            </span>
          )}

          {debate.message_count !== undefined && (
            <span className="text-[10px] font-mono text-text-dim flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              {debate.message_count}
            </span>
          )}
        </div>
        <span className="text-[10px] text-text-dim font-mono flex-shrink-0">{timeAgo(debate.created_at)}</span>
      </div>

      {/* Topic */}
      <h3 className="text-base font-bold text-text-primary mb-4 group-hover:text-accent-purple-light transition-colors relative z-10 leading-snug line-clamp-2">
        {debate.topic}
      </h3>

      {/* Participants */}
      <div className="flex items-center justify-between gap-3 relative z-10">
        {/* Side A */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="w-9 h-9 rounded-xl bg-bg-elevated flex items-center justify-center text-lg flex-shrink-0 border border-accent-purple/20">
            {debate.persona_a_emoji}
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-text-primary truncate text-sm">{debate.persona_a_name}</div>
            {debate.persona_a_archetype && (
              <div className="text-[9px] font-mono text-accent-purple-light truncate uppercase">{debate.persona_a_archetype}</div>
            )}
            {debate.stance_a && (
              <div className="text-[9px] font-mono text-text-dim truncate italic mt-0.5">"{debate.stance_a}"</div>
            )}
          </div>
        </div>

        <div className="flex-shrink-0 text-[10px] font-black text-text-dim uppercase tracking-widest px-2">VS</div>

        {/* Side B */}
        <div className="flex items-center justify-end gap-2 min-w-0 flex-1">
          <div className="min-w-0 text-right">
            <div className={`font-semibold truncate text-sm ${!debate.persona_b_name ? 'text-accent-teal/50' : 'text-text-primary'}`}>
              {debate.persona_b_name || 'Waiting...'}
            </div>
            {debate.persona_b_archetype && (
              <div className="text-[9px] font-mono text-accent-teal-light truncate uppercase">{debate.persona_b_archetype}</div>
            )}
            {debate.stance_b && (
              <div className="text-[9px] font-mono text-text-dim truncate italic mt-0.5">"{debate.stance_b}"</div>
            )}
          </div>
          <div className={`w-9 h-9 rounded-xl bg-bg-elevated flex items-center justify-center text-lg flex-shrink-0 border ${
            !debate.persona_b_name ? 'border-accent-teal/30 border-dashed' : 'border-accent-teal/20'
          }`}>
            {debate.persona_b_emoji || '?'}
          </div>
        </div>
      </div>

      {/* Vote bar */}
      {total > 0 && (
        <div className="mt-4 relative z-10">
          <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden flex">
            <div className="h-full bg-accent-purple transition-all duration-1000 ease-out" style={{ width: `${pctA}%` }} />
            <div className="h-full bg-accent-teal transition-all duration-1000 ease-out" style={{ width: `${pctB}%` }} />
          </div>
          <div className="flex justify-between mt-1.5 font-mono text-[9px] font-bold uppercase tracking-wider">
            <span className="text-accent-purple-light">{pctA}%</span>
            <span className="text-text-dim">{total} votes</span>
            <span className="text-accent-teal-light">{pctB}%</span>
          </div>
        </div>
      )}
    </div>
  );
}
