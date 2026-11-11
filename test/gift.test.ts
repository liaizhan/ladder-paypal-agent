import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, cleanSeats, giftTotal } from '../src/catalog.ts';
import { DEFAULT_GIFT_NOTE, cleanGiftNote, parseGiftCall } from '../src/agent.ts';
import { INVOICE_ID, buildGiftInvoice, invoiceEventId, readInvoice } from '../src/paypal.ts';
import { signGift, verifyGift } from '../src/pass.ts';
import { GIFT_CODE, giftCodes, noteRedeemFail, redeemBlocked, issueGiftCodes, publicGift, redeemGiftCode, saveGift, getGift, type GiftRecord, type KVNamespace } from '../src/ledger.ts';

function memoryKv(): KVNamespace {
  const m = new Map<string, { value: string; metadata: unknown }>();
  return {
    async get(key) { const e = m.get(key); return e ? JSON.parse(e.value) : null; },
    async put(key, value, opts) { m.set(key, { value, metadata: opts?.metadata ?? null }); },
    async getWithMetadata(key) { const e = m.get(key); return e ? e : { value: null, metadata: null }; },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, metadata: m.get(name)!.metadata })), list_complete: true }; },
  };
}

const ID = 'INV2-TWZJ-7HWR-EAMN-MJ68';

test('gift seats: 1 to 200 whole seats, total in cents from the catalog', () => {
  assert.equal(cleanSeats(20), 20);
  assert.equal(cleanSeats('8'), 8);
  assert.equal(cleanSeats(0), null);
  assert.equal(cleanSeats(201), null);
  assert.equal(cleanSeats(2.5), null);
  assert.equal(cleanSeats('ten'), null);
  assert.equal(giftTotal(PLANS.ladder_3m, 20), '1560.00');
  assert.equal(giftTotal(PLANS.ladder_1m, 3), '117.00');
});

test('gift invoice: one line, quantity = seats, price from the catalog, no partial payments', () => {
  const body = buildGiftInvoice({ plan: PLANS.ladder_3m, seats: 20, note: 'A gift for you', company: 'Acme' });
  assert.equal(body.detail.reference, 'gift:ladder_3m');
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].quantity, '20');
  assert.equal(body.items[0].unit_amount.value, '78.00');
  assert.equal(body.configuration.partial_payment.allow_partial_payment, false);
  assert.ok(body.items[0].description.includes('Acme'));
});

test('gift invoice: PayPal answer is read into plan, seats, totals', () => {
  const info = readInvoice({ id: ID, status: 'PAID', detail: { invoice_number: '0007', reference: 'gift:ladder_1m' }, amount: { value: '117.00' }, payments: { paid_amount: { value: '117.00' } }, items: [{ quantity: '3' }] });
  assert.deepEqual(info, { id: ID, number: '0007', status: 'PAID', total: '117.00', paid: '117.00', planId: 'ladder_1m', seats: 3 });
  assert.equal(readInvoice({ detail: { reference: 'other' } }).planId, '');
  assert.ok(INVOICE_ID.test(ID));
  assert.equal(invoiceEventId({ resource: { invoice: { id: ID } } }), ID);
  assert.equal(invoiceEventId({ resource: { id: ID } }), ID);
  assert.equal(invoiceEventId({ resource: { id: '../evil' } }), '');
});

test('gift agent: tool call read in both Workers AI shapes, seats out of range become null', () => {
  const flat = parseGiftCall({ tool_calls: [{ name: 'create_gift_invoice', arguments: { plan_id: 'ladder_3m', seats: 20, gift_note: 'Happy New Year! This is time for yourself, from all of us.', company: 'Acme <script>' } }] });
  assert.equal(flat?.kind, 'invoice');
  if (flat?.kind === 'invoice') {
    assert.equal(flat.seats, 20);
    assert.equal(flat.company, 'Acme script');
  }
  const nested = parseGiftCall({ choices: [{ message: { tool_calls: [{ function: { name: 'create_gift_invoice', arguments: JSON.stringify({ plan_id: 'ladder_1m', seats: 5000 }) } }] } }] });
  assert.equal(nested?.kind === 'invoice' && nested.seats, null);
  assert.equal(parseGiftCall({ tool_calls: [{ name: 'create_gift_invoice', arguments: { plan_id: 'ladder_free', seats: 3 } }] }), null);
  const ask = parseGiftCall({ tool_calls: [{ name: 'ask_hr', arguments: { question: 'How many people are on the team?' } }] });
  assert.deepEqual(ask, { kind: 'ask', question: 'How many people are on the team?' });
});

