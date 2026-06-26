// Live Autonomous Debate Orchestrator
//
// Architecture:
//   POST /debates/:id/live-start → runAutonomousDebate(debateId) [fire-and-forget]
//   For each turn:
//     1. Broadcast auto_turn_start  → client shows "thinking" indicator
//     2. Stream tokens via Gemini generateContentStream()
//        → broadcast auto_token per chunk (with side, index)
//     3. After full argument: computeLiveScore() + detectFallaciesOnly() in parallel
//     4. Broadcast auto_turn_end with { score, fallacies, runningScoreA, runningScoreB }
//     5. Save message + scores to DB
//     6. If human has taken over a side: wait for auto_human_turn event instead of AI
//   End: broadcast auto_complete { winner, scoreA, scoreB }
//
// Human takeover:
//   socket event 'auto_human_join' { debateId, side } → humanJoin(debateId, side)
//   socket event 'auto_human_turn' { debateId, content } → humanSubmitTurn(debateId, content)
//   orchestrator checks humanOverrides map before each AI call
//   waits up to 5 minutes for human message before timing out

import { getModel } from './gemini.js';
import pool from '../db.js';
import { broadcastToDebate } from './socket.js';
import { computeLiveScore } from './liveIntelligence.js';
import { detectFallaciesOnly } from './explainabilityEngine.js';


// ─── Human Override State ─────────────────────────────────────────────────────
// debateId → { side: 'a'|'b', active: bool }
export const humanOverrides = new Map<number, { side: 'a' | 'b' }>();
// debateId → Promise resolver waiting for human text
const humanTurnResolvers = new Map<number, (content: string) => void>();
// debateId → AbortController for stopping the loop externally
const activeDebates = new Set<number>();

export function humanJoin(debateId: number, side: 'a' | 'b'): void {
  humanOverrides.set(debateId, { side });
  broadcastToDebate(debateId, 'auto_human_joined', { side });
}

export function humanSubmitTurn(debateId: number, content: string): void {
  const resolve = humanTurnResolvers.get(debateId);
  if (resolve) {
    humanTurnResolvers.delete(debateId);
    resolve(content);
  }
}

export function isDebateRunning(debateId: number): boolean {
  return activeDebates.has(debateId);
}

function waitForHumanTurn(debateId: number): Promise<string> {
  return new Promise((resolve) => {
    humanTurnResolvers.set(debateId, resolve);
    // 5-minute timeout — auto-forfeit
    setTimeout(() => {
      if (humanTurnResolvers.has(debateId)) {
        humanTurnResolvers.delete(debateId);
        resolve('[Human forfeited — argument not submitted in time]');
      }
    }, 5 * 60 * 1000);
  });
}

// ─── Streaming Argument Generator ────────────────────────────────────────────

