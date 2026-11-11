# Ladder Plan Advisor: AI that picks the right plan, PayPal that lets the person decide

**Live demo (PayPal sandbox):** https://ladder-paypal-agent.liaizhan77.workers.dev

**Payments dashboard (AG Grid):** https://ladder-paypal-agent.liaizhan77.workers.dev/dashboard

Ladder is a self-help method by Aizhan Li, author of the Ladder method. A person names where they stand now ("me"), the obstacles between them and a goal, and the goal itself. The obstacles become steps, and each step comes with short video practices. The method runs today on [108psy.com](https://108psy.com) in Russian, Kazakh and English, with a paid subscription for the video practices.

This project adds an agentic checkout to Ladder:

1. The person describes a goal in their own words, in English, Russian or Kazakh.
2. An AI advisor builds their ladder (me, obstacles, goal) and asks at most one clarifying question.
3. The advisor recommends one plan (1 month or 3 months) and explains why, quoting the person's own obstacles.
4. A checkout agent calls a tool, `create_paypal_order`, and prepares the PayPal order itself. It chooses the plan the person asked for in their own words, or the recommended one. If the person said they do not want to buy, it calls `skip_order` instead and nothing is prepared.
5. PayPal Checkout opens with that order. The person can switch plans, and nothing is charged without their approval in PayPal.
6. After the capture, the server checks the amount against its own catalog, signs an access pass and the AI writes the first step for today.
7. Within 14 days the person can get a full refund in one click. PayPal webhooks keep every order status in sync on the dashboard.

## Why this matters

Choosing between one month and three months is a guess for most people. A person with one recent fear does not need three months. A person whose obstacles have lasted for years, or touch the body and family patterns, will likely run out of a one-month plan before the work is done. The advisor makes that choice with the person, in their language, before they pay.

## How PayPal and AI work together

```
Browser                         Cloudflare Worker                     Services
-------                         -----------------                     --------
chat message  --------------->  /api/chat
                                  crisis check (no AI, no sale)
                                  advise() -------------------------> Workers AI (Llama 3.3 70B, JSON mode)
                                  checkoutAgent() ------------------> Workers AI, tools:
                                                                        create_paypal_order(plan_id)
                                                                        skip_order(reason)
                                  Orders v2 create -----------------> PayPal sandbox
              <---------------  { ladder, plan id, reason, agent order id }

PayPal Buttons createOrder      reuses the agent order, or if the person
              --------------->  switched plans: /api/orders { plan id, ladder }
                                  price from server catalog
                                  Orders v2 create -----------------> PayPal sandbox
              <---------------  { order id }

person approves in PayPal

onApprove --------------------> /api/orders/:id/capture
                                  Orders v2 capture ----------------> PayPal sandbox
                                  status COMPLETED + amount check
                                  sign access pass (HMAC-SHA256)
                                  firstStep() ----------------------> Workers AI
              <---------------  { pass, expiry, capture id, first step }

refund button ----------------> /api/refund { pass }
                                  verify pass, GET capture ---------> PayPal Payments v2
                                  14-day window + amount check
                                  refund capture -------------------> PayPal Payments v2
              <---------------  { refund id }, access closed

PayPal webhooks --------------> /api/paypal/webhook
                                  verify signature -----------------> PayPal Notifications
                                  idempotent by event id
                                  status never moves backwards
```

Design rules:

- **The AI picks a plan id, never a price.** Amounts live only in `src/catalog.ts` on the server. The browser sends a plan id, and capture re-checks the captured amount against the catalog. A prompt injection cannot change what the person pays.
- **The agent acts, the person approves.** The checkout agent creates the PayPal order through a tool call, but its only argument is a plan id from an enum. PayPal asks the person, and nothing is charged until they approve. One payment, no auto-renewal.
- **A refusal is respected.** If the person says they do not want to buy, the agent calls `skip_order` and no order is created. Money worries or doubts are treated as part of the ladder, not as a refusal.
- **Refund without a support ticket.** The refund endpoint accepts only a valid signed pass, checks the capture with PayPal, the 14-day window and the catalog amount, and sends one idempotent refund request.
- **Webhooks are verified, not trusted.** Every event is checked with PayPal's `verify-webhook-signature`, stored once per event id, and a late event can never move an order back (for example from REFUNDED to COMPLETED).
- **Safety before sales.** Every user message passes a crisis check before the model is called. If a message signals danger, the advisor never sells: it shows verified emergency and trust lines for Kazakhstan and a reminder to call a local emergency number.
- **No health promises.** The advisor is told it is not a doctor or a therapist and never promises results.
- **Personal order lines.** The PayPal item description carries the plan and the person's goal, so the receipt says what they are working on.
- **No database for access.** The access pass is signed and carries plan, expiry and the PayPal capture id.
- **Privacy by design in the ledger.** The dashboard ledger keeps plan ids, counts, PayPal ids and statuses only. No goals, obstacles, names or emails are stored.

## PayPal features used

- Orders v2 API, server side: OAuth client credentials, create order with `intent: CAPTURE`, item breakdown, `DIGITAL_GOODS`, `PayPal-Request-Id` for idempotency, `experience_context` (brand name, `NO_SHIPPING`, `PAY_NOW`), capture.
- Orders v2 `GET` order details, to reconcile open orders on the dashboard.
- PayPal JavaScript SDK Buttons in the page (`createOrder`, `onApprove`, `onError`). A declined funding source (`INSTRUMENT_DECLINED` on capture) calls `actions.restart()`, so the person can choose another one. `createOrder` reuses the order the AI agent prepared.
- Payments v2: `GET /v2/payments/captures/:id` to check status, amount and date before a refund, and `POST /v2/payments/captures/:id/refund` with `PayPal-Request-Id`, so a double click cannot refund twice.
- Webhooks: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, each verified with `POST /v1/notifications/verify-webhook-signature`.

## Payments dashboard (AG Grid)

`/dashboard` shows what the advisor and PayPal did, built with AG Grid Community:

- **Orders grid:** created time, PayPal status, who created the order (the AI agent or the PayPal button), the plan the AI recommended, the plan the person chose, whether they followed the advice, amount, number of steps on the ladder, language, PayPal webhooks received and the last event, PayPal order id, capture id and refund id. Floating filters, quick search, status buttons (paid, open, refunded, declined or expired), pagination, a pinned total row and CSV export.
- **KPI tiles** that recompute from the filtered rows: conversations, recommendations and the share of 3-month advice, safety handoffs, orders and how many of them the AI agent created, paid share, net revenue after refunds, how often people paid for the plan the AI recommended, refunds under the 14-day guarantee and verified webhook events.
- **Advisor funnel by day:** conversations, recommendations (1 month and 3 months) and safety handoffs for the last 30 days.
- **Reconcile with PayPal:** orders that are still open after 2 minutes are checked against PayPal Orders v2 (`GET /v2/checkout/orders/:id`), so abandoned or approved orders show their real status.

How the data gets there:

- `/api/orders` saves an order record to Workers KV. The recommended plan comes from a token the server signed when the advisor answered, so the browser cannot fake "followed the AI".
- Capture updates the record to `COMPLETED` with the capture id, or to `INSTRUMENT_DECLINED`.
- Verified PayPal webhooks update the same record (approved, completed, denied, refunded, reversed) and count the events, so the dashboard stays right even if the browser closes before capture.
- A refund sets the record to `REFUNDED` with the PayPal refund id.
- Chat counters are one KV key per event with the counts in metadata. Workers KV is eventually consistent, so read-modify-write counters would lose events.
- The dashboard is public for judges. Order ids of unfinished orders are masked, so nobody can act on them.

## Prices

The live site sells in Kazakhstani tenge through Kaspi: 19,900 KZT for 1 month and 39,800 KZT for 3 months (the third month is free). The sandbox demo uses USD equivalents: $39 and $78. The live site gives a 14-day refund guarantee, and the demo does the same in one click: the refund goes back through PayPal and the access pass stops working.

## Try it (sandbox)

1. Open the live demo.
2. Type a goal, or press one of the example buttons.
3. Read the ladder and the recommendation. Pick a plan.
4. Press the PayPal button and log in with the sandbox buyer below. No real money moves.
5. See the access pass, the expiry date, the PayPal capture id and your first step.
6. Optional: press "Request a refund (14-day guarantee)" and confirm. The refund appears on the dashboard, together with the PayPal webhook that confirmed it.

Sandbox buyer for judges: see the Devpost submission ("Testing instructions"). Any PayPal sandbox personal account works too.

## Run it yourself

Requirements: Node.js 20+, a Cloudflare account (free plan works, Workers AI included), a PayPal developer account (free sandbox).

```bash
git clone https://github.com/liaizhan/ladder-paypal-agent.git
cd ladder-paypal-agent
npm install
```

1. In the PayPal Developer Dashboard, open Apps & Credentials (Sandbox) and copy the Client ID and Secret of a REST app.
2. Put the Client ID into `wrangler.jsonc` (`vars.PAYPAL_CLIENT_ID`).
3. For the dashboard, create a KV namespace with `npx wrangler kv namespace create LADDER_ORDERS` and put its id into `wrangler.jsonc` (`kv_namespaces`). Without it, checkout still works and the dashboard stays empty.
4. Create `.dev.vars` for local runs:

```
PAYPAL_CLIENT_SECRET=your_sandbox_secret
PASS_SECRET=any_long_random_string
```

5. For webhooks, create a sandbox webhook in the PayPal Developer Dashboard for `https://<your worker>/api/paypal/webhook` with the five event types listed above, and put its id into `wrangler.jsonc` (`vars.PAYPAL_WEBHOOK_ID`). Without it, webhooks are rejected and everything else works.
6. Run locally:

```bash
npm run dev
```

7. Deploy:

```bash
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler secret put PASS_SECRET
npm run deploy
```

Tests (catalog, safety check, AI output parsing, checkout tool calls, order building, pass and recommendation tokens, ledger, webhook mapping and idempotency):

```bash
npm test
```

## Project layout

- `src/index.ts`: routes and the capture check.
- `src/agent.ts`: advisor prompt, output parsing, checkout agent with tool calls, first step.
- `src/paypal.ts`: Orders v2 create and capture, Payments v2 refund, webhook verification.
- `src/catalog.ts`: the only place with prices.
- `src/safety.ts`: crisis check and help lines.
- `src/pass.ts`: signed access pass and recommendation token.
- `src/page.ts`: the page and PayPal Buttons.
- `src/ledger.ts`: order ledger and chat counters in Workers KV.
- `src/dashboard.ts`: the AG Grid payments dashboard.

## What was built during the hackathon

Ladder and 108psy.com existed before the submission period, with Kaspi payments in Kazakhstan. This repository is new: the AI plan advisor, the PayPal Orders v2 checkout, the server-side price guard, the crisis check before checkout, the signed access pass, the checkout agent with tool calls, one-click refunds, verified PayPal webhooks and the AG Grid payments dashboard were all written during the PayPal AI Hackathon (November 2026).

## License

MIT. See `LICENSE`. The Ladder method, its texts and videos on 108psy.com are not part of this license.
