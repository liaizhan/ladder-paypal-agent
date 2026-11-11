// Order ledger for the payments dashboard, stored in Workers KV.
// Privacy by design: no goals, obstacles, names or emails are stored.
// A record holds plan ids, counts, PayPal ids and statuses only.

import { isPlanId, PLANS, type PlanId } from './catalog.ts';

export interface KVNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { metadata?: unknown; expirationTtl?: number }): Promise<void>;
  getWithMetadata(key: string): Promise<{ value: string | null; metadata: unknown }>;
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export type Lang = 'en' | 'ru' | 'kk';

export interface OrderRecord {
  orderId: string;
  createdAt: string;
  recommended: PlanId | null; // what the AI advisor recommended (from a signed token)
  chosen: PlanId; // what the person chose to pay for
  amount: string; // from the server catalog
  steps: number; // number of obstacles on the ladder, no text
  lang: Lang | '';
  status: string; // CREATED, APPROVED, COMPLETED, INSTRUMENT_DECLINED, VOIDED, EXPIRED
  captureId: string;
  updatedAt: string;
}

export interface DayStats {
  date: string;
  conversations: number;
  recommendations: number;
  rec1m: number;
  rec3m: number;
  safetyHandoffs: number;
}

const FINAL = new Set(['COMPLETED', 'VOIDED', 'EXPIRED']);

export function isFinal(status: string): boolean {
  return FINAL.has(status);
}

/** Script-based language guess. Kazakh has letters Russian does not. */
export function detectLang(text: string): Lang {
  if (/[әғқңөұүһі]/i.test(text)) return 'kk';
  if (/[а-яё]/i.test(text)) return 'ru';
  return 'en';
}

export function newOrderRecord(input: {
  orderId: string;
  chosen: PlanId;
  recommended: unknown;
  steps: number;
  lang: unknown;
  now?: Date;
}): OrderRecord {
  const now = (input.now ?? new Date()).toISOString();
  const lang = input.lang === 'en' || input.lang === 'ru' || input.lang === 'kk' ? input.lang : '';
  return {
    orderId: input.orderId,
    createdAt: now,
    recommended: isPlanId(input.recommended) ? input.recommended : null,
    chosen: input.chosen,
    amount: PLANS[input.chosen].amount,
    steps: Math.max(0, Math.min(7, Math.floor(input.steps) || 0)),
    lang,
    status: 'CREATED',
    captureId: '',
    updatedAt: now,
  };
}

const orderKey = (id: string) => `order:${id}`;

export async function saveOrder(kv: KVNamespace, rec: OrderRecord): Promise<void> {
  // The record lives in key metadata, so one list() call returns the whole ledger.
  await kv.put(orderKey(rec.orderId), '', { metadata: rec, expirationTtl: 60 * 60 * 24 * 120 });
}

export async function getOrder(kv: KVNamespace, id: string): Promise<OrderRecord | null> {
  const { metadata } = await kv.getWithMetadata(orderKey(id));
  return (metadata as OrderRecord | null) ?? null;
}

export async function updateOrder(kv: KVNamespace, id: string, patch: Partial<OrderRecord>): Promise<void> {
  const rec = await getOrder(kv, id);
  if (!rec) return;
  await saveOrder(kv, { ...rec, ...patch, updatedAt: new Date().toISOString() });
}

export async function listOrders(kv: KVNamespace, max = 500): Promise<OrderRecord[]> {
  const out: OrderRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'order:', limit: 1000, cursor });
    for (const k of page.keys) if (k.metadata) out.push(k.metadata as OrderRecord);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && out.length < max);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, max);
}

const dayKey = (date: string) => `stat:${date}`;

export function emptyDay(date: string): DayStats {
  return { date, conversations: 0, recommendations: 0, rec1m: 0, rec3m: 0, safetyHandoffs: 0 };
}

export type ChatEvent = { kind: 'start' } | { kind: 'recommend'; plan: PlanId } | { kind: 'safety' };

export function applyEvents(day: DayStats, events: ChatEvent[]): DayStats {
  const d = { ...day };
  for (const e of events) {
    if (e.kind === 'start') d.conversations++;
    if (e.kind === 'safety') d.safetyHandoffs++;
    if (e.kind === 'recommend') {
      d.recommendations++;
      if (e.plan === 'ladder_1m') d.rec1m++;
      else d.rec3m++;
    }
  }
  return d;
}

/** One key per chat turn that matters, counts in metadata. Workers KV is
 *  eventually consistent, so read-modify-write counters would lose events. */
export async function countChat(kv: KVNamespace, events: ChatEvent[], now = new Date()): Promise<void> {
  if (!events.length) return;
  const date = now.toISOString().slice(0, 10);
  const id = `${now.getTime().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  await kv.put(`${dayKey(date)}:${id}`, '', { metadata: applyEvents(emptyDay(date), events), expirationTtl: 60 * 60 * 24 * 120 });
}

export function sumDays(entries: DayStats[]): DayStats[] {
  const map = new Map<string, DayStats>();
  for (const e of entries) {
    const d = map.get(e.date) ?? emptyDay(e.date);
    d.conversations += e.conversations;
    d.recommendations += e.recommendations;
    d.rec1m += e.rec1m;
    d.rec3m += e.rec3m;
    d.safetyHandoffs += e.safetyHandoffs;
    map.set(e.date, d);
  }
  return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export async function listDays(kv: KVNamespace, days = 30, now = new Date()): Promise<DayStats[]> {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const entries: DayStats[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'stat:', limit: 1000, cursor });
    for (const k of page.keys) {
      const m = k.metadata as DayStats | undefined;
      if (m && m.date >= since) entries.push(m);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && entries.length < 20_000);
  return sumDays(entries);
}

/** Public view: order ids of unfinished orders are masked, so nobody can act on them. */
export function publicOrder(rec: OrderRecord): OrderRecord & { followedAdvice: boolean | null } {
  const masked = rec.status === 'COMPLETED' ? rec.orderId : '...' + rec.orderId.slice(-5);
  return {
    ...rec,
    orderId: masked,
    followedAdvice: rec.recommended ? rec.recommended === rec.chosen : null,
  };
}
