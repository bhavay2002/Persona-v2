import React, { useEffect, useState } from 'react';
import { useNav } from '../App';

const BASE = '/api';
async function req(path: string) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error('Request failed');
  return res.json();
}

function StatCard({ label, value, sub, color = 'text-text-primary' }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-text-dim mb-2">{label}</div>
      <div className={`text-3xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-text-dim mt-1">{sub}</div>}
    </div>
  );
}

export default function Analytics() {
  const { navigate } = useNav();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { req('/metrics').then(setData).catch(() => {}).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="max-w-6xl mx-auto py-6 text-text-dim">Loading metrics...</div>;
  if (!data) return <div className="max-w-6xl mx-auto py-6 text-text-dim">No metrics available</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-8 py-6">
      <div className="border-b border-border-subtle pb-6">
        <h1 className="text-3xl font-bold text-text-primary tracking-tight">Platform Analytics</h1>
        <p className="text-text-secondary mt-1 text-sm">Real-time aggregated insights — engagement, quality, and experiment outcomes</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Operators" value={data.platform?.user_count || 0} color="text-accent-teal-light" />
        <StatCard label="Entities" value={data.platform?.persona_count || 0} color="text-accent-purple-light" sub={`${data.platform?.marketplace_count || 0} on marketplace`} />
        <StatCard label="Statements" value={data.platform?.post_count || 0} sub={`${data.platform?.total_likes || 0} total likes`} />
        <StatCard label="Conflicts" value={data.platform?.debate_count || 0} color="text-red-400" sub={`${data.platform?.ai_debate_count || 0} AI-generated`} />
      </div>
      <div className="bg-bg-surface border border-border-subtle rounded-2xl p-6">
        <h3 className="font-semibold text-text-primary text-sm mb-4">A/B Test Results</h3>
        {(!data.experiments || data.experiments.length === 0) ? <p className="text-text-dim text-sm">No results yet</p> : <pre className="text-xs text-text-dim overflow-auto">{JSON.stringify(data.experiments, null, 2)}</pre>}
      </div>
      <div className="bg-bg-surface border border-border-subtle rounded-2xl p-6">
        <h3 className="font-semibold text-text-primary text-sm mb-4">Top Entities</h3>
        <pre className="text-xs text-text-dim overflow-auto">{JSON.stringify(data.topPersonas?.slice(0, 10) || [], null, 2)}</pre>
      </div>
      <button onClick={() => navigate('feed')} className="text-xs font-mono uppercase tracking-widest text-accent-purple">Back to Feed</button>
    </div>
  );
}
