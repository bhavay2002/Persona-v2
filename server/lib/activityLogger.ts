import pool from '../db.js';

export interface ActivityEvent {
  userId: number;
  personaId?: number;
  entityType: 'post' | 'debate' | 'debate_message' | 'persona' | 'vote' | 'like';
  entityId: number;
  action: string;
  metadata?: Record<string, any>;
}

export async function logActivity(event: ActivityEvent): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO activity_log (user_id, persona_id, entity_type, entity_id, action, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [event.userId, event.personaId ?? null, event.entityType, event.entityId,
       event.action, JSON.stringify(event.metadata || {})]
    );
  } catch {
    // Never crash the caller — activity log is non-critical
  }
}
