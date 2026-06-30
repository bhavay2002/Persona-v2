import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface ArgumentStructure {
  claim: string;
  evidence: string[];
  assumptions: string[];
  conclusion: string;
  reasoning_graph: { nodes: ReasoningNode[]; edges: ReasoningEdge[] };
  fallacies: Fallacy[];
  overall_strength: number;
  confidence: number;
}

interface ReasoningNode {
  id: string;
  type: 'claim' | 'evidence' | 'assumption' | 'conclusion';
  text: string;
  strength?: number;
}

interface ReasoningEdge {
  from: string;
  to: string;
  type: 'supports' | 'assumes' | 'leads_to' | 'undermines';
  label?: string;
}

interface Fallacy {
  type: string;
  text_span: string;
  severity: number;
  explanation: string;
}

interface Props {
  text: string;
  postId?: number;
  debateMessageId?: number;
  personaId?: number;
  onClose: () => void;
}

const NODE_TYPE_STYLE: Record<string, { color: string; bg: string; border: string; label: string }> = {
  claim:      { color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.3)', label: 'Claim' },
  evidence:   { color: '#14b8a6', bg: 'rgba(20,184,166,0.12)', border: 'rgba(20,184,166,0.3)', label: 'Evidence' },
  assumption: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)', label: 'Assumption' },
  conclusion: { color: '#10b981', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.3)', label: 'Conclusion' },
};

const EDGE_COLOR: Record<string, string> = {
  supports: '#10b981', assumes: '#f59e0b', leads_to: '#8b5cf6', undermines: '#ef4444',
};

