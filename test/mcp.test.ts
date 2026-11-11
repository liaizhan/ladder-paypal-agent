import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRpc, TOOLS, type McpDeps } from '../src/mcp.ts';
import { approvalLink, buildOrder } from '../src/paypal.ts';
import { PLANS } from '../src/catalog.ts';
import { renderReturn } from '../src/returnPage.ts';

function fakeDeps() {
  const bought: { plan: string; goal: string }[] = [];
  const deps: McpDeps = {
    buy: async (plan, goal) => {
      bought.push({ plan: plan.id, goal });
      return { id: 'ORDER12345678', approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345678' };
    },
    status: async () => 'CREATED',
  };
  return { deps, bought };
}

const call = (name: string, args: unknown, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('initialize answers with a supported protocol version and tools capability', async () => {
  const { deps } = fakeDeps();
  const r: any = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, deps);
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.ok(r.result.capabilities.tools);
  const old: any = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, deps);
  assert.equal(old.result.protocolVersion, '2025-11-25');
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps), null);
});

test('tools/list exposes three tools; buy_ladder_plan has no price field', async () => {
  const { deps } = fakeDeps();
  const r: any = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps);
  assert.deepEqual(r.result.tools.map((t: any) => t.name), ['list_ladder_plans', 'buy_ladder_plan', 'check_ladder_order']);
  const buy = TOOLS.find((t) => t.name === 'buy_ladder_plan')!;
  assert.deepEqual(Object.keys(buy.inputSchema.properties), ['plan_id', 'goal']);
});

test('buy_ladder_plan returns the PayPal link and the catalog price, ignoring an amount', async () => {
  const { deps, bought } = fakeDeps();
  const r: any = await handleRpc(call('buy_ladder_plan', { plan_id: 'ladder_3m', amount: '1.00', goal: 'Launch my course' }), deps);
  assert.equal(r.result.structuredContent.price_usd, '78.00');
  assert.match(r.result.structuredContent.approve_url, /sandbox\.paypal\.com/);
  assert.match(r.result.content[0].text, /Nothing is charged until they approve/);
  assert.deepEqual(bought, [{ plan: 'ladder_3m', goal: 'Launch my course' }]);
});

test('buy_ladder_plan refuses unknown plans and never sells on a crisis signal', async () => {
  const { deps, bought } = fakeDeps();
  const bad: any = await handleRpc(call('buy_ladder_plan', { plan_id: 'ladder_free' }), deps);
  assert.equal(bad.result.isError, true);
  const crisis: any = await handleRpc(call('buy_ladder_plan', { plan_id: 'ladder_1m', goal: 'I want to kill myself' }), deps);
  assert.equal(crisis.result.structuredContent.order_created, false);
  assert.equal(bought.length, 0);
});

test('check_ladder_order validates the id; unknown methods and tools get errors', async () => {
  const { deps } = fakeDeps();
  const r: any = await handleRpc(call('check_ladder_order', { order_id: 'ORDER12345678' }), deps);
  assert.equal(r.result.structuredContent.status, 'CREATED');
  const bad: any = await handleRpc(call('check_ladder_order', { order_id: '../x' }), deps);
  assert.equal(bad.result.isError, true);
  const m: any = await handleRpc({ jsonrpc: '2.0', id: 9, method: 'resources/list' }, deps);
  assert.equal(m.error.code, -32601);
  const t: any = await handleRpc(call('pay_now', {}), deps);
  assert.equal(t.error.code, -32602);
  const inv: any = await handleRpc({ id: 1, method: 'ping' } as any, deps);
  assert.equal(inv.error.code, -32600);
});

test('orders for MCP carry return and cancel urls; page orders do not', () => {
  const withReturn: any = buildOrder(PLANS.ladder_1m, null, { returnUrl: 'https://x.dev/return', cancelUrl: 'https://x.dev/' });
  assert.equal(withReturn.paymentSource.paypal.experienceContext.returnUrl, 'https://x.dev/return');
  const page: any = buildOrder(PLANS.ladder_1m, null);
  assert.equal(page.paymentSource.paypal.experienceContext.returnUrl, undefined);
  assert.equal(approvalLink([{ rel: 'self', href: 'a' }, { rel: 'payer-action', href: 'b' }]), 'b');
  assert.equal(approvalLink([{ rel: 'approve', href: 'c' }]), 'c');
  assert.equal(approvalLink(null), '');
});

test('the return page escapes text and embeds the pass safely', () => {
  const html = renderReturn({ kind: 'paid', planName: '<b>x</b>', amount: '39.00', captureId: 'CAP1', expires: '2026-12-11T00:00:00Z', pass: '</script><x>' });
  assert.ok(!html.includes('<b>x</b>'));
  assert.ok(!html.includes('</script><x>'));
  assert.match(renderReturn({ kind: 'error', message: 'No <money>' }), /No &lt;money&gt;/);
});
