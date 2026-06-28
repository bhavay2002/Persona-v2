import { Router } from 'express';
import pool from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { classifyMessageType, computeDebateQuality } from '../lib/debateEngine.js';
import { addJob } from '../lib/jobQueue.js';
import { invalidateFeed } from '../lib/cache.js';
import { logActivity } from '../lib/activityLogger.js';
import { createNotification } from '../lib/notifier.js';
import { runAutomation } from '../lib/automation.js';
import { broadcastToDebate } from '../lib/socket.js';
import { runAutonomousDebate, isDebateRunning } from '../lib/debateOrchestrator.js';

const router = Router();

router.get('/', async (req, res) => {
  const { status, limit = 20, offset = 0 } = req.query;
  try {
    let query = `
      SELECT d.*,
        pa.name as persona_a_name, pa.avatar_emoji as persona_a_emoji,
        pa.archetype as persona_a_archetype, pa.tone as persona_a_tone,
        pb.name as persona_b_name, pb.avatar_emoji as persona_b_emoji,
        pb.archetype as persona_b_archetype,
        (SELECT COUNT(*)::int FROM debate_messages dm WHERE dm.debate_id = d.id) as message_count
      FROM debates d
      JOIN personas pa ON d.persona_a_id = pa.id
      LEFT JOIN personas pb ON d.persona_b_id = pb.id
    `;
    const params: any[] = [];
    if (status) {
      params.push(status);
      query += ` WHERE d.status = $${params.length}`;
    }
    query += ` ORDER BY d.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
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
    const debate = await pool.query(
      `SELECT d.*,
        pa.name as persona_a_name, pa.avatar_emoji as persona_a_emoji,
        pa.tone as persona_a_tone, pa.archetype as persona_a_archetype,
        pa.tone_formality as pa_formality, pa.tone_assertiveness as pa_assertiveness,
        pb.name as persona_b_name, pb.avatar_emoji as persona_b_emoji,
        pb.tone as persona_b_tone, pb.archetype as persona_b_archetype
       FROM debates d
       JOIN personas pa ON d.persona_a_id = pa.id
       LEFT JOIN personas pb ON d.persona_b_id = pb.id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (debate.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const messages = await pool.query(
      `SELECT dm.*, pe.name as persona_name, pe.avatar_emoji
       FROM debate_messages dm
       JOIN personas pe ON dm.persona_id = pe.id
       WHERE dm.debate_id = $1 ORDER BY dm.created_at ASC`,
      [req.params.id]
    );
    res.json({ ...debate.rows[0], messages: messages.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', authenticateToken, async (req: AuthRequest, res) => {
  const { topic, description, personaAId, personaBId, stanceA, stanceB } = req.body;
  if (!topic || !personaAId) return res.status(400).json({ error: 'topic and personaAId required' });

  try {
    const personaCheck = await pool.query('SELECT user_id FROM personas WHERE id = $1', [personaAId]);
    if (personaCheck.rows.length === 0) return res.status(404).json({ error: 'Persona not found' });
    if (personaCheck.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your persona' });

    const result = await pool.query(
      `INSERT INTO debates (topic, description, persona_a_id, persona_b_id, status, stance_a, stance_b)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [topic, description || null, personaAId, personaBId || null,
       personaBId ? 'active' : 'open', stanceA || null, stanceB || null]
    );
    await pool.query('UPDATE personas SET debate_count = debate_count + 1 WHERE id = $1', [personaAId]);
    invalidateFeed();

    const debate = result.rows[0];
    logActivity({ userId: req.userId!, personaId: personaAId, entityType: 'debate', entityId: debate.id, action: 'debate_created', metadata: { topic } });

    res.json(debate);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/join', authenticateToken, async (req: AuthRequest, res) => {
  const { personaBId, stanceB } = req.body;
  const { id } = req.params;
  try {
    const debate = await pool.query('SELECT * FROM debates WHERE id = $1', [id]);
    if (debate.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (debate.rows[0].status !== 'open') return res.status(400).json({ error: 'Debate not open to join' });

    const personaCheck = await pool.query('SELECT user_id FROM personas WHERE id = $1', [personaBId]);
    if (personaCheck.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your persona' });

    const result = await pool.query(
      `UPDATE debates SET persona_b_id = $1, status = 'active', stance_b = $2 WHERE id = $3 RETURNING *`,
      [personaBId, stanceB || null, id]
    );
    await pool.query('UPDATE personas SET debate_count = debate_count + 1 WHERE id = $1', [personaBId]);
    invalidateFeed();

    // Notify the debate creator that someone joined
    const creatorPersona = await pool.query(
      'SELECT pe.user_id, pe.name FROM personas pe WHERE pe.id = $1',
      [debate.rows[0].persona_a_id]
    );
    if (creatorPersona.rows.length > 0 && creatorPersona.rows[0].user_id !== req.userId) {
      createNotification(creatorPersona.rows[0].user_id, 'debate_message',
        'Challenger Joined', `Someone joined your debate: "${debate.rows[0].topic.slice(0, 60)}..."`,
        'debate', parseInt(id));
    }

    logActivity({ userId: req.userId!, personaId: personaBId, entityType: 'debate', entityId: parseInt(id), action: 'debate_joined' });

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/message', authenticateToken, async (req: AuthRequest, res) => {
  const { personaId, content, aiGenerated } = req.body;
  const { id } = req.params;
  if (!personaId || !content) return res.status(400).json({ error: 'personaId and content required' });

  try {
    const personaCheck = await pool.query('SELECT user_id, ai_prompt_profile FROM personas WHERE id = $1', [personaId]);
    if (personaCheck.rows.length === 0) return res.status(404).json({ error: 'Persona not found' });
    if (personaCheck.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your persona' });

    const msgCount = await pool.query('SELECT COUNT(*)::int as cnt FROM debate_messages WHERE debate_id = $1', [id]);
    const isFirst = msgCount.rows[0].cnt === 0;
    const msgType = classifyMessageType(content, isFirst);

    const result = await pool.query(
      `INSERT INTO debate_messages (debate_id, persona_id, content, ai_generated, msg_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, personaId, content, aiGenerated || false, msgType]
    );
    const msg = result.rows[0];
    const pe = await pool.query('SELECT name, avatar_emoji FROM personas WHERE id = $1', [personaId]);
    const fullMsg = { ...msg, persona_name: pe.rows[0].name, avatar_emoji: pe.rows[0].avatar_emoji };

    invalidateFeed();

    // Queue analysis + evaluation jobs
    addJob('analyze-debate-message', { messageId: msg.id, content, debateId: id });
    if (aiGenerated && personaCheck.rows[0].ai_prompt_profile) {
      addJob('evaluate-debate-message', {
        messageId: msg.id,
        personaProfile: personaCheck.rows[0].ai_prompt_profile,
        userInput: content,
        aiOutput: content,
      });
    }

    // Broadcast to all clients viewing this debate in real-time
    broadcastToDebate(id, 'new-message', fullMsg);

    // Notify the opponent
    const debate = await pool.query('SELECT persona_a_id, persona_b_id, topic FROM debates WHERE id = $1', [id]);
    if (debate.rows.length > 0) {
      const { persona_a_id, persona_b_id, topic } = debate.rows[0];
      const opponentPersonaId = personaId === persona_a_id ? persona_b_id : persona_a_id;
      if (opponentPersonaId) {
        const opponent = await pool.query('SELECT user_id FROM personas WHERE id = $1', [opponentPersonaId]);
        if (opponent.rows.length > 0 && opponent.rows[0].user_id !== req.userId) {
          createNotification(opponent.rows[0].user_id, 'debate_message', 'New Debate Reply',
            `${pe.rows[0].name} replied in: "${topic.slice(0, 55)}..."`, 'debate', parseInt(id));
        }
      }
    }

    logActivity({ userId: req.userId!, personaId, entityType: 'debate_message', entityId: msg.id, action: 'debate_message_sent', metadata: { debateId: parseInt(id), msgType } });

    res.json(fullMsg);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/vote', authenticateToken, async (req: AuthRequest, res) => {
  const { votedFor } = req.body;
  const debateId = parseInt(req.params.id, 10);
  if (isNaN(debateId)) return res.status(400).json({ error: 'Invalid debate ID' });
  if (!['a', 'b'].includes(votedFor)) return res.status(400).json({ error: 'votedFor must be a or b' });

  try {
    const existing = await pool.query(
      'SELECT id FROM debate_votes WHERE debate_id = $1 AND user_id = $2', [debateId, req.userId]
    );
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Already voted' });

    await pool.query('INSERT INTO debate_votes (debate_id, user_id, voted_for) VALUES ($1, $2, $3)', [debateId, req.userId, votedFor]);
    const updateVotes = votedFor === 'a'
      ? 'UPDATE debates SET votes_a = votes_a + 1 WHERE id = $1'
      : 'UPDATE debates SET votes_b = votes_b + 1 WHERE id = $1';
    await pool.query(updateVotes, [debateId]);
    const updated = await pool.query('SELECT votes_a, votes_b FROM debates WHERE id = $1', [debateId]);
    const votes = updated.rows[0];

    // Broadcast updated vote counts to all debate viewers
    broadcastToDebate(String(debateId), 'vote-update', votes);

    // Notify both debaters
    const debate = await pool.query(
      `SELECT d.topic, pa.user_id as uid_a, pb.user_id as uid_b
       FROM debates d
       JOIN personas pa ON d.persona_a_id = pa.id
       LEFT JOIN personas pb ON d.persona_b_id = pb.id
       WHERE d.id = $1`, [debateId]
    );
    if (debate.rows.length > 0) {
      const { topic, uid_a, uid_b } = debate.rows[0];
      const shortTopic = topic.slice(0, 55);
      [uid_a, uid_b].forEach(uid => {
        if (uid && uid !== req.userId) {
          createNotification(uid, 'debate_vote', 'New Vote Cast',
            `Someone voted in: "${shortTopic}..."`, 'debate', debateId);
        }
      });
    }

    logActivity({ userId: req.userId!, entityType: 'vote', entityId: debateId, action: 'debate_voted', metadata: { side: votedFor } });
    runAutomation({ type: 'debate_voted', userId: req.userId!, entityId: debateId });

    res.json({ success: true, votes });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── AI vs AI Debate (Live Streaming Mode) ───────────────────────────────────

router.post('/ai-vs-ai', authenticateToken, async (req: AuthRequest, res) => {
  const { topic, description, personaAId, personaBId, rounds = 6 } = req.body;
  if (!topic || !personaAId || !personaBId) {
    return res.status(400).json({ error: 'topic, personaAId, and personaBId are required' });
  }
  try {
    const [checkA, checkB] = await Promise.all([
      pool.query('SELECT user_id FROM personas WHERE id = $1', [personaAId]),
      pool.query('SELECT id FROM personas WHERE id = $1', [personaBId]),
    ]);
    if (!checkA.rows.length || checkA.rows[0].user_id !== req.userId) {
      return res.status(403).json({ error: 'Persona A must be yours' });
    }
    if (!checkB.rows.length) return res.status(404).json({ error: 'Opponent persona not found' });

    const result = await pool.query(
      `INSERT INTO debates (topic, description, persona_a_id, persona_b_id, status, is_ai_generated, rounds_total, rounds_completed)
       VALUES ($1, $2, $3, $4, 'pending', true, $5, 0) RETURNING *`,
      [topic, description || null, personaAId, personaBId, Math.min(parseInt(rounds) || 6, 10)]
    );
    const debate = result.rows[0];

    invalidateFeed();

    logActivity({
      userId: req.userId!,
      personaId: parseInt(personaAId),
      entityType: 'debate',
      entityId: debate.id,
      action: 'debate_created',
      metadata: { topic, ai_generated: true },
    });

    // Return debate immediately — client calls /live-start to begin streaming
    res.json({ ...debate, _live_mode: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Live Streaming Start ─────────────────────────────────────────────────────
// Called by LiveDebateArena on mount. Triggers the autonomous streaming orchestrator.

router.post('/:id/live-start', authenticateToken, async (req: AuthRequest, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid debate ID' });

  try {
    const debateRes = await pool.query(
      `SELECT d.*, pa.user_id as owner_id
       FROM debates d
       JOIN personas pa ON d.persona_a_id = pa.id
       WHERE d.id = $1`,
      [id]
    );
    if (!debateRes.rows.length) return res.status(404).json({ error: 'Debate not found' });
    const debate = debateRes.rows[0];

    if (debate.owner_id !== req.userId) {
      return res.status(403).json({ error: 'Only the debate owner can start it' });
    }
    if (debate.status === 'active' || debate.status === 'completed') {
      return res.json({ already_running: true, status: debate.status });
    }
    if (isDebateRunning(id)) {
      return res.json({ already_running: true, status: 'active' });
    }

    // Fire-and-forget — the orchestrator runs independently and streams via WebSocket
    runAutonomousDebate(id).catch((err: any) => {
      console.error(`[orchestrator] Debate ${id} failed:`, err?.message || err);
    });

    res.json({ started: true, debateId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
