import { Router } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';

const router = Router();

// ─── Browse Marketplace ──────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { sort = 'score', tag, limit = 24, offset = 0 } = req.query;

  const orderClause: Record<string, string> = {
    score:     '(0.4 * pm.downloads + 0.3 * pm.rating + 0.2 * (SELECT COUNT(*) FROM debates WHERE persona_a_id = p.id OR persona_b_id = p.id) + 0.1 * EXTRACT(EPOCH FROM (NOW() - pm.published_at)) / -86400) DESC',
    downloads: 'pm.downloads DESC',
    rating:    'pm.rating DESC',
    recent:    'pm.published_at DESC',
    debates:   '(SELECT COUNT(*) FROM debates WHERE persona_a_id = p.id OR persona_b_id = p.id) DESC',
  };

  try {
    const params: any[] = [];
    let where = 'WHERE p.is_public = true AND pm.id IS NOT NULL';
    if (tag) {
      params.push(`{${tag}}`);
      where += ` AND pm.tags @> $${params.length}`;
    }

    params.push(Number(limit), Number(offset));
    const result = await pool.query(
      `SELECT
         p.id, p.name, p.avatar_emoji, p.archetype, p.tone, p.ideology,
         p.description, p.clone_count, p.cloned_from,
         COALESCE(p.trust_score, 100) as trust_score,
         pm.id as marketplace_id, pm.tags, pm.rating, pm.rating_count,
         pm.downloads, pm.featured, pm.published_at,
         (SELECT COUNT(*)::int FROM debates WHERE persona_a_id = p.id OR persona_b_id = p.id) as debate_count,
         (SELECT COUNT(*)::int FROM posts WHERE persona_id = p.id) as post_count
       FROM personas p
       JOIN persona_marketplace pm ON pm.persona_id = p.id
       ${where}
       ORDER BY ${orderClause[sort as string] || orderClause.score}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Get all unique tags for filter sidebar
    const tagsRes = await pool.query(
      `SELECT DISTINCT UNNEST(tags) as tag FROM persona_marketplace ORDER BY tag`
    );

    res.json({
      personas: result.rows,
      tags: tagsRes.rows.map((r: any) => r.tag),
      total: result.rows.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Publish Persona ─────────────────────────────────────────────────────────

router.post('/:personaId/publish', authenticateToken, async (req: AuthRequest, res) => {
  const { personaId } = req.params;
  const { tags = [] } = req.body;
  try {
    const persona = await pool.query(
      'SELECT * FROM personas WHERE id = $1 AND user_id = $2',
      [personaId, req.userId]
    );
    if (!persona.rows.length) return res.status(404).json({ error: 'Persona not found' });

    await pool.query('UPDATE personas SET is_public = true WHERE id = $1', [personaId]);

    await pool.query(
      `INSERT INTO persona_marketplace (persona_id, tags)
       VALUES ($1, $2)
       ON CONFLICT (persona_id) DO UPDATE SET tags = EXCLUDED.tags`,
      [personaId, tags]
    );

    res.json({ success: true, message: 'Persona published to marketplace' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Unpublish Persona ───────────────────────────────────────────────────────

router.delete('/:personaId/publish', authenticateToken, async (req: AuthRequest, res) => {
  const { personaId } = req.params;
  try {
    const persona = await pool.query(
      'SELECT id FROM personas WHERE id = $1 AND user_id = $2',
      [personaId, req.userId]
    );
    if (!persona.rows.length) return res.status(404).json({ error: 'Persona not found' });

    await pool.query('UPDATE personas SET is_public = false WHERE id = $1', [personaId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Clone Persona ────────────────────────────────────────────────────────────

router.post('/:personaId/clone', authenticateToken, async (req: AuthRequest, res) => {
  const { personaId } = req.params;
  try {
    const original = await pool.query(
      `SELECT p.*, pm.id as marketplace_id FROM personas p
       JOIN persona_marketplace pm ON pm.persona_id = p.id
       WHERE p.id = $1 AND p.is_public = true`,
      [personaId]
    );
    if (!original.rows.length) return res.status(404).json({ error: 'Persona not available' });

    const src = original.rows[0];

    // Check user persona limit
    const count = await pool.query('SELECT COUNT(*) FROM personas WHERE user_id = $1', [req.userId]);
    if (parseInt(count.rows[0].count) >= 10) {
      return res.status(400).json({ error: 'Persona limit reached (10 max)' });
    }

    const cloned = await pool.query(
      `INSERT INTO personas
         (user_id, name, avatar_emoji, description, tone, ideology, archetype,
          beliefs, rhetorical_style, taboos, goals, constraints_list,
          tone_formality, tone_emotionality, tone_assertiveness, cloned_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        req.userId,
        `${src.name} (Clone)`,
        src.avatar_emoji,
        src.description || null,
        src.tone,
        src.ideology,
        src.archetype,
        src.beliefs,
        src.rhetorical_style || [],
        src.taboos || [],
        src.goals || [],
        src.constraints_list || [],
        src.tone_formality,
        src.tone_emotionality,
        src.tone_assertiveness,
        personaId,
      ]
    );

    // Increment download/clone counts
    await Promise.all([
      pool.query('UPDATE persona_marketplace SET downloads = downloads + 1 WHERE persona_id = $1', [personaId]),
      pool.query('UPDATE personas SET clone_count = clone_count + 1 WHERE id = $1', [personaId]),
    ]);

    res.json(cloned.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Rate Persona ─────────────────────────────────────────────────────────────

router.post('/:personaId/rate', authenticateToken, async (req: AuthRequest, res) => {
  const { personaId } = req.params;
  const { rating } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });
  try {
    // Incremental rolling average
    await pool.query(
      `UPDATE persona_marketplace
       SET rating = (rating * rating_count + $1) / (rating_count + 1),
           rating_count = rating_count + 1
       WHERE persona_id = $2`,
      [rating, personaId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
