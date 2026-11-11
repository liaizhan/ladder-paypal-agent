import { advise, firstStep, sanitize, type AiBinding, type Ladder } from './agent.ts';
import { PLANS, planOrNull } from './catalog.ts';
import { captureOrder, createOrder, getOrderStatuses } from './paypal.ts';
import { expiryFrom, signPass, signRecommendation, verifyPass, verifyRecommendation } from './pass.ts';
import {
  countChat,
  detectLang,
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
  LADDER_ORDERS?: KVNamespace;
}

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
        if (turn.stage === 'recommend' && turn.plan) {
          events.push({ kind: 'recommend', plan: turn.plan });
          const lang = detectLang(history.filter((m) => m.role === 'user').map((m) => m.content).join(' '));
          recToken = await signRecommendation(env.PASS_SECRET, { plan: turn.plan, steps: turn.ladder?.obstacles.length ?? 0, lang });
        }
        if (env.LADDER_ORDERS) background(ctx, countChat(env.LADDER_ORDERS, events));
        return json({ ...turn, recToken });
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
        if (kv) background(ctx, updateOrder(kv, capture[1], { status: 'COMPLETED', captureId: result.captureId }));
        const expires = expiryFrom(new Date(), plan.days);
        const pass = await signPass(env.PASS_SECRET, { plan: plan.id, captureId: result.captureId, expires });
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
          const statuses = await getOrderStatuses(env, stale.map((o) => o.orderId)).catch(() => ({}) as Record<string, string>);
          for (const o of stale) {
            const st = statuses[o.orderId];
            if (!st) continue;
            reconciled++;
            o.status = st;
            o.updatedAt = new Date().toISOString();
            background(ctx, saveOrder(kv, o));
          }
        }
        return json({ orders: orders.map(publicOrder), days, reconciled, generatedAt: new Date().toISOString() });
      }

      if (request.method === 'GET' && pathname === '/api/pass') {
        const token = url.searchParams.get('token') ?? '';
        const pass = await verifyPass(env.PASS_SECRET, token);
        return json(pass ? { active: true, ...pass } : { active: false });
      }
    } catch (err) {
      console.log(JSON.stringify({ event: 'error', path: pathname, message: String(err) }));
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }

    return json({ error: 'not found' }, 404);
  },
};
