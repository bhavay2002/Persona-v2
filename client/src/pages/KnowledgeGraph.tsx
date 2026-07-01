import React, { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import ExplainabilityPanel from '../components/ExplainabilityPanel';

// ─── Force Layout ─────────────────────────────────────────────────────────────

interface Pos { x: number; y: number; vx: number; vy: number }

function runForceLayout(
  nodeCount: number,
  edges: { source_id: number; target_id: number }[],
  idToIdx: Map<number, number>,
  width: number,
  height: number
): Pos[] {
  const cx = width / 2, cy = height / 2;
  const positions: Pos[] = Array.from({ length: nodeCount }, () => ({
    x: cx + (Math.random() - 0.5) * width * 0.6,
    y: cy + (Math.random() - 0.5) * height * 0.6,
    vx: 0, vy: 0,
  }));

  const k = Math.sqrt((width * height) / Math.max(nodeCount, 1)) * 0.9;

  for (let iter = 0; iter < 250; iter++) {
    const cooling = 1 - iter / 250;
    const alpha = 0.25 * cooling;

    // Repulsion: O(n²) — fine for n < 300
    for (let i = 0; i < nodeCount; i++) {
      for (let j = i + 1; j < nodeCount; j++) {
        const dx = positions[i].x - positions[j].x || 0.01;
        const dy = positions[i].y - positions[j].y || 0.01;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (k * k) / dist * alpha;
        positions[i].vx += (dx / dist) * f;
        positions[i].vy += (dy / dist) * f;
        positions[j].vx -= (dx / dist) * f;
        positions[j].vy -= (dy / dist) * f;
      }
    }

    // Attraction along edges
    for (const edge of edges) {
      const si = idToIdx.get(edge.source_id);
      const ti = idToIdx.get(edge.target_id);
      if (si === undefined || ti === undefined) continue;
      const dx = positions[ti].x - positions[si].x;
      const dy = positions[ti].y - positions[si].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (dist * dist) / k * alpha * 0.8;
      positions[si].vx += (dx / dist) * f;
      positions[si].vy += (dy / dist) * f;
      positions[ti].vx -= (dx / dist) * f;
      positions[ti].vy -= (dy / dist) * f;
    }

    // Gravity toward center
    for (const p of positions) {
      p.vx += (cx - p.x) * 0.008;
      p.vy += (cy - p.y) * 0.008;
    }

    // Integrate + clamp
    const maxD = 12 * cooling;
    for (const p of positions) {
      p.vx *= 0.82;
      p.vy *= 0.82;
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (speed > maxD) { p.vx = (p.vx / speed) * maxD; p.vy = (p.vy / speed) * maxD; }
      p.x = Math.max(48, Math.min(width - 48, p.x + p.vx));
      p.y = Math.max(48, Math.min(height - 48, p.y + p.vy));
    }
  }
  return positions;
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

const TOPIC_PALETTE = [
  '#8b5cf6','#14b8a6','#f59e0b','#ef4444','#3b82f6',
  '#10b981','#f97316','#ec4899','#06b6d4','#84cc16',
];
let _topicColorIdx = 0;
const topicColorMap = new Map<string, string>();
function topicColor(topic: string): string {
  if (!topicColorMap.has(topic)) {
    topicColorMap.set(topic, TOPIC_PALETTE[_topicColorIdx % TOPIC_PALETTE.length]);
    _topicColorIdx++;
  }
  return topicColorMap.get(topic)!;
}

function edgeColor(type: string) {
  if (type === 'SUPPORTS') return '#10b981';
  if (type === 'CONTRADICTS') return '#ef4444';
  return '#6b7280';
}

function edgeDash(type: string) {
  if (type === 'SIMILAR') return '4 4';
  return undefined;
}

function nodeRadius(degree: number) {
  return Math.max(6, Math.min(16, 6 + degree * 1.5));
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function KnowledgeGraph() {
  const [graphData, setGraphData] = useState<any>(null);
  const [topics, setTopics] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [positions, setPositions] = useState<Pos[]>([]);
  const [selectedTopic, setSelectedTopic] = useState('');
  const [selectedEdgeType, setSelectedEdgeType] = useState('');
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [analyzeText, setAnalyzeText] = useState('');
  const [explainTarget, setExplainTarget] = useState<{ text: string } | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [tab, setTab] = useState<'graph' | 'topics' | 'debates' | 'analyze'>('graph');

  const svgRef = useRef<SVGSVGElement>(null);
  const SVG_W = 900, SVG_H = 580;

  const loadGraph = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: '120' };
      if (selectedTopic) params.topic = selectedTopic;
      if (selectedEdgeType) params.edge_type = selectedEdgeType;

      const [gData, tData, sData, suggestData] = await Promise.all([
        api.getKgGraph(params),
        api.getKgTopics(),
        api.getKgStats(),
        api.getKgDebateSuggestions(),
      ]);

      setGraphData(gData);
      setTopics(tData.topics || []);
      setStats(sData);
      setSuggestions(suggestData.suggestions || []);

      // Run force layout
      if (gData.nodes?.length > 0) {
        const idToIdx = new Map<number, number>(gData.nodes.map((n: any, i: number) => [n.id, i]));
        const pos = runForceLayout(gData.nodes.length, gData.edges || [], idToIdx, SVG_W, SVG_H);
        setPositions(pos);
      } else {
        setPositions([]);
      }
    } catch {}
    setLoading(false);
  }, [selectedTopic, selectedEdgeType]);

  useEffect(() => { loadGraph(); }, [loadGraph]);

  const handleNodeClick = async (node: any) => {
    if (selectedNode?.id === node.id) { setSelectedNode(null); return; }
    setSelectedNode(node);
  };

  return (
    <div className="max-w-7xl mx-auto pt-2 pb-8 space-y-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end gap-4 justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">Knowledge Graph</h1>
          <p className="text-text-secondary text-sm mt-1">Structured map of beliefs, claims, and contradictions across the network</p>
        </div>
        {stats && (
          <div className="flex gap-3 flex-wrap">
            {[
              { label: 'Claims', value: stats.claims?.total || 0, color: 'text-accent-purple-light' },
              { label: 'Topics', value: stats.claims?.topics || 0, color: 'text-accent-teal-light' },
              { label: 'Edges', value: stats.edges?.total || 0, color: 'text-yellow-400' },
              { label: 'Contradictions', value: stats.contradiction_pairs || 0, color: 'text-red-400' },
            ].map(s => (
              <div key={s.label} className="bg-bg-surface border border-border-subtle rounded-xl px-4 py-2 text-center min-w-[80px]">
                <div className={`text-lg font-bold font-mono ${s.color}`}>{s.value}</div>
                <div className="text-[9px] font-mono uppercase text-text-dim">{s.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-bg-surface/50 p-1 rounded-xl border border-border-subtle w-fit">
        {(['graph', 'topics', 'debates', 'analyze'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all capitalize ${
              tab === t ? 'bg-accent-purple/10 text-accent-purple-light shadow-[0_0_12px_rgba(139,92,246,0.1)]' : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
            }`}>
            {t === 'debates' ? 'Debate Seeds' : t === 'analyze' ? 'Analyze' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Graph Tab ── */}
      {tab === 'graph' && (
        <div className="space-y-3">
          {/* Filters */}
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-[10px] font-mono uppercase text-text-dim">Filter:</span>
            <select value={selectedTopic} onChange={e => setSelectedTopic(e.target.value)}
              className="bg-bg-elevated border border-border-mid rounded-lg px-3 py-1.5 text-xs text-text-secondary focus:outline-none focus:border-accent-purple">
              <option value="">All Topics</option>
              {topics.map(t => <option key={t.topic} value={t.topic}>{t.topic} ({t.claim_count})</option>)}
            </select>
            <select value={selectedEdgeType} onChange={e => setSelectedEdgeType(e.target.value)}
              className="bg-bg-elevated border border-border-mid rounded-lg px-3 py-1.5 text-xs text-text-secondary focus:outline-none focus:border-accent-purple">
              <option value="">All Edges</option>
              <option value="SUPPORTS">Supports</option>
              <option value="CONTRADICTS">Contradicts</option>
              <option value="SIMILAR">Similar</option>
            </select>
            <button onClick={loadGraph} className="px-3 py-1.5 bg-bg-elevated border border-border-mid rounded-lg text-xs text-text-secondary hover:text-text-primary transition-colors">
              ↺ Refresh
            </button>
            <div className="flex items-center gap-3 ml-2">
              {[['SUPPORTS','#10b981'],['CONTRADICTS','#ef4444'],['SIMILAR','#6b7280']].map(([t,c]) => (
                <span key={t} className="flex items-center gap-1 text-[9px] font-mono text-text-dim">
                  <span className="inline-block w-3 h-0.5 rounded" style={{ background: c }}></span>{t}
                </span>
              ))}
            </div>
          </div>

          {/* Graph Canvas */}
          <div className="bg-bg-surface border border-border-subtle rounded-2xl overflow-hidden relative" style={{ height: SVG_H }}>
            {loading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-accent-purple border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
                  <p className="text-text-dim text-xs font-mono">Computing layout…</p>
                </div>
              </div>
            ) : !graphData?.nodes?.length ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
                <div className="text-5xl mb-4 opacity-20">◈</div>
                <p className="text-text-dim font-mono text-sm uppercase tracking-wider">No claims in the graph yet</p>
                <p className="text-text-dim text-xs mt-2">Claims are extracted automatically when posts and debate messages are created.</p>
                <button onClick={() => setTab('analyze')}
                  className="mt-4 px-4 py-2 bg-accent-purple/10 border border-accent-purple/30 rounded-xl text-accent-purple-light text-xs font-mono font-bold uppercase tracking-widest hover:bg-accent-purple/20 transition-colors">
                  Analyze Text Manually →
                </button>
              </div>
            ) : (
              <svg ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                className="cursor-default" onMouseLeave={() => setTooltip(null)}>
                <defs>
                  <marker id="arrow-supports" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L6,3 z" fill="#10b981" opacity="0.7" />
                  </marker>
                  <marker id="arrow-contradicts" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L6,3 z" fill="#ef4444" opacity="0.7" />
                  </marker>
                  <marker id="arrow-similar" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L6,3 z" fill="#6b7280" opacity="0.5" />
                  </marker>
                </defs>

                {/* Edges */}
                {graphData.edges.map((edge: any, i: number) => {
                  const si = graphData.nodes.findIndex((n: any) => n.id === edge.source_id);
                  const ti = graphData.nodes.findIndex((n: any) => n.id === edge.target_id);
                  if (si < 0 || ti < 0 || !positions[si] || !positions[ti]) return null;
                  const s = positions[si], t = positions[ti];
                  const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
                  const isHovered = hoveredEdge === i;
                  const isSelected = selectedNode && (edge.source_id === selectedNode.id || edge.target_id === selectedNode.id);
                  const opacity = selectedNode ? (isSelected ? 0.9 : 0.08) : (isHovered ? 0.9 : 0.35);
                  return (
                    <g key={`e-${i}`}>
                      <line x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                        stroke={edgeColor(edge.type)}
                        strokeWidth={isHovered || isSelected ? 2.5 : 1.5}
                        strokeDasharray={edgeDash(edge.type)}
                        strokeOpacity={opacity}
                        markerEnd={`url(#arrow-${edge.type.toLowerCase()})`}
                      />
                      {/* Invisible hit area */}
                      <line x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                        stroke="transparent" strokeWidth={10}
                        onMouseEnter={e => { setHoveredEdge(i); setTooltip({ x: mx, y: my, text: edge.type }); }}
                        onMouseLeave={() => { setHoveredEdge(null); setTooltip(null); }}
                      />
                    </g>
                  );
                })}

                {/* Nodes */}
                {graphData.nodes.map((node: any, i: number) => {
                  if (!positions[i]) return null;
                  const { x, y } = positions[i];
                  const r = nodeRadius(node.degree);
                  const color = topicColor(node.topic);
                  const isSelected = selectedNode?.id === node.id;
                  const isNeighbor = selectedNode && graphData.edges.some((e: any) =>
                    (e.source_id === selectedNode.id && e.target_id === node.id) ||
                    (e.target_id === selectedNode.id && e.source_id === node.id)
                  );
                  const dimmed = selectedNode && !isSelected && !isNeighbor;

                  return (
                    <g key={`n-${node.id}`} style={{ cursor: 'pointer' }}
                      onClick={() => handleNodeClick(node)}
                      onMouseEnter={e => setTooltip({ x, y: y - r - 8, text: node.text.slice(0, 60) + (node.text.length > 60 ? '…' : '') })}
                      onMouseLeave={() => setTooltip(null)}>
                      {isSelected && (
                        <circle cx={x} cy={y} r={r + 6} fill={color} opacity={0.15} />
                      )}
                      <circle cx={x} cy={y} r={r}
                        fill={color}
                        fillOpacity={dimmed ? 0.08 : isSelected ? 1 : 0.7}
                        stroke={color}
                        strokeWidth={isSelected ? 2.5 : 1}
                        strokeOpacity={dimmed ? 0.1 : 1}
                      />
                      {/* Polarity indicator */}
                      {node.polarity === 'pro' && (
                        <text x={x} y={y + 1} textAnchor="middle" dominantBaseline="middle"
                          fontSize="7" fill="white" opacity={dimmed ? 0.1 : 0.9} fontWeight="bold">+</text>
                      )}
                      {node.polarity === 'anti' && (
                        <text x={x} y={y + 1} textAnchor="middle" dominantBaseline="middle"
                          fontSize="7" fill="white" opacity={dimmed ? 0.1 : 0.9} fontWeight="bold">−</text>
                      )}
                      {/* Persona emoji */}
                      {node.persona_emoji && r >= 10 && (
                        <text x={x + r + 2} y={y} fontSize="10" opacity={dimmed ? 0.1 : 0.8}>{node.persona_emoji}</text>
                      )}
                    </g>
                  );
                })}

                {/* Tooltip */}
                {tooltip && (
                  <g>
                    <rect x={tooltip.x - 100} y={tooltip.y - 22} width={200} height={24}
                      rx={4} fill="#1a1a2e" fillOpacity={0.95} stroke="#3d3d5c" strokeWidth={1} />
                    <text x={tooltip.x} y={tooltip.y - 6} textAnchor="middle"
                      fontSize="10" fill="#e2e8f0" fontFamily="monospace">{tooltip.text}</text>
                  </g>
                )}
              </svg>
            )}
          </div>

          {/* Selected Node Panel */}
          {selectedNode && (
            <div className="bg-bg-surface border border-border-subtle rounded-2xl p-5 animate-slide-up">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-md border"
                      style={{ color: topicColor(selectedNode.topic), borderColor: topicColor(selectedNode.topic) + '40', background: topicColor(selectedNode.topic) + '15' }}>
                      {selectedNode.topic}
                    </span>
                    <span className={`text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-md border ${
                      selectedNode.polarity === 'pro' ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' :
                      selectedNode.polarity === 'anti' ? 'text-red-400 bg-red-400/10 border-red-400/20' :
                      'text-text-dim bg-bg-elevated border-border-subtle'
                    }`}>{selectedNode.polarity}</span>
                    <span className="text-[9px] font-mono text-text-dim">confidence: {Math.round(selectedNode.confidence * 100)}%</span>
                    {selectedNode.persona_emoji && (
                      <span className="text-sm">{selectedNode.persona_emoji} <span className="text-xs text-text-secondary">{selectedNode.persona_name}</span></span>
                    )}
                  </div>
                  <p className="text-text-primary text-sm leading-relaxed">{selectedNode.text}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => setExplainTarget({ text: selectedNode.text })}
                    className="px-3 py-1.5 bg-accent-purple/10 border border-accent-purple/30 rounded-lg text-accent-purple-light text-[10px] font-mono font-bold uppercase tracking-widest hover:bg-accent-purple/20 transition-colors">
                    ⚡ Analyze
                  </button>
                  <button onClick={() => setSelectedNode(null)}
                    className="px-3 py-1.5 bg-bg-elevated border border-border-subtle rounded-lg text-text-dim text-[10px] font-mono hover:text-text-secondary transition-colors">✕</button>
                </div>
              </div>

              {/* Related edges inline */}
              {graphData.edges.filter((e: any) => e.source_id === selectedNode.id || e.target_id === selectedNode.id).length > 0 && (
                <div className="mt-3 pt-3 border-t border-border-subtle">
                  <p className="text-[9px] font-mono uppercase text-text-dim mb-2">Connected Claims ({selectedNode.degree})</p>
                  <div className="flex flex-wrap gap-2">
                    {graphData.edges
                      .filter((e: any) => e.source_id === selectedNode.id || e.target_id === selectedNode.id)
                      .slice(0, 6)
                      .map((edge: any, i: number) => {
                        const relatedId = edge.source_id === selectedNode.id ? edge.target_id : edge.source_id;
                        const related = graphData.nodes.find((n: any) => n.id === relatedId);
                        if (!related) return null;
                        return (
                          <button key={i} onClick={() => handleNodeClick(related)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-bg-elevated border border-border-subtle rounded-xl text-xs text-text-secondary hover:text-text-primary hover:border-border-mid transition-colors max-w-[260px]">
                            <span className="text-[9px] font-mono font-bold shrink-0"
                              style={{ color: edgeColor(edge.type) }}>{edge.type}</span>
                            <span className="truncate">{related.text.slice(0, 50)}…</span>
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Topics Tab ── */}
      {tab === 'topics' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {topics.map(t => {
            const color = topicColor(t.topic);
            const maxCount = Math.max(...topics.map((x: any) => x.claim_count), 1);
            return (
              <div key={t.topic}
                className="bg-bg-surface border border-border-subtle rounded-2xl p-5 hover:border-border-mid transition-all cursor-pointer"
                onClick={() => { setSelectedTopic(t.topic); setTab('graph'); }}>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-bold capitalize" style={{ color }}>{t.topic}</span>
                  <span className="text-[10px] font-mono text-text-dim">{t.claim_count} claims</span>
                </div>
                <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden mb-3">
                  <div className="h-full rounded-full" style={{ width: `${(t.claim_count / maxCount) * 100}%`, background: color }} />
                </div>
                <div className="flex gap-3 text-[10px] font-mono">
                  <span className="text-emerald-400">+{t.pro_count} pro</span>
                  <span className="text-red-400">−{t.anti_count} anti</span>
                  {t.contradiction_count > 0 && (
                    <span className="text-red-400 font-bold">⚡{t.contradiction_count} conflicts</span>
                  )}
                </div>
              </div>
            );
          })}
          {!topics.length && (
            <div className="col-span-full text-center py-16 text-text-dim">
              <p className="font-mono text-sm uppercase tracking-wider">No topic clusters yet</p>
            </div>
          )}
        </div>
      )}

      {/* ── Debate Seeds Tab ── */}
      {tab === 'debates' && (
        <div className="space-y-4">
          <p className="text-text-secondary text-sm">High-contradiction claim pairs between different personas — prime candidates for structured debates.</p>
          {suggestions.map((s: any, i: number) => (
            <div key={i} className="bg-bg-surface border border-border-subtle rounded-2xl p-5 hover:border-red-500/20 transition-all">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[9px] font-mono uppercase text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-md">⚡ CONTRADICTION</span>
                <span className="text-[9px] font-mono uppercase text-text-dim">{s.topic}</span>
                <span className="text-[9px] font-mono text-text-dim ml-auto">weight: {parseFloat(s.weight).toFixed(2)}</span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-accent-purple/8 border border-accent-purple/20 rounded-xl p-3">
                  <div className="text-[9px] font-mono text-accent-purple-light mb-1">{s.persona_a || 'Unknown'}</div>
                  <p className="text-xs text-text-secondary leading-relaxed">"{s.claim_a}"</p>
                </div>
                <div className="bg-accent-teal/8 border border-accent-teal/20 rounded-xl p-3">
                  <div className="text-[9px] font-mono text-accent-teal-light mb-1">{s.persona_b || 'Unknown'}</div>
                  <p className="text-xs text-text-secondary leading-relaxed">"{s.claim_b}"</p>
                </div>
              </div>
            </div>
          ))}
          {!suggestions.length && (
            <div className="text-center py-16 text-text-dim">
              <p className="font-mono text-sm uppercase tracking-wider">No contradiction pairs found yet</p>
              <p className="text-xs mt-2">Need claims from multiple personas on the same topic to generate debate seeds.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Analyze Tab ── */}
      {tab === 'analyze' && (
        <div className="max-w-2xl space-y-4">
          <p className="text-text-secondary text-sm">Paste any argument text to extract claims, detect fallacies, and map the reasoning structure.</p>
          <textarea value={analyzeText} onChange={e => setAnalyzeText(e.target.value)}
            rows={5} placeholder="Enter an argument, debate message, or any claim-bearing text to analyze its logical structure…"
            className="w-full bg-bg-surface border border-border-mid rounded-xl px-4 py-3 text-text-primary focus:outline-none focus:border-accent-purple focus:ring-1 focus:ring-accent-purple/30 transition-all resize-none text-sm" />
          <div className="flex gap-3">
            <button disabled={analyzeText.trim().length < 10}
              onClick={() => setExplainTarget({ text: analyzeText.trim() })}
              className="px-5 py-2 bg-accent-purple/10 border border-accent-purple/30 rounded-xl text-accent-purple-light text-sm font-mono font-bold uppercase tracking-widest hover:bg-accent-purple/20 disabled:opacity-40 transition-colors">
              ⚡ Analyze Argument
            </button>
            <button disabled={analyzeText.trim().length < 20}
              onClick={async () => {
                try {
                  await api.extractKgClaims({ text: analyzeText.trim() });
                  setAnalyzeText('');
                  await loadGraph();
                  setTab('graph');
                } catch {}
              }}
              className="px-5 py-2 bg-accent-teal/10 border border-accent-teal/30 rounded-xl text-accent-teal-light text-sm font-mono font-bold uppercase tracking-widest hover:bg-accent-teal/20 disabled:opacity-40 transition-colors">
              ◈ Add to Graph
            </button>
          </div>
        </div>
      )}

      {/* Explainability Panel (modal-style) */}
      {explainTarget && (
        <ExplainabilityPanel text={explainTarget.text} onClose={() => setExplainTarget(null)} />
      )}
    </div>
  );
}
