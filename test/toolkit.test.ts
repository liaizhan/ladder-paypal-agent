import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_TOOLS, askPayPal, checkArgs, makeToolkit, readToolCall, redact, workersTools, type ToolkitLike } from '../src/toolkit.ts';

test('real toolkit, read-only config: only get and list tools, no refunds or writes', () => {
  const tk = makeToolkit('id', 'secret', true);
  const names = tk.getTools().map((t) => t.function.name).sort();
  assert.deepEqual(names, ['get_invoice', 'get_order', 'list_disputes', 'list_invoices']);
  assert.ok(!names.some((n) => /create|send|refund|capture|cancel|update|delete|remind/.test(n)));
  const flat = workersTools(tk);
  assert.equal(flat.length, 4);
  assert.ok(flat.every((t) => typeof t.name === 'string' && t.parameters && t.description.length <= 700));
});

test('readToolCall accepts both Workers AI shapes and refuses unknown tools', () => {
  assert.deepEqual(readToolCall({ tool_calls: [{ name: 'get_order', arguments: { id: '9e420655yj316124p' } }] }), { name: 'get_order', args: { id: '9E420655YJ316124P' } });
  assert.deepEqual(
    readToolCall({ choices: [{ message: { tool_calls: [{ function: { name: 'list_disputes', arguments: '{"page_size":50}' } }] } }] }),
    { name: 'list_disputes', args: { page_size: 10 } },
  );
  assert.equal(readToolCall({ tool_calls: [{ name: 'create_refund', arguments: { capture_id: 'X' } }] }), null);
  assert.equal(readToolCall({ tool_calls: [{ name: 'get_order', arguments: '{bad json' }] }), null);
  assert.equal(readToolCall({ response: 'hello' }), null);
});

test('checkArgs drops unknown fields and bad ids', () => {
  assert.equal(checkArgs('get_order', { id: '../../v1/oauth2' }), null);
  assert.equal(checkArgs('get_invoice', { invoice_id: 'INV2-AAAA-BBBB-CCCC' }), null);
  assert.deepEqual(checkArgs('get_invoice', { invoice_id: 'inv2-aaaa-bbbb-cccc-dddd' }), { invoice_id: 'INV2-AAAA-BBBB-CCCC-DDDD' });
  assert.deepEqual(checkArgs('list_invoices', { page_size: 500, fields: 'all' }), { page: 1, page_size: 10, total_required: true });
  assert.ok(ALLOWED_TOOLS.every((t) => checkArgs(t, {}) === null || typeof checkArgs(t, {}) === 'object'));
});

test('redact hides personal fields, payer links and unpaid invoice ids', () => {
  const out = redact({
    items: [
      { id: 'INV2-AAAA-BBBB-CCCC-DDDD', status: 'UNPAID', detail: { metadata: { recipient_view_url: 'https://pay', create_time: 't' } } },
      { id: 'INV2-EEEE-FFFF-GGGG-HHHH', status: 'PAID', primary_recipients: [{ billing_info: { email_address: 'a@b.c', name: { given_name: 'A', surname: 'B' } } }] },
    ],
    payer: { payer_id: 'P1', email_address: 'x@y.z', address: { country_code: 'US' } },
    links: [{ href: 'https://api' }],
  }) as any;
  assert.equal(out.items[0].id, '...DDDD');
  assert.equal(out.items[0].detail.metadata.recipient_view_url, '[hidden]');
  assert.equal(out.items[0].detail.metadata.create_time, 't');
  assert.equal(out.items[1].id, 'INV2-EEEE-FFFF-GGGG-HHHH');
  assert.equal(out.items[1].primary_recipients[0].billing_info.email_address, '[hidden]');
  assert.equal(out.items[1].primary_recipients[0].billing_info.name.given_name, '[hidden]');
  assert.deepEqual(out.payer, { payer_id: '[hidden]', email_address: '[hidden]', address: '[hidden]' });
  assert.equal(out.links, undefined);
  assert.ok(!JSON.stringify(out).includes('@'));
  assert.equal((redact({ id: '9E420655YJ316124P', intent: 'CAPTURE', status: 'APPROVED' }) as any).id, '...6124P');
  assert.equal((redact({ id: '9E420655YJ316124P', intent: 'CAPTURE', status: 'COMPLETED' }) as any).id, '9E420655YJ316124P');
});

function fakeToolkit(content: unknown, calls: string[]): ToolkitLike {
  const real = makeToolkit('id', 'secret', true);
  return {
    getTools: () => real.getTools(),
    handleToolCall: async (c) => { calls.push(c.function.name + ' ' + c.function.arguments); return { content: JSON.stringify(content) }; },
  };
}

test('askPayPal: tool call, redacted result to the summary, read-only note for change requests', async () => {
  const calls: string[] = [];
  const prompts: string[] = [];
  const ai = {
    run: async (_m: string, input: any) => {
      prompts.push(input.messages.map((m: any) => m.content).join('\n'));
      return input.tools ? { tool_calls: [{ name: 'get_order', arguments: { id: '9E420655YJ316124P' } }] } : { response: 'Order is COMPLETED.' };
    },
  };
  const tk = fakeToolkit({ id: '9E420655YJ316124P', status: 'COMPLETED', payer: { email_address: 'p@x.y' } }, calls);
  const r = await askPayPal(ai, 'm', tk, 'Refund my latest order', 'order 9E420655YJ316124P: COMPLETED');
  assert.equal(r.tool, 'get_order');
  assert.deepEqual(calls, ['get_order {"id":"9E420655YJ316124P"}']);
  assert.equal(r.answer, 'Order is COMPLETED.');
  assert.ok(prompts[0].includes('order 9E420655YJ316124P'));
  assert.ok(prompts[1].includes('read-only, so nothing was changed'));
  assert.ok(!prompts[1].includes('p@x.y'));
});

test('askPayPal: no allowed tool means no PayPal call', async () => {
  const calls: string[] = [];
  const ai = { run: async () => ({ tool_calls: [{ name: 'create_invoice', arguments: {} }] }) };
  const r = await askPayPal(ai, 'm', fakeToolkit({}, calls), 'make an invoice', '');
  assert.equal(r.tool, null);
  assert.equal(calls.length, 0);
});
