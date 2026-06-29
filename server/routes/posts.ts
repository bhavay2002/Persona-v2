import { Router } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { addJob } from '../lib/jobQueue.js';
import { invalidateFeed, invalidatePersona } from '../lib/cache.js';
import { logActivity } from '../lib/activityLogger.js';
import { createNotification } from '../lib/notifier.js';
import { runAutomation } from '../lib/automation.js';

const router = Router();

router.get('/', async (req, res) => {
  const { tag, personaId, limit = 20, offset = 0 } = req.query;
  try {
    let query = `
      SELECT p.*, pe.name as persona_name, pe.avatar_emoji, pe.tone, pe.ideology
      FROM posts p
      JOIN personas pe ON p.persona_id = pe.id
    `;
    const params: any[] = [];
    const conditions: string[] = [];

    if (tag) {
      params.push(`{${tag}}`);
      conditions.push(`p.topic_tags @> $${params.length}`);
    }
    if (personaId) {
      params.push(personaId);
      conditions.push(`p.persona_id = $${params.length}`);
    }
    if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ` ORDER BY p.like_count DESC, p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, pe.name as persona_name, pe.avatar_emoji, pe.tone, pe.ideology
       FROM posts p JOIN personas pe ON p.persona_id = pe.id WHERE p.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', authenticateToken, async (req: AuthRequest, res) => {
  const { personaId, content, originalContent, topicTags, aiGenerated } = req.body;
  if (!personaId || !content) return res.status(400).json({ error: 'personaId and content required' });

  try {
    const personaCheck = await pool.query('SELECT user_id, ai_prompt_profile FROM personas WHERE id = $1', [personaId]);
    if (personaCheck.rows.length === 0) return res.status(404).json({ error: 'Persona not found' });
    if (personaCheck.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your persona' });

    const tagsArr = Array.isArray(topicTags) ? topicTags : (topicTags ? [topicTags] : []);
    const result = await pool.query(
      `INSERT INTO posts (persona_id, user_id, content, original_content, topic_tags, ai_generated)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [personaId, req.userId, content, originalContent || null, tagsArr, aiGenerated || false]
    );
    await pool.query('UPDATE personas SET post_count = post_count + 1 WHERE id = $1', [personaId]);

    const post = result.rows[0];
    const peResult = await pool.query('SELECT name, avatar_emoji, tone, ideology FROM personas WHERE id = $1', [personaId]);

    invalidateFeed();
    invalidatePersona(personaId);

    // Queue background evaluation + moderation + trust jobs
    if (aiGenerated && personaCheck.rows[0].ai_prompt_profile) {
      addJob('evaluate-post', {
        postId: post.id,
        personaId,
        personaProfile: personaCheck.rows[0].ai_prompt_profile,
        userInput: originalContent || content,
        aiOutput: content,
      });
    }
    addJob('classify-thinking-style', { postId: post.id, content });
    addJob('cognitive-analysis', { postId: post.id, content, personaId });
    addJob('moderate-post', { postId: post.id, content });
    addJob('check-persona-abuse', { personaId });
    addJob('update-persona-trust', { personaId });

    // Activity log + automation (non-blocking)
    logActivity({ userId: req.userId!, personaId, entityType: 'post', entityId: post.id, action: 'post_created', metadata: { tags: tagsArr, aiGenerated } });
    runAutomation({ type: 'post_created', userId: req.userId!, personaId, entityId: post.id });

    res.json({ ...post, ...peResult.rows[0], persona_name: peResult.rows[0].name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/like', authenticateToken, async (req: AuthRequest, res) => {
  const { id } = req.params;
  try {
    const existing = await pool.query('SELECT id FROM post_likes WHERE post_id = $1 AND user_id = $2', [id, req.userId]);
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [id, req.userId]);
      await pool.query('UPDATE posts SET like_count = like_count - 1 WHERE id = $1', [id]);
      invalidateFeed();
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)', [id, req.userId]);
      await pool.query('UPDATE posts SET like_count = like_count + 1 WHERE id = $1', [id]);
      invalidateFeed();

      // Find who owns this post's persona to notify them
      const postOwner = await pool.query(
        `SELECT pe.user_id, pe.name as persona_name, p.id as post_id
         FROM posts p JOIN personas pe ON p.persona_id = pe.id WHERE p.id = $1`,
        [id]
      );
      if (postOwner.rows.length > 0) {
        const { user_id, persona_name } = postOwner.rows[0];
        if (user_id !== req.userId) {
          createNotification(user_id, 'post_liked', 'Post Liked',
            `Someone liked a post by ${persona_name}.`, 'post', parseInt(id));
        }
      }

      logActivity({ userId: req.userId!, entityType: 'like', entityId: parseInt(id), action: 'post_liked' });
      runAutomation({ type: 'post_liked', userId: req.userId!, entityId: parseInt(id) });

      res.json({ liked: true });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
