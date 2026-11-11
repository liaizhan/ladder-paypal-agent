import { advise, firstStep, sanitize, type AiBinding, type Ladder } from './agent.ts';
import { PLANS, planOrNull } from './catalog.ts';
import { captureOrder, createOrder } from './paypal.ts';
import { expiryFrom, signPass, verifyPass } from './pass.ts';
import { HELP_TEXT, isCrisis } from './safety.ts';
import { renderPage } from './page.ts';

export interface Env {
  AI: AiBinding;
  AI_MODEL: string;
  PAYPAL_ENV: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PASS_SECRET: string;
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'GET' && pathname === '/') {
      return new Response(renderPage({ clientId: env.PAYPAL_CLIENT_ID, plans: Object.values(PLANS), env: env.PAYPAL_ENV }), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    try {
      if (request.method === 'POST' && pathname === '/api/chat') {
        const body = await readJson(request);
        const history = sanitize(body.messages);
        const last = [...history].reverse().find((m) => m.role === 'user');
        if (!last) return json({ error: 'empty' }, 400);
        if (history.some((m) => m.role === 'user' && isCrisis(m.content))) {
          return json({ reply: HELP_TEXT, stage: 'help', ladder: null, plan: null, reason: null });
        }
        const turn = await advise(env.AI, env.AI_MODEL, history);
        return json(turn);
      }

      if (request.method === 'POST' && pathname === '/api/orders') {
        const body = await readJson(request);
        const plan = planOrNull(body.plan);
        if (!plan) return json({ error: 'unknown plan' }, 400);
        const id = await createOrder(env, plan, cleanLadder(body.ladder));
        return json({ id });
      }

      const capture = pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/capture$/);
      if (request.method === 'POST' && capture) {
        const body = await readJson(request);
        const result = await captureOrder(env, capture[1]);
        if (result.status === 'INSTRUMENT_DECLINED') return json({ error: 'INSTRUMENT_DECLINED' }, 422);
        const plan = planOrNull(result.planId);
        if (result.status !== 'COMPLETED' || !plan || result.amount !== plan.amount) {
          return json({ error: 'payment not completed', status: result.status }, 402);
        }
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
