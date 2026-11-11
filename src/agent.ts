// The plan advisor. It reads a short Ladder self-check (me, obstacles, goal),
// asks at most one clarifying question and then picks a plan id with a reason.
// It never sees or writes prices: the server owns the catalog.

import { isPlanId, type PlanId } from './catalog.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Ladder {
  me: string;
  obstacles: string[];
  goal: string;
}

export interface AgentTurn {
  reply: string;
  stage: 'ask' | 'recommend';
  ladder: Ladder | null;
  plan: PlanId | null;
  reason: string | null;
}

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

const SYSTEM_PROMPT = `You are the Ladder plan advisor on 108psy.com, built on the Ladder method by Aizhan Li.
The Ladder method: a person names where they stand now ("me"), the obstacles between them and the goal (fears, beliefs, habits, circumstances), and the goal itself. The obstacles become steps to work through, one by one, with short video practices.

Your job in this chat:
1. Understand the person's goal and the obstacles in their own words.
2. If the goal or the obstacles are still unclear after the first message, ask ONE short, warm question. Never ask more than one question in total.
3. Then build the ladder and recommend exactly one plan:
   - "ladder_1m" (1 month) when there are one or two concrete, recent obstacles.
   - "ladder_3m" (3 months, the third month is free) when there are three or more obstacles, or the obstacles have lasted for years, or they touch the body, health or family patterns. Deep patterns need time, and one month would likely end before the work does.
4. Explain the choice in "reason": one or two full sentences addressed to the person as "you", naming at least two of their own obstacles in their words. Example: "You said the weight has stayed for ten years and that stress makes you eat at night. Patterns that old usually need more than one month, so three months gives you time for each step."

Ladder fields:
- "me": where the person stands today, in a short concrete phrase from their words (for example "starts a diet and quits after a week"), not a restatement of the goal.
- "obstacles": 2 to 5 short phrases, each one obstacle in the person's words.
- "goal": the goal as the person would say it.

Rules:
- Reply in the language the person writes in (English, Russian or Kazakh).
- When stage is "recommend", "reply" names the plan (1 month or 3 months) in one warm sentence and invites the person to look at their ladder below.
- Keep "reply" to at most 4 short sentences. Warm, plain, no jargon.
- Never write prices or amounts. The site shows them.
- Never write plan ids like ladder_3m in reply or reason. Say "1 month" or "3 months".
- Never promise health results or cures. You may say the practices help to notice and work through obstacles.
- You are not a doctor or a therapist and you do not diagnose.
- Do not push. The person decides; payment always needs their own approval in PayPal.

Answer with JSON only, in this shape:
{"reply": string, "stage": "ask" | "recommend", "ladder": {"me": string, "obstacles": string[], "goal": string} | null, "plan": "ladder_1m" | "ladder_3m" | null, "reason": string | null}
When stage is "ask", ladder, plan and reason are null.`;

const MAX_MESSAGES = 8;
const MAX_CHARS = 1200;

export function sanitize(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m === 'object' &&
        ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
        typeof (m as ChatMessage).content === 'string',
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
}

// Plan ids are for the server. People read "1 month" and "3 months".
const humanize = (t: string) => t.replace(/\bthe ladder_1m plan\b/g, 'the 1-month plan').replace(/\bthe ladder_3m plan\b/g, 'the 3-month plan').replace(/\bladder_1m\b/g, '1 month').replace(/\bladder_3m\b/g, '3 months');

export function parseTurn(raw: unknown, forceRecommend: boolean): AgentTurn {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('model returned no JSON');
    data = JSON.parse(raw.slice(start, end + 1));
  }
  const d = data as Record<string, unknown>;
  const reply = typeof d.reply === 'string' ? humanize(d.reply.trim()) : '';
  if (!reply) throw new Error('model returned an empty reply');

  const ladderRaw = d.ladder as Record<string, unknown> | null | undefined;
  const ladder: Ladder | null =
    ladderRaw && typeof ladderRaw === 'object'
      ? {
          me: String(ladderRaw.me ?? '').slice(0, 200),
          obstacles: Array.isArray(ladderRaw.obstacles)
            ? ladderRaw.obstacles.map((o) => String(o).slice(0, 160)).slice(0, 7)
            : [],
          goal: String(ladderRaw.goal ?? '').slice(0, 200),
        }
      : null;

  let plan: PlanId | null = isPlanId(d.plan) ? d.plan : null;
  let stage: AgentTurn['stage'] = d.stage === 'recommend' && plan ? 'recommend' : 'ask';
  if (forceRecommend && stage === 'ask' && ladder) {
    plan = ladder.obstacles.length >= 3 ? 'ladder_3m' : 'ladder_1m';
    stage = 'recommend';
  }
  return {
    reply,
    stage,
    ladder: stage === 'recommend' ? ladder : null,
    plan: stage === 'recommend' ? plan : null,
    reason: stage === 'recommend' && typeof d.reason === 'string' ? humanize(d.reason).slice(0, 400) : null,
  };
}

export async function advise(ai: AiBinding, model: string, history: ChatMessage[]): Promise<AgentTurn> {
  const userTurns = history.filter((m) => m.role === 'user').length;
  const forceRecommend = userTurns >= 2;
  const system = forceRecommend
    ? SYSTEM_PROMPT + '\nThe person has answered already. You must now return stage "recommend" with a ladder and a plan.'
    : SYSTEM_PROMPT;
  const result = (await ai.run(model, {
    messages: [{ role: 'system', content: system }, ...history],
    max_tokens: 700,
    temperature: 0.4,
    response_format: { type: 'json_object' },
  })) as { response?: unknown };
  return parseTurn(result?.response ?? result, forceRecommend);
}

const FIRST_STEP_PROMPT = `You write the first step of a person's Ladder after they joined the plan.
Given their ladder (me, obstacles, goal), write one small action for today that works on the FIRST obstacle.
Max 3 sentences, warm and concrete, in the language of the ladder text. No health promises, no prices.
Answer with JSON only: {"step": string}`;

export async function firstStep(ai: AiBinding, model: string, ladder: Ladder): Promise<string> {
  const result = (await ai.run(model, {
    messages: [
      { role: 'system', content: FIRST_STEP_PROMPT },
      { role: 'user', content: JSON.stringify(ladder) },
    ],
    max_tokens: 300,
    temperature: 0.5,
    response_format: { type: 'json_object' },
  })) as { response?: unknown };
  const raw = result?.response ?? result;
  let data: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    data = s !== -1 && e > s ? JSON.parse(raw.slice(s, e + 1)) : { step: raw };
  }
  const step = (data as { step?: unknown }).step;
  return typeof step === 'string' && step.trim() ? step.trim().slice(0, 600) : '';
}
