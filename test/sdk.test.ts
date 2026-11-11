// The PayPal Server SDK path, end to end but offline: the SDK's HTTP layer is replaced
// by a local function that records each request and answers like PayPal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS } from '../src/catalog.ts';
import { captureOrder, createOrderWithLink, getCapture, getOrderStatuses, refundCapture, useTestTransport } from '../src/paypal.ts';

const ENV = { PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'test-id', PAYPAL_CLIENT_SECRET: 'test-secret' };
type Sent = { method: string; url: string; headers: Record<string, string>; body: any };

function fake(answer: (r: Sent) => [number, unknown]) {
  const sent: Sent[] = [];
  useTestTransport(async (config: any) => {
    const headers: Record<string, string> = {};
    const h = typeof config.headers?.toJSON === 'function' ? config.headers.toJSON() : config.headers ?? {};
    for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    const url = (config.baseURL ?? '') + config.url;
    const raw = config.data;
    const r: Sent = { method: String(config.method).toUpperCase(), url, headers, body: typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : raw };
    sent.push(r);
    const [status, data] = url.endsWith('/v1/oauth2/token') ? [200, { access_token: 'tok', token_type: 'Bearer', expires_in: 32400 }] : answer(r);
    return { status, statusText: String(status), headers: { 'content-type': 'application/json' }, data: JSON.stringify(data), config, request: {} };
  });
  return sent;
}
const api = (s: Sent[]) => s.filter((r) => !r.url.endsWith('/v1/oauth2/token'));

test('SDK createOrder sends the exact Orders v2 JSON, an idempotency key and returns the payer-action link', async () => {
  const sent = fake(() => [200, { id: 'ORDER12345678', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'x' }, { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345678' }] }]);
  const out = await createOrderWithLink(ENV, PLANS.ladder_3m, { me: 'm', obstacles: [], goal: 'Open a bakery' }, { returnUrl: 'https://x.dev/return', cancelUrl: 'https://x.dev/' });
  assert.deepEqual(out, { id: 'ORDER12345678', approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345678' });
  const [r] = api(sent);
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
  assert.equal(r.headers.authorization, 'Bearer tok');
  assert.match(r.headers['paypal-request-id'], /^[0-9a-f-]{36}$/);
  const unit = r.body.purchase_units[0];
  assert.equal(r.body.intent, 'CAPTURE');
  assert.equal(unit.reference_id, 'ladder_3m');
  assert.equal(unit.amount.currency_code, 'USD');
  assert.equal(unit.amount.value, '78.00');
  assert.equal(unit.amount.breakdown.item_total.value, '78.00');
  assert.equal(unit.items[0].category, 'DIGITAL_GOODS');
  assert.equal(unit.items[0].unit_amount.value, '78.00');
  const ctx = r.body.payment_source.paypal.experience_context;
  assert.equal(ctx.shipping_preference, 'NO_SHIPPING');
  assert.equal(ctx.user_action, 'PAY_NOW');
  assert.equal(ctx.return_url, 'https://x.dev/return');
});

test('SDK client reuses one OAuth token across calls', async () => {
  const sent = fake(() => [200, { id: 'ORDER12345678', status: 'CREATED', links: [] }]);
  await createOrderWithLink(ENV, PLANS.ladder_1m, null);
  await createOrderWithLink(ENV, PLANS.ladder_1m, null);
  assert.equal(sent.filter((r) => r.url.endsWith('/v1/oauth2/token')).length, 1);
});

test('SDK captureOrder reads the capture, and a declined card returns INSTRUMENT_DECLINED', async () => {
  fake(() => [201, { id: 'ORDER12345678', status: 'COMPLETED', payer: { name: { given_name: 'Dana' } }, purchase_units: [{ reference_id: 'ladder_1m', payments: { captures: [{ id: 'CAP123456789', status: 'COMPLETED', amount: { currency_code: 'USD', value: '39.00' } }] } }] }]);
  assert.deepEqual(await captureOrder(ENV, 'ORDER12345678'), { status: 'COMPLETED', planId: 'ladder_1m', amount: '39.00', captureId: 'CAP123456789', payerName: 'Dana' });
  fake(() => [422, { name: 'UNPROCESSABLE_ENTITY', message: 'declined', debug_id: 'd1', details: [{ issue: 'INSTRUMENT_DECLINED' }] }]);
  assert.equal((await captureOrder(ENV, 'ORDER12345678')).status, 'INSTRUMENT_DECLINED');
  fake(() => [422, { name: 'UNPROCESSABLE_ENTITY', message: 'x', debug_id: 'd2', details: [{ issue: 'ORDER_NOT_APPROVED' }] }]);
  await assert.rejects(captureOrder(ENV, 'ORDER12345678'), /paypal capture 422 ORDER_NOT_APPROVED/);
  await assert.rejects(captureOrder(ENV, 'bad/../id'), /bad order id/);
});

test('SDK getOrderStatuses maps 404 to EXPIRED and skips bad ids', async () => {
  const sent = fake((r) => (r.url.includes('/GONE12345678') ? [404, { name: 'RESOURCE_NOT_FOUND', message: 'x', debug_id: 'd' }] : [200, { id: 'OK1234567890', status: 'APPROVED' }]));
  assert.deepEqual(await getOrderStatuses(ENV, ['OK1234567890', 'GONE12345678', 'bad id']), { OK1234567890: 'APPROVED', GONE12345678: 'EXPIRED' });
  assert.equal(api(sent).length, 2);
});

test('SDK getCapture and refundCapture: real capture data, one refund per capture', async () => {
  fake(() => [200, { id: 'CAP123456789', status: 'COMPLETED', amount: { currency_code: 'USD', value: '39.00' }, custom_id: 'ladder_1m', create_time: '2026-11-11T10:00:00Z', supplementary_data: { related_ids: { order_id: 'ORDER12345678' } } }]);
  assert.deepEqual(await getCapture(ENV, 'CAP123456789'), { status: 'COMPLETED', amount: '39.00', createTime: '2026-11-11T10:00:00Z', orderId: 'ORDER12345678', planId: 'ladder_1m' });
  fake(() => [404, { name: 'RESOURCE_NOT_FOUND', message: 'x', debug_id: 'd' }]);
  assert.equal(await getCapture(ENV, 'CAP123456789'), null);
  const sent = fake(() => [201, { id: 'REF123456789', status: 'COMPLETED' }]);
  assert.deepEqual(await refundCapture(ENV, 'CAP123456789'), { id: 'REF123456789', status: 'COMPLETED' });
  const [r] = api(sent);
  assert.equal(r.url, 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP123456789/refund');
  assert.equal(r.headers['paypal-request-id'], 'ladder-refund-CAP123456789');
  assert.equal(r.headers.prefer, 'return=minimal');
  assert.deepEqual(r.body, { note_to_payer: 'Ladder 14-day refund guarantee' });
});
