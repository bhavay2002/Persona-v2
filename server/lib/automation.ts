import pool from '../db.js';
import { addJob } from './jobQueue.js';
import { createNotification } from './notifier.js';

export interface AutomationEvent {
  type: 'post_created' | 'post_liked' | 'debate_voted' | 'persona_created';
  userId: number;
  personaId?: number;
  entityId: number;
}

export async function runAutomation(event: AutomationEvent): Promise<void> {
  try {
    switch (event.type) {
      case 'post_created':   await handlePostCreated(event);   break;
      case 'post_liked':     await handlePostLiked(event);     break;
      case 'debate_voted':   await handleDebateVoted(event);   break;
      case 'persona_created': await handlePersonaCreated(event); break;
    }
  } catch (err) {
    console.warn('Automation engine error:', err);
  }
}

async function handlePostCreated(event: AutomationEvent): Promise<void> {
  if (!event.personaId) return;
  const { rows } = await pool.query(
    'SELECT post_count, last_evolved_at, name FROM personas WHERE id = $1',
    [event.personaId]
  );
  if (!rows.length) return;
  const { post_count, last_evolved_at, name } = rows[0];

  if (post_count > 0 && post_count % 10 === 0) {
    const daysSince = last_evolved_at
      ? (Date.now() - new Date(last_evolved_at).getTime()) / 86_400_000
      : Infinity;
    if (daysSince > 1) {
      addJob('evolve-persona-auto', { personaId: event.personaId, userId: event.userId });
      await createNotification(
        event.userId, 'milestone', 'Evolution Triggered',
        `${name} hit ${post_count} posts — auto-evolution queued.`,
        'persona', event.personaId
      );
    }
  }
}

async function handlePostLiked(event: AutomationEvent): Promise<void> {
  const { rows } = await pool.query(
    'SELECT like_count, persona_id FROM posts WHERE id = $1',
    [event.entityId]
  );
  if (!rows.length) return;
  const { like_count, persona_id } = rows[0];

  if (like_count === 10) {
    await pool.query(
      'UPDATE personas SET reputation_score = LEAST(100, reputation_score + 5) WHERE id = $1',
      [persona_id]
    );
    await createNotification(
      event.userId, 'milestone', 'Post Milestone',
      'Your post reached 10 likes — persona reputation +5.',
      'post', event.entityId
    );
  }
}

async function handleDebateVoted(event: AutomationEvent): Promise<void> {
  const { rows } = await pool.query(
    'SELECT votes_a, votes_b FROM debates WHERE id = $1',
    [event.entityId]
  );
  if (!rows.length) return;
  const total = rows[0].votes_a + rows[0].votes_b;

  if (total === 5) {
    await pool.query(
      'UPDATE debates SET quality_score = LEAST(100, quality_score + 8) WHERE id = $1',
      [event.entityId]
    );
  }
}

async function handlePersonaCreated(event: AutomationEvent): Promise<void> {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int as cnt FROM personas WHERE user_id = $1',
    [event.userId]
  );
  if (rows[0].cnt === 1) {
    await pool.query(
      'UPDATE users SET trust_score = trust_score + 10 WHERE id = $1',
      [event.userId]
    );
  }
}
