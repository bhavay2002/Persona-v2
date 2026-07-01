import React, { useState } from 'react';
import { useAuth, useNav } from '../App';

export default function Register() {
  const { register } = useAuth();
  const { navigate } = useNav();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('Security keys do not match'); return; }
    if (password.length < 6) { setError('Security key must be at least 6 characters'); return; }
    setLoading(true);
    try {
      await register(email, password);
    } catch (err: any) {
      setError(err.message || 'Registration failed');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center py-12">
      <div className="w-full max-w-md animate-fade-in">
        <div className="text-center mb-10">
          <div className="w-20 h-20 mx-auto bg-gradient-to-br from-accent-purple/20 to-accent-teal/20 rounded-2xl flex items-center justify-center border border-border-subtle shadow-inner mb-6 relative">
            <div className="absolute inset-0 rounded-2xl bg-accent-teal/10 blur-xl"></div>
            <div className="relative text-4xl">🎭</div>
          </div>
          <h1 className="text-3xl font-bold text-text-primary tracking-tight mb-3">Initialize Operator</h1>
          <p className="text-text-secondary text-sm">Join the synthesis network</p>
        </div>

        <div className="bg-bg-surface border border-border-subtle rounded-2xl p-8 shadow-[0_0_40px_rgba(0,0,0,0.5)] relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-accent-teal to-accent-purple opacity-50"></div>
          
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
              <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Security Key</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Minimum 6 characters"
                required
                className="input-base font-mono tracking-widest"
              />
            </div>
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-widest font-bold text-text-secondary mb-2">Confirm Security Key</label>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
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
                <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span> Initializing</>
              ) : 'Generate Access Token'}
            </button>
          </form>
        </div>

        <div className="mt-6 flex items-start gap-3 bg-bg-surface border border-border-subtle rounded-xl p-4">
          <svg className="w-5 h-5 text-accent-teal flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <p className="text-text-secondary text-xs leading-relaxed">
            <strong className="text-text-primary">End-to-end anonymity.</strong> Your operator ID remains hidden. Only your generated personas are visible to the network.
          </p>
        </div>
        
        <p className="text-center text-text-dim text-sm mt-8">
          Already an operator?{' '}
          <button onClick={() => navigate('login')} className="text-accent-purple-light hover:text-white transition-colors font-medium hover:underline underline-offset-4">
            Initialize Session
          </button>
        </p>
      </div>
    </div>
  );
}
