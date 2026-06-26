import pool from '../db.js';
import { broadcastToUser } from './socket.js';

export async function createNotification(
  userId: number,
  type: string,
  title: string,
  message: string,
  entityType?: string,
  entityId?: number
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, type, title, message, entityType ?? null, entityId ?? null]
    );
    broadcastToUser(userId, 'new-notification', { type, title, message });
  } catch {
    // Never crash the caller — notifications are non-critical
  }
}
