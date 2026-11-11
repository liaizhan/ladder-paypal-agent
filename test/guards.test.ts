import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCheckoutCall } from '../src/agent.ts';
import { captureGuard, captureMatches, chatGuards, injectionGuard, tamperGuard } from '../src/guards.ts';

test('readCheckoutCall keeps the raw call but accepts only an enum plan', () => {
  const call = readCheckoutCall({ tool_calls: [{ name: 'create_paypal_order', arguments: { plan_id: 'ladder_free', amount: '1.00' } }] });
  assert.equal(call.tool, 'create_paypal_order');
  assert.match(call.args, /ladder_free/);
  assert.equal(call.plan, null);
  const ok = readCheckoutCall({ choices: [{ message: { tool_calls: [{ function: { name: 'create_paypal_order', arguments: '{"plan_id":"ladder_3m","amount":"1.00"}' } }] } }] });
  assert.equal(ok.plan, 'ladder_3m');
  assert.deepEqual(readCheckoutCall({}), { tool: '', args: '', plan: null });
});

test('chatGuards show the server price and a respected refusal', () => {
  const buy = chatGuards({ tool: 'create_paypal_order', args: '{}', plan: 'ladder_3m' });
  assert.deepEqual(buy.map((g) => g.id), ['crisis', 'enum', 'price', 'approve']);
  assert.match(buy[2].text, /\$78\.00/);
  const skip = chatGuards({ tool: 'skip_order', args: '{}', plan: null });
  assert.deepEqual(skip.map((g) => g.id), ['crisis', 'refusal']);
  assert.deepEqual(chatGuards(null).map((g) => g.id), ['crisis']);
});

test('a $1 injection never changes the price', () => {
  const g = injectionGuard({ tool: 'create_paypal_order', args: '{"plan_id":"ladder_1m","amount":"1.00"}', plan: 'ladder_1m' });
  assert.match(g.text, /price stays \$39\.00/);
  const none = injectionGuard({ tool: 'create_paypal_order', args: '{"plan_id":"ladder_free"}', plan: null });
  assert.match(none.text, /accepted nothing/);
});

test('a tampered browser body still sends the catalog amount', () => {
  const g = tamperGuard({ plan: 'ladder_1m', amount: '1.00' });
  assert.ok(g.ok);
  assert.match(g.text, /PayPal gets \$39\.00/);
  assert.match(tamperGuard({ plan: 'ladder_free', amount: '1.00' }).text, /refused with 400/);
});

test('capture must match the catalog amount', () => {
  assert.equal(captureMatches('COMPLETED', 'ladder_1m', '1.00'), null);
  assert.equal(captureMatches('PENDING', 'ladder_1m', '39.00'), null);
  assert.equal(captureMatches('COMPLETED', 'ladder_1m', '39.00')?.id, 'ladder_1m');
  assert.ok(captureGuard().ok);
});