test('gift note: prices and health promises never reach employees', () => {
  assert.equal(cleanGiftNote('A gift worth $78 for each of you, enjoy the practices.'), DEFAULT_GIFT_NOTE);
  assert.equal(cleanGiftNote('These practices will cure your stress, enjoy this gift.'), DEFAULT_GIFT_NOTE);
  assert.equal(cleanGiftNote('Talk to your therapist and use this gift for yourself.'), DEFAULT_GIFT_NOTE);
  assert.equal(cleanGiftNote('short'), DEFAULT_GIFT_NOTE);
  const ok = 'Happy New Year from the whole team. Take some time for yourself.';
  assert.equal(cleanGiftNote(ok), ok);
});

test('gift codes: one per seat, stable for the same invoice, each code works once', async () => {
  const a = await giftCodes('secret', ID, 3);
  const b = await giftCodes('secret', ID, 3);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 3);
  assert.ok(a.every((c) => GIFT_CODE.test(c)));
  assert.notDeepEqual(await giftCodes('other', ID, 3), a);

  const kv = memoryKv();
  const rec: GiftRecord = { invoiceId: ID, invoiceNumber: '0007', createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z', plan: 'ladder_3m', seats: 3, unit: '78.00', total: '234.00', status: 'PAID', codes: 0, payerUrl: 'https://www.sandbox.paypal.com/invoice/p/#X', webhooks: 1 };
  await saveGift(kv, rec);
  const codes = await issueGiftCodes(kv, 'secret', rec);
  assert.equal((await getGift(kv, ID))?.codes, 3);
  assert.deepEqual(await redeemGiftCode(kv, codes[0].toLowerCase()), { invoiceId: ID, plan: 'ladder_3m' });
  assert.equal(await redeemGiftCode(kv, codes[0]), null);
  await issueGiftCodes(kv, 'secret', rec); // a second webhook does not revive a used code
  assert.equal(await redeemGiftCode(kv, codes[0]), null);
  assert.equal(await redeemGiftCode(kv, 'LDR-AAAA-AAAA-AAAA'), null);
  assert.equal(await redeemGiftCode(kv, codes[1].slice(0, 13)), null); // the old 8-symbol shape is not accepted
  assert.equal(await redeemGiftCode(kv, 'not a code'), null);
});

test('gift: HR token is bound to one invoice, dashboard hides payer link and unpaid ids', async () => {
  const t = await signGift('secret', ID);
  assert.ok(await verifyGift('secret', t, ID));
  assert.equal(await verifyGift('secret', t, 'INV2-AAAA-BBBB-CCCC-DDDD'), false);
  assert.equal(await verifyGift('other', t, ID), false);
  const rec: GiftRecord = { invoiceId: ID, invoiceNumber: '1', createdAt: '', updatedAt: '', plan: 'ladder_1m', seats: 2, unit: '39.00', total: '78.00', status: 'UNPAID', codes: 0, payerUrl: 'https://x', webhooks: 0 };
  const pub = publicGift(rec) as Record<string, unknown>;
  assert.equal(pub.payerUrl, undefined);
  assert.equal(pub.invoiceId, '...MJ68');
  assert.equal(publicGift({ ...rec, status: 'PAID' }).invoiceId, ID);
});

test('gift redeem: after 10 wrong codes in an hour the client is blocked', async () => {
  const kv = memoryKv();
  for (let i = 0; i < 9; i++) await noteRedeemFail(kv, 'abc');
  assert.equal(await redeemBlocked(kv, 'abc'), false);
  await noteRedeemFail(kv, 'abc');
  assert.equal(await redeemBlocked(kv, 'abc'), true);
  assert.equal(await redeemBlocked(kv, 'other'), false);
});
