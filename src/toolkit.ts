// "Ask PayPal": the owner asks a question in plain words, Claude (Llama 3.3 as fallback) picks one tool from the
// official PayPal Agent Toolkit, and the toolkit calls PayPal. The toolkit is built with
// read-only actions only (orders.get, invoices.list/get, disputes.list),
// so the model cannot create, capture, refund or send anything. The server checks the tool
// name and the ids again, hides personal fields in the PayPal answer, and only then lets the
// model summarise it.

import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai';
import type { AiBinding } from './agent.ts';

export const READ_ONLY_ACTIONS = {
  orders: { get: true },
  invoices: { list: true, get: true },
  disputes: { list: true },
};
// transactions.list is left out: it needs the Transaction Search permission on the PayPal app.

export const ALLOWED_TOOLS = ['get_order', 'list_invoices', 'get_invoice', 'list_disputes'] as const;
export type ToolName = (typeof ALLOWED_TOOLS)[number];

const ORDER_ID = /^[A-Z0-9]{10,20}$/;
const INVOICE_ID = /^INV2(-[A-Z0-9]{4}){4}$/;

export interface ToolkitLike {
  getTools(): Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>;
  handleToolCall(call: { id: string; type: 'function'; function: { name: string; arguments: string } }): Promise<{ content: unknown }>;
}

export function makeToolkit(clientId: string, clientSecret: string, sandbox: boolean): ToolkitLike {
  return new PayPalAgentToolkit({
    clientId,
    clientSecret,
    configuration: { actions: READ_ONLY_ACTIONS, context: { sandbox } },
  }) as unknown as ToolkitLike;
}

/** Toolkit tools in the flat shape Workers AI expects, limited to the allow-list. */
export function workersTools(toolkit: ToolkitLike): Array<{ name: string; description: string; parameters: unknown }> {
  return toolkit
    .getTools()
    .filter((t) => (ALLOWED_TOOLS as readonly string[]).includes(t.function.name))
    .map((t) => ({ name: t.function.name, description: (t.function.description ?? '').trim().slice(0, 700), parameters: t.function.parameters ?? { type: 'object', properties: {} } }));
}

/** Reads the first allowed tool call from a Workers AI answer and checks its arguments. */
export function readToolCall(result: unknown): { name: ToolName; args: Record<string, unknown> } | null {
  const r = (result ?? {}) as Record<string, any>;
  const raw = r.tool_calls ?? r.choices?.[0]?.message?.tool_calls;
  for (const c of (Array.isArray(raw) ? raw : []) as Array<Record<string, any>>) {
    const name = c?.name ?? c?.function?.name;
    if (!(ALLOWED_TOOLS as readonly string[]).includes(name)) continue;
    let a: unknown = c?.arguments ?? c?.function?.arguments ?? {};
    if (typeof a === 'string') {
      try { a = JSON.parse(a || '{}'); } catch { continue; }
    }
    const args = checkArgs(name as ToolName, a && typeof a === 'object' ? (a as Record<string, unknown>) : {});
    if (args) return { name: name as ToolName, args };
  }
  return null;
}

/** Keeps only known arguments with safe values; null means the call is refused. */
export function checkArgs(name: ToolName, a: Record<string, unknown>): Record<string, unknown> | null {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const size = (v: unknown, max: number) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? Math.min(n, max) : undefined;
  };
  switch (name) {
    case 'get_order': {
      const id = str(a.id).toUpperCase();
      return ORDER_ID.test(id) ? { id } : null;
    }
    case 'get_invoice': {
      const id = str(a.invoice_id).toUpperCase();
      return INVOICE_ID.test(id) ? { invoice_id: id } : null;
    }
    case 'list_invoices':
      return { page: 1, page_size: size(a.page_size, 10) ?? 10, total_required: true };
    case 'list_disputes':
      return { page_size: size(a.page_size, 10) ?? 10 };
  }
}

