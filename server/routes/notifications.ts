import { Router } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.get('/', authenticateToken, async (req: AuthRequest, res) => {
  const { limit = 30 } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.userId, limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/count', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*)::int as count FROM notifications WHERE user_id = $1 AND read = false',
      [req.userId]
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/read-all', authenticateToken, async (req: AuthRequest, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read = true WHERE user_id = $1 AND read = false',
      [req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id/read', authenticateToken, async (req: AuthRequest, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
