import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../App';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CalibrationStatus {
  platt_a: number;
  platt_b: number;
  n_labeled: number;
  brier_score: number;
  reliability_curve: { bin_center: number; mean_predicted: number; mean_actual: number; count: number }[];
  calibration_gap: number;
  is_calibrated: boolean;
}

interface EvalStats {
  total: number;
  labeled: number;
  correct: number;
  incorrect: number;
  avg_prob: string;
  avg_brier: string;
}

interface TaskSummary {
  recent: any[];
  averages: { bias: number; emotion: number; reasoning: number };
  drift_events: number;
  leakage_trend: number;
  task_weights: { bias: number; emotion: number; reasoning: number; method: string };
}

interface QueueItem {
  id: number;
  post_id: number | null;
  raw_composite: string;
  calibrated_prob: string;
  confidence_low: string;
  confidence_high: string;
  post_preview: string | null;
  created_at: string;
}

// ─── Reliability Curve SVG ────────────────────────────────────────────────────

function ReliabilityCurve({ curve }: { curve: CalibrationStatus['reliability_curve'] }) {
  const SIZE = 220;
  const PAD = 28;
  const PLOT = SIZE - PAD * 2;

  function toXY(px: number, py: number) {
    return { x: PAD + px * PLOT, y: PAD + (1 - py) * PLOT };
  }

  // Confidence region (±0.1 band around diagonal)
  const bandPoints = [
    toXY(0, 0.1), toXY(0.9, 1), toXY(1, 1), toXY(1, 0.9), toXY(0.1, 0), toXY(0, 0.1)
  ];
  const bandD = bandPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z';

  // Perfect calibration diagonal
  const diagStart = toXY(0, 0);
  const diagEnd   = toXY(1, 1);

  return (
    <svg width={SIZE} height={SIZE} className="w-full max-w-[260px]">
      {/* Grid */}
      {[0.25, 0.5, 0.75].map(v => {
        const { x: gx1 } = toXY(v, 0); const { y: gy1 } = toXY(0, v);
        const { x: gx2 } = toXY(v, 1); const { y: gy2 } = toXY(1, v);
        return (
          <g key={v}>
            <line x1={gx1} y1={PAD} x2={gx1} y2={PAD + PLOT} stroke="#1e293b" strokeWidth="1" />
            <line x1={PAD} y1={gy1} x2={PAD + PLOT} y2={gy1} stroke="#1e293b" strokeWidth="1" />
          </g>
        );
      })}

      {/* Confidence band */}
      <path d={bandD} fill="rgba(139,92,246,0.07)" />

      {/* Perfect calibration diagonal */}
      <line x1={diagStart.x} y1={diagStart.y} x2={diagEnd.x} y2={diagEnd.y}
        stroke="#8b5cf6" strokeWidth="1.5" strokeDasharray="5,4" opacity="0.5" />

      {/* Axis labels */}
      {[0, 0.25, 0.5, 0.75, 1].map(v => {
        const { x } = toXY(v, 0); const { y } = toXY(0, v);
        return (
          <g key={v}>
            <text x={x} y={PAD + PLOT + 14} textAnchor="middle" fontSize="8" fill="#475569">
              {v.toFixed(2)}
            </text>
            <text x={PAD - 6} y={y + 3} textAnchor="end" fontSize="8" fill="#475569">
              {v.toFixed(2)}
            </text>
          </g>
        );
      })}

      {/* Axis labels */}
      <text x={PAD + PLOT / 2} y={SIZE - 2} textAnchor="middle" fontSize="8" fill="#64748b">
        Predicted Probability
      </text>
      <text x={10} y={PAD + PLOT / 2} textAnchor="middle" fontSize="8" fill="#64748b"
        transform={`rotate(-90, 10, ${PAD + PLOT / 2})`}>
        Actual Accuracy
      </text>

      {/* Border */}
      <rect x={PAD} y={PAD} width={PLOT} height={PLOT}
        fill="none" stroke="#1e293b" strokeWidth="1" />

      {/* Data points */}
      {curve.length === 0 ? (
        <text x={PAD + PLOT / 2} y={PAD + PLOT / 2} textAnchor="middle" fontSize="9" fill="#475569">
          No labeled data yet
        </text>
      ) : (
        curve.map((pt, i) => {
          const { x, y } = toXY(pt.mean_predicted, pt.mean_actual);
          const gap = Math.abs(pt.mean_predicted - pt.mean_actual);
          const color = gap < 0.05 ? '#10b981' : gap < 0.15 ? '#f59e0b' : '#ef4444';
          const r = Math.max(3, Math.min(8, Math.sqrt(pt.count) * 1.5));
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={r} fill={color} opacity="0.85" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
              <text x={x} y={y - r - 2} textAnchor="middle" fontSize="7" fill={color}>
                {pt.count}
              </text>
            </g>
          );
        })
      )}
    </svg>
  );
}