const HIDDEN_KEY = /email|phone|address|payer_id|account_id|given_name|surname|full_name|tax_id|birth_date|national_number|_url$|^url$|href/i;
const PAID = new Set(['PAID', 'MARKED_AS_PAID']);

/** Masks an invoice id to its last 4 characters: anyone with an unpaid invoice id can open its payer page. */
export const maskInvoice = (id: string) => '...' + id.slice(-4);
/** Same rule as the dashboard: an order id is shown only once the order is captured. */
export const maskOrder = (id: string) => '...' + id.slice(-5);

/** Hides personal fields and payer links, masks unpaid invoice ids and open order ids, and drops HATEOAS links
 *  before the model or the page sees the answer. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[cut]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const unpaidInvoice = typeof obj.id === 'string' && obj.id.startsWith('INV2') && !PAID.has(String(obj.status ?? ''));
    const openOrder = typeof obj.id === 'string' && 'intent' in obj && obj.status !== 'COMPLETED';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'links') continue;
      if (k === 'id' && unpaidInvoice) out[k] = maskInvoice(v as string);
      else if (k === 'id' && openOrder) out[k] = maskOrder(v as string);
      else out[k] = HIDDEN_KEY.test(k) ? '[hidden]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function cleanAsk(q: unknown): string {
  return typeof q === 'string' ? q.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

const PICK_PROMPT = `You help the owner of a small online shop look things up in PayPal (sandbox).
Call exactly one tool from the PayPal Agent Toolkit to answer the question. You can only read: get an order, list or get invoices, list disputes.
If the question is about creating, paying, refunding, cancelling or sending something, call list_invoices and do not try to change anything.
Known records from the shop's own ledger, newest first, so you can use real ids:
`;

const SUMMARY_PROMPT = `You answer the shop owner's question using only the PayPal API result below.
Two or three short sentences in plain English. Name statuses, amounts, currencies and dates as they appear. Personal fields show as [hidden]; do not guess them.
If the result is an error or empty, say so plainly. Never invent data.`;

const WRITE_INTENT = /\b(refund|cancel|void|capture|pay|charge|send|create|delete|remind|change|update)\b/i;

export interface AskResult {
  tool: ToolName | null;
  args: Record<string, unknown> | null;
  answer: string;
  result: unknown;
}

export async function askPayPal(ai: AiBinding, model: string, toolkit: ToolkitLike, question: string, known: string): Promise<AskResult> {
  const picked = await ai.run(model, {
    messages: [
      { role: 'system', content: PICK_PROMPT + (known || '(no records yet)') },
      { role: 'user', content: question },
    ],
    tools: workersTools(toolkit),
    max_tokens: 200,
    temperature: 0,
  });
  const call = readToolCall(picked);
  if (!call) return { tool: null, args: null, answer: 'The AI did not pick a PayPal tool for that. Try naming an order or asking about invoices.', result: null };

  const reply = await toolkit.handleToolCall({ id: 'ask-1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } });
  let data: unknown = reply.content;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* keep text */ }
  }
  const safe = redact(data);
  const readOnlyNote = WRITE_INTENT.test(question)
    ? '\nThe owner asked for a change. Start with: "Ask PayPal is read-only, so nothing was changed." Then describe what was looked up.'
    : '';
  const forModel = JSON.stringify(safe).slice(0, 6000);

  const summary = (await ai.run(model, {
    messages: [
      { role: 'system', content: SUMMARY_PROMPT + readOnlyNote },
      { role: 'user', content: `Question: ${question}\nTool: ${call.name} ${JSON.stringify(call.args)}\nResult: ${forModel}` },
    ],
    max_tokens: 220,
    temperature: 0,
  })) as Record<string, any>;
  const text = typeof summary?.response === 'string' ? summary.response : summary?.choices?.[0]?.message?.content;
  return { tool: call.name, args: call.args, answer: (typeof text === 'string' && text.trim()) || 'PayPal answered; see the result below.', result: safe };
}
