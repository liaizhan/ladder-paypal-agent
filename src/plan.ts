// The ladder plan on a Bryntum Gantt timeline. The AI decides how many days each
// obstacle gets and names one practice for it, through one tool call. The server
// fits those days into the access period exactly, chains the steps with
// dependencies and ties the plan to the PayPal payment: a draft before payment,
// anchored to the capture date after it, closed after a refund.
// Nothing here is stored: the plan is rebuilt from the ladder the browser sends.

import type { AiBinding, Ladder } from './agent.ts';

export const REFUND_WINDOW_DAYS = 14;
export const MIN_STEP_DAYS = 2;

export const PLAN_TOOL = {
  name: 'schedule_ladder_steps',
  description: 'Split the access period between the obstacles, in the order given, and name one short practice for each.',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'array', items: { type: 'integer' }, description: 'days for each obstacle, in order; older or deeper obstacles get more days; the sum should equal the period' },
      practices: { type: 'array', items: { type: 'string' }, description: 'one practice per obstacle, in order, at most 8 words, in the language of the obstacles' },
    },
    required: ['days', 'practices'],
  },
};

const PROMPT = `You plan the work on a person's ladder: the obstacles between where they stand and their goal.
They work through the obstacles one by one, in the order given, with short video practices.
Call schedule_ladder_steps once. Give each obstacle a number of days so that older, deeper or body-related obstacles get more time, and the days add up to the period.
For each obstacle write one practice title, at most 8 words, in the language of the obstacles, kind and concrete (for example "Notice the fear in one small decision a day").
Never promise health results or cures. Never mention prices.`;

export interface PlanTask {
  id: number;
  name: string;
  startDate: string; // YYYY-MM-DD
  duration: number; // days, 0 = milestone
  kind: 'payment' | 'refund-window' | 'step' | 'goal' | 'refund';
  note?: string;
  inactive?: boolean;
  manuallyScheduled?: boolean;
}

export interface LadderPlan {
  status: 'draft' | 'active' | 'refunded';
  startDate: string;
  endDate: string;
  totalDays: number;
  source: 'ai' | 'even';
  tasks: PlanTask[];
  dependencies: { fromTask: number; toTask: number }[];
}

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(day + 'T00:00:00Z') + n * DAY));

/** Plain text for the timeline: no markup characters, no control characters, trimmed. */
export function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[<>&"`\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

const asArray = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
};

/** Splits total days between n steps by the model's weights, at least MIN_STEP_DAYS each, summing exactly to total. */
/** The model's day counts if there is one positive number per step, each within the period; otherwise null. */
export function validWeights(total: number, n: number, weights: unknown): number[] | null {
  const w = asArray(weights).map((x) => (typeof x === 'string' ? Number(x) : x));
  return w.length === n && w.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= total) ? (w as number[]) : null;
}

export function splitDays(total: number, n: number, weights?: unknown): number[] {
  const ws = validWeights(total, n, weights) ?? Array(n).fill(1);
  const free = total - MIN_STEP_DAYS * n;
  if (free < 0) return Array(n).fill(Math.floor(total / n)).map((d, i) => d + (i < total % n ? 1 : 0));
  const sum = ws.reduce((a, b) => a + b, 0);
  const raw = ws.map((x) => (x / sum) * free);
  const out = raw.map((x) => MIN_STEP_DAYS + Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) out[order[k][1]]++;
  return out;
}

/** Reads schedule_ladder_steps arguments from a Workers AI answer (both tool_calls shapes). */
export function readPlanCall(result: unknown): Record<string, unknown> | null {
  const r = (result ?? {}) as Record<string, any>;
  const raw = r.tool_calls ?? r.choices?.[0]?.message?.tool_calls;
  for (const c of (Array.isArray(raw) ? raw : []) as Array<Record<string, any>>) {
    if ((c?.name ?? c?.function?.name) !== 'schedule_ladder_steps') continue;
    let a: unknown = c?.arguments ?? c?.function?.arguments ?? {};
    if (typeof a === 'string') {
      try { a = JSON.parse(a); } catch { continue; }
    }
    return a && typeof a === 'object' ? (a as Record<string, unknown>) : null;
  }
  return null;
}

export interface PlanInput {
  ladder: Ladder;
  totalDays: number;
  startDate: string; // YYYY-MM-DD: today for a draft, the capture day once paid
  status: LadderPlan['status'];
  captureId?: string;
  refundId?: string;
  args?: Record<string, unknown> | null; // the model's tool call, checked here
}

export function buildPlan(p: PlanInput): LadderPlan {
  const obstacles = p.ladder.obstacles.map((o) => cleanText(o, 90)).filter(Boolean).slice(0, 7);
  const steps = obstacles.length ? obstacles : ['Your first step'];
  const days = splitDays(p.totalDays, steps.length, p.args?.days);
  const aiDays = validWeights(p.totalDays, steps.length, p.args?.days) !== null;
  const practices = asArray(p.args?.practices).map((x) => cleanText(x, 80));
  const off = p.status === 'refunded';
  const tasks: PlanTask[] = [
    {
      id: 1,
      kind: 'payment',
      startDate: p.startDate,
      duration: 0,
      name: p.status === 'draft' ? 'Starts when PayPal confirms the payment' : 'PayPal payment captured' + (p.captureId ? ' ' + cleanText(p.captureId, 40) : ''),
    },
    {
      id: 2,
      kind: 'refund-window',
      startDate: addDays(p.startDate, REFUND_WINDOW_DAYS),
      duration: 0,
      manuallyScheduled: true,
      name: `${REFUND_WINDOW_DAYS}-day refund window closes`,
    },
  ];
  const deps: LadderPlan['dependencies'] = [];
  let day = 0;
  let prev = 1;
  steps.forEach((name, i) => {
    const id = 10 + i;
    tasks.push({ id, kind: 'step', name, startDate: addDays(p.startDate, day), duration: days[i], note: practices[i] || undefined, inactive: off || undefined });
    deps.push({ fromTask: prev, toTask: id });
    day += days[i];
    prev = id;
  });
  const goal = cleanText(p.ladder.goal, 90);
  tasks.push({ id: 3, kind: 'goal', name: goal ? 'Goal: ' + goal : 'Your goal', startDate: addDays(p.startDate, p.totalDays), duration: 0, inactive: off || undefined });
  deps.push({ fromTask: prev, toTask: 3 });
  if (off) tasks.push({ id: 4, kind: 'refund', name: 'PayPal refund' + (p.refundId ? ' ' + cleanText(p.refundId, 40) : '') + ': plan closed', startDate: isoDay(new Date()), duration: 0, manuallyScheduled: true });
  return {
    status: p.status,
    startDate: p.startDate,
    endDate: addDays(p.startDate, p.totalDays),
    totalDays: p.totalDays,
    source: aiDays || practices.some(Boolean) ? 'ai' : 'even',
    tasks,
    dependencies: deps,
  };
}

export async function askPlan(ai: AiBinding, model: string, ladder: Ladder, totalDays: number): Promise<Record<string, unknown> | null> {
  const result = await ai.run(model, {
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: JSON.stringify({ period_days: totalDays, me: ladder.me, obstacles: ladder.obstacles, goal: ladder.goal }) },
    ],
    tools: [PLAN_TOOL],
    max_tokens: 400,
    temperature: 0.3,
  });
  return readPlanCall(result);
}
