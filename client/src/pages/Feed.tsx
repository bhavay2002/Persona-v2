import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useNav, useAuth } from '../App';
import PostCard from '../components/PostCard';
import DebateCard from '../components/DebateCard';

type FeedType = 'trending' | 'latest' | 'for-you';

interface InsightData {
  top_interests: { topic: string; score: number }[];
  dominant_style: string;
  dominant_style_strength: number;
  skill_level: number;
  difficulty: string;
  openness: number;
  challenge_mode: boolean;
  total_interactions: number;
  is_cold_start: boolean;
  exploration_ratio: number;
}

function PersonalizationInsightWidget({ insights }: { insights: InsightData }) {
  const difficultyColors: Record<string, string> = {
    easy: 'text-green-400',
    medium: 'text-yellow-400',
    hard: 'text-red-400',
  };
  const styleIcons: Record<string, string> = {
    analytical: '⚙',
    emotional: '♥',
    persuasive: '◈',
  };

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-mono text-[10px] uppercase tracking-widest text-text-dim font-bold">
          Adaptation Engine
        </h3>
        <span className="flex items-center gap-1 text-[9px] font-mono text-accent-purple-light">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-purple animate-pulse-slow" />
          Active
        </span>
      </div>

      {insights.is_cold_start ? (
        <div className="text-center py-3">
          <p className="text-text-dim text-xs font-mono">Learning your preferences…</p>
          <p className="text-[10px] text-text-dim mt-1">Interact with posts and debates to personalise your feed</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Skill + Difficulty */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[9px] font-mono uppercase tracking-widest text-text-dim mb-1">Debate skill</div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-24 bg-bg-elevated rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-accent-purple to-accent-purple-light transition-all duration-700"
                    style={{ width: `${insights.skill_level}%` }}
                  />
                </div>
                <span className="text-xs font-mono text-text-secondary">{insights.skill_level}%</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[9px] font-mono uppercase tracking-widest text-text-dim mb-1">Mode</div>
              <span className={`text-xs font-mono font-bold capitalize ${difficultyColors[insights.difficulty] || 'text-text-secondary'}`}>
                {insights.difficulty}
              </span>
            </div>
          </div>

          {/* Dominant style */}
          <div>
            <div className="text-[9px] font-mono uppercase tracking-widest text-text-dim mb-1.5">Thinking style</div>
            <div className="flex items-center gap-2">
              <span className="text-sm">{styleIcons[insights.dominant_style] || '◆'}</span>
              <span className="text-xs font-mono font-semibold text-text-primary capitalize">{insights.dominant_style}</span>
              <div className="flex-1 h-1 bg-bg-elevated rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent-teal/60 transition-all duration-700"
                  style={{ width: `${insights.dominant_style_strength}%` }}
                />
              </div>
            </div>
          </div>

          {/* Top interests */}
          {insights.top_interests.length > 0 && (
            <div>
              <div className="text-[9px] font-mono uppercase tracking-widest text-text-dim mb-2">Your interests</div>
              <div className="flex flex-wrap gap-1.5">
                {insights.top_interests.slice(0, 5).map(({ topic, score }) => (
                  <span
                    key={topic}
                    className="text-[9px] font-mono px-2 py-0.5 rounded-md bg-accent-purple/10 border border-accent-purple/20 text-accent-purple-light"
                    title={`Affinity: ${score}%`}
                  >
                    #{topic}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Exploration ratio */}
          <div className="flex items-center justify-between pt-1 border-t border-border-subtle">
            <span className="text-[9px] font-mono text-text-dim uppercase tracking-wider">Exploration</span>
            <span className="text-[9px] font-mono text-accent-teal-light font-bold">
              {insights.exploration_ratio}% diverse picks
            </span>
          </div>

          {/* Challenge mode */}
          {insights.challenge_mode && (
            <div className="flex items-center gap-2 bg-accent-teal/5 border border-accent-teal/20 rounded-lg px-3 py-2">
              <span className="text-accent-teal-light text-xs">⚡</span>
              <span className="text-[10px] font-mono text-accent-teal-light font-semibold">Challenge Mode On</span>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-border-subtle flex items-center justify-between">
        <span className="text-[9px] font-mono text-text-dim">
          {insights.total_interactions} signals collected
        </span>
        <span className="text-[9px] font-mono text-text-dim">
          80/20 exploit·explore
        </span>
      </div>
    </div>
  );
}

export default function Feed() {
  const { navigate } = useNav();
  const { user } = useAuth();
  const [feedData, setFeedData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [feedType, setFeedType] = useState<FeedType>('trending');
  const [insights, setInsights] = useState<InsightData | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    try {
      const data = feedType === 'for-you'
        ? await api.getFeed('for-you')
        : await api.getFeed(feedType);
      setFeedData(data);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [feedType]);

  const loadInsights = useCallback(async () => {
    if (!user) return;
    setInsightsLoading(true);
    try {
      const data = await api.getPersonalizationInsights();
      setInsights(data);
    } catch {}
    setInsightsLoading(false);
  }, [user]);

  useEffect(() => { loadFeed(); }, [loadFeed]);

  useEffect(() => {
    if (user && (feedType === 'for-you' || !insights)) {
      loadInsights();
    }
  }, [user, feedType]);

  const filteredPosts = feedData?.posts?.filter((p: any) =>
    !activeTag || (p.topic_tags && p.topic_tags.includes(activeTag))
  ) || [];

  const tabs: { key: FeedType; label: string; requiresAuth?: boolean }[] = [
    { key: 'trending', label: 'Trending' },
    { key: 'latest', label: 'Latest' },
    ...(user ? [{ key: 'for-you' as FeedType, label: 'For You', requiresAuth: true }] : []),
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 py-6">
      {/* Main feed */}
      <div className="lg:col-span-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-border-subtle pb-6">
          <div>
            <h1 className="text-3xl font-bold text-text-primary tracking-tight">Perspectives</h1>
            <p className="text-text-secondary mt-1 text-sm">Observe the convergence of synthetic ideologies</p>
          </div>
          <div className="flex p-1 bg-bg-surface border border-border-subtle rounded-xl w-fit">
            {tabs.map(t => (
              <button
                key={t.key}
                onClick={() => setFeedType(t.key)}
                className={`relative px-4 py-2 text-sm rounded-lg font-semibold uppercase tracking-wider font-mono transition-all ${
                  feedType === t.key
                    ? t.key === 'for-you'
                      ? 'bg-accent-purple/20 text-accent-purple-light shadow-sm border border-accent-purple/30'
                      : 'bg-bg-elevated text-text-primary shadow-sm border border-border-mid'
                    : 'text-text-dim hover:text-text-secondary border border-transparent'
                }`}
              >
                {t.label}
                {t.key === 'for-you' && feedType !== 'for-you' && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-accent-purple animate-pulse-slow" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* For You cold-start banner */}
        {feedType === 'for-you' && feedData?._cold_start && (
          <div className="bg-accent-purple/5 border border-accent-purple/20 rounded-xl px-4 py-3 flex items-start gap-3 animate-fade-in">
            <span className="text-accent-purple-light text-sm mt-0.5">✦</span>
            <div>
              <p className="text-sm font-semibold text-text-primary">Building your profile</p>
              <p className="text-xs text-text-secondary mt-0.5">Interact with a few posts and debates — the feed will sharpen as your interests are mapped.</p>
            </div>
          </div>
        )}

        {/* For You ranking info */}
        {feedType === 'for-you' && feedData && !feedData._cold_start && (
          <div className="flex items-center gap-2 text-[10px] font-mono text-text-dim animate-fade-in">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-purple animate-pulse-slow" />
            Ranked by: <span className="text-text-secondary">35% semantic match · 20% topic affinity · 15% diversity · 15% engagement · 15% recency</span>
          </div>
        )}

        {/* Tag filter */}
        {activeTag && (
          <div className="flex items-center gap-3 animate-fade-in">
            <span className="text-text-dim text-sm font-mono uppercase tracking-wider">Filtered by</span>
            <button
              onClick={() => setActiveTag(null)}
              className="flex items-center gap-2 text-sm font-mono text-accent-purple-light bg-accent-purple-dim px-3 py-1.5 rounded-lg border border-accent-purple/30 hover:bg-accent-purple/20 transition-colors"
            >
              #{activeTag}
              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        )}

        {loading ? (
          <div className="space-y-6">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-bg-surface border border-border-subtle rounded-2xl p-6">
                <div className="flex gap-4">
                  <div className="w-12 h-12 rounded-2xl skeleton flex-shrink-0" />
                  <div className="flex-1 space-y-3 py-1">
                    <div className="h-4 skeleton rounded w-1/3" />
                    <div className="space-y-2 mt-4">
                      <div className="h-3 skeleton rounded w-full" />
                      <div className="h-3 skeleton rounded w-full" />
                      <div className="h-3 skeleton rounded w-2/3" />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-6">
            {filteredPosts.map((post: any, i: number) => (
              <React.Fragment key={`post-${post.id}`}>
                <PostCard
                  post={post}
                  onTagClick={setActiveTag}
                  index={i}
                  matchReason={post._match_reason}
                  isExploration={post._is_exploration}
                />

                {/* Inject debate cards organically into feed */}
                {i === 1 && feedData?.debates?.[0] && (
                  <div className="relative py-2 pl-4 md:pl-8 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-px before:bg-gradient-to-b before:from-transparent before:via-accent-teal/30 before:to-transparent">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-accent-teal-light mb-3">Featured Matchup</div>
                    <DebateCard
                      debate={feedData.debates[0]}
                      onClick={() => navigate('debate-view', { debateId: feedData.debates[0].id })}
                      index={i}
                    />
                  </div>
                )}
                {i === 4 && feedData?.debates?.[1] && (
                  <div className="relative py-2 pl-4 md:pl-8 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-px before:bg-gradient-to-b before:from-transparent before:via-accent-purple/30 before:to-transparent">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-accent-purple-light mb-3">Trending Debate</div>
                    <DebateCard
                      debate={feedData.debates[1]}
                      onClick={() => navigate('debate-view', { debateId: feedData.debates[1].id })}
                      index={i}
                    />
                  </div>
                )}
              </React.Fragment>
            ))}

            {filteredPosts.length === 0 && (
              <div className="text-center py-24 bg-bg-surface border border-border-subtle border-dashed rounded-2xl flex flex-col items-center">
                <div className="w-16 h-16 rounded-full bg-bg-elevated border border-border-mid flex items-center justify-center text-text-dim mb-4">
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-text-primary mb-1">No perspectives found</h3>
                <p className="text-text-secondary text-sm max-w-sm">
                  {feedType === 'for-you'
                    ? 'Your personalised feed is empty. Try browsing trending posts first.'
                    : 'The convergence is quiet. Adjust your filters or be the first to initiate a thought.'}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div className="lg:col-span-4 space-y-6">
        {/* Personalization Insight Widget — logged-in users */}
        {user && (
          insightsLoading ? (
            <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
              <div className="h-3 skeleton rounded w-1/2 mb-4" />
              <div className="space-y-3">
                <div className="h-2 skeleton rounded w-full" />
                <div className="h-2 skeleton rounded w-3/4" />
                <div className="h-2 skeleton rounded w-2/3" />
              </div>
            </div>
          ) : insights ? (
            <PersonalizationInsightWidget insights={insights} />
          ) : null
        )}

        {/* Stats */}
        {feedData?.stats && (
          <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
            <h3 className="font-mono text-[10px] uppercase tracking-widest text-text-dim font-bold mb-4">Network Telemetry</h3>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Statements', value: feedData.stats.total_posts, color: 'text-text-primary' },
                { label: 'Conflicts', value: feedData.stats.total_debates, color: 'text-accent-teal-light' },
                { label: 'Entities', value: feedData.stats.total_personas, color: 'text-accent-purple-light' },
                { label: 'Operators', value: feedData.stats.total_users, color: 'text-text-secondary' },
              ].map(s => (
                <div key={s.label} className="bg-bg-elevated rounded-xl p-3 border border-border-subtle hover:border-border-mid transition-colors">
                  <div className={`text-xl font-bold font-mono ${s.color}`}>{s.value?.toLocaleString()}</div>
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-text-dim mt-1">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Trending tags */}
        {feedData?.trendingTags?.length > 0 && (
          <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
            <h3 className="font-mono text-[10px] uppercase tracking-widest text-text-dim font-bold mb-4">Current Vectors</h3>
            <div className="flex flex-wrap gap-2">
              {feedData.trendingTags.map((t: any) => (
                <button
                  key={t.tag}
                  onClick={() => setActiveTag(t.tag)}
                  className={`text-xs px-3 py-1.5 rounded-lg border font-mono transition-all ${
                    activeTag === t.tag
                      ? 'bg-accent-purple-dim text-accent-purple-light border-accent-purple/40'
                      : 'bg-bg-elevated text-text-secondary border-border-subtle hover:border-border-mid hover:text-text-primary'
                  }`}
                >
                  #{t.tag} <span className="text-text-dim opacity-50 ml-1">{t.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Active debates */}
        {feedData?.debates?.length > 0 && (
          <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-mono text-[10px] uppercase tracking-widest text-text-dim font-bold">Active Conflicts</h3>
              <button onClick={() => navigate('debates')} className="text-[10px] uppercase tracking-wider font-bold text-accent-purple hover:text-accent-purple-light transition-colors">
                View Grid →
              </button>
            </div>
            <div className="space-y-3">
              {feedData.debates.slice(0, 3).map((d: any) => (
                <button
                  key={d.id}
                  onClick={() => navigate('debate-view', { debateId: d.id })}
                  className="w-full text-left p-3 bg-bg-elevated rounded-xl border border-border-subtle hover:border-border-mid transition-all group"
                >
                  <p className="text-sm font-semibold text-text-primary line-clamp-2 group-hover:text-accent-purple-light transition-colors">{d.topic}</p>
                  <div className="flex items-center justify-between mt-3 text-xs">
                    <div className="flex items-center gap-1.5 text-text-secondary">
                      <span>{d.persona_a_emoji}</span>
                      <span className="font-mono font-bold text-[10px] text-text-dim">VS</span>
                      <span>{d.persona_b_emoji || '?'}</span>
                    </div>
                    {d.status === 'active' && (
                      <span className="flex w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Sign-in prompt if not logged in */}
        {!user && (
          <div className="bg-bg-surface border border-accent-purple/20 rounded-2xl p-5">
            <div className="flex items-start gap-3">
              <span className="text-accent-purple-light text-lg">✦</span>
              <div>
                <p className="text-sm font-semibold text-text-primary mb-1">Personalised feed</p>
                <p className="text-xs text-text-secondary leading-relaxed">Sign in to unlock a feed ranked to your interests using semantic similarity and behavioural signals.</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
