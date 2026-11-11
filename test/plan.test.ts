import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitDays, buildPlan, cleanText, readPlanCall, askPlan, validWeights, PLAN_TOOL, MIN_STEP_DAYS } from '../src/plan.ts';

const LADDER = { me: 'Me now', obstacles: ['Fear of mistakes', 'Never finish things', 'Weak English'], goal: 'Work abroad' };
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

test('splitDays sums exactly to the period and keeps the minimum per step', () => {
  for (const [total, n, w] of [[30, 3, [10, 30, 50]], [90, 7, [1, 1, 1, 1, 1, 1, 90]], [90, 4, undefined], [31, 3, [1, 2, 3]]] as const) {
    const d = splitDays(total, n, w as any);
    assert.equal(d.length, n);
    assert.equal(sum(d), total);
    assert.ok(d.every((x) => x >= MIN_STEP_DAYS));
  }
  assert.deepEqual(splitDays(30, 3, [5, 10, 15]), [6, 10, 14]);
});

test('bad weights fall back to an even split', () => {
  assert.deepEqual(splitDays(30, 3, [1, 2]), [10, 10, 10]);
  assert.deepEqual(splitDays(30, 3, [1, -2, 3]), [10, 10, 10]);
  assert.deepEqual(splitDays(30, 3, 'nonsense'), [10, 10, 10]);
  assert.equal(validWeights(30, 3, [1, 500, 3]), null);
  assert.deepEqual(validWeights(30, 3, '["5","10","15"]'), [5, 10, 15]);
  assert.equal(sum(splitDays(5, 3)), 5);
});

test('a draft plan starts today, chains the steps and ends on the goal', () => {
  const p = buildPlan({ ladder: LADDER, totalDays: 30, startDate: '2026-11-11', status: 'draft', args: { days: [5, 10, 15], practices: ['Notice one fear a day', 'Finish one tiny thing', 'Ten minutes of English'] } });
  assert.equal(p.status, 'draft');
  assert.equal(p.source, 'ai');
  assert.equal(p.endDate, '2026-12-11');
  assert.equal(p.tasks[0].name, 'Starts when PayPal confirms the payment');
  assert.equal(p.tasks.find((t) => t.id === 2)?.startDate, '2026-11-25');
  const steps = p.tasks.filter((t) => t.kind === 'step');
  assert.deepEqual(steps.map((t) => t.startDate), ['2026-11-11', '2026-11-17', '2026-11-27']);
  assert.equal(sum(steps.map((t) => t.duration)), 30);
  assert.equal(steps[2].note, 'Ten minutes of English');
  assert.equal(p.tasks.find((t) => t.kind === 'goal')?.name, 'Goal: Work abroad');
  assert.deepEqual(p.dependencies.map((d) => [d.fromTask, d.toTask]), [[1, 10], [10, 11], [11, 12], [12, 3]]);
});

test('an active plan names the capture; a refunded plan closes its steps', () => {
  const a = buildPlan({ ladder: LADDER, totalDays: 90, startDate: '2026-11-11', status: 'active', captureId: 'CAP123' });
  assert.equal(a.source, 'even');
  assert.equal(a.tasks[0].name, 'PayPal payment captured CAP123');
  assert.ok(a.tasks.every((t) => !t.inactive));
  const r = buildPlan({ ladder: LADDER, totalDays: 90, startDate: '2026-11-11', status: 'refunded', captureId: 'CAP123', refundId: 'REF9' });
  assert.ok(r.tasks.filter((t) => t.kind === 'step' || t.kind === 'goal').every((t) => t.inactive));
  assert.equal(r.tasks.find((t) => t.kind === 'refund')?.name, 'PayPal refund REF9: plan closed');
});

test('text from the ladder and the model is cleaned before it reaches the timeline', () => {
  assert.equal(cleanText('<img src=x onerror="a">  ok', 90), 'img src=x onerror= a ok');
  assert.equal(cleanText(42, 90), '');
  assert.equal(cleanText('x'.repeat(200), 90).length, 90);
  const p = buildPlan({ ladder: { me: 'm', obstacles: ['<b>bold</b>'], goal: '' }, totalDays: 30, startDate: '2026-11-11', status: 'draft', args: { practices: ['<script>x</script>'] } });
  assert.ok(!JSON.stringify(p.tasks).includes('<'));
  assert.equal(p.tasks.find((t) => t.kind === 'goal')?.name, 'Your goal');
});

test('reads schedule_ladder_steps in both Workers AI shapes', () => {
  assert.deepEqual(readPlanCall({ tool_calls: [{ name: 'schedule_ladder_steps', arguments: { days: [1] } }] }), { days: [1] });
  assert.deepEqual(readPlanCall({ choices: [{ message: { tool_calls: [{ function: { name: 'schedule_ladder_steps', arguments: '{"days":[2]}' } }] } }] }), { days: [2] });
  assert.equal(readPlanCall({ tool_calls: [{ name: 'create_paypal_order', arguments: {} }] }), null);
  assert.equal(readPlanCall({ response: 'hi' }), null);
});

test('askPlan sends the ladder and the period with only the plan tool', async () => {
  let sent: any;
  const ai = { run: async (_m: string, input: any) => { sent = input; return { tool_calls: [{ name: 'schedule_ladder_steps', arguments: { days: [10, 10, 10] } }] }; } };
  const args = await askPlan(ai as any, 'model', LADDER, 30);
  assert.deepEqual(args, { days: [10, 10, 10] });
  assert.equal(sent.tools.length, 1);
  assert.equal(sent.tools[0], PLAN_TOOL);
  assert.equal(JSON.parse(sent.messages[1].content).period_days, 30);
  assert.ok(!sent.messages[0].content.includes('$'));
});
