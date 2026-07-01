import React, { useState, useEffect, createContext, useContext } from 'react';
import { isLoggedIn, getUser, saveToken, saveUser, clearToken } from './lib/auth';
import { api } from './lib/api';
import { connectSocket, disconnectSocket, getSocket } from './lib/socket';
import Layout from './components/Layout';
import Feed from './pages/Feed';
import Login from './pages/Login';
import Register from './pages/Register';
import PersonasDashboard from './pages/PersonasDashboard';
import CreatePost from './pages/CreatePost';
import DebateArena from './pages/DebateArena';
import DebateView from './pages/DebateView';
import Insights from './pages/Insights';
import Notifications from './pages/Notifications';
import Marketplace from './pages/Marketplace';
import Analytics from './pages/Analytics';
import Research from './pages/Research';
import KnowledgeGraph from './pages/KnowledgeGraph';
import SystemHealth from './pages/SystemHealth';
import Calibration from './pages/Calibration';
import EvaluationDashboard from './pages/EvaluationDashboard';
import LiveDebateArena from './pages/LiveDebateArena';

export interface User {
  id: number;
  email: string;
  role?: 'user' | 'admin';
  trustScore: number;
}

export interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  login: async () => {},
  register: async () => {},
  logout: () => {},
  loading: true,
});

export function useAuth() {
  return useContext(AuthContext);
}

type Page = 'feed' | 'personas' | 'create-post' | 'debates' | 'debate-view' | 'live-debate' | 'insights' | 'login' | 'register' | 'notifications' | 'marketplace' | 'analytics' | 'research' | 'knowledge' | 'health' | 'calibration' | 'evaluation';

export interface NavContextType {
  page: Page;
  pageParams: any;
  navigate: (page: Page, params?: any) => void;
  notifCount: number;
  refreshNotifCount: () => void;
}

export const NavContext = createContext<NavContextType>({
  page: 'feed',
  pageParams: {},
  navigate: () => {},
  notifCount: 0,
  refreshNotifCount: () => {},
});

export function useNav() {
  return useContext(NavContext);
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [page, setPage] = useState<Page>('feed');
  const [pageParams, setPageParams] = useState<any>({});
  const [notifCount, setNotifCount] = useState(0);

  useEffect(() => {
    if (isLoggedIn()) {
      const cached = getUser();
      if (cached) setUser(cached);
      api.me().then(u => {
        setUser(u);
        saveUser(u);
      }).catch(() => {
        clearToken();
        setUser(null);
      }).finally(() => setAuthLoading(false));
    } else {
      setAuthLoading(false);
    }
  }, []);

  // Connect socket + fetch notification count when user logs in
  useEffect(() => {
    if (!user) return;

    const s = connectSocket(user.id);

    // Real-time notification bump
    s.on('new-notification', () => setNotifCount(c => c + 1));

    // Fetch initial unread count
    api.getNotificationCount().then(d => setNotifCount(d.count)).catch(() => {});

    // Poll every 60s as fallback
    const interval = setInterval(() => {
      api.getNotificationCount().then(d => setNotifCount(d.count)).catch(() => {});
    }, 60_000);

    return () => {
      s.off('new-notification');
      clearInterval(interval);
      disconnectSocket();
    };
  }, [user?.id]);

  const refreshNotifCount = () => {
    if (user) api.getNotificationCount().then(d => setNotifCount(d.count)).catch(() => {});
  };

  const login = async (email: string, password: string) => {
    const data = await api.login(email, password);
    saveToken(data.token);
    saveUser(data.user);
    setUser(data.user);
    setPage('feed');
  };

  const register = async (email: string, password: string) => {
    const data = await api.register(email, password);
    saveToken(data.token);
    saveUser(data.user);
    setUser(data.user);
    setPage('feed');
  };

  const logout = () => {
    clearToken();
    setUser(null);
    setNotifCount(0);
    setPage('feed');
  };

  const isAdmin = user?.role === 'admin';

  const navigate = (p: Page, params?: any) => {
    setPage(p);
    setPageParams(params || {});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderPage = () => {
    switch (page) {
      case 'login': return <Login />;
      case 'register': return <Register />;
      case 'personas': return <PersonasDashboard />;
      case 'create-post': return <CreatePost />;
      case 'debates': return <DebateArena />;
      case 'debate-view': return <DebateView debateId={pageParams.debateId} />;
      case 'live-debate': return <LiveDebateArena debateId={pageParams.debateId} />;
      case 'insights': return <Insights />;
      case 'notifications': return <Notifications onRead={refreshNotifCount} />;
      case 'marketplace': return <Marketplace />;
      case 'analytics': return <Analytics />;
      case 'research': return <Research />;
      case 'knowledge': return <KnowledgeGraph />;
      case 'health': return isAdmin ? <SystemHealth /> : <Feed />;
      case 'calibration': return isAdmin ? <Calibration /> : <Feed />;
      case 'evaluation': return isAdmin ? <EvaluationDashboard /> : <Feed />;
      default: return <Feed />;
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-[100dvh] bg-bg-base flex items-center justify-center">
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-2 border-border-subtle border-t-accent-purple rounded-full animate-spin mx-auto mb-6"></div>
          <p className="text-text-secondary tracking-widest text-sm uppercase font-mono">Initializing</p>
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ user, login, register, logout, loading: authLoading }}>
      <NavContext.Provider value={{ page, pageParams, navigate, notifCount, refreshNotifCount }}>
        <Layout>
          <div className="animate-fade-in w-full">
            {renderPage()}
          </div>
        </Layout>
      </NavContext.Provider>
    </AuthContext.Provider>
  );
}
