// The plan advisor. It reads a short Ladder self-check (me, obstacles, goal),
// asks at most one clarifying question and then picks a plan id with a reason.
// It never sees or writes prices: the server owns the catalog.

import { cleanSeats, isPlanId, MAX_SEATS, type PlanId } from './catalog.ts';

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

// The checkout agent. After the advisor recommends a plan, a second model call
// may use one tool, create_paypal_order. The tool only prepares a PayPal order:
// money moves only when the person approves it in PayPal. The model never sets
// an amount; the server takes the price from the catalog.

const CHECKOUT_PROMPT = `You are the Ladder checkout agent. The plan advisor has just recommended a plan to the person.
You must call exactly one of two tools:
- create_paypal_order prepares a PayPal order. It never charges money: the person approves the payment in PayPal themselves or simply closes it.
- skip_order is for when the person explicitly said they do not want to buy or pay, or asked not to be sold to.
Choosing the plan: use the plan the person asked for in their own words ("only one month" means ladder_1m, "three months" means ladder_3m). If they did not ask, use the recommended plan.
Money worries, doubts, fears or "I have no savings" are part of the ladder, not a refusal: still create the order.`;

export const SKIP_TOOL = {
  type: 'function',
  function: {
    name: 'skip_order',
    description: 'Do not prepare an order, because the person explicitly refused to buy or asked not to be sold to.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
};

export const CHECKOUT_TOOL = {
  type: 'function',
  function: {
    name: 'create_paypal_order',
    description: 'Prepare a PayPal order for a Ladder plan. The person approves the payment in PayPal; this tool never charges money.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', enum: ['ladder_1m', 'ladder_3m'], description: 'ladder_1m is 1 month, ladder_3m is 3 months' },
      },
      required: ['plan_id'],
    },
  },
};

/** Reads a create_paypal_order call from a Workers AI answer (both tool_calls shapes). */
export function parseCheckoutCall(result: unknown): PlanId | null {
  const r = (result ?? {}) as Record<string, any>;
  // Workers AI returns either { tool_calls } or the OpenAI shape { choices: [{ message: { tool_calls } }] }.
  const raw = r.tool_calls ?? r.choices?.[0]?.message?.tool_calls;
  const calls = Array.isArray(raw) ? raw : [];
  for (const c of calls as Array<Record<string, any>>) {
    const name = c?.name ?? c?.function?.name;
    if (name !== 'create_paypal_order') continue;
    let args: unknown = c?.arguments ?? c?.function?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        continue;
      }
    }
    const plan = (args as Record<string, unknown>)?.plan_id;
    if (isPlanId(plan)) return plan;
  }
  return null;
}

export interface CheckoutCall {
  tool: string; // tool name the model called, '' when it called none
  args: string; // the raw arguments, as the model wrote them (shown on the page)
  plan: PlanId | null; // what the server accepted
}

/** Like parseCheckoutCall, but keeps what the model tried, for the guardrail demo. */
export function readCheckoutCall(result: unknown): CheckoutCall {
  const r = (result ?? {}) as Record<string, any>;
  const raw = r.tool_calls ?? r.choices?.[0]?.message?.tool_calls;
  const first = (Array.isArray(raw) ? raw : [])[0] as Record<string, any> | undefined;
  if (!first) return { tool: '', args: '', plan: null };
  const tool = String(first?.name ?? first?.function?.name ?? '');
  const a = first?.arguments ?? first?.function?.arguments ?? {};
  const args = (typeof a === 'string' ? a : JSON.stringify(a)).slice(0, 240);
  return { tool, args, plan: parseCheckoutCall(result) };
}

export async function checkoutAgent(ai: AiBinding, model: string, history: ChatMessage[], recommended: PlanId): Promise<PlanId | null> {
  return (await checkoutAgentCall(ai, model, history, recommended)).plan;
}

export async function checkoutAgentCall(ai: AiBinding, model: string, history: ChatMessage[], recommended: PlanId): Promise<CheckoutCall> {
  const words = history
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join(' / ')
    .slice(-1500);
  const result = await ai.run(model, {
    messages: [
      { role: 'system', content: CHECKOUT_PROMPT },
      ...history,
      {
        role: 'system',
        content: `The advisor recommended ${recommended}. The person's own words: "${words}". Did they refuse to buy? Did they name a plan length? Call one tool now.`,
      },
    ],
    tools: [CHECKOUT_TOOL, SKIP_TOOL],
    max_tokens: 200,
    temperature: 0.1,
  });
  return readCheckoutCall(result);
}

