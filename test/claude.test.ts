import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromClaudeMessage, makeClaudeBinding, toClaudeRequest, type ClaudeRequest } from '../src/claude.ts';
import { readCheckoutCall, parseTurn } from '../src/agent.ts';

const llama = (answer: unknown) => {
  const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  return { calls, run: async (model: string, input: Record<string, unknown>) => (calls.push({ model, input }), answer) };
};

test('leading system becomes the system prompt, a later system note stays as a user note', () => {
  const req = toClaudeRequest('claude-sonnet-5-5', {
    messages: [
      { role: 'system', content: 'You are the checkout agent.' },
      { role: 'user', content: 'I want 3 months' },
      { role: 'system', content: 'Call one tool now.' },
    ],
    max_tokens: 200,
    temperature: 0.1,
  });
  assert.equal(req.system, 'You are the checkout agent.');
  assert.deepEqual(req.messages, [{ role: 'user', content: 'I want 3 months\n\n[App note] Call one tool now.' }]);
  assert.equal(req.max_tokens, 512);
  assert.equal('temperature' in req, false);
});

test('history that starts or ends with the assistant is made valid', () => {
  const req = toClaudeRequest('m', {
    messages: [
      { role: 'system', content: 'S' },
      { role: 'assistant', content: 'Hi, how many people?' },
      { role: 'user', content: '12' },
      { role: 'assistant', content: 'Thanks' },
    ],
  });
  assert.equal(req.messages[0].role, 'user');
  assert.equal(req.messages.at(-1)!.role, 'user');
  for (let i = 1; i < req.messages.length; i++) assert.notEqual(req.messages[i].role, req.messages[i - 1].role);
});

test('json_object adds a JSON-only instruction; tools keep their schema without $schema', () => {
  const req = toClaudeRequest('m', {
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }],
    response_format: { type: 'json_object' },
    tools: [{ name: 'get_order', description: 'Get an order', parameters: { type: 'object', properties: { id: { type: 'string' } }, $schema: 'http://json-schema.org/draft-07/schema#' } }],
  });
  assert.match(req.system!, /JSON object only/);
  assert.deepEqual(req.tools, [{ name: 'get_order', description: 'Get an order', input_schema: { type: 'object', properties: { id: { type: 'string' } } } }]);
  assert.deepEqual(req.tool_choice, { type: 'auto' });
});

test('a Claude tool_use block comes back in the Workers AI shape the guards already read', () => {
  const out = fromClaudeMessage({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'create_checkout', input: { plan: 'ladder_3m' } }] });
  assert.deepEqual(out, { tool_calls: [{ name: 'create_checkout', arguments: { plan: 'ladder_3m' } }] });
  assert.equal(readCheckoutCall(out).tool, 'create_checkout');
});

test('Claude text comes back as response and the advisor parser reads it', () => {
  const out = fromClaudeMessage({ content: [{ type: 'text', text: '{"stage":"ask","reply":"What is your goal?"}' }] });
  assert.equal(parseTurn(out.response, false).reply, 'What is your goal?');
});

test('Claude answers first when it works', async () => {
  const sent: ClaudeRequest[] = [];
  const fallback = llama({ response: 'llama' });
  const ai = makeClaudeBinding({
    claudeModel: 'claude-sonnet-5-5',
    fallback,
    client: { messages: { create: async (r) => (sent.push(r), { content: [{ type: 'text', text: 'claude' }] }) } },
  });
  assert.deepEqual(await ai.run('@cf/llama', { messages: [{ role: 'user', content: 'hi' }] }), { response: 'claude' });
  assert.equal(sent[0].model, 'claude-sonnet-5-5');
  assert.equal(fallback.calls.length, 0);
});

test('an error from Claude sends the same input to Llama', async () => {
  const reasons: string[] = [];
  const fallback = llama({ response: 'llama' });
  const input = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 200 };
  const ai = makeClaudeBinding({
    claudeModel: 'claude-sonnet-5-5',
    fallback,
    onFallback: (r) => reasons.push(r),
    client: { messages: { create: async () => { throw new Error('529 overloaded'); } } },
  });
  assert.deepEqual(await ai.run('@cf/llama', input), { response: 'llama' });
  assert.deepEqual(fallback.calls, [{ model: '@cf/llama', input }]);
  assert.deepEqual(reasons, ['529 overloaded']);
});

test('without an API key every call goes to Llama', async () => {
  const fallback = llama({ response: 'llama' });
  const ai = makeClaudeBinding({ claudeModel: 'claude-sonnet-5-5', fallback });
  assert.deepEqual(await ai.run('@cf/llama', { messages: [] }), { response: 'llama' });
  assert.equal(fallback.calls.length, 1);
});

test('an empty Claude answer also falls back', async () => {
  const fallback = llama({ response: 'llama' });
  const ai = makeClaudeBinding({ claudeModel: 'm', fallback, client: { messages: { create: async () => ({ content: [] }) } } });
  assert.deepEqual(await ai.run('@cf/llama', { messages: [{ role: 'user', content: 'x' }] }), { response: 'llama' });
});

test('tools in the OpenAI shape { type, function } are flattened for Claude', () => {
  const req = toClaudeRequest('m', {
    messages: [{ role: 'user', content: 'q' }],
    tools: [{ type: 'function', function: { name: 'skip_order', description: 'Skip', parameters: { type: 'object', properties: { reason: { type: 'string' } } } } }],
  });
  assert.deepEqual(req.tools, [{ name: 'skip_order', description: 'Skip', input_schema: { type: 'object', properties: { reason: { type: 'string' } } } }]);
});