async function streamArgument(
  debateId: number,
  side: 'a' | 'b',
  personaName: string,
  personaTone: string,
  personaIdeology: string,
  personaBeliefs: string[],
  topic: string,
  opponentName: string,
  opponentLastMsg: string | null,
  roundNum: number,
  totalRounds: number
): Promise<string> {
  const isOpening = !opponentLastMsg;
  const isClosing = roundNum === totalRounds;

  const prompt = `You are ${personaName}, debating with ${personaTone || 'measured'} tone and ${personaIdeology || 'independent'} ideology.
${personaBeliefs?.length > 0 ? `Core beliefs: ${personaBeliefs.slice(0, 3).join('; ')}` : ''}

Debate topic: "${topic}"
Round ${roundNum} of ${totalRounds}${isClosing ? ' (CLOSING ARGUMENT — make your strongest, most memorable final point)' : ''}.

${isOpening
    ? 'Open the debate with your clearest, most confident position statement on this topic.'
    : `${opponentName} just argued: "${opponentLastMsg?.slice(0, 280)}"

Directly counter their specific point or expose its logical weakness, then reinforce your position with a concrete example or principle.`}

Rules:
- Stay completely in character as ${personaName}
- Use ${personaTone || 'direct'} tone throughout  
- Be specific — no vague platitudes
- Do NOT start with your name or "As ${personaName}"
- Maximum 90 words

Your argument:`;

  let fullText = '';
  let tokenIndex = 0;

  try {
    const model = getModel();
    const stream = await model.generateContentStream(prompt);

    for await (const chunk of stream.stream) {
      const text = chunk.text();
      if (!text) continue;
      fullText += text;
      broadcastToDebate(debateId, 'auto_token', { side, token: text, index: tokenIndex++ });
      if (tokenIndex > 600) {
        broadcastToDebate(debateId, 'auto_token', { side, token: '…', index: tokenIndex++ });
        break;
      }
    }
  } catch {
    // Rule-based fallback when Gemini is unavailable
    const fallback = `The evidence on "${topic}" is clear from a ${personaIdeology || 'principled'} standpoint. My opponent's argument relies on assumptions that don't hold under scrutiny — let me show you why.`;
    fullText = fallback;
    broadcastToDebate(debateId, 'auto_token', { side, token: fallback, index: 0 });
  }

  return fullText.trim().slice(0, 600);
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────

export async function runAutonomousDebate(debateId: number): Promise<void> {
  if (activeDebates.has(debateId)) return; // Already running
  activeDebates.add(debateId);

  try {
    const debateRes = await pool.query(
      `SELECT d.*,
         pa.name as persona_a_name, pa.tone as persona_a_tone,
         pa.ideology as persona_a_ideology, pa.beliefs as persona_a_beliefs,
         pa.avatar_emoji as persona_a_emoji,
         pb.name as persona_b_name, pb.tone as persona_b_tone,
         pb.ideology as persona_b_ideology, pb.beliefs as persona_b_beliefs,
         pb.avatar_emoji as persona_b_emoji
       FROM debates d
       JOIN personas pa ON d.persona_a_id = pa.id
       JOIN personas pb ON d.persona_b_id = pb.id
       WHERE d.id = $1`,
      [debateId]
    );

    if (!debateRes.rows.length) return;
    const d = debateRes.rows[0];
    const totalRounds = d.rounds_total || 6;

    // Mark debate live
    await pool.query("UPDATE debates SET is_live = true, status = 'active' WHERE id = $1", [debateId]);

    broadcastToDebate(debateId, 'auto_start', {
      debateId, totalRounds,
      personaA: { name: d.persona_a_name, emoji: d.persona_a_emoji, id: d.persona_a_id },
      personaB: { name: d.persona_b_name, emoji: d.persona_b_emoji, id: d.persona_b_id },
      topic: d.topic,
    });

    let lastMsgA: string | null = null;
    let lastMsgB: string | null = null;
    const scoresA: number[] = [];
    const scoresB: number[] = [];

    for (let round = 0; round < totalRounds; round++) {
      const isA = round % 2 === 0;
      const side: 'a' | 'b' = isA ? 'a' : 'b';

      const speakerId      = isA ? d.persona_a_id        : d.persona_b_id;
      const speakerName    = isA ? d.persona_a_name      : d.persona_b_name;
      const speakerTone    = isA ? d.persona_a_tone      : d.persona_b_tone;
      const speakerIdeolog = isA ? d.persona_a_ideology  : d.persona_b_ideology;
      const speakerBeliefs = isA ? (d.persona_a_beliefs || []) : (d.persona_b_beliefs || []);
      const opponentName   = isA ? d.persona_b_name      : d.persona_a_name;
      const lastOpponent   = isA ? lastMsgB              : lastMsgA;

      // Signal turn start — client shows "thinking" animation
      broadcastToDebate(debateId, 'auto_turn_start', {
        side, personaName: speakerName, turnNum: round + 1, totalTurns: totalRounds,
      });

      // Brief thinking pause for UX drama
      await new Promise(r => setTimeout(r, 900));

      // Check if human has taken over this side
      const override = humanOverrides.get(debateId);
      let content: string;
      let isHumanTurn = false;

      if (override?.side === side) {
        isHumanTurn = true;
        broadcastToDebate(debateId, 'auto_human_turn_request', {
          side, personaName: speakerName, turnNum: round + 1,
        });
        content = await waitForHumanTurn(debateId);
      } else {
        content = await streamArgument(
          debateId, side, speakerName, speakerTone, speakerIdeolog, speakerBeliefs,
          d.topic, opponentName, lastOpponent, round + 1, totalRounds
        );
      }

      // Save message to DB
      const msgRes = await pool.query(
        `INSERT INTO debate_messages (debate_id, persona_id, content, ai_generated, msg_type)
         VALUES ($1, $2, $3, $4, 'argument') RETURNING *`,
        [debateId, speakerId, content, !isHumanTurn]
      );
      const msgId = msgRes.rows[0].id;

      // Score + fallacy detection in parallel — non-blocking
      const [score, fallacies] = await Promise.all([
        computeLiveScore(content).catch(() => null),
        detectFallaciesOnly(content).catch(() => []),
      ]);

      // Persist scores
      if (score) {
        await pool.query(
          `UPDATE debate_messages SET logic_score = $1, persuasiveness_score = $2, fallacies = $3 WHERE id = $4`,
          [score.logic_score, score.persuasiveness, JSON.stringify(fallacies), msgId]
        ).catch(() => {});
      }

      // Update running averages
      if (isA) scoresA.push(score?.overall ?? 0);
      else      scoresB.push(score?.overall ?? 0);

      const avgA = scoresA.length ? scoresA.reduce((a, b) => a + b, 0) / scoresA.length : 0;
      const avgB = scoresB.length ? scoresB.reduce((a, b) => a + b, 0) / scoresB.length : 0;

      // Broadcast completed turn with full intelligence overlay
      broadcastToDebate(debateId, 'auto_turn_end', {
        side, personaName: speakerName, content, msgId,
        score,
        fallacies,
        runningScoreA: Math.round(avgA * 100),
        runningScoreB: Math.round(avgB * 100),
        turnNum: round + 1,
        isHumanTurn,
      });

      await pool.query('UPDATE debates SET rounds_completed = $1 WHERE id = $2', [round + 1, debateId]);

      if (isA) lastMsgA = content;
      else     lastMsgB = content;

      // Inter-turn pause
      await new Promise(r => setTimeout(r, 1200));
    }

    // Wrap up
    const avgA = scoresA.length ? scoresA.reduce((a, b) => a + b, 0) / scoresA.length : 0;
    const avgB = scoresB.length ? scoresB.reduce((a, b) => a + b, 0) / scoresB.length : 0;
    const winner = avgA > avgB + 0.03 ? 'a' : avgB > avgA + 0.03 ? 'b' : 'draw';

    await pool.query(
      "UPDATE debates SET status = 'completed', is_live = false WHERE id = $1",
      [debateId]
    );

    humanOverrides.delete(debateId);

    broadcastToDebate(debateId, 'auto_complete', {
      debateId, winner,
      scoreA: Math.round(avgA * 100),
      scoreB: Math.round(avgB * 100),
      personaAName: d.persona_a_name,
      personaBName: d.persona_b_name,
    });

  } finally {
    activeDebates.delete(debateId);
  }
}