function strengthBar(value: number, color: string) {
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1 bg-bg-elevated rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${value * 100}%`, background: color }} />
      </div>
      <span className="text-[9px] font-mono" style={{ color }}>{Math.round(value * 100)}%</span>
    </div>
  );
}

// ─── Mini Reasoning Graph ─────────────────────────────────────────────────────

function MiniReasoningGraph({ graph }: { graph: ArgumentStructure['reasoning_graph'] }) {
  const { nodes, edges } = graph;
  if (!nodes.length) return null;

  const W = 480, H = 200;
  const typeOrder = ['evidence', 'assumption', 'claim', 'conclusion'];

  // Layout: column by type
  const columns: Record<string, ReasoningNode[]> = { evidence: [], assumption: [], claim: [], conclusion: [] };
  for (const n of nodes) {
    const col = typeOrder.includes(n.type) ? n.type : 'claim';
    columns[col].push(n);
  }

  const colX: Record<string, number> = { evidence: 60, assumption: 180, claim: 300, conclusion: 420 };
  const positions: Record<string, { x: number; y: number }> = {};

  for (const [type, col] of Object.entries(columns)) {
    col.forEach((n, i) => {
      const totalInCol = col.length;
      positions[n.id] = {
        x: colX[type],
        y: (H / (totalInCol + 1)) * (i + 1),
      };
    });
  }

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="rounded-xl overflow-visible">
      <defs>
        {['supports','assumes','leads_to','undermines'].map(t => (
          <marker key={t} id={`mini-${t}`} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
            <path d="M0,0 L0,5 L5,2.5 z" fill={EDGE_COLOR[t]} opacity="0.8" />
          </marker>
        ))}
      </defs>

      {/* Edges */}
      {edges.map((e, i) => {
        const s = positions[e.from], t = positions[e.to];
        if (!s || !t) return null;
        const color = EDGE_COLOR[e.type] || '#6b7280';
        const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
        return (
          <g key={i}>
            <line x1={s.x} y1={s.y} x2={t.x} y2={t.y}
              stroke={color} strokeWidth={1.5} strokeOpacity={0.6}
              markerEnd={`url(#mini-${e.type})`} />
            {e.label && (
              <text x={mx} y={my - 4} textAnchor="middle" fontSize="7" fill={color} opacity="0.8" fontFamily="monospace">{e.label}</text>
            )}
          </g>
        );
      })}

      {/* Nodes */}
      {nodes.map(node => {
        const p = positions[node.id];
        if (!p) return null;
        const style = NODE_TYPE_STYLE[node.type] || NODE_TYPE_STYLE.claim;
        const shortText = node.text.length > 28 ? node.text.slice(0, 28) + '…' : node.text;
        return (
          <g key={node.id}>
            <rect x={p.x - 45} y={p.y - 14} width={90} height={28} rx={6}
              fill={style.bg} stroke={style.border} strokeWidth={1} />
            <text x={p.x} y={p.y + 1} textAnchor="middle" dominantBaseline="middle"
              fontSize="8" fill={style.color} fontFamily="monospace">{shortText}</text>
          </g>
        );
      })}

      {/* Column labels */}
      {typeOrder.map(type => {
        const style = NODE_TYPE_STYLE[type];
        return (
          <text key={type} x={colX[type]} y={16} textAnchor="middle"
            fontSize="7" fill={style.color} opacity="0.6" fontFamily="monospace" fontWeight="bold">
            {type.toUpperCase()}
          </text>
        );
      })}
    </svg>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export default function ExplainabilityPanel({ text, postId, debateMessageId, personaId, onClose }: Props) {
  const [structure, setStructure] = useState<ArgumentStructure | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'structure' | 'graph' | 'fallacies'>('structure');
  const [highlightedSpan, setHighlightedSpan] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.analyzeArgument({ text, postId, debateMessageId, personaId })
      .then((data: any) => { if (!cancelled) setStructure(data.structure); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [text, postId, debateMessageId]);

  // Highlight fallacy spans in the original text
  function renderHighlightedText() {
    if (!structure?.fallacies.length || !text) return <p className="text-text-secondary text-sm leading-relaxed">{text}</p>;
    const spans = structure.fallacies.map(f => f.text_span).filter(Boolean);
    if (!spans.length) return <p className="text-text-secondary text-sm leading-relaxed">{text}</p>;

    let parts: { t: string; fallacy?: Fallacy }[] = [{ t: text }];
    for (const fallacy of structure.fallacies) {
      if (!fallacy.text_span) continue;
      parts = parts.flatMap(part => {
        if (part.fallacy) return [part];
        const idx = part.t.indexOf(fallacy.text_span);
        if (idx < 0) return [part];
        return [
          { t: part.t.slice(0, idx) },
          { t: fallacy.text_span, fallacy },
          { t: part.t.slice(idx + fallacy.text_span.length) },
        ].filter(p => p.t.length > 0);
      });
    }

    return (
      <p className="text-text-secondary text-sm leading-relaxed">
        {parts.map((p, i) => p.fallacy
          ? <span key={i} className="bg-red-500/20 border-b border-red-500/60 cursor-help transition-colors hover:bg-red-500/30"
              title={`${p.fallacy.type}: ${p.fallacy.explanation}`}
              onMouseEnter={() => setHighlightedSpan(p.fallacy!.text_span)}
              onMouseLeave={() => setHighlightedSpan(null)}>
              {p.t}
            </span>
          : <span key={i}>{p.t}</span>
        )}
      </p>
    );
  }

  const strengthColor = structure
    ? structure.overall_strength > 0.65 ? '#10b981' : structure.overall_strength > 0.40 ? '#f59e0b' : '#ef4444'
    : '#6b7280';

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative bg-bg-surface border border-border-subtle rounded-t-3xl md:rounded-3xl w-full md:max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col shadow-2xl animate-slide-up"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="p-5 border-b border-border-subtle bg-bg-elevated/50 flex items-start justify-between gap-4 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-[9px] font-mono uppercase tracking-widest text-accent-purple-light bg-accent-purple/10 border border-accent-purple/20 px-2 py-0.5 rounded-md">⚡ Argument Analysis</span>
              {structure && (
                <>
                  <span className="text-[9px] font-mono text-text-dim">
                    strength: <span style={{ color: strengthColor }}>{Math.round(structure.overall_strength * 100)}%</span>
                  </span>
                  {structure.fallacies.length > 0 && (
                    <span className="text-[9px] font-mono text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-md">
                      ⚠ {structure.fallacies.length} fallac{structure.fallacies.length === 1 ? 'y' : 'ies'}
                    </span>
                  )}
                </>
              )}
            </div>
            <p className="text-text-secondary text-xs leading-relaxed line-clamp-2">{text.slice(0, 150)}{text.length > 150 ? '…' : ''}</p>
          </div>
          <button onClick={onClose} className="text-text-dim hover:text-text-secondary text-xl leading-none shrink-0 mt-1">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border-subtle shrink-0">
          {(['structure', 'graph', 'fallacies'] as const).map(t => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`flex-1 py-2.5 text-[10px] font-mono uppercase tracking-widest font-bold transition-colors ${
                activeTab === t ? 'text-accent-purple-light border-b-2 border-accent-purple' : 'text-text-dim hover:text-text-secondary'
              }`}>
              {t === 'structure' ? 'Structure' : t === 'graph' ? 'Reasoning Graph' : `Fallacies${structure?.fallacies.length ? ` (${structure.fallacies.length})` : ''}`}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 p-5">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="w-8 h-8 border-2 border-accent-purple border-t-transparent rounded-full animate-spin mb-4"></div>
              <p className="text-text-dim text-xs font-mono uppercase tracking-wider">Analyzing argument structure…</p>
            </div>
          ) : !structure ? (
            <p className="text-text-dim text-sm text-center py-8">Analysis failed. Try again.</p>
          ) : (
            <>
              {/* ── Structure Tab ── */}
              {activeTab === 'structure' && (
                <div className="space-y-4">
                  {/* Original text with highlights */}
                  <div className="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
                    <div className="text-[9px] font-mono uppercase text-text-dim mb-2 tracking-wider">Original Text</div>
                    {renderHighlightedText()}
                  </div>

                  {/* Claim */}
                  <div className="bg-accent-purple/8 border border-accent-purple/20 rounded-xl p-4">
                    <div className="text-[9px] font-mono uppercase text-accent-purple-light mb-1.5 tracking-wider">Central Claim</div>
                    <p className="text-sm text-text-primary font-medium leading-relaxed">{structure.claim}</p>
                    {strengthBar(structure.overall_strength, '#8b5cf6')}
                  </div>

                  {/* Evidence */}
                  {structure.evidence.length > 0 && (
                    <div className="bg-accent-teal/8 border border-accent-teal/20 rounded-xl p-4">
                      <div className="text-[9px] font-mono uppercase text-accent-teal-light mb-2 tracking-wider">Evidence ({structure.evidence.length})</div>
                      <ul className="space-y-1.5">
                        {structure.evidence.map((e, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-text-secondary leading-relaxed">
                            <span className="text-accent-teal-light shrink-0 font-mono text-[10px] mt-0.5">▸</span>{e}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Assumptions */}
                  {structure.assumptions.length > 0 && (
                    <div className="bg-yellow-500/8 border border-yellow-500/20 rounded-xl p-4">
                      <div className="text-[9px] font-mono uppercase text-yellow-400 mb-2 tracking-wider">Hidden Assumptions ({structure.assumptions.length})</div>
                      <ul className="space-y-1.5">
                        {structure.assumptions.map((a, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-text-secondary leading-relaxed">
                            <span className="text-yellow-400 shrink-0 font-mono text-[10px] mt-0.5">∼</span>{a}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Conclusion */}
                  {structure.conclusion && (
                    <div className="bg-emerald-500/8 border border-emerald-500/20 rounded-xl p-4">
                      <div className="text-[9px] font-mono uppercase text-emerald-400 mb-1.5 tracking-wider">Conclusion</div>
                      <p className="text-sm text-text-secondary leading-relaxed">{structure.conclusion}</p>
                    </div>
                  )}

                  {/* Strength gauge */}
                  <div className="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
                    <div className="flex justify-between mb-1">
                      <span className="text-[9px] font-mono uppercase text-text-dim tracking-wider">Argument Strength</span>
                      <span className="text-[9px] font-mono font-bold" style={{ color: strengthColor }}>{Math.round(structure.overall_strength * 100)}%</span>
                    </div>
                    <div className="h-2 bg-bg-surface rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${structure.overall_strength * 100}%`, background: strengthColor }} />
                    </div>
                    <p className="text-[9px] font-mono text-text-dim mt-1.5">
                      {structure.overall_strength > 0.65 ? 'Strong — well-supported argument with clear reasoning'
                        : structure.overall_strength > 0.40 ? 'Moderate — some evidence but gaps in reasoning'
                        : 'Weak — claims without adequate support'}
                    </p>
                  </div>
                </div>
              )}

              {/* ── Reasoning Graph Tab ── */}
              {activeTab === 'graph' && (
                <div className="space-y-4">
                  {structure.reasoning_graph.nodes.length > 0 ? (
                    <>
                      <div className="bg-bg-elevated rounded-xl p-4 border border-border-subtle overflow-x-auto">
                        <MiniReasoningGraph graph={structure.reasoning_graph} />
                      </div>
                      <div className="flex gap-3 flex-wrap">
                        {(['claim','evidence','assumption','conclusion'] as const).filter(t =>
                          structure.reasoning_graph.nodes.some(n => n.type === t)
                        ).map(type => {
                          const style = NODE_TYPE_STYLE[type];
                          const count = structure.reasoning_graph.nodes.filter(n => n.type === type).length;
                          return (
                            <div key={type} className="flex items-center gap-1.5">
                              <div className="w-3 h-3 rounded" style={{ background: style.bg, border: `1px solid ${style.border}` }} />
                              <span className="text-[9px] font-mono text-text-dim capitalize">{type} ({count})</span>
                            </div>
                          );
                        })}
                      </div>
                      <div className="space-y-2">
                        <p className="text-[9px] font-mono uppercase text-text-dim tracking-wider">All Nodes</p>
                        {structure.reasoning_graph.nodes.map(node => {
                          const style = NODE_TYPE_STYLE[node.type];
                          return (
                            <div key={node.id} className="flex items-start gap-3 px-3 py-2 rounded-xl border"
                              style={{ background: style.bg, borderColor: style.border }}>
                              <span className="text-[9px] font-mono font-bold shrink-0 mt-0.5 uppercase" style={{ color: style.color }}>{style.label}</span>
                              <p className="text-xs text-text-secondary leading-relaxed">{node.text}</p>
                              {node.strength !== undefined && (
                                <span className="text-[9px] font-mono shrink-0 mt-0.5" style={{ color: style.color }}>{Math.round(node.strength * 100)}%</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <p className="text-text-dim text-sm text-center py-8">No reasoning graph could be constructed.</p>
                  )}
                </div>
              )}

              {/* ── Fallacies Tab ── */}
              {activeTab === 'fallacies' && (
                <div className="space-y-4">
                  {structure.fallacies.length === 0 ? (
                    <div className="text-center py-12">
                      <div className="text-4xl mb-3">✓</div>
                      <p className="text-emerald-400 font-mono text-sm uppercase tracking-wider font-bold">No logical fallacies detected</p>
                      <p className="text-text-dim text-xs mt-1">The argument appears logically sound.</p>
                    </div>
                  ) : (
                    <>
                      <p className="text-text-secondary text-xs">
                        {structure.fallacies.length} logical error{structure.fallacies.length !== 1 ? 's' : ''} detected in this argument.
                        Hover the highlighted text above to see which span each applies to.
                      </p>
                      {structure.fallacies.map((f, i) => (
                        <div key={i} className="bg-red-500/8 border border-red-500/20 rounded-xl p-4">
                          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] font-mono text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-md uppercase font-bold">{f.type}</span>
                              <div className="flex gap-0.5">
                                {Array.from({ length: 5 }, (_, j) => (
                                  <div key={j} className={`w-2 h-2 rounded-sm ${j < Math.round(f.severity * 5) ? 'bg-red-500' : 'bg-red-500/15'}`} />
                                ))}
                              </div>
                              <span className="text-[9px] font-mono text-red-400">{Math.round(f.severity * 100)}% severity</span>
                            </div>
                          </div>
                          {f.text_span && (
                            <div className="mb-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
                              <span className="text-[9px] font-mono text-text-dim uppercase mr-2">Span:</span>
                              <span className="text-xs text-red-300 italic">"{f.text_span}"</span>
                            </div>
                          )}
                          <p className="text-xs text-text-secondary leading-relaxed">{f.explanation}</p>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

