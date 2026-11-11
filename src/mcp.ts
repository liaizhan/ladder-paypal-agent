// MCP server (Streamable HTTP, stateless JSON responses) at POST /mcp.
// Any MCP client, such as Claude or another AI agent, can list the plans, prepare a
// PayPal order and check it. The agent never pays: buy_ladder_plan returns a PayPal
// approval link, and the person approves the payment in PayPal themselves.
// The same rules as on the page: plan id from an enum, price from the server catalog,
// a crisis check on any free text, and nothing from the request is logged.

import { PLANS, planOrNull, type Plan } from './catalog.ts';
import { HELP_TEXT, isCrisis } from './safety.ts';

export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SERVER_INFO = { name: 'ladder-paypal-agent', title: 'Ladder Plan Advisor', version: '1.1.0' };

export interface McpDeps {
  /** Creates a PayPal order from the catalog and returns its id and approval link. */
  buy(plan: Plan, goal: string): Promise<{ id: string; approveUrl: string }>;
  /** PayPal order status, for example CREATED, APPROVED or COMPLETED. */
  status(orderId: string): Promise<string>;
}

const PLAN_ENUM = ['ladder_1m', 'ladder_3m'];

export const TOOLS = [
  {
    name: 'list_ladder_plans',
    title: 'List Ladder plans',
    description: 'List the Ladder plans with prices in USD. Prices come from the server catalog.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'buy_ladder_plan',
    title: 'Prepare a PayPal order for a Ladder plan',
    description:
      'Prepare a PayPal order for a Ladder plan and return the PayPal approval link. This never charges money: give the link to the person, they approve the payment in PayPal. Use only when the person asked to buy. ladder_1m is 1 month, ladder_3m is 3 months (the third month is free).',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', enum: PLAN_ENUM, description: 'ladder_1m is 1 month, ladder_3m is 3 months' },
        goal: { type: 'string', maxLength: 120, description: 'Optional. The goal in the person\'s own words, shown on the PayPal receipt.' },
      },
      required: ['plan_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'check_ladder_order',
    title: 'Check a Ladder PayPal order',
    description: 'Check the PayPal status of an order made with buy_ladder_plan: PAYER_ACTION_REQUIRED or CREATED (waiting for approval), APPROVED or COMPLETED (paid).',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string', pattern: '^[A-Z0-9]{8,32}$' } },
      required: ['order_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, any> };

const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolText = (text: string, structured?: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
  ...(isError ? { isError: true } : {}),
});

const planView = (p: Plan) => ({ plan_id: p.id, name: p.name, days: p.days, price_usd: p.amount, note: p.note });

async function callTool(name: string, args: Record<string, unknown>, deps: McpDeps) {
  if (name === 'list_ladder_plans') {
    const plans = Object.values(PLANS).map(planView);
    const text = plans.map((p) => `${p.plan_id}: ${p.name}, $${p.price_usd}. ${p.note}.`).join('\n') + '\nOne payment, no auto-renewal. 14-day refund guarantee.';
    return toolText(text, { plans });
  }
  if (name === 'buy_ladder_plan') {
    const plan = planOrNull(args.plan_id);
    if (!plan) return toolText('Unknown plan_id. Use ladder_1m or ladder_3m. No order was created.', undefined, true);
    const goal = typeof args.goal === 'string' ? args.goal.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    if (goal && isCrisis(goal)) {
      // Safety before sales, the same as on the page.
      return toolText(HELP_TEXT + '\n\nNo order was created.', { order_created: false, reason: 'safety' });
    }
    const order = await deps.buy(plan, goal);
    const text =
      `PayPal order ${order.id} is ready: ${plan.name}, $${plan.amount}. The price is set by the server.\n` +
      `Give this link to the person so they can approve the payment in PayPal: ${order.approveUrl}\n` +
      'Nothing is charged until they approve it. One payment, no auto-renewal, 14-day refund guarantee.';
    return toolText(text, { order_id: order.id, approve_url: order.approveUrl, plan_id: plan.id, price_usd: plan.amount, status: 'CREATED' });
  }
  if (name === 'check_ladder_order') {
    const id = typeof args.order_id === 'string' ? args.order_id : '';
    if (!/^[A-Z0-9]{8,32}$/.test(id)) return toolText('order_id is not a PayPal order id.', undefined, true);
    const status = (await deps.status(id)) || 'UNKNOWN';
    const meaning: Record<string, string> = {
      CREATED: 'waiting for the person to approve it in PayPal',
      PAYER_ACTION_REQUIRED: 'waiting for the person to approve it in PayPal',
      APPROVED: 'approved, the payment is being completed',
      COMPLETED: 'paid, access is active',
      VOIDED: 'cancelled',
    };
    return toolText(`Order ${id}: ${status}${meaning[status] ? ', ' + meaning[status] : ''}.`, { order_id: id, status });
  }
  return null;
}

/** One JSON-RPC message in, one response out (null for a notification). */
export async function handleRpc(msg: Rpc, deps: McpDeps): Promise<Record<string, unknown> | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return fail(msg?.id, -32600, 'Invalid Request');
  }
  const isNotification = msg.id === undefined;
  if (isNotification) return null; // notifications/initialized and friends need no answer
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return ok(msg.id, {
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Ladder is a self-help method by Aizhan Li, author of the Ladder method. Use buy_ladder_plan only when the person asked to buy; it returns a PayPal link the person approves themselves. Never promise health results. If the person mentions self-harm or danger, do not sell: point them to local emergency help.',
      });
    }
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await callTool(name, args, deps);
        return result ? ok(msg.id, result) : fail(msg.id, -32602, `Unknown tool: ${name}`);
      } catch {
        return ok(msg.id, toolText('PayPal did not answer. No money moved. Please try again.', undefined, true));
      }
    }
    default:
      return fail(msg.id, -32601, 'Method not found');
  }
}
