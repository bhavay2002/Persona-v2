import { Router } from 'express';
import {
  runOfflineEval, runShadowTest, aggregateOnlineMetrics,
  getEvalHistory, getModelVersions, getShadowTests, getOnlineMetricsHistory,
  loadDataset, listDatasets,
} from '../lib/evaluationRunner.js';
import { hardenedRAG, syncPostsToRAG, getRAGStats, ingestDocument } from '../lib/rag.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import pool from '../db.js';

const router = Router();

// ─── Eval Datasets ────────────────────────────────────────────────────────────

router.get('/datasets', async (_req, res) => {
  try {
    const names = listDatasets();
    const datasets = names.map(name => {
      const d = loadDataset(name);
      return d ? { name, version: d.version, task: d.task, description: d.description, sample_count: d.samples.length } : null;
    }).filter(Boolean);
    res.json({ datasets });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Run Offline Eval ─────────────────────────────────────────────────────────

router.post('/run', async (req, res) => {
  const { dataset_name, model_version = 'v1.0', fast_mode = true } = req.body;
  if (!dataset_name) return res.status(400).json({ error: 'dataset_name required' });

  try {
    const result = await runOfflineEval(dataset_name, model_version, fast_mode);
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Eval History ─────────────────────────────────────────────────────────────

router.get('/history', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string || '30'), 100);
  try {
    const history = await getEvalHistory(limit);
    res.json({ history });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Model Versions ───────────────────────────────────────────────────────────

router.get('/versions', async (_req, res) => {
  try {
    const versions = await getModelVersions();
    res.json({ versions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/versions', authenticateToken, async (req: AuthRequest, res) => {
  const { version_name, config, status = 'shadow' } = req.body;
  if (!version_name || !config) return res.status(400).json({ error: 'version_name and config required' });
  try {
    const result = await pool.query(
      `INSERT INTO model_versions (version_name, config, status) VALUES ($1, $2, $3)
       ON CONFLICT (version_name) DO UPDATE SET config = EXCLUDED.config, status = EXCLUDED.status
       RETURNING *`,
      [version_name, JSON.stringify(config), status]
    );
    res.json({ version: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/versions/:name', authenticateToken, async (req: AuthRequest, res) => {
  const { status } = req.body;
  if (!['active', 'shadow', 'retired', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  try {
    await pool.query('UPDATE model_versions SET status=$1 WHERE version_name=$2', [status, req.params.name]);
    res.json({ updated: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Regression Gate ──────────────────────────────────────────────────────────

router.get('/gate', async (req, res) => {
  const { dataset_name } = req.query;
  try {
    // Latest 2 runs for each dataset
    const query = dataset_name
      ? `SELECT * FROM eval_runs WHERE dataset_name = $1 ORDER BY created_at DESC LIMIT 5`
      : `SELECT DISTINCT ON (model_version, dataset_name) *
         FROM eval_runs ORDER BY model_version, dataset_name, created_at DESC`;
    const result = await pool.query(query, dataset_name ? [dataset_name] : []);

    // Gate summary: for each dataset, compare latest vs previous
    const grouped: Record<string, any[]> = {};
    for (const row of result.rows) {
      if (!grouped[row.dataset_name]) grouped[row.dataset_name] = [];
      grouped[row.dataset_name].push(row);
    }

    const gateSummary = Object.entries(grouped).map(([dataset, runs]) => ({
      dataset,
      latest: runs[0],
      passed: runs[0]?.passed_gate,
      comparison: runs.length > 1 ? {
        accuracy_delta: parseFloat(runs[0].accuracy) - parseFloat(runs[1].accuracy),
        f1_delta:       parseFloat(runs[0].f1_score) - parseFloat(runs[1].f1_score),
        brier_delta:    parseFloat(runs[0].brier_score) - parseFloat(runs[1].brier_score),
        prev_version:   runs[1].model_version,
      } : null,
    }));

    res.json({ gate_summary: gateSummary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Shadow Testing ───────────────────────────────────────────────────────────

router.post('/shadow', async (req, res) => {
  const { text, version_a = 'v1.0', version_b = 'v1.1' } = req.body;
  if (!text || text.length < 20) return res.status(400).json({ error: 'text required (min 20 chars)' });

  try {
    const result = await runShadowTest(text, version_a, version_b);
    res.json({ result, version_a, version_b });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/shadow', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string || '10'), 50);
  try {
    const tests = await getShadowTests(limit);
    res.json({ tests });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Online Metrics ───────────────────────────────────────────────────────────

router.get('/online', async (req, res) => {
  const { model_version, days } = req.query;
  try {
    const [current, history] = await Promise.all([
      aggregateOnlineMetrics((model_version as string) || 'v1.0'),
      getOnlineMetricsHistory(parseInt(days as string || '14')),
    ]);
    res.json({ current, history });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RAG: Hardened Query ──────────────────────────────────────────────────────

router.post('/rag/query', async (req, res) => {
  const { query, top_k = 5, skip_grounding = false } = req.body;
  if (!query || query.length < 5) return res.status(400).json({ error: 'query required' });

  try {
    const result = await hardenedRAG(query, {
      topK: Math.min(parseInt(top_k), 10),
      skipGrounding: skip_grounding,
    });
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RAG: Stats ───────────────────────────────────────────────────────────────

router.get('/rag/stats', async (_req, res) => {
  try {
    const stats = await getRAGStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RAG: Document Ingestion ─────────────────────────────────────────────────

router.post('/rag/ingest', async (req, res) => {
  const { content, title, source, source_quality, topic, doc_type } = req.body;
  if (!content || content.length < 20) return res.status(400).json({ error: 'content required' });

  try {
    const id = await ingestDocument({ content, title, source, source_quality, topic, doc_type });
    res.json({ doc_id: id, message: 'Document ingested into RAG store' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RAG: Sync Posts ─────────────────────────────────────────────────────────

router.post('/rag/sync-posts', async (req, res) => {
  const { limit = 50 } = req.body;
  try {
    const count = await syncPostsToRAG(parseInt(limit));
    res.json({ ingested: count, message: `${count} posts synced to RAG document store` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RAG: Documents list ─────────────────────────────────────────────────────

router.get('/rag/documents', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string || '20'), 100);
  try {
    const result = await pool.query(
      `SELECT id, LEFT(content, 120) as content_preview, title, source, source_quality, topic, doc_type, created_at
       FROM rag_documents ORDER BY created_at DESC LIMIT $1`, [limit]
    );
    const countRes = await pool.query('SELECT COUNT(*)::int as total FROM rag_documents');
    res.json({ documents: result.rows, total: countRes.rows[0].total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
