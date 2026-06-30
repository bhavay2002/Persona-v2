import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/utils';
import { useNav } from '../App';

const TYPE_ICONS: Record<string, string> = {
  post_liked: '❤️',
  debate_message: '💬',
  debate_vote: '🗳️',
  milestone: '⚡',
  persona_evolved: '🧬',
};
const TYPE_ICON_DEFAULT = '🔔';

export default function Notifications({ onRead }: { onRead?: () => void }) {
  const { navigate } = useNav();
  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getNotifications().then(setNotifications).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const markRead = async (id: number) => {
    await api.markNotificationRead(id).catch(() => {});
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    onRead?.();
  };

  const markAllRead = async () => {
    await api.markAllNotificationsRead().catch(() => {});
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    onRead?.();
  };

  const hasUnread = notifications.some(n => !n.read);

  return (
    <div className="max-w-2xl mx-auto pt-4 pb-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary tracking-tight">Signal Feed</h1>
          <p className="text-xs font-mono text-text-dim uppercase tracking-widest mt-0.5">Incoming transmissions</p>
        </div>
        {hasUnread && (
          <button onClick={markAllRead}
            className="text-[10px] font-mono uppercase tracking-widest text-accent-teal-light hover:text-accent-teal transition-colors border border-accent-teal/30 hover:border-accent-teal/60 px-3 py-1.5 rounded-lg">
            Clear All
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-bg-surface border border-border-subtle rounded-2xl skeleton" />
          ))}
        </div>
      ) : notifications.length === 0 ? (
        <div className="text-center py-24">
          <div className="text-5xl mb-4 opacity-30">🔕</div>
          <p className="font-mono text-sm uppercase tracking-widest text-text-dim">No incoming signals</p>
          <button onClick={() => navigate('feed')} className="mt-6 btn-secondary px-6 text-xs">Back to Feed</button>
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map(n => (
            <div key={n.id} onClick={() => !n.read && markRead(n.id)}
              className={`group flex items-start gap-4 p-4 rounded-2xl border transition-all ${
                n.read
                  ? 'bg-bg-surface border-border-subtle opacity-60 cursor-default'
                  : 'bg-bg-surface border-accent-purple/20 hover:border-accent-purple/40 shadow-[0_0_12px_rgba(139,92,246,0.06)] cursor-pointer'
              }`}>
              <div className="text-2xl mt-0.5 flex-shrink-0">
                {TYPE_ICONS[n.type] || TYPE_ICON_DEFAULT}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-bold text-text-primary">{n.title}</span>
                  {!n.read && <span className="w-2 h-2 rounded-full bg-accent-purple flex-shrink-0 shadow-[0_0_6px_rgba(139,92,246,0.6)]" />}
                </div>
                <p className="text-xs text-text-secondary">{n.message}</p>
                <p className="text-[10px] font-mono text-text-dim mt-1 uppercase tracking-wider">{timeAgo(n.created_at)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
