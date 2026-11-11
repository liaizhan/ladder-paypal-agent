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
  status: string; // CREATED, APPROVED, COMPLETED, REFUNDED, INSTRUMENT_DECLINED, VOIDED, EXPIRED
  captureId: string;
  updatedAt: string;
  createdBy?: 'agent' | 'person'; // the AI agent's tool call, or the PayPal button
  refundId?: string;
  webhooks?: number; // verified PayPal webhook events applied to this order
  lastEvent?: string; // last verified PayPal event type
}

export interface DayStats {
  date: string;
  conversations: number;
  recommendations: number;
  rec1m: number;
  rec3m: number;
  safetyHandoffs: number;
}

const FINAL = new Set(['COMPLETED', 'REFUNDED', 'REVERSED', 'DECLINED', 'VOIDED', 'EXPIRED']);

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
  createdBy?: 'agent' | 'person';
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
    createdBy: input.createdBy ?? 'person',
    webhooks: 0,
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

const TTL = 60 * 60 * 24 * 120;

/** capture id -> order id, so a refund or a refund webhook finds its order. */
export async function linkCapture(kv: KVNamespace, captureId: string, orderId: string): Promise<void> {
  if (captureId && orderId) await kv.put(`capture:${captureId}`, orderId, { expirationTtl: TTL });
}

export async function orderIdForCapture(kv: KVNamespace, captureId: string): Promise<string> {
  const { value } = await kv.getWithMetadata(`capture:${captureId}`);
  return value ?? '';
}

// A later PayPal state never goes back: a late APPROVED event cannot undo a refund.
const RANK: Record<string, number> = { CREATED: 0, PAYER_ACTION_REQUIRED: 0, SAVED: 0, APPROVED: 1, COMPLETED: 2, DECLINED: 2, INSTRUMENT_DECLINED: 1, REFUNDED: 3, REVERSED: 3 };

export function nextStatus(current: string, incoming: string): string {
  return (RANK[incoming] ?? 0) >= (RANK[current] ?? 0) ? incoming : current;
}

/** Applies one verified webhook event. Returns false if the event id was seen before. */
export async function applyWebhook(
  kv: KVNamespace,
  eventId: string,
  eventType: string,
  update: { orderId: string; captureId: string; status: string },
): Promise<'applied' | 'duplicate' | 'unknown-order'> {
  const seenKey = `wh:${eventId}`;
  const seen = await kv.getWithMetadata(seenKey);
  if (seen.value !== null) return 'duplicate';
  await kv.put(seenKey, eventType, { expirationTtl: 60 * 60 * 24 * 30 });
  const orderId = update.orderId || (update.captureId ? await orderIdForCapture(kv, update.captureId) : '');
  const rec = orderId ? await getOrder(kv, orderId) : null;
  if (!rec) return 'unknown-order';
  if (update.captureId && update.status === 'COMPLETED') await linkCapture(kv, update.captureId, orderId);
  await saveOrder(kv, {
    ...rec,
    status: nextStatus(rec.status, update.status),
    captureId: rec.captureId || (update.status === 'COMPLETED' ? update.captureId : ''),
    webhooks: (rec.webhooks ?? 0) + 1,
    lastEvent: eventType,
    updatedAt: new Date().toISOString(),
  });
  return 'applied';
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
  const masked = rec.captureId ? rec.orderId : '...' + rec.orderId.slice(-5);
  return {
    ...rec,
    orderId: masked,
    followedAdvice: rec.recommended ? rec.recommended === rec.chosen : null,
  };
}

// Team gifts: a company pays one PayPal invoice, then gets one access code per seat.
// The record holds plan, seat count, amounts, PayPal ids and statuses only.

export interface GiftRecord {
  invoiceId: string;
  invoiceNumber: string;
  createdAt: string;
  updatedAt: string;
  plan: PlanId;
  seats: number;
  unit: string; // catalog price per seat
  total: string; // seats x unit, from the server
  status: string; // DRAFT, UNPAID, PAID, CANCELLED
  codes: number; // access codes issued (0 until PAID)
  payerUrl?: string; // PayPal payer view, kept private
  webhooks: number;
  lastEvent?: string;
}

