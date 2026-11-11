import { advise, checkoutAgentCall, firstStep, giftAgent, sanitize, type AiBinding, type Ladder } from './agent.ts';
import { giftTotal, MAX_SEATS, MIN_SEATS, PLANS, planOrNull } from './catalog.ts';
import {
  captureOrder,
  createGiftInvoice,
  createOrder,
  eventToUpdate,
  getCapture,
  getInvoice,
  getOrderStatuses,
  INVOICE_ID,
  invoiceEventId,
  refundCapture,
  sendInvoice,
  verifyWebhook,
  webhookHeaders,
} from './paypal.ts';
import { expiryFrom, signGift, signPass, signRecommendation, verifyGift, verifyPass, verifyRecommendation } from './pass.ts';
import {
  applyWebhook,
  countChat,
  detectLang,
  getGift,
  issueGiftCodes,
  listGifts,
  publicGift,
  redeemGiftCode,
  redeemBlocked,
  noteRedeemFail,
  saveGift,
  updateGift,
  type GiftRecord,
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
import { captureGuard, captureMatches, chatGuards, injectionGuard, INJECTION, tamperGuard, type Guard } from './guards.ts';
import { renderPage } from './page.ts';
import { renderGift } from './gift.ts';

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

/** Asks PayPal for the invoice. Codes are issued only for PAID with the full catalog total,
 *  the same plan and the same seat count the server put on the invoice. */
async function settleGift(env: Env, kv: KVNamespace, rec: GiftRecord, eventType?: string): Promise<{ rec: GiftRecord; codes: string[] }> {
  const inv = await getInvoice(env, rec.invoiceId);
  if (!inv) return { rec, codes: [] };
  const plan = planOrNull(rec.plan);
  const fullyPaid =
    inv.status === 'PAID' && !!plan && inv.planId === rec.plan && inv.seats === rec.seats && inv.total === giftTotal(plan, rec.seats) && inv.paid === inv.total;
  const patch: Partial<GiftRecord> = { status: inv.status };
  if (eventType) {
    patch.webhooks = (rec.webhooks ?? 0) + 1;
    patch.lastEvent = eventType;
  }
  const next = (await updateGift(kv, rec.invoiceId, patch)) ?? { ...rec, ...patch };
  if (!fullyPaid) return { rec: next, codes: [] };
  const codes = await issueGiftCodes(kv, env.PASS_SECRET, next);
  return { rec: { ...next, codes: codes.length }, codes };
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

    if (request.method === 'GET' && pathname === '/gift') {
      return new Response(renderGift({ env: env.PAYPAL_ENV, plans: Object.values(PLANS), maxSeats: MAX_SEATS }), {
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
        let guards: Guard[] = [];
        if (turn.stage === 'recommend' && turn.plan) {
          events.push({ kind: 'recommend', plan: turn.plan });
          const lang = detectLang(history.filter((m) => m.role === 'user').map((m) => m.content).join(' '));
          const steps = turn.ladder?.obstacles.length ?? 0;
          recToken = await signRecommendation(env.PASS_SECRET, { plan: turn.plan, steps, lang });
          // The checkout agent may call create_paypal_order. The price comes from the catalog,
          // and the person still approves the payment in PayPal.
          try {
            const call = await checkoutAgentCall(env.AI, env.AI_MODEL, history, turn.plan);
            guards = chatGuards(call);
            const agentPlan = planOrNull(call.plan);
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
          if (!guards.length) guards = chatGuards(null);
        }
        if (env.LADDER_ORDERS) background(ctx, countChat(env.LADDER_ORDERS, events));
        return json({ ...turn, recToken, agentOrder, guards });
      }

      // "Try to make it $1": runs the real checks with no PayPal call and no ledger record.
      if (request.method === 'POST' && pathname === '/api/guard-test') {
        let injection: Guard;
        try {
          const call = await checkoutAgentCall(env.AI, env.AI_MODEL, [{ role: 'user', content: INJECTION }], 'ladder_1m');
          injection = injectionGuard(call);
        } catch {
          injection = { id: 'injection', ok: true, text: 'Model did not answer; the server created no order' };
        }
        return json({
          prompt: INJECTION,
          checks: [
            injection,
            tamperGuard({ plan: 'ladder_1m', amount: '1.00' }),
            tamperGuard({ plan: 'ladder_free', amount: '1.00' }),
            captureGuard(),
          ],
          note: 'No PayPal order was created by this test.',
        });
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
        const plan = captureMatches(result.status, result.planId, result.amount);
        if (!plan) {
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

      // Team gift: the gift agent prepares a DRAFT PayPal invoice through a tool call.
      // The server checks the seat count and sets the price; nothing is sent yet.
      if (request.method === 'POST' && pathname === '/api/gift/draft') {
        const kv = env.LADDER_ORDERS;
        if (!kv) return json({ error: 'gifts need storage' }, 503);
        const body = await readJson(request);
        const history = sanitize(body.messages);
        if (!history.some((m) => m.role === 'user')) return json({ error: 'empty' }, 400);
        if (history.some((m) => m.role === 'user' && isCrisis(m.content))) return json({ stage: 'help', reply: HELP_TEXT });
        const call = await giftAgent(env.AI, env.AI_MODEL, history);
        if (!call) return json({ stage: 'ask', reply: 'How many people is the gift for, and should it be 1 month or 3 months?' });
        if (call.kind === 'ask') return json({ stage: 'ask', reply: call.question });
        const plan = planOrNull(call.plan);
        if (!plan) return json({ stage: 'ask', reply: 'Should it be 1 month or 3 months?' });
        const tool = `create_gift_invoice(plan_id="${call.plan}", seats=${JSON.stringify(call.requested ?? null)})`;
        if (call.seats === null) {
          return json({ stage: 'refused', tool, reply: `One invoice covers ${MIN_SEATS} to ${MAX_SEATS} seats. The server did not create it. Please give a number in that range.` });
        }
        const inv = await createGiftInvoice(env, { plan, seats: call.seats, note: call.note, company: call.company });
        const now = new Date().toISOString();
        const rec: GiftRecord = {
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          createdAt: now,
          updatedAt: now,
          plan: plan.id,
          seats: call.seats,
          unit: plan.amount,
          total: inv.total,
          status: inv.status || 'DRAFT',
          codes: 0,
          webhooks: 0,
        };
        await saveGift(kv, rec);
        return json({
          stage: 'draft',
          tool,
          invoiceId: inv.id,
          number: inv.number,
          plan: plan.id,
          planName: plan.name,
          seats: call.seats,
          unit: plan.amount,
          total: inv.total,
          note: call.note,
          company: call.company,
          token: await signGift(env.PASS_SECRET, inv.id),
        });
      }

      const giftSend = pathname.match(/^\/api\/gift\/(INV2[A-Z0-9-]+)\/send$/);
      if (request.method === 'POST' && giftSend) {
        const kv = env.LADDER_ORDERS;
        const id = giftSend[1];
        if (!kv || !INVOICE_ID.test(id)) return json({ error: 'not found' }, 404);
        const body = await readJson(request);
        if (!(await verifyGift(env.PASS_SECRET, body.token, id))) return json({ error: 'invalid token' }, 401);
        const rec = await getGift(kv, id);
        if (!rec) return json({ error: 'not found' }, 404);
        if (rec.payerUrl) return json({ payerUrl: rec.payerUrl, status: rec.status });
        const payerUrl = await sendInvoice(env, id);
        await updateGift(kv, id, { payerUrl, status: 'UNPAID' });
        return json({ payerUrl, status: 'UNPAID' });
      }

      const giftGet = pathname.match(/^\/api\/gift\/(INV2[A-Z0-9-]+)$/);
      if (request.method === 'GET' && giftGet) {
        const kv = env.LADDER_ORDERS;
        const id = giftGet[1];
        if (!kv || !INVOICE_ID.test(id)) return json({ error: 'not found' }, 404);
        if (!(await verifyGift(env.PASS_SECRET, url.searchParams.get('token'), id))) return json({ error: 'invalid token' }, 401);
        const rec = await getGift(kv, id);
        if (!rec) return json({ error: 'not found' }, 404);
        const settled = await settleGift(env, kv, rec);
        return json({ status: settled.rec.status, seats: rec.seats, total: rec.total, payerUrl: rec.payerUrl ?? '', codes: settled.codes });
      }

      if (request.method === 'POST' && pathname === '/api/gift/redeem') {
        const kv = env.LADDER_ORDERS;
        if (!kv) return json({ error: 'gifts need storage' }, 503);
        // At most 10 wrong codes per client per hour. The client is a hash of the IP, the IP is not stored.
        const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.PASS_SECRET}:${ip}`)));
        const client = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
        if (await redeemBlocked(kv, client)) return json({ error: 'Too many wrong codes. Please try again in an hour.' }, 429);
        const body = await readJson(request);
        const seat = await redeemGiftCode(kv, String(body.code ?? ''));
        if (!seat) {
          await noteRedeemFail(kv, client);
          return json({ error: 'This code is not valid or was already used.' }, 404);
        }
        const plan = PLANS[seat.plan];
        const expires = expiryFrom(new Date(), plan.days);
        const pass = await signPass(env.PASS_SECRET, { plan: plan.id, captureId: '', expires, invoiceId: seat.invoiceId });
        return json({ plan: plan.id, planName: plan.name, expires, pass });
      }

      if (request.method === 'GET' && pathname === '/api/dashboard') {
        const kv = env.LADDER_ORDERS;
        if (!kv) return json({ orders: [], days: [], gifts: [], reconciled: 0 });
        const [orders, days, gifts] = await Promise.all([listOrders(kv), listDays(kv), listGifts(kv)]);
        // Sent gift invoices still unpaid after 2 minutes are checked with PayPal Invoicing (at most 5).
        const staleGifts = gifts.filter((g) => g.status === 'UNPAID' && Date.now() - Date.parse(g.updatedAt) > 120_000).slice(0, 5);
        if (staleGifts.length) {
          const giftWork = Promise.all(staleGifts.map((g) => settleGift(env, kv, g).catch(() => ({ rec: g, codes: [] }))));
          background(ctx, giftWork);
          const done = await Promise.race([giftWork, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
          if (done) for (const d of done) Object.assign(gifts.find((g) => g.invoiceId === d.rec.invoiceId) ?? {}, d.rec);
        }
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
        return json({ orders: orders.map(publicOrder), days, gifts: gifts.map(publicGift), reconciled, generatedAt: new Date().toISOString() });
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
        if (pass.invoiceId) return json({ error: 'This seat was a gift. Refunds go to the company that paid the invoice.' }, 409);
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
        const eventType = String(event.event_type ?? '');
        if (eventType.startsWith('INVOICING.INVOICE.')) {
          const kv = env.LADDER_ORDERS;
          const id = invoiceEventId(event);
          let giftResult = 'ignored';
          if (kv && id) {
            const seenKey = `wh:${String(event.id ?? '')}`;
            if ((await kv.getWithMetadata(seenKey)).value !== null) giftResult = 'duplicate';
            else {
              await kv.put(seenKey, eventType, { expirationTtl: 60 * 60 * 24 * 30 });
              const rec = await getGift(kv, id);
              if (!rec) giftResult = 'unknown-invoice';
              else {
                // The event says what happened; PayPal Invoicing is asked again for the amounts.
                const settled = await settleGift(env, kv, rec, eventType);
                giftResult = settled.codes.length ? `codes:${settled.codes.length}` : `status:${settled.rec.status}`;
              }
            }
          }
          console.log(JSON.stringify({ event: 'paypal_webhook', type: eventType, result: giftResult }));
          return json({ ok: true, result: giftResult });
        }
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
