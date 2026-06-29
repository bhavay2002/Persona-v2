import { Router } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { compilePersonaPrompt } from '../lib/promptCompiler.js';

const router = Router();

const EMOJIS = ['🎭', '💼', '🌿', '⚖️', '🔬', '🎨', '📰', '🏛️', '💡', '🔥', '🌍', '🤖', '✊', '🧠', '👑', '🦅', '🌱', '⚡'];

function buildSchema(body: any) {
  const {
    name, tone, ideology, expertise, avatarEmoji, archetype,
    toneFormality, toneEmotionality, toneAssertiveness,
    beliefs, rhetoricalStyle, taboos, goals, constraintsList, status
  } = body;

  const expertiseArr = Array.isArray(expertise) ? expertise : (expertise ? String(expertise).split(',').map((s: string) => s.trim()).filter(Boolean) : []);
  const beliefsArr = Array.isArray(beliefs) ? beliefs : [];
  const rhetoricalArr = Array.isArray(rhetoricalStyle) ? rhetoricalStyle : (rhetoricalStyle ? [rhetoricalStyle] : []);
  const taboosArr = Array.isArray(taboos) ? taboos : (taboos ? String(taboos).split(',').map((s: string) => s.trim()).filter(Boolean) : []);
  const goalsArr = Array.isArray(goals) ? goals : (goals ? String(goals).split(',').map((s: string) => s.trim()).filter(Boolean) : []);
  const constraintsArr = Array.isArray(constraintsList) ? constraintsList : (constraintsList ? [constraintsList] : []);
  const emoji = avatarEmoji || EMOJIS[Math.floor(Math.random() * EMOJIS.length)];

  const personaSchema = {
    name: name?.trim(),
    archetype,
    tone: (toneFormality !== undefined || toneEmotionality !== undefined || toneAssertiveness !== undefined) ? {
      formality: parseFloat(toneFormality ?? 0.5),
      emotionality: parseFloat(toneEmotionality ?? 0.5),
      assertiveness: parseFloat(toneAssertiveness ?? 0.5),
    } : undefined,
    beliefs: beliefsArr,
    expertise: expertiseArr,
    rhetorical_style: rhetoricalArr,
    taboos: taboosArr,
    goals: goalsArr,
    constraints_list: constraintsArr,
    legacy_tone: tone,
    ideology,
  };

  const compiled = compilePersonaPrompt(personaSchema);

  return {
    name: name?.trim(),
    avatar_emoji: emoji,
    tone: tone || null,
    ideology: ideology || null,
    archetype: archetype || null,
    expertise: expertiseArr,
    tone_formality: parseFloat(toneFormality ?? 0.5),
    tone_emotionality: parseFloat(toneEmotionality ?? 0.5),
    tone_assertiveness: parseFloat(toneAssertiveness ?? 0.5),
    beliefs: JSON.stringify(beliefsArr),
    rhetorical_style: rhetoricalArr,
    taboos: taboosArr,
    goals: goalsArr,
    constraints_list: constraintsArr,
    ai_prompt_profile: compiled.full,
    status: status || 'active',
  };
}

router.get('/', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, 
        (SELECT COUNT(*) FROM posts WHERE persona_id = p.id) as computed_post_count,
        (SELECT COALESCE(SUM(like_count),0) FROM posts WHERE persona_id = p.id) as total_likes
       FROM personas p WHERE p.user_id = $1 ORDER BY p.created_at DESC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/public', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.avatar_emoji, p.tone, p.ideology, p.archetype,
        p.expertise, p.rhetorical_style, p.tone_formality, p.tone_emotionality,
        p.tone_assertiveness, p.post_count, p.debate_count, p.reputation_score, p.status
       FROM personas p WHERE p.status = 'active'
       ORDER BY p.post_count + p.debate_count DESC LIMIT 30`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM posts WHERE persona_id = p.id) as computed_post_count,
        (SELECT COALESCE(SUM(like_count),0) FROM posts WHERE persona_id = p.id) as total_likes
       FROM personas p WHERE p.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', authenticateToken, async (req: AuthRequest, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  try {
    const schema = buildSchema(req.body);
    const result = await pool.query(
      `INSERT INTO personas (
        user_id, name, avatar_emoji, tone, ideology, archetype, expertise,
        tone_formality, tone_emotionality, tone_assertiveness,
        beliefs, rhetorical_style, taboos, goals, constraints_list,
        ai_prompt_profile, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        req.userId, schema.name, schema.avatar_emoji, schema.tone, schema.ideology,
        schema.archetype, schema.expertise, schema.tone_formality, schema.tone_emotionality,
        schema.tone_assertiveness, schema.beliefs, schema.rhetorical_style,
        schema.taboos, schema.goals, schema.constraints_list,
        schema.ai_prompt_profile, schema.status
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id', authenticateToken, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  try {
    const check = await pool.query('SELECT user_id, version FROM personas WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (check.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your persona' });

    const schema = buildSchema(req.body);
    const newVersion = (check.rows[0].version || 1) + 1;

    const result = await pool.query(
      `UPDATE personas SET
        name=$1, avatar_emoji=$2, tone=$3, ideology=$4, archetype=$5, expertise=$6,
        tone_formality=$7, tone_emotionality=$8, tone_assertiveness=$9,
        beliefs=$10, rhetorical_style=$11, taboos=$12, goals=$13, constraints_list=$14,
        ai_prompt_profile=$15, status=$16, version=$17
       WHERE id=$18 RETURNING *`,
      [
        schema.name, schema.avatar_emoji, schema.tone, schema.ideology, schema.archetype,
        schema.expertise, schema.tone_formality, schema.tone_emotionality,
        schema.tone_assertiveness, schema.beliefs, schema.rhetorical_style,
        schema.taboos, schema.goals, schema.constraints_list,
        schema.ai_prompt_profile, schema.status || 'active', newVersion, id
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/clone', authenticateToken, async (req: AuthRequest, res) => {
  const { id } = req.params;
  try {
    const original = await pool.query('SELECT * FROM personas WHERE id = $1', [id]);
    if (original.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const p = original.rows[0];
    const result = await pool.query(
      `INSERT INTO personas (
        user_id, name, avatar_emoji, tone, ideology, archetype, expertise,
        tone_formality, tone_emotionality, tone_assertiveness,
        beliefs, rhetorical_style, taboos, goals, constraints_list,
        ai_prompt_profile, status, cloned_from
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        req.userId, `${p.name} (Fork)`, p.avatar_emoji, p.tone, p.ideology,
        p.archetype, p.expertise, p.tone_formality, p.tone_emotionality,
        p.tone_assertiveness, p.beliefs, p.rhetorical_style, p.taboos,
        p.goals, p.constraints_list, p.ai_prompt_profile, 'draft', id
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id/status', authenticateToken, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['draft', 'active', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'Status must be draft, active, or archived' });
  }
  try {
    const check = await pool.query('SELECT user_id FROM personas WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (check.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your persona' });

    const result = await pool.query(
      'UPDATE personas SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', authenticateToken, async (req: AuthRequest, res) => {
  const { id } = req.params;
  try {
    const check = await pool.query('SELECT user_id FROM personas WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (check.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your persona' });
    await pool.query('DELETE FROM personas WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
