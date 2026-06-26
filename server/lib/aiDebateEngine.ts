import pool from '../db.js';
import { getModel } from './gemini.js';
import { broadcastToDebate } from './socket.js';


// ─── Argument Generation ─────────────────────────────────────────────────────

async function generateArgument(
  personaName: string,
  tone: string,
  ideology: string,
  beliefs: string[],
  topic: string,
  opponentName: string,
  opponentLastMsg: string | null,
  roundNum: number,
  totalRounds: number
): Promise<string> {
  try {
    const model = getModel();
    const isOpening = !opponentLastMsg;
    const isClosing = roundNum === totalRounds;

    const prompt = `You are ${personaName}, a debater with ${tone || 'measured'} tone and ${ideology || 'independent'} ideology.
${beliefs?.length > 0 ? `Your core beliefs: ${beliefs.slice(0, 3).join('; ')}` : ''}

Debate topic: "${topic}"
Round ${roundNum} of ${totalRounds}${isClosing ? ' (CLOSING ARGUMENT — make your strongest final point)' : ''}.

${isOpening
  ? `Open the debate with your clearest position statement on this topic.`
  : `${opponentName} just argued: "${opponentLastMsg?.slice(0, 280)}"

Directly counter their specific point or expose its weakness, then reinforce your position with new reasoning.`}

Rules:
- Stay completely in character as ${personaName}
- Use ${tone || 'direct'} tone throughout
- Be specific — reference concrete examples or principles
- Do NOT use phrases like "As ${personaName}" or start with your name
- Maximum 90 words

Your argument:`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim().slice(0, 600);
  } catch {
    // Rule-based fallback when quota exceeded
    const fallbacks = [
      `The fundamental principle here is clear: ${topic} requires us to consider the long-term consequences of our current trajectory. History shows that ${ideology || 'principled'} approaches consistently outperform reactive ones.`,
      `My opponent raises a superficial point. The real issue with ${topic} is structural — we cannot solve it without first addressing the underlying assumptions that lead to these outcomes.`,
      `Let me be direct: the evidence on ${topic} is not ambiguous. The ${ideology || 'data-driven'} perspective shows that continued inaction compounds the problem exponentially.`,
      `This debate ultimately comes down to values. When we examine ${topic} through a ${ideology || 'principled'} lens, the only defensible position is one that prioritizes long-term stability over short-term convenience.`,
    ];
    return fallbacks[(roundNum - 1) % fallbacks.length];
  }
}

// ─── Main AI Debate Runner ───────────────────────────────────────────────────

export async function runAiDebate(debateId: number): Promise<void> {
  const debateRes = await pool.query(
    `SELECT d.*,
       pa.name as persona_a_name, pa.tone as persona_a_tone,
       pa.ideology as persona_a_ideology, pa.beliefs as persona_a_beliefs,
       pb.name as persona_b_name, pb.tone as persona_b_tone,
       pb.ideology as persona_b_ideology, pb.beliefs as persona_b_beliefs
     FROM debates d
     JOIN personas pa ON d.persona_a_id = pa.id
     JOIN personas pb ON d.persona_b_id = pb.id
     WHERE d.id = $1`,
    [debateId]
  );

  if (!debateRes.rows.length) return;
  const d = debateRes.rows[0];
  const totalRounds = d.rounds_total || 6;

  // Set debate live
  await pool.query("UPDATE debates SET is_live = true, status = 'active' WHERE id = $1", [debateId]);
  broadcastToDebate(debateId, 'debate-started', { debateId, totalRounds });

  let lastMsgA: string | null = null;
  let lastMsgB: string | null = null;

  for (let round = 0; round < totalRounds; round++) {
    const isA = round % 2 === 0;
    const [
      speakerId, speakerName, speakerTone, speakerIdeology, speakerBeliefs,
      opponentName, lastOpponentMsg
    ] = isA
      ? [d.persona_a_id, d.persona_a_name, d.persona_a_tone, d.persona_a_ideology, d.persona_a_beliefs, d.persona_b_name, lastMsgB]
      : [d.persona_b_id, d.persona_b_name, d.persona_b_tone, d.persona_b_ideology, d.persona_b_beliefs, d.persona_a_name, lastMsgA];

    const content = await generateArgument(
      speakerName, speakerTone, speakerIdeology, speakerBeliefs || [],
      d.topic, opponentName, lastOpponentMsg, round + 1, totalRounds
    );

    const msgRes = await pool.query(
      `INSERT INTO debate_messages (debate_id, persona_id, content, is_ai_generated)
       VALUES ($1, $2, $3, true) RETURNING *`,
      [debateId, speakerId, content]
    );

    const msg = {
      ...msgRes.rows[0],
      persona_name: speakerName,
      persona_a: isA,
    };

    broadcastToDebate(debateId, 'new-message', msg);

    if (isA) lastMsgA = content;
    else lastMsgB = content;

    await pool.query('UPDATE debates SET rounds_completed = $1 WHERE id = $2', [round + 1, debateId]);

    // Realistic inter-round pacing (1.5s between turns)
    await new Promise(r => setTimeout(r, 1500));
  }

  await pool.query(
    "UPDATE debates SET status = 'completed', is_live = false WHERE id = $1",
    [debateId]
  );
  broadcastToDebate(debateId, 'debate-complete', { debateId });
}
