import { advise, checkoutAgent, firstStep, sanitize, type AiBinding, type Ladder } from './agent.ts';
import { PLANS, planOrNull } from './catalog.ts';
import { captureOrder, createOrder, eventToUpdate, getCapture, getOrderStatuses, refundCapture, verifyWebhook, webhookHeaders } from './paypal.ts';
import { expiryFrom, signPass, signRecommendation, verifyPass, verifyRecommendation } from './pass.ts';
import {
  applyWebhook,
  countChat,
  detectLang,
  linkCapture,
  orderIdForCapture,
  isFinal,
  listDays,
  listOrders,
  newOrderRecord,
  publicOrder,
  saveOrder,
  updateOrder,
  type ChatEvent,
  type KVNamespace,
} from './ledger.ts';
import { renderDashboard } from './dashboard.ts';
import { HELP_TEXT, isCrisis } from './safety.ts';
import { renderPage } from './page.ts';

export interface Env {
  AI: AiBinding;
  AI_MODEL: string;
  PAYPAL_ENV: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PASS_SECRET: string;
  PAYPAL_WEBHOOK_ID?: string;
  LADDER_ORDERS?: KVNamespace;
}

const REFUND_DAYS = 14;

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

// Ledger writes never break a chat or a payment.
function background(ctx: Ctx, work: Promise<unknown>): void {
  ctx.waitUntil(work.catch((err) => console.log(JSON.stringify({ event: 'ledger_error', message: String(err) }))));
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

function cleanLadder(raw: unknown): Ladder | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    me: String(r.me ?? '').slice(0, 200),
    obstacles: Array.isArray(r.obstacles) ? r.obstacles.map((o) => String(o).slice(0, 160)).slice(0, 7) : [],
    goal: String(r.goal ?? '').slice(0, 200),
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'GET' && pathname === '/') {
      return new Response(renderPage({ clientId: env.PAYPAL_CLIENT_ID, plans: Object.values(PLANS), env: env.PAYPAL_ENV }), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (request.method === 'GET' && pathname === '/dashboard') {
      return new Response(renderDashboard(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    try {
      if (request.method === 'POST' && pathname === '/api/chat') {
        const body = await readJson(request);
        const history = sanitize(body.messages);
        const last = [...history].reverse().find((m) => m.role === 'user');
        if (!last) return json({ error: 'empty' }, 400);
        const events: ChatEvent[] = history.filter((m) => m.role === 'user').length === 1 ? [{ kind: 'start' }] : [];
        if (history.some((m) => m.role === 'user' && isCrisis(m.content))) {
          if (env.LADDER_ORDERS) background(ctx, countChat(env.LADDER_ORDERS, [...events, { kind: 'safety' }]));
          return json({ reply: HELP_TEXT, stage: 'help', ladder: null, plan: null, reason: null });
        }
        const turn = await advise(env.AI, env.AI_MODEL, history);
        let recToken: string | null = null;
        let agentOrder: { id: string; plan: string; tool: string } | null = null;
        if (turn.stage === 'recommend' && turn.plan) {
          events.push({ kind: 'recommend', plan: turn.plan });
          const lang = detectLang(history.filter((m) => m.role === 'user').map((m) => m.content).join(' '));
          const steps = turn.ladder?.obstacles.length ?? 0;
          recToken = await signRecommendation(env.PASS_SECRET, { plan: turn.plan, steps, lang });
          // The checkout agent may call create_paypal_order. The price comes from the catalog,
          // and the person still approves the payment in PayPal.
          try {
            const agentPlan = planOrNull(await checkoutAgent(env.AI, env.AI_MODEL, history, turn.plan));
            if (agentPlan) {
              const id = await createOrder(env, agentPlan, turn.ladder);
              agentOrder = { id, plan: agentPlan.id, tool: `create_paypal_order(plan_id="${agentPlan.id}")` };
              if (env.LADDER_ORDERS) {
                background(
                  ctx,
                  saveOrder(env.LADDER_ORDERS, newOrderRecord({ orderId: id, chosen: agentPlan.id, recommended: turn.plan, steps, lang, createdBy: 'agent' })),
                );
              }
            }
          } catch (err) {
            console.log(JSON.stringify({ event: 'agent_order_error', message: String(err) }));
          }
        }
        if (env.LADDER_ORDERS) background(ctx, countChat(env.LADDER_ORDERS, events));
        return json({ ...turn, recToken, agentOrder });
      }

      if (request.method === 'POST' && pathname === '/api/orders') {
        const body = await readJson(request);
        const plan = planOrNull(body.plan);
        if (!plan) return json({ error: 'unknown plan' }, 400);
        const ladder = cleanLadder(body.ladder);
        const id = await createOrder(env, plan, ladder);
        if (env.LADDER_ORDERS) {
          const rec = await verifyRecommendation(env.PASS_SECRET, body.recToken);
          background(
            ctx,
            saveOrder(
              env.LADDER_ORDERS,
              newOrderRecord({ orderId: id, chosen: plan.id, recommended: rec?.plan, steps: rec?.steps ?? ladder?.obstacles.length ?? 0, lang: rec?.lang }),
            ),
          );
        }
        return json({ id });
      }

      const capture = pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/capture$/);
      if (request.method === 'POST' && capture) {
        const body = await readJson(request);
        const result = await captureOrder(env, capture[1]);
        const kv = env.LADDER_ORDERS;
        if (result.status === 'INSTRUMENT_DECLINED') {
          if (kv) background(ctx, updateOrder(kv, capture[1], { status: 'INSTRUMENT_DECLINED' }));
          return json({ error: 'INSTRUMENT_DECLINED' }, 422);
        }
        const plan = planOrNull(result.planId);
        if (result.status !== 'COMPLETED' || !plan || result.amount !== plan.amount) {
          if (kv) background(ctx, updateOrder(kv, capture[1], { status: result.status || 'FAILED' }));
          return json({ error: 'payment not completed', status: result.status }, 402);
        }
        if (kv) {
          background(ctx, updateOrder(kv, capture[1], { status: 'COMPLETED', captureId: result.captureId }));
          background(ctx, linkCapture(kv, result.captureId, capture[1]));
        }
        const expires = expiryFrom(new Date(), plan.days);
        const pass = await signPass(env.PASS_SECRET, { plan: plan.id, captureId: result.captureId, expires, orderId: capture[1] });
        const ladder = cleanLadder(body.ladder);
        let step = '';
        if (ladder) {
          try {
            step = await firstStep(env.AI, env.AI_MODEL, ladder);
          } catch {
            step = '';
          }
        }
        return json({
          status: result.status,
          plan: plan.id,
          planName: plan.name,
          amount: result.amount,
          captureId: result.captureId,
          payerName: result.payerName,
          expires,
          pass,
          firstStep: step,
        });
      }

      if (request.method === 'GET' && pathname === '/api/dashboard') {
        const kv = env.LADDER_ORDERS;
        if (!kv) return json({ orders: [], days: [], reconciled: 0 });
        const [orders, days] = await Promise.all([listOrders(kv), listDays(kv)]);
        // Reconcile unfinished orders older than 2 minutes with PayPal Orders v2 (at most 10 per load).
        const stale = orders
          .filter((o) => !isFinal(o.status) && Date.now() - Date.parse(o.updatedAt) > 120_000)
          .slice(0, 10);
        let reconciled = 0;
        if (stale.length) {
          const work = getOrderStatuses(env, stale.map((o) => o.orderId))
            .catch(() => ({}) as Record<string, string>)
            .then(async (statuses) => {
              for (const o of stale) {
                const st = statuses[o.orderId];
                if (!st) continue;
                await saveOrder(kv, { ...o, status: st, updatedAt: new Date().toISOString() });
              }
              return statuses;
            });
          background(ctx, work);
          // The page waits at most 4 seconds for PayPal; a slower answer is saved for the next load.
          const statuses = await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
          if (statuses) {
            for (const o of stale) {
              const st = statuses[o.orderId];
              if (!st) continue;
              reconciled++;
              o.status = st;
              o.updatedAt = new Date().toISOString();
            }
          }
        }
        return json({ orders: orders.map(publicOrder), days, reconciled, generatedAt: new Date().toISOString() });
      }

      if (request.method === 'GET' && pathname === '/api/pass') {
        const token = url.searchParams.get('token') ?? '';
        const pass = await verifyPass(env.PASS_SECRET, token);
        if (!pass) return json({ active: false });
        const refunded = env.LADDER_ORDERS ? await env.LADDER_ORDERS.getWithMetadata(`refund:${pass.captureId}`) : { value: null };
        return json(refunded.value !== null ? { active: false, refunded: true, ...pass } : { active: true, ...pass });
      }

      // 14-day refund guarantee: the signed pass proves the purchase, PayPal confirms
      // the capture, its age and its amount, then Payments v2 refunds the full amount.
      if (request.method === 'POST' && pathname === '/api/refund') {
        const body = await readJson(request);
        const pass = await verifyPass(env.PASS_SECRET, String(body.pass ?? ''));
        if (!pass) return json({ error: 'invalid pass' }, 401);
        const kv = env.LADDER_ORDERS;
        if (kv) {
          const done = await kv.getWithMetadata(`refund:${pass.captureId}`);
          if (done.value !== null) return json({ refunded: true, refundId: done.value, already: true });
        }
        const cap = await getCapture(env, pass.captureId);
        if (!cap) return json({ error: 'capture not found' }, 404);
        const plan = planOrNull(cap.planId);
        if (cap.status !== 'COMPLETED' && cap.status !== 'PARTIALLY_REFUNDED') return json({ error: 'not refundable', status: cap.status }, 409);
        if (!plan || cap.amount !== plan.amount) return json({ error: 'amount mismatch' }, 409);
        if (Date.now() - Date.parse(cap.createTime) > REFUND_DAYS * 86_400_000) return json({ error: 'refund window closed' }, 403);
        const refund = await refundCapture(env, pass.captureId);
        if (kv) {
          const orderId = pass.orderId || cap.orderId || (await orderIdForCapture(kv, pass.captureId));
          await kv.put(`refund:${pass.captureId}`, refund.id, { expirationTtl: 60 * 60 * 24 * 120 });
          if (orderId) background(ctx, updateOrder(kv, orderId, { status: 'REFUNDED', refundId: refund.id }));
        }
        return json({ refunded: true, refundId: refund.id, status: refund.status, amount: cap.amount });
      }

      // PayPal webhook: the signature is checked by PayPal, every event id is applied once,
      // and a late event never moves an order back (a refund stays a refund).
      if (request.method === 'POST' && pathname === '/api/paypal/webhook') {
        const raw = await request.text();
        let event: any;
        try {
          event = JSON.parse(raw);
        } catch {
          return json({ error: 'bad json' }, 400);
        }
        const h = webhookHeaders(request.headers);
        if (!h || !(await verifyWebhook(env, h, event))) return json({ error: 'signature not verified' }, 401);
        const update = eventToUpdate(event);
        let result = 'ignored';
        if (update && env.LADDER_ORDERS) {
          result = await applyWebhook(env.LADDER_ORDERS, String(event.id ?? ''), String(event.event_type ?? ''), update);
          if (update.status === 'REFUNDED' && update.captureId) {
            await env.LADDER_ORDERS.put(`refund:${update.captureId}`, String(event.resource?.id ?? 'webhook'), { expirationTtl: 60 * 60 * 24 * 120 });
          }
        }
        console.log(JSON.stringify({ event: 'paypal_webhook', type: event.event_type, result }));
        return json({ ok: true, result });
      }
    } catch (err) {
      console.log(JSON.stringify({ event: 'error', path: pathname, message: String(err) }));
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }

    return json({ error: 'not found' }, 404);
  },
};
