import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import {
  extractClaims, buildEdgesForNewClaims, getGraphData, getClaimWithEdges,
  getTopicClusters, getPersonaBeliefProfile, suggestDebatesFromContradictions,
} from '../lib/knowledgeGraph.js';
import {
  analyzeArgument, getStoredAnalysis, detectFallaciesOnly, getRecentAnalyses,
} from '../lib/explainabilityEngine.js';
import pool from '../db.js';

const router = Router();

// ─── Graph Data ───────────────────────────────────────────────────────────────

router.get('/graph', async (req, res) => {
  try {
    const { topic, edge_type, persona_id, limit } = req.query as Record<string, string>;
    const data = await getGraphData({
      topic: topic || undefined,
      edgeType: edge_type as any || undefined,
      personaId: persona_id ? parseInt(persona_id) : undefined,
      limit: limit ? parseInt(limit) : 150,
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Claims ───────────────────────────────────────────────────────────────────

router.get('/claims', async (req, res) => {
  try {
    const { topic, persona_id, polarity, limit = '50', offset = '0' } = req.query as Record<string, string>;
    let query = `
      SELECT c.*, p.name as persona_name, p.avatar_emoji,
        (SELECT COUNT(*)::int FROM claim_edges WHERE source_id = c.id OR target_id = c.id) as degree
      FROM claims c
      LEFT JOIN personas p ON p.id = c.persona_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (topic) { params.push(topic); query += ` AND c.topic = $${params.length}`; }
    if (persona_id) { params.push(parseInt(persona_id)); query += ` AND c.persona_id = $${params.length}`; }
    if (polarity) { params.push(polarity); query += ` AND c.polarity = $${params.length}`; }
    params.push(parseInt(limit), parseInt(offset));
    query += ` ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const result = await pool.query(query, params);
    res.json({ claims: result.rows, total: result.rows.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/claims/:id', async (req, res) => {
  try {
    const data = await getClaimWithEdges(parseInt(req.params.id));
    if (!data) return res.status(404).json({ error: 'Claim not found' });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Claim Extraction ─────────────────────────────────────────────────────────

router.post('/extract', authenticateToken, async (req: AuthRequest, res) => {
  const { text, personaId, postId, debateMessageId } = req.body;
  if (!text || text.length < 20) return res.status(400).json({ error: 'text must be at least 20 characters' });
  try {
    const claims = await extractClaims(text, { personaId, postId, debateMessageId });
    if (claims.length > 0) {
      // Build edges in background (non-blocking)
      buildEdgesForNewClaims(claims.map(c => c.id)).catch(() => {});
    }
    res.json({ claims, count: claims.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Topics ───────────────────────────────────────────────────────────────────

router.get('/topics', async (_req, res) => {
  try {
    const clusters = await getTopicClusters();
    res.json({ topics: clusters });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Persona Belief Profile ───────────────────────────────────────────────────

router.get('/persona/:id', async (req, res) => {
  try {
    const profile = await getPersonaBeliefProfile(parseInt(req.params.id));
    res.json({ profile });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Debate Suggestions ───────────────────────────────────────────────────────

router.get('/debate-suggestions', async (_req, res) => {
  try {
    const suggestions = await suggestDebatesFromContradictions();
    res.json({ suggestions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Explainability ───────────────────────────────────────────────────────────

router.post('/explain', async (req, res) => {
  const { text, personaId, postId, debateMessageId } = req.body;
  if (!text || text.length < 10) return res.status(400).json({ error: 'text required' });
  try {
    const structure = await analyzeArgument(text, { personaId, postId, debateMessageId });
    res.json({ structure });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/explain/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (type !== 'post' && type !== 'debate_message') return res.status(400).json({ error: 'type must be post or debate_message' });
  try {
    const structure = await getStoredAnalysis(type as 'post' | 'debate_message', parseInt(id));
    if (!structure) return res.status(404).json({ error: 'No analysis found' });
    res.json({ structure });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/detect-fallacies', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const fallacies = await detectFallaciesOnly(text);
    res.json({ fallacies });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/explain/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string || '20'), 50);
    const analyses = await getRecentAnalyses(limit);
    res.json({ analyses });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────

router.get('/stats', async (_req, res) => {
  try {
    const [claims, edges, analyses, contradictions] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int as total, COUNT(DISTINCT topic)::int as topics FROM claims`),
      pool.query(`SELECT COUNT(*)::int as total, COUNT(CASE WHEN type='CONTRADICTS' THEN 1 END)::int as contradicts, COUNT(CASE WHEN type='SUPPORTS' THEN 1 END)::int as supports FROM claim_edges`),
      pool.query(`SELECT COUNT(*)::int as total, AVG(jsonb_array_length(fallacies))::numeric(4,2) as avg_fallacies FROM argument_structures`),
      pool.query(`SELECT COUNT(*)::int as total FROM claim_edges WHERE type='CONTRADICTS'`),
    ]);
    res.json({
      claims: claims.rows[0],
      edges: edges.rows[0],
      analyses: analyses.rows[0],
      contradiction_pairs: contradictions.rows[0].total,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