// The gift agent. An HR person or a union describes a team gift in plain words.
// The model may call create_gift_invoice with a plan id from an enum, a seat count
// and a short gift note, or ask_hr with one question when something is missing.
// It never sets a price: the server multiplies seats by the catalog price.

const GIFT_PROMPT = `You are the Ladder gift agent. A company, a team lead or a trade union wants to give Ladder access to its own employees or members as a holiday gift.
Ladder: a self-help method by Aizhan Li, author of the Ladder method. Each person maps where they stand, the obstacles and a goal, and works through the obstacles with short video practices.
Plans: ladder_1m is 1 month, ladder_3m is 3 months (the third month is free).
Call exactly one tool:
- create_gift_invoice when you know the plan length and the number of people. Each person is one seat. If they did not name a length, use ladder_3m for holidays like New Year, otherwise ladder_1m.
- ask_hr with ONE short question when the number of people is missing.
The gift note goes to the employees inside the PayPal invoice: 2 or 3 warm sentences from the company, in the language of the request, about time for yourself and small steps toward a personal goal.
The note must not name prices or amounts, must not promise health results or cures, and must not mention doctors or therapy.
Seats: at most ${MAX_SEATS} in one invoice.`;

export const GIFT_TOOL = {
  type: 'function',
  function: {
    name: 'create_gift_invoice',
    description: 'Prepare a DRAFT PayPal invoice for Ladder gift seats. Nothing is sent or charged: the HR person reviews the draft and sends it.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', enum: ['ladder_1m', 'ladder_3m'], description: 'ladder_1m is 1 month, ladder_3m is 3 months' },
        seats: { type: 'integer', description: `Number of people who get a code, 1 to ${MAX_SEATS}` },
        gift_note: { type: 'string', description: 'Two or three warm sentences to the employees. No prices, no health promises.' },
        company: { type: 'string', description: 'Company, team or union name if the person gave one, else empty' },
      },
      required: ['plan_id', 'seats', 'gift_note'],
    },
  },
};

export const ASK_HR_TOOL = {
  type: 'function',
  function: {
    name: 'ask_hr',
    description: 'Ask one short question when the number of people is missing.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
};

export type GiftCall =
  | { kind: 'invoice'; plan: PlanId; seats: number | null; requested: unknown; note: string; company: string }
  | { kind: 'ask'; question: string };

// The note goes to employees: no amounts and no health claims, whatever the model wrote.
const NOTE_BLOCK = /[$€₸₽]|\b(usd|kzt|tenge|dollars?|price|cost|cure|cures|heal|heals|healing|therapy|therapist|doctor|diagnos\w*)\b|\d+\s*(usd|kzt|\$)/i;

export const DEFAULT_GIFT_NOTE =
  'This is a gift from your team: time for yourself. Map where you stand and one goal that matters to you, and take it in small steps with short video practices.';

export function cleanGiftNote(note: unknown): string {
  const t = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
  return t.length >= 20 && !NOTE_BLOCK.test(t) ? t : DEFAULT_GIFT_NOTE;
}

export function cleanCompany(name: unknown): string {
  return typeof name === 'string' ? name.replace(/[^\p{L}\p{N} .,&'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

/** Reads the gift agent's tool call (both Workers AI shapes). seats is null when out of range. */
export function parseGiftCall(result: unknown): GiftCall | null {
  const r = (result ?? {}) as Record<string, any>;
  const raw = r.tool_calls ?? r.choices?.[0]?.message?.tool_calls;
  const calls = Array.isArray(raw) ? raw : [];
  for (const c of calls as Array<Record<string, any>>) {
    const name = c?.name ?? c?.function?.name;
    let args: unknown = c?.arguments ?? c?.function?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        continue;
      }
    }
    const a = (args ?? {}) as Record<string, unknown>;
    if (name === 'ask_hr' && typeof a.question === 'string' && a.question.trim()) {
      return { kind: 'ask', question: a.question.trim().slice(0, 300) };
    }
    if (name === 'create_gift_invoice' && isPlanId(a.plan_id)) {
      return { kind: 'invoice', plan: a.plan_id, seats: cleanSeats(a.seats), requested: a.seats, note: cleanGiftNote(a.gift_note), company: cleanCompany(a.company) };
    }
  }
  return null;
}

export async function giftAgent(ai: AiBinding, model: string, history: ChatMessage[]): Promise<GiftCall | null> {
  const result = await ai.run(model, {
    messages: [{ role: 'system', content: GIFT_PROMPT }, ...history, { role: 'system', content: 'Call one tool now.' }],
    tools: [GIFT_TOOL, ASK_HR_TOOL],
    max_tokens: 400,
    temperature: 0.2,
  });
  return parseGiftCall(result);
}
