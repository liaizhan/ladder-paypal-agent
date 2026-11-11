import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGridView, readViewCall, cleanQuestion, askGrid, VIEW_TOOL } from '../src/ask.ts';

const NOW = new Date('2026-11-11T12:00:00Z');

test('a full tool call becomes an AG Grid filter model, sort and chips', () => {
  const v = toGridView({ status: 'paid', created_by: 'mcp', chosen_plan: 'ladder_3m', followed_ai: 'no', language: 'ru', min_amount: 40, sort_by: 'amount', sort_dir: 'desc' }, NOW);
  assert.equal(v.status, 'paid');
  assert.deepEqual(v.filterModel.createdBy, { filterType: 'text', type: 'equals', filter: 'Agent over MCP' });
  assert.deepEqual(v.filterModel.chosen, { filterType: 'text', type: 'equals', filter: '3 months' });
  assert.deepEqual(v.filterModel.followedAdvice, { filterType: 'text', type: 'equals', filter: 'Switched' });
  assert.deepEqual(v.filterModel.lang, { filterType: 'text', type: 'equals', filter: 'Russian' });
  assert.deepEqual(v.filterModel.amount, { filterType: 'number', type: 'greaterThanOrEqual', filter: 40 });
  assert.deepEqual(v.sort, { colId: 'amount', sort: 'desc' });
  assert.ok(v.chips.includes('Created by Agent over MCP'));
});

test('values outside the fixed lists are dropped, not passed to the grid', () => {
  const v = toGridView({ status: 'everything', created_by: 'admin', chosen_plan: 'ladder_free', sort_by: 'orderId; drop', min_amount: -5, max_amount: 'lots', last_days: 9999, evil: '<script>' }, NOW);
  assert.equal(v.status, 'all');
  assert.deepEqual(v.filterModel, {});
  assert.equal(v.sort, null);
  assert.deepEqual(v.chips, []);
});

test('amount range and last N days', () => {
  const v = toGridView({ min_amount: 30, max_amount: '50', last_days: 7 }, NOW);
  assert.deepEqual(v.filterModel.amount, { filterType: 'number', type: 'inRange', filter: 30, filterTo: 50 });
  assert.deepEqual(v.filterModel.createdAt, { filterType: 'date', type: 'greaterThan', dateFrom: '2026-11-04 00:00:00' });
  assert.ok(v.chips.includes('Last 7 days'));
  assert.ok(toGridView({ last_days: 1 }, NOW).chips.includes('Today'));
});

test('reads set_grid_view in both Workers AI shapes and ignores other tools', () => {
  assert.deepEqual(readViewCall({ tool_calls: [{ name: 'set_grid_view', arguments: { status: 'paid' } }] }), { status: 'paid' });
  assert.deepEqual(readViewCall({ choices: [{ message: { tool_calls: [{ function: { name: 'set_grid_view', arguments: '{"sort_by":"amount"}' } }] } }] }), { sort_by: 'amount' });
  assert.equal(readViewCall({ tool_calls: [{ name: 'create_paypal_order', arguments: {} }] }), null);
  assert.equal(readViewCall({ response: 'hi' }), null);
});

test('askGrid sends only the question and the one tool', async () => {
  let sent: any;
  const ai = { run: async (_m: string, input: any) => { sent = input; return { tool_calls: [{ name: 'set_grid_view', arguments: { status: 'refunded' } }] }; } };
  const r = await askGrid(ai as any, 'model', cleanQuestion('  Refunds  please '));
  assert.equal(r.view?.status, 'refunded');
  assert.equal(sent.tools.length, 1);
  assert.equal(sent.tools[0], VIEW_TOOL);
  assert.equal(sent.messages[1].content, 'Refunds please');
  assert.equal(cleanQuestion('x'.repeat(500)).length, 200);
  assert.equal(cleanQuestion(42), '');
});