const giftKey = (id: string) => `gift:${id}`;

export async function saveGift(kv: KVNamespace, rec: GiftRecord): Promise<void> {
  await kv.put(giftKey(rec.invoiceId), '', { metadata: rec, expirationTtl: TTL });
}

export async function getGift(kv: KVNamespace, id: string): Promise<GiftRecord | null> {
  const { metadata } = await kv.getWithMetadata(giftKey(id));
  return (metadata as GiftRecord | null) ?? null;
}

export async function updateGift(kv: KVNamespace, id: string, patch: Partial<GiftRecord>): Promise<GiftRecord | null> {
  const rec = await getGift(kv, id);
  if (!rec) return null;
  const next = { ...rec, ...patch, updatedAt: new Date().toISOString() };
  await saveGift(kv, next);
  return next;
}

export async function listGifts(kv: KVNamespace, max = 200): Promise<GiftRecord[]> {
  const out: GiftRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'gift:', limit: 1000, cursor });
    for (const k of page.keys) if (k.metadata) out.push(k.metadata as GiftRecord);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && out.length < max);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, max);
}

/** Public view for the dashboard: no payer link, unpaid invoice ids masked. */
export function publicGift(rec: GiftRecord): Omit<GiftRecord, 'payerUrl'> {
  const { payerUrl: _hidden, ...rest } = rec;
  return { ...rest, invoiceId: rec.status === 'PAID' ? rec.invoiceId : '...' + rec.invoiceId.slice(-4) };
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** One code per seat, the same every time for the same invoice: the webhook and
 *  the status check can both issue them without creating a second set. */
export async function giftCodes(secret: string, invoiceId: string, seats: number): Promise<string[]> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const out: string[] = [];
  for (let i = 0; i < seats; i++) {
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`gift:${invoiceId}:${i}`)));
    let s = '';
    for (let j = 0; j < 8; j++) s += CODE_ALPHABET[mac[j] % CODE_ALPHABET.length];
    out.push(`LDR-${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return out;
}

export const GIFT_CODE = /^LDR-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

interface CodeEntry {
  invoiceId: string;
  plan: PlanId;
  used: boolean;
}

/** Writes the codes for a paid invoice. Safe to call twice: used codes stay used. */
export async function issueGiftCodes(kv: KVNamespace, secret: string, rec: GiftRecord): Promise<string[]> {
  const codes = await giftCodes(secret, rec.invoiceId, rec.seats);
  for (const code of codes) {
    const k = `giftcode:${code}`;
    const { value } = await kv.getWithMetadata(k);
    if (value === null) await kv.put(k, JSON.stringify({ invoiceId: rec.invoiceId, plan: rec.plan, used: false } satisfies CodeEntry), { expirationTtl: TTL });
  }
  if (rec.codes !== codes.length) await saveGift(kv, { ...rec, codes: codes.length, updatedAt: new Date().toISOString() });
  return codes;
}

/** Turns one code into access once. Returns null for an unknown or used code. */
export async function redeemGiftCode(kv: KVNamespace, code: string): Promise<{ invoiceId: string; plan: PlanId } | null> {
  const c = String(code ?? '').trim().toUpperCase();
  if (!GIFT_CODE.test(c)) return null;
  const k = `giftcode:${c}`;
  const { value } = await kv.getWithMetadata(k);
  if (value === null) return null;
  let entry: CodeEntry;
  try {
    entry = JSON.parse(value) as CodeEntry;
  } catch {
    return null;
  }
  if (entry.used || !isPlanId(entry.plan)) return null;
  await kv.put(k, JSON.stringify({ ...entry, used: true }), { expirationTtl: TTL });
  return { invoiceId: entry.invoiceId, plan: entry.plan };
}
