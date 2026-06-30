import React, { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../App';
import { timeAgo } from '../lib/utils';

interface Post {
  id: number;
  persona_id: number;
  persona_name: string;
  avatar_emoji: string;
  tone?: string;
  ideology?: string;
  archetype?: string;
  tone_formality?: number;
  tone_emotionality?: number;
  tone_assertiveness?: number;
  rhetorical_style?: string[];
  content: string;
  topic_tags?: string[];
  ai_generated: boolean;
  ai_explanation?: string;
  intent_type?: string;
  like_count: number;
  created_at: string;
  moderation?: { action: string; toxicity?: number; categories?: string[] };
  trust_score?: number;
}

const INTENT_COLORS: Record<string, string> = {
  argumentative: 'text-red-400 bg-red-500/10 border-red-500/20',
  emotional: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
  informational: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  question: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
  narrative: 'text-accent-teal-light bg-accent-teal/10 border-accent-teal/20',
};

function ToneBar({ val, color }: { val: number; color: string }) {
  return (
    <div className="h-1 w-8 bg-bg-elevated rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${val * 100}%` }} />
    </div>
  );
}

export default function PostCard({
  post,
  onTagClick,
  index = 0,
  matchReason,
  isExploration,
}: {
  post: Post;
  onTagClick?: (tag: string) => void;
  index?: number;
  matchReason?: string | null;
  isExploration?: boolean;
}) {
  const { user } = useAuth();
  const [likes, setLikes] = useState(post.like_count || 0);
  const [liked, setLiked] = useState(false);
  const [liking, setLiking] = useState(false);
  const [likeAnim, setLikeAnim] = useState(false);
  const [showExplain, setShowExplain] = useState(false);

  const handleLike = async () => {
    if (!user || liking) return;
    setLiking(true);
    setLikeAnim(true);
    setTimeout(() => setLikeAnim(false), 400);
    try {
      const res = await api.likePost(post.id);
      setLiked(res.liked);
      setLikes(prev => res.liked ? prev + 1 : prev - 1);
    } catch {}
    setLiking(false);
  };

  const hasTone = post.tone_formality !== undefined && post.tone_formality !== null;

  return (
    <article
      className="group bg-bg-surface border border-border-subtle rounded-2xl p-5 md:p-6 card-hover animate-slide-up relative overflow-hidden"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      {/* Subtle left accent that brightens on hover */}
      <div className="absolute left-0 top-4 bottom-4 w-px bg-gradient-to-b from-transparent via-accent-purple/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

      <div className="flex gap-4">
        {/* Avatar */}
        <div className="w-12 h-12 rounded-2xl bg-bg-elevated flex items-center justify-center text-2xl flex-shrink-0 border border-border-subtle shadow-inner group-hover:border-border-mid transition-colors">
          {post.avatar_emoji}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-text-primary group-hover:text-white transition-colors">{post.persona_name}</span>
                {post.archetype && (
                  <span className="hidden sm:inline px-2 py-0.5 rounded-md text-[9px] uppercase font-mono tracking-wider font-bold text-accent-purple-light bg-accent-purple/10 border border-accent-purple/20">
                    {post.archetype}
                  </span>
                )}
                {post.tone && !post.archetype && (
                  <span className="hidden sm:inline px-2 py-0.5 rounded-md text-[10px] uppercase font-mono tracking-wider font-semibold text-text-secondary bg-bg-elevated border border-border-subtle">
                    {post.tone}
                  </span>
                )}
                {post.ideology && (
                  <span className="hidden md:inline px-2 py-0.5 rounded-md text-[10px] uppercase font-mono tracking-wider font-semibold text-text-secondary bg-bg-elevated border border-border-subtle">
                    {post.ideology}
                  </span>
                )}
              </div>

              {/* Tone micro-bars */}
              {hasTone && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  <ToneBar val={post.tone_formality ?? 0.5} color="bg-accent-purple/50" />
                  <ToneBar val={post.tone_emotionality ?? 0.5} color="bg-accent-teal/50" />
                  <ToneBar val={post.tone_assertiveness ?? 0.5} color="bg-yellow-500/50" />
                  <span className="text-[9px] font-mono text-text-dim uppercase tracking-widest ml-0.5">F·E·A</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Match reason badge */}
              {matchReason && !isExploration && (
                <span className="hidden sm:inline text-[9px] font-mono text-accent-purple-light bg-accent-purple/10 border border-accent-purple/20 px-1.5 py-0.5 rounded whitespace-nowrap">
                  ✦ {matchReason}
                </span>
              )}
              {isExploration && (
                <span className="hidden sm:inline text-[9px] font-mono text-accent-teal-light bg-accent-teal/10 border border-accent-teal/20 px-1.5 py-0.5 rounded whitespace-nowrap">
                  ↗ Explore
                </span>
              )}
              <span className="text-xs text-text-dim font-mono">{timeAgo(post.created_at)}</span>
            </div>
          </div>

          {/* Moderation warning badge */}
          {post.moderation?.action === 'warn' && (
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-mono font-bold text-yellow-400 bg-yellow-500/10 px-2 py-0.5 rounded-md border border-yellow-500/25">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                Content Advisory
              </span>
            </div>
          )}

          {/* AI Badge + Intent */}
          {post.ai_generated && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-mono font-bold text-accent-teal-light bg-accent-teal/10 px-2 py-0.5 rounded-md border border-accent-teal/20">
                <span className="w-1 h-1 rounded-full bg-accent-teal-light animate-pulse-slow"></span>
                AI Enhanced
              </span>
              {post.intent_type && (
                <span className={`inline-flex items-center text-[10px] uppercase tracking-wider font-mono font-bold px-2 py-0.5 rounded-md border ${INTENT_COLORS[post.intent_type] || 'text-text-dim border-border-subtle bg-bg-elevated'}`}>
                  {post.intent_type}
                </span>
              )}
            </div>
          )}

          {/* Post Content */}
          <p className="text-text-primary text-[15px] leading-relaxed whitespace-pre-wrap">{post.content}</p>

          {/* Tags */}
          {post.topic_tags && post.topic_tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-4">
              {post.topic_tags.map(tag => (
                <button key={tag} onClick={() => onTagClick?.(tag)}
                  className="text-xs font-mono text-accent-purple-light bg-accent-purple-dim hover:bg-accent-purple/20 px-2.5 py-1 rounded-lg transition-colors border border-accent-purple/20 hover:border-accent-purple/40">
                  #{tag}
                </button>
              ))}
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center gap-5 mt-4 pt-4 border-t border-border-subtle">
            {/* Like button with micro-animation */}
            <button
              onClick={handleLike}
              disabled={!user}
              title={!user ? 'Sign in to like' : liked ? 'Unlike' : 'Like'}
              className={`flex items-center gap-1.5 text-sm font-medium transition-all group/like ${
                liked ? 'text-accent-purple-light' : 'text-text-dim hover:text-text-primary'
              } ${!user ? 'cursor-default opacity-50' : 'cursor-pointer'}`}
            >
              <svg
                className={`w-4 h-4 transition-all duration-200 ${
                  liked ? 'fill-current' : 'stroke-current fill-transparent group-hover/like:stroke-accent-purple-light'
                } ${likeAnim ? 'scale-125' : 'scale-100'}`}
                viewBox="0 0 24 24"
              >
                <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
              <span className={`text-xs font-mono transition-all ${likeAnim ? 'text-accent-purple-light' : ''}`}>
                {likes}
              </span>
            </button>

            {/* Explainability toggle */}
            {post.ai_generated && post.ai_explanation && (
              <button onClick={() => setShowExplain(v => !v)}
                className="flex items-center gap-1.5 text-xs font-mono text-text-dim hover:text-accent-purple-light transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                {showExplain ? 'Hide analysis' : 'Why this?'}
              </button>
            )}
          </div>

          {/* Explainability Panel */}
          {showExplain && post.ai_explanation && (
            <div className="mt-3 bg-bg-elevated border border-accent-purple/20 rounded-xl p-3.5 animate-slide-up">
              <div className="flex items-start gap-2.5">
                <span className="text-accent-purple-light mt-0.5 flex-shrink-0">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </span>
                <p className="text-[11px] text-text-secondary leading-relaxed font-mono italic">"{post.ai_explanation}"</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
