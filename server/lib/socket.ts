import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import {
  generateCoDebateSuggestion,
  computeLiveScore,
  updateBehaviorProfile,
  BehaviorProfile,
} from './liveIntelligence.js';
import { streamAIResponse } from './streamingAI.js';
import { setWSConnections, recordWSMessage } from './telemetry.js';
import { humanJoin, humanSubmitTurn } from './debateOrchestrator.js';

let io: Server | null = null;

// Per-session behavior profiles: key = `${debateId}:${personaId}`
// TTL cleanup runs every 10 minutes — removes profiles older than 2 hours
const behaviorProfiles = new Map<string, BehaviorProfile & { _updatedAt: number }>();
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of behaviorProfiles.entries()) {
    if (v._updatedAt < cutoff) behaviorProfiles.delete(k);
  }
}, 10 * 60 * 1000);

// Per-socket in-flight guard (prevents parallel Gemini calls from the same socket)
const pendingSuggest = new Set<string>();
const pendingScore   = new Set<string>();
const pendingStream  = new Set<string>();

// Track active WS connections count
let activeConnections = 0;

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['polling', 'websocket'],
  });

  io.on('connection', (socket) => {
    activeConnections++;
    setWSConnections(activeConnections);

    socket.on('disconnect', () => {
      activeConnections = Math.max(0, activeConnections - 1);
      setWSConnections(activeConnections);
      pendingStream.delete(socket.id);
    });

    // ── Standard room management ──────────────────────────────────────────────

    socket.on('register-user', (userId: number) => {
      socket.join(`user:${userId}`);
    });

    socket.on('join-debate', (debateId: number) => {
      socket.join(`debate:${debateId}`);
      const size = io?.sockets.adapter.rooms.get(`debate:${debateId}`)?.size || 0;
      io?.to(`debate:${debateId}`).emit('viewer-count', { count: size });
    });

    socket.on('leave-debate', (debateId: number) => {
      socket.leave(`debate:${debateId}`);
      const size = io?.sockets.adapter.rooms.get(`debate:${debateId}`)?.size || 0;
      io?.to(`debate:${debateId}`).emit('viewer-count', { count: size });
    });

    socket.on('typing', ({ debateId, personaName }: { debateId: number; personaName: string }) => {
      socket.to(`debate:${debateId}`).emit('peer-typing', { personaName });
    });

    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (room.startsWith('debate:')) {
          const size = Math.max(0, (io?.sockets.adapter.rooms.get(room)?.size || 1) - 1);
          io?.to(room).emit('viewer-count', { count: size });
        }
      }
    });

    // ── A. Co-Debate Suggestion Engine ────────────────────────────────────────
    // Client emits this on every debounced keystroke (300ms debounce in frontend).
    // We guard against parallel in-flight calls per socket.

    socket.on('co_debate_suggest', async (payload: {
      text: string;
      personaId: number;
      personaName: string;
      personaTone: string;
      topic: string;
      stance: string;
    }) => {
      const guardKey = `${socket.id}:suggest`;
      if (pendingSuggest.has(guardKey)) return;
      pendingSuggest.add(guardKey);

      try {
        const suggestion = await generateCoDebateSuggestion(
          payload.text,
          payload.personaName || 'Persona',
          payload.personaTone || '',
          payload.topic || '',
          payload.stance || ''
        );
        socket.emit('suggestion', suggestion);
      } catch {
        // Fail silently — suggestions are non-critical
      } finally {
        pendingSuggest.delete(guardKey);
      }
    });

    // ── B. Real-Time Scoring Engine ───────────────────────────────────────────
    // Client emits on debounced keystrokes (600ms debounce in frontend).
    // Scores are returned only to the requesting socket, not broadcast to the room.

    socket.on('live_score', async (payload: {
      text: string;
      debateId: number;
      personaId: number;
    }) => {
      const guardKey = `${socket.id}:score`;
      if (pendingScore.has(guardKey)) return;
      pendingScore.add(guardKey);

      try {
        const score = await computeLiveScore(payload.text);
        socket.emit('score_update', score);

        // Update the behavior profile for this persona in this debate
        const profileKey = `${payload.debateId}:${payload.personaId}`;
        const updated = updateBehaviorProfile(
          behaviorProfiles.get(profileKey),
          payload.debateId,
          payload.personaId,
          score,
          payload.text
        );
        behaviorProfiles.set(profileKey, { ...updated, _updatedAt: Date.now() });

        // Emit the updated opponent strategy back to this socket
        socket.emit('behavior_update', {
          dominantStyle: updated.dominantStyle,
          repetitionScore: updated.repetitionScore,
          avgLogic: updated.avgLogic,
          avgPersuasion: updated.avgPersuasion,
          strategyLabel: updated.strategyLabel,
          strategy: updated.strategy,
          messageCount: updated.messageCount,
        });
      } catch {
        // Fail silently
      } finally {
        pendingScore.delete(guardKey);
      }
    });

    // ── C. Fetch current behavior profile (on join) ───────────────────────────
    socket.on('get_behavior_profile', (payload: { debateId: number; personaId: number }) => {
      const key = `${payload.debateId}:${payload.personaId}`;
      const profile = behaviorProfiles.get(key);
      if (profile) {
        socket.emit('behavior_update', {
          dominantStyle: profile.dominantStyle,
          repetitionScore: profile.repetitionScore,
          avgLogic: profile.avgLogic,
          avgPersuasion: profile.avgPersuasion,
          strategyLabel: profile.strategyLabel,
          strategy: profile.strategy,
          messageCount: profile.messageCount,
        });
      }
    });

    // ── D. AI Token Streaming ─────────────────────────────────────────────────
    // Client sends: { prompt, requestId, context?, cacheKey?, personaId? }
    // Server emits:
    //   token      { token, requestId, index, from_cache?, coalesced? }
    //   stream_done { requestId, total_tokens, latency_ms, ttft_ms }
    //   stream_error { requestId, error, fallback }
    //
    // Guard: one concurrent stream per socket (pendingStream)

    socket.on('ai_stream', async (payload: {
      prompt: string;
      requestId: string;
      context?: string;
      cacheKey?: string;
      personaId?: number;
    }) => {
      if (!payload?.prompt) {
        socket.emit('stream_error', { requestId: payload.requestId, error: 'Missing prompt' });
        return;
      }

      const guard = socket.id;
      if (pendingStream.has(guard)) {
        socket.emit('stream_error', {
          requestId: payload.requestId,
          error: 'A stream is already in progress for this connection',
        });
        return;
      }

      pendingStream.add(guard);
      const t0 = Date.now();

      try {
        await streamAIResponse(socket, payload.prompt, payload.requestId, {
          breakerName: 'gemini-stream',
          context: payload.context || 'default',
          cacheKey: payload.cacheKey,
        });
      } finally {
        pendingStream.delete(guard);
        recordWSMessage(Date.now() - t0);
      }
    });

    // ── E. Stream cancel ─────────────────────────────────────────────────────
    // Client can abort an in-progress stream gracefully
    socket.on('ai_stream_cancel', (payload: { requestId: string }) => {
      pendingStream.delete(socket.id);
      socket.emit('stream_done', {
        requestId: payload?.requestId,
        total_tokens: 0,
        latency_ms: 0,
        cancelled: true,
      });
    });

    // ── F. Live Arena — Human Takeover ────────────────────────────────────────
    // Client emits 'auto_human_join' to take over a side in an autonomous debate
    socket.on('auto_human_join', (payload: { debateId: number; side: 'a' | 'b' }) => {
      if (!payload?.debateId || !payload?.side) return;
      humanJoin(payload.debateId, payload.side);
    });

    // Client emits 'auto_human_turn' when they submit their argument
    socket.on('auto_human_turn', (payload: { debateId: number; content: string }) => {
      if (!payload?.debateId || !payload?.content?.trim()) return;
      humanSubmitTurn(payload.debateId, payload.content.trim());
    });
  });

  return io;
}

export function broadcastToDebate(debateId: number | string, event: string, data: any): void {
  if (io) io.to(`debate:${debateId}`).emit(event, data);
}

export function broadcastToUser(userId: number, event: string, data: any): void {
  if (io) io.to(`user:${userId}`).emit(event, data);
}

export function getIO(): Server | null {
  return io;
}