// ─── Task Performance Bars ────────────────────────────────────────────────────

function TaskBar({ label, value, uncertainty, weight, color }: {
  label: string; value: number; uncertainty: number; weight: number; color: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex justify-between mb-0.5">
        <span className="text-[10px] font-mono text-text-secondary">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-text-dim">w={Math.round(weight * 100)}%</span>
          <span className="text-[9px] font-mono" style={{ color }}>±{Math.round(uncertainty * 100)}%</span>
          <span className="text-sm font-bold font-mono" style={{ color }}>
            {Math.round(value * 100)}%
          </span>
        </div>
      </div>
      <div className="h-2 bg-bg-elevated rounded-full overflow-hidden relative">
        <div className="h-full rounded-full transition-all" style={{ width: `${value * 100}%`, background: color }} />
        {/* Uncertainty band */}
        <div className="absolute top-0 h-full opacity-20 rounded-full"
          style={{
            left: `${Math.max(0, value - uncertainty) * 100}%`,
            width: `${Math.min(1, uncertainty * 2) * 100}%`,
            background: color,
          }} />
      </div>
    </div>
  );
}

// ─── Platt Scaling Viz ────────────────────────────────────────────────────────

function PlattViz({ a, b }: { a: number; b: number }) {
  const W = 180; const H = 80; const P = 16;
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const points = Array.from({ length: 50 }, (_, i) => {
    const x = i / 49;
    const y = sigmoid(a * x + b);
    return { px: P + x * (W - P * 2), py: P + (1 - y) * (H - P * 2) };
  });
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.px} ${p.py}`).join(' ');
  const identity = [
    { px: P, py: H - P },
    { px: W - P, py: P },
  ];
  const idD = identity.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.px} ${p.py}`).join(' ');

  return (
    <svg width={W} height={H} className="w-full">
      <path d={idD} stroke="#475569" strokeWidth="1" strokeDasharray="3,3" fill="none" />
      <path d={pathD} stroke="#14b8a6" strokeWidth="2" fill="none" />
      <text x={P} y={H - 3} fontSize="7" fill="#475569">raw→0</text>
      <text x={W - P - 20} y={H - 3} fontSize="7" fill="#475569">raw→1</text>
    </svg>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Calibration() {
  const { user } = useAuth();
  const [status, setStatus] = useState<CalibrationStatus | null>(null);
  const [stats, setStats] = useState<EvalStats | null>(null);
  const [tasks, setTasks] = useState<TaskSummary | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [labellingId, setLabellingId] = useState<number | null>(null);
  const [analyzeText, setAnalyzeText] = useState('');
  const [analyzeResult, setAnalyzeResult] = useState<any>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [inferenceMode, setInferenceMode] = useState<'balanced' | 'debate' | 'factcheck'>('balanced');

  const load = useCallback(async () => {
    try {
      const [statusRes, tasksRes, queueRes] = await Promise.all([
        api.getCalibrationStatus(),
        api.getTaskPerformance(),
        api.getEvaluationQueue(),
      ]);
      setStatus(statusRes.status);
      setStats(statusRes.stats);
      setTasks(tasksRes);
      setQueue(queueRes.queue || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submitLabel(id: number, label: 0 | 1) {
    setLabellingId(id);
    try {
      await api.submitCalibrationLabel(id, label);
      setQueue(q => q.filter(x => x.id !== id));
      await load();
    } catch {}
    setLabellingId(null);
  }

  async function runAnalysis() {
    if (!analyzeText.trim() || analyzeText.length < 20) return;
    setAnalyzing(true);
    try {
      const result = await api.runMultiTaskAnalysis(analyzeText, inferenceMode);
      setAnalyzeResult(result.result || result);
    } catch (e: any) {
      setAnalyzeResult({ error: e.message });
    }
    setAnalyzing(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="w-8 h-8 border-2 border-accent-teal border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const s = status!;
  const brierColor = s.brier_score < 0.1 ? '#10b981' : s.brier_score < 0.2 ? '#f59e0b' : '#ef4444';
  const gapColor   = s.calibration_gap < 0.05 ? '#10b981' : s.calibration_gap < 0.15 ? '#f59e0b' : '#ef4444';

  return (
    <div className="max-w-7xl mx-auto pt-2 pb-8 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold tracking-tight">Probabilistic Truth System</h1>
            <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded uppercase ${
              s.is_calibrated ? 'text-emerald-400 bg-emerald-400/10' : 'text-yellow-400 bg-yellow-400/10'
            }`}>
              {s.is_calibrated ? '✓ Calibrated' : '◐ Calibrating'}
            </span>
          </div>
          <p className="text-text-secondary text-sm">
            P(correct | evidence) via Platt scaling · Multi-task analysis · Brier score validation
          </p>
        </div>
        <button onClick={load}
          className="px-3 py-1.5 bg-bg-surface border border-border-subtle rounded-lg text-[10px] font-mono text-text-secondary hover:text-text-primary transition-colors">
          ↺ Refresh
        </button>
      </div>

      {/* Top metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {[
          { label: 'Brier Score', value: s.brier_score.toFixed(4), sub: 'lower = better', color: brierColor },
          { label: 'Calibration Gap', value: s.calibration_gap.toFixed(3), sub: '|pred − actual|', color: gapColor },
          { label: 'Labeled', value: s.n_labeled, sub: 'human evaluations', color: '#8b5cf6' },
          { label: 'Platt a', value: s.platt_a.toFixed(4), sub: 'scale parameter', color: '#14b8a6' },
          { label: 'Platt b', value: s.platt_b.toFixed(4), sub: 'shift parameter', color: '#14b8a6' },
          { label: 'Drift Events', value: tasks?.drift_events ?? 0, sub: 'task conflicts', color: tasks?.drift_events ? '#ef4444' : '#6b7280' },
        ].map(m => (
          <div key={m.label} className="bg-bg-surface border border-border-subtle rounded-xl p-3 text-center">
            <div className="text-xl font-bold font-mono" style={{ color: m.color }}>{m.value}</div>
            <div className="text-[9px] font-mono uppercase text-text-dim">{m.label}</div>
            <div className="text-[8px] font-mono text-text-dim/60 mt-0.5">{m.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Left: Reliability curve + Platt viz */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-text-primary">Reliability Curve</h3>
              <span className="text-[8px] font-mono text-text-dim uppercase">ECE Visualization</span>
            </div>
            <div className="flex justify-center">
              <ReliabilityCurve curve={s.reliability_curve} />
            </div>
            <div className="mt-3 flex gap-3 justify-center">
              {[
                { color: '#10b981', label: 'Calibrated (gap < 5%)' },
                { color: '#f59e0b', label: 'Moderate gap' },
                { color: '#ef4444', label: 'Uncalibrated' },
              ].map(l => (
                <div key={l.label} className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ background: l.color }} />
                  <span className="text-[7px] font-mono text-text-dim">{l.label}</span>
                </div>
              ))}
            </div>
            <p className="text-[8px] font-mono text-text-dim mt-2 text-center">
              Circle size = sample count · Purple dashed = perfect calibration
            </p>
          </div>

          {/* Platt scaling visualization */}
          <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-text-primary">Platt Scaling</h3>
              <code className="text-[9px] font-mono text-accent-teal-light bg-accent-teal/10 px-2 py-0.5 rounded">
                σ({s.platt_a.toFixed(3)}·x {s.platt_b >= 0 ? '+' : ''}{s.platt_b.toFixed(3)})
              </code>
            </div>
            <PlattViz a={s.platt_a} b={s.platt_b} />
            <p className="text-[8px] font-mono text-text-dim mt-2">
              Teal curve = calibrated mapping. Dashed = identity (uncalibrated). Updates via online gradient descent on human labels.
            </p>
            {stats && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {[
                  { label: 'Total Evals', value: stats.total },
                  { label: 'Avg Prob', value: parseFloat(stats.avg_prob || '0').toFixed(3) },
                  { label: 'Correct', value: stats.correct },
                  { label: 'Incorrect', value: stats.incorrect },
                ].map(m => (
                  <div key={m.label} className="text-center">
                    <div className="text-sm font-bold font-mono text-text-primary">{m.value}</div>
                    <div className="text-[8px] font-mono text-text-dim">{m.label}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Center: Multi-task monitor + analysis */}
        <div className="lg:col-span-1 space-y-4">
          {/* Task heads */}
          {tasks && (
            <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-text-primary">Task Heads</h3>
                <div className="flex items-center gap-2">
                  {tasks.drift_events > 0 && (
                    <span className="text-[9px] font-mono text-red-400 bg-red-400/10 border border-red-400/20 px-2 py-0.5 rounded animate-pulse">
                      ⚡ Drift Detected
                    </span>
                  )}
                  <span className="text-[8px] font-mono text-text-dim">{tasks.task_weights.method}</span>
                </div>
              </div>

              <TaskBar label="Reasoning Head" value={tasks.averages.reasoning}
                uncertainty={0.12} weight={tasks.task_weights.reasoning} color="#10b981" />
              <TaskBar label="Bias Head" value={tasks.averages.bias}
                uncertainty={0.10} weight={tasks.task_weights.bias} color="#ef4444" />
              <TaskBar label="Emotion Head" value={tasks.averages.emotion}
                uncertainty={0.08} weight={tasks.task_weights.emotion} color="#f59e0b" />

              {/* Dynamic weights pie */}
              <div className="mt-4">
                <p className="text-[9px] font-mono text-text-dim uppercase mb-2">Dynamic Weights (inverse-variance)</p>
                <div className="h-2 rounded-full overflow-hidden flex">
                  {[
                    { w: tasks.task_weights.reasoning, c: '#10b981' },
                    { w: tasks.task_weights.emotion, c: '#f59e0b' },
                    { w: tasks.task_weights.bias, c: '#ef4444' },
                  ].map((seg, i) => (
                    <div key={i} className="h-full" style={{ width: `${seg.w * 100}%`, background: seg.c }} />
                  ))}
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-[7px] font-mono text-emerald-400">Reasoning {Math.round(tasks.task_weights.reasoning * 100)}%</span>
                  <span className="text-[7px] font-mono text-yellow-400">Emotion {Math.round(tasks.task_weights.emotion * 100)}%</span>
                  <span className="text-[7px] font-mono text-red-400">Bias {Math.round(tasks.task_weights.bias * 100)}%</span>
                </div>
              </div>

              {/* Leakage indicator */}
              <div className="mt-4 p-2 rounded-xl border border-border-subtle bg-bg-elevated">
                <div className="flex justify-between items-center">
                  <span className="text-[9px] font-mono text-text-dim">Task Leakage (cross-correlation)</span>
                  <span className={`text-[9px] font-mono font-bold ${
                    tasks.leakage_trend > 0.7 ? 'text-red-400' : tasks.leakage_trend > 0.5 ? 'text-yellow-400' : 'text-emerald-400'
                  }`}>
                    {(tasks.leakage_trend * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="h-1 bg-bg-surface rounded-full mt-1 overflow-hidden">
                  <div className="h-full rounded-full"
                    style={{
                      width: `${tasks.leakage_trend * 100}%`,
                      background: tasks.leakage_trend > 0.7 ? '#ef4444' : tasks.leakage_trend > 0.5 ? '#f59e0b' : '#10b981',
                    }} />
                </div>
                {tasks.leakage_trend > 0.7 && (
                  <p className="text-[8px] font-mono text-red-400 mt-1">
                    High cross-task correlation — potential representation leakage between heads
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Live Analysis Tester */}
          <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
            <h3 className="text-sm font-bold text-text-primary mb-3">Live Analysis</h3>

            <div className="flex gap-1 mb-3">
              {(['balanced', 'debate', 'factcheck'] as const).map(m => (
                <button key={m} onClick={() => setInferenceMode(m)}
                  className={`flex-1 py-1 text-[9px] font-mono uppercase rounded border transition-colors ${
                    inferenceMode === m
                      ? 'text-accent-teal-light bg-accent-teal/10 border-accent-teal/30'
                      : 'text-text-dim bg-bg-elevated border-border-subtle hover:border-border-mid'
                  }`}>
                  {m}
                </button>
              ))}
            </div>

            <textarea
              value={analyzeText}
              onChange={e => setAnalyzeText(e.target.value)}
              placeholder="Paste any argument or claim to run multi-task analysis + truth calibration..."
              className="w-full bg-bg-elevated border border-border-subtle rounded-xl p-3 text-xs text-text-primary resize-none focus:outline-none focus:border-accent-teal/50 placeholder:text-text-dim"
              rows={4} />

            <button onClick={runAnalysis} disabled={analyzing || analyzeText.length < 20}
              className="w-full mt-2 py-2 bg-accent-teal/10 border border-accent-teal/20 text-accent-teal-light rounded-xl text-[10px] font-mono uppercase tracking-wider hover:bg-accent-teal/20 transition-colors disabled:opacity-40">
              {analyzing ? 'Analyzing...' : 'Run Multi-Task Analysis'}
            </button>

            {analyzeResult && !analyzeResult.error && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between p-2 bg-bg-elevated rounded-xl border border-border-subtle">
                  <span className="text-[9px] font-mono text-text-dim">P(correct)</span>
                  <span className="text-sm font-bold font-mono text-accent-teal-light">
                    {analyzeResult.truth_probability !== undefined
                      ? `${(analyzeResult.truth_probability * 100).toFixed(1)}%`
                      : `${(analyzeResult.composite_score * 100 || 0).toFixed(1)}%`
                    }
                  </span>
                </div>
                {analyzeResult.tasks && (
                  <div className="grid grid-cols-3 gap-1">
                    {[
                      { label: 'Reasoning', v: analyzeResult.tasks.reasoning_score, c: '#10b981' },
                      { label: 'Bias', v: analyzeResult.tasks.bias_score, c: '#ef4444' },
                      { label: 'Emotion', v: analyzeResult.tasks.emotion_score, c: '#f59e0b' },
                    ].map(m => (
                      <div key={m.label} className="bg-bg-elevated rounded-xl p-2 text-center border border-border-subtle">
                        <div className="text-sm font-bold font-mono" style={{ color: m.c }}>
                          {Math.round(m.v * 100)}%
                        </div>
                        <div className="text-[7px] font-mono text-text-dim">{m.label}</div>
                      </div>
                    ))}
                  </div>
                )}
                {analyzeResult.drift && analyzeResult.drift.detected && (
                  <div className="p-2 bg-red-500/8 border border-red-500/20 rounded-xl">
                    <p className="text-[9px] font-mono text-red-400">⚡ Drift: {analyzeResult.drift.details}</p>
                  </div>
                )}
                {analyzeResult.weights && (
                  <div className="p-2 bg-bg-elevated rounded-xl border border-border-subtle">
                    <p className="text-[8px] font-mono text-text-dim mb-1">Dynamic weights ({inferenceMode} mode)</p>
                    <div className="h-1.5 rounded-full overflow-hidden flex">
                      {[
                        { w: analyzeResult.weights.reasoning, c: '#10b981' },
                        { w: analyzeResult.weights.emotion, c: '#f59e0b' },
                        { w: analyzeResult.weights.bias, c: '#ef4444' },
                      ].map((seg, i) => (
                        <div key={i} style={{ width: `${seg.w * 100}%`, background: seg.c }} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {analyzeResult?.error && (
              <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded-xl">
                <p className="text-[9px] font-mono text-red-400">{analyzeResult.error}</p>
              </div>
            )}
          </div>
        </div>

        {/* Right: Human evaluation queue */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-text-primary">Human Evaluation Loop</h3>
              <span className="text-[9px] font-mono text-text-dim bg-bg-elevated px-2 py-0.5 rounded">
                {queue.length} pending
              </span>
            </div>
            <p className="text-[9px] font-mono text-text-dim mb-4">
              Label AI outputs as Correct / Incorrect to update Platt scaling parameters and improve calibration accuracy.
            </p>

            {queue.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-text-dim text-sm">No unlabeled evaluations</p>
                <p className="text-text-dim text-[10px] mt-1">
                  Run an analysis or post content to generate evaluation entries
                </p>
                {user && (
                  <button onClick={async () => {
                    await api.bulkCalibratePost({ limit: 10 });
                    await load();
                  }} className="mt-3 px-3 py-1.5 bg-bg-elevated border border-border-mid rounded-xl text-[9px] font-mono text-text-secondary hover:text-text-primary transition-colors">
                    Import Recent Posts
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
                {queue.map(item => (
                  <div key={item.id} className="bg-bg-elevated border border-border-subtle rounded-xl p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[8px] font-mono text-text-dim">#{item.id}</span>
                        <span className="text-[9px] font-mono text-accent-teal-light">
                          P={parseFloat(item.calibrated_prob).toFixed(3)}
                        </span>
                        <span className="text-[8px] font-mono text-text-dim">
                          [{parseFloat(item.confidence_low).toFixed(2)}, {parseFloat(item.confidence_high).toFixed(2)}]
                        </span>
                      </div>
                    </div>
                    {item.post_preview && (
                      <p className="text-[10px] text-text-secondary line-clamp-2 mb-2">
                        {item.post_preview}
                      </p>
                    )}
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => submitLabel(item.id, 1)}
                        disabled={labellingId === item.id}
                        className="flex-1 py-1 text-[9px] font-mono text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-lg hover:bg-emerald-400/20 transition-colors disabled:opacity-40">
                        ✓ Correct
                      </button>
                      <button
                        onClick={() => submitLabel(item.id, 0)}
                        disabled={labellingId === item.id}
                        className="flex-1 py-1 text-[9px] font-mono text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg hover:bg-red-400/20 transition-colors disabled:opacity-40">
                        ✗ Incorrect
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Architecture callout */}
          <div className="bg-bg-surface border border-border-subtle rounded-2xl p-4 space-y-2">
            <h4 className="text-[10px] font-mono uppercase text-text-dim tracking-wider">System Architecture</h4>
            {[
              { step: 'Input', desc: 'Raw text argument' },
              { step: 'Shared Encoder', desc: '1 Gemini call → 7-dim feature vector' },
              { step: 'Task Heads', desc: 'Bias · Emotion · Reasoning (no extra calls)' },
              { step: 'Dynamic Weights', desc: 'Inverse-variance weighting (σ⁻²)' },
              { step: 'Platt Scaling', desc: 'σ(a·x+b) → P(correct)' },
              { step: 'CI', desc: 'Wilson score 95% confidence interval' },
              { step: 'Brier Score', desc: 'Running calibration quality metric' },
              { step: 'Human Loop', desc: 'Online gradient descent update' },
            ].map((s, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-[8px] font-mono text-accent-purple shrink-0 mt-0.5">{i + 1}.</span>
                <div className="flex-1">
                  <span className="text-[9px] font-mono text-text-primary">{s.step}</span>
                  <span className="text-[8px] font-mono text-text-dim ml-1">— {s.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
