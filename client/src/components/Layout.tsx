import React from 'react';
import { useAuth, useNav } from '../App';

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { page, navigate, notifCount } = useNav();
  const isAdmin = user?.role === 'admin';

  const navItems = [
    { id: 'feed', label: 'Feed' },
    { id: 'debates', label: 'Debates' },
    { id: 'marketplace', label: 'Market' },
    { id: 'personas', label: 'Personas' },
    { id: 'create-post', label: 'Post' },
    { id: 'insights', label: 'Insights' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'research', label: 'CDS' },
    { id: 'knowledge', label: 'Graph' },
    ...(isAdmin ? [
      { id: 'health', label: 'Health' },
      { id: 'calibration', label: 'Calib' },
      { id: 'evaluation', label: 'Eval' },
    ] : []),
  ] as const;

  return (
    <div className="min-h-[100dvh] bg-bg-base text-text-primary selection:bg-accent-purple/30">
      {/* Top Nav */}
      <header className="fixed top-0 left-0 right-0 z-50 glass-panel border-b border-border-subtle">
        <div className="max-w-7xl mx-auto px-4 md:px-8 h-16 flex items-center justify-between">
          <button
            onClick={() => navigate('feed')}
            className="flex items-center gap-3 group"
          >
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-purple to-accent-teal p-[1px]">
              <div className="w-full h-full bg-bg-surface rounded-[7px] flex items-center justify-center">
                <span className="w-2 h-2 rounded-full bg-accent-teal shadow-[0_0_10px_rgba(20,184,166,0.8)]"></span>
              </div>
            </div>
            <span className="font-semibold text-lg tracking-tight group-hover:text-white transition-colors">Persona</span>
          </button>

          <nav className="hidden md:flex items-center gap-1 bg-bg-surface/50 p-1 rounded-xl border border-border-subtle">
            {navItems.map(item => (
              <button
                key={item.id}
                onClick={() => navigate(item.id as any)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                  page === item.id || (item.id === 'debates' && page === 'debate-view')
                    ? 'bg-accent-purple/10 text-accent-purple-light shadow-[0_0_15px_rgba(139,92,246,0.1)]'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            {user ? (
              <div className="flex items-center gap-3">
                <div className="hidden lg:flex flex-col items-end">
                  <span className="text-sm font-medium text-text-primary">{user.email.split('@')[0]}</span>
                  <span className="text-[10px] text-accent-teal-light uppercase tracking-wider font-mono">Trust Score: {user.trustScore}</span>
                </div>

                {/* Notification Bell */}
                <button
                  onClick={() => navigate('notifications')}
                  className={`relative p-2 rounded-xl border transition-all ${
                    page === 'notifications'
                      ? 'bg-accent-purple/10 border-accent-purple/40 text-accent-purple-light'
                      : 'bg-bg-surface border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-mid'
                  }`}
                  title="Notifications"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  {notifCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-accent-purple text-[9px] font-bold text-white flex items-center justify-center shadow-[0_0_8px_rgba(139,92,246,0.6)]">
                      {notifCount > 9 ? '9+' : notifCount}
                    </span>
                  )}
                </button>

                <button
                  onClick={logout}
                  className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-white bg-bg-surface border border-border-subtle hover:border-border-mid rounded-xl transition-all"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => navigate('login')}
                  className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-white transition-colors"
                >
                  Sign in
                </button>
                <button
                  onClick={() => navigate('register')}
                  className="px-4 py-2 text-sm font-medium bg-accent-purple hover:bg-accent-purple-light hover:shadow-[0_0_20px_rgba(139,92,246,0.3)] text-white rounded-xl transition-all"
                >
                  Get started
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="pt-24 pb-24 md:pb-12 min-h-[100dvh] flex flex-col">
        <div className="max-w-7xl mx-auto px-4 md:px-8 w-full flex-1 flex flex-col">
          {children}
        </div>
      </main>

      {/* Mobile bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 md:hidden glass-panel border-t border-border-subtle z-50 pb-safe">
        <div className="flex justify-around p-2">
          {navItems.map(item => {
            const isActive = page === item.id || (item.id === 'debates' && page === 'debate-view');
            return (
              <button
                key={item.id}
                onClick={() => navigate(item.id as any)}
                className={`p-3 rounded-xl flex flex-col items-center gap-1 text-xs font-medium transition-all ${
                  isActive
                    ? 'text-accent-purple-light bg-accent-purple/10'
                    : 'text-text-dim hover:text-text-primary'
                }`}
              >
                <div className={`w-1.5 h-1.5 rounded-full transition-transform ${isActive ? 'bg-accent-purple-light scale-100' : 'bg-transparent scale-0'}`}></div>
                <span>{item.label}</span>
              </button>
            );
          })}
          {/* Mobile notification button */}
          <button
            onClick={() => navigate('notifications')}
            className={`relative p-3 rounded-xl flex flex-col items-center gap-1 text-xs font-medium transition-all ${
              page === 'notifications' ? 'text-accent-purple-light bg-accent-purple/10' : 'text-text-dim hover:text-text-primary'
            }`}
          >
            <div className={`w-1.5 h-1.5 rounded-full transition-transform ${page === 'notifications' ? 'bg-accent-purple-light scale-100' : 'bg-transparent scale-0'}`}></div>
            <span className="relative">
              Alerts
              {notifCount > 0 && (
                <span className="absolute -top-2 -right-3 w-3.5 h-3.5 rounded-full bg-accent-purple text-[8px] font-bold text-white flex items-center justify-center">
                  {notifCount > 9 ? '9+' : notifCount}
                </span>
              )}
            </span>
          </button>
        </div>
      </nav>
    </div>
  );
}
