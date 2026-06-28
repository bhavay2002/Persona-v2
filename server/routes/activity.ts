import { Router } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';

const router = Router();

router.get('/', authenticateToken, async (req: AuthRequest, res) => {
  const { limit = 30, offset = 0 } = req.query;
  try {
    const result = await pool.query(
      `SELECT al.*, pe.name as persona_name, pe.avatar_emoji as persona_emoji
       FROM activity_log al
       LEFT JOIN personas pe ON al.persona_id = pe.id
       WHERE al.user_id = $1
       ORDER BY al.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
