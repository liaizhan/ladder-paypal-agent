// "Ask the grid": a plain-words question about the orders becomes an AG Grid view.
// The model never sees the orders and never writes code. It fills one tool call with
// values from fixed lists, the server checks every value, and the page applies the
// result with setFilterModel and applyColumnState. Wrong or unknown values are dropped.

import type { AiBinding } from './agent.ts';

export const STATUS = ['all', 'paid', 'open', 'refunded', 'problem'] as const;
export const CREATED_BY = { agent: 'AI agent', person: 'PayPal button', mcp: 'Agent over MCP' } as const;
export const PLAN_TEXT = { ladder_1m: '1 month', ladder_3m: '3 months' } as const;
export const LANG_TEXT = { en: 'English', ru: 'Russian', kk: 'Kazakh' } as const;
export const SORT_COLUMNS = ['createdAt', 'amount', 'steps', 'status', 'webhooks'] as const;

export const VIEW_TOOL = {
  name: 'set_grid_view',
  description: 'Show the orders that answer the question. Leave out every field the question does not mention.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...STATUS], description: 'paid = captured; open = checkout not finished; refunded = refunded or reversed; problem = declined, voided or expired' },
      created_by: { type: 'string', enum: Object.keys(CREATED_BY), description: 'agent = the AI agent on the page; person = the PayPal button; mcp = an outside AI agent over MCP' },
      chosen_plan: { type: 'string', enum: Object.keys(PLAN_TEXT), description: 'the plan the person bought' },
      recommended_plan: { type: 'string', enum: Object.keys(PLAN_TEXT), description: 'the plan the AI advisor recommended' },
      followed_ai: { type: 'string', enum: ['yes', 'no'], description: 'yes = bought the recommended plan; no = switched to the other plan' },
      language: { type: 'string', enum: Object.keys(LANG_TEXT) },
      min_amount: { type: 'number', description: 'minimum amount in USD' },
      max_amount: { type: 'number', description: 'maximum amount in USD' },
      last_days: { type: 'integer', description: 'only orders created in the last N days; today = 1, this week = 7' },
      sort_by: { type: 'string', enum: [...SORT_COLUMNS], description: 'createdAt = time; webhooks = number of PayPal webhook events' },
      sort_dir: { type: 'string', enum: ['asc', 'desc'] },
    },
    required: [],
  },
};

const PROMPT = `You turn a question about a table of PayPal orders into one call of set_grid_view.
Columns: time created, PayPal status, who created the order (AI agent, PayPal button or an outside agent over MCP), plan the AI recommended, plan the person chose, whether they followed the AI, amount in USD ($39 for 1 month, $78 for 3 months), steps on the ladder, language, PayPal webhook events.
Fill only the fields the question asks about. "Biggest" or "most expensive" means sort_by amount desc. "Latest" or "newest" means sort_by createdAt desc. Always call the tool, even for a vague question.`;

export interface GridView {
  status: (typeof STATUS)[number];
  filterModel: Record<string, unknown>;
  sort: { colId: string; sort: 'asc' | 'desc' } | null;
  chips: string[]; // what was applied, in plain words, for the page
}

const pick = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
const num = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};
const textEquals = (filter: string) => ({ filterType: 'text', type: 'equals', filter });

