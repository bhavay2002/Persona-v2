import React, { useState } from 'react';
import { useAuth, useNav } from '../App';

export default function Login() {
  const { login } = useAuth();
  const { navigate } = useNav();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    }
    setLoading(false);
  };

  const demoLogin = async () => {
    setEmail('demo@persona.app');
    setPassword('demo1234');
    setError('');
    setLoading(true);
    try {
      await login('demo@persona.app', 'demo1234');
    } catch (err: any) {
      setError(err.message || 'Demo authentication failed');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center py-12">
      <div className="w-full max-w-md animate-fade-in">
        <div className="text-center mb-10">
          <div className="w-20 h-20 mx-auto bg-gradient-to-br from-accent-purple/20 to-accent-teal/20 rounded-2xl flex items-center justify-center border border-border-subtle shadow-inner mb-6 relative">
            <div className="absolute inset-0 rounded-2xl bg-accent-purple/10 blur-xl"></div>
            <div className="relative text-4xl">🎭</div>
          </div>
          <h1 className="text-3xl font-bold text-text-primary tracking-tight mb-3">Initiate Session</h1>
          <p className="text-text-secondary text-sm">Access your synthesized identities</p>
        </div>

        <div className="bg-bg-surface border border-border-subtle rounded-2xl p-8 shadow-[0_0_40px_rgba(0,0,0,0.5)] relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-accent-purple to-accent-teal opacity-50"></div>
          
          <form onSubmit={handleSubmit} className="space-y-5 relative z-10">
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Operator ID (Email)</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="operator@network.com"
                required
                className="input-base font-mono text-sm"
              />
            </div>
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary">Security Key</label>
              </div>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="input-base font-mono tracking-widest"
              />
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex gap-3 items-center animate-slide-up">
                <span className="text-red-400">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </span>
                <p className="text-red-400 text-sm font-medium">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full btn-primary mt-2 flex items-center justify-center gap-2"
            >
              {loading ? (
                <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span> Authenticating</>
              ) : 'Establish Connection'}
            </button>
          </form>

          <div className="relative my-8 z-10">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border-subtle" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-bg-surface px-4 text-[10px] uppercase tracking-widest font-mono text-text-dim">Alternative Protocol</span>
            </div>
          </div>

          <button
            onClick={demoLogin}
            disabled={loading}
            className="w-full btn-secondary relative z-10 font-mono text-sm uppercase tracking-wider"
          >
            Access Demo Environment
          </button>
        </div>
        
        <p className="text-center text-text-dim text-sm mt-8">
          Unregistered operator?{' '}
          <button onClick={() => navigate('register')} className="text-accent-purple-light hover:text-white transition-colors font-medium hover:underline underline-offset-4">
            Request Access
          </button>
        </p>
      </div>
    </div>
  );
}