/** Checks every value from the model against the fixed lists and builds the AG Grid view. */
export function toGridView(args: Record<string, unknown>, now = new Date()): GridView {
  const fm: Record<string, unknown> = {};
  const chips: string[] = [];
  const status = pick(args.status, STATUS) ?? 'all';
  if (status !== 'all') chips.push({ paid: 'Paid', open: 'Open', refunded: 'Refunded', problem: 'Declined or expired' }[status]);

  const by = pick(args.created_by, Object.keys(CREATED_BY) as (keyof typeof CREATED_BY)[]);
  if (by) { fm.createdBy = textEquals(CREATED_BY[by]); chips.push('Created by ' + CREATED_BY[by]); }
  const plans = Object.keys(PLAN_TEXT) as (keyof typeof PLAN_TEXT)[];
  const chosen = pick(args.chosen_plan, plans);
  if (chosen) { fm.chosen = textEquals(PLAN_TEXT[chosen]); chips.push('Chose ' + PLAN_TEXT[chosen]); }
  const rec = pick(args.recommended_plan, plans);
  if (rec) { fm.recommended = textEquals(PLAN_TEXT[rec]); chips.push('AI recommended ' + PLAN_TEXT[rec]); }
  const followed = pick(args.followed_ai, ['yes', 'no'] as const);
  if (followed) { fm.followedAdvice = textEquals(followed === 'yes' ? 'Yes' : 'Switched'); chips.push(followed === 'yes' ? 'Followed the AI' : 'Switched plan'); }
  const lang = pick(args.language, Object.keys(LANG_TEXT) as (keyof typeof LANG_TEXT)[]);
  if (lang) { fm.lang = textEquals(LANG_TEXT[lang]); chips.push(LANG_TEXT[lang]); }

  const min = num(args.min_amount, 0, 100000);
  const max = num(args.max_amount, 0, 100000);
  if (min !== null && max !== null && min <= max) {
    fm.amount = { filterType: 'number', type: 'inRange', filter: min, filterTo: max };
    chips.push(`$${min} to $${max}`);
  } else if (min !== null) {
    fm.amount = { filterType: 'number', type: 'greaterThanOrEqual', filter: min };
    chips.push(`At least $${min}`);
  } else if (max !== null) {
    fm.amount = { filterType: 'number', type: 'lessThanOrEqual', filter: max };
    chips.push(`Up to $${max}`);
  }

  const days = num(args.last_days, 1, 366);
  if (days !== null) {
    // greaterThan in AG Grid excludes the day itself, so the filter date is the day before the first day shown.
    const before = new Date(now.getTime() - Math.round(days) * 86400000).toISOString().slice(0, 10);
    fm.createdAt = { filterType: 'date', type: 'greaterThan', dateFrom: before + ' 00:00:00' };
    chips.push(Math.round(days) === 1 ? 'Today' : `Last ${Math.round(days)} days`);
  }

  const col = pick(args.sort_by, SORT_COLUMNS);
  const dir = pick(args.sort_dir, ['asc', 'desc'] as const) ?? 'desc';
  const sort = col ? { colId: col, sort: dir } : null;
  if (sort) chips.push(`Sorted by ${{ createdAt: 'time', amount: 'amount', steps: 'steps', status: 'status', webhooks: 'webhooks' }[sort.colId]}, ${dir === 'desc' ? 'high to low' : 'low to high'}`);

  return { status, filterModel: fm, sort, chips };
}

/** Reads set_grid_view arguments from a Workers AI answer (both tool_calls shapes). */
export function readViewCall(result: unknown): Record<string, unknown> | null {
  const r = (result ?? {}) as Record<string, any>;
  const raw = r.tool_calls ?? r.choices?.[0]?.message?.tool_calls;
  for (const c of (Array.isArray(raw) ? raw : []) as Array<Record<string, any>>) {
    if ((c?.name ?? c?.function?.name) !== 'set_grid_view') continue;
    let a: unknown = c?.arguments ?? c?.function?.arguments ?? {};
    if (typeof a === 'string') {
      try { a = JSON.parse(a); } catch { continue; }
    }
    return a && typeof a === 'object' ? (a as Record<string, unknown>) : null;
  }
  return null;
}

export function cleanQuestion(q: unknown): string {
  return typeof q === 'string' ? q.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

export async function askGrid(ai: AiBinding, model: string, question: string): Promise<{ args: Record<string, unknown> | null; view: GridView | null }> {
  const result = await ai.run(model, {
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: question },
    ],
    tools: [VIEW_TOOL],
    max_tokens: 200,
    temperature: 0,
  });
  const args = readViewCall(result);
  return { args, view: args ? toGridView(args) : null };
}
