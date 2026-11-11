# Ladder Plan Advisor: AI that picks the right plan, PayPal that lets the person decide

**Live demo (PayPal sandbox):** https://ladder-paypal-agent.liaizhan77.workers.dev

**Payments dashboard (AG Grid):** https://ladder-paypal-agent.liaizhan77.workers.dev/dashboard

Ladder is a self-help method by Aizhan Li, author of the Ladder method. A person names where they stand now ("me"), the obstacles between them and a goal, and the goal itself. The obstacles become steps, and each step comes with short video practices. The method runs today on [108psy.com](https://108psy.com) in Russian, Kazakh and English, with a paid subscription for the video practices.

This project adds an agentic checkout to Ladder:

1. The person describes a goal in their own words, in English, Russian or Kazakh.
2. An AI advisor builds their ladder (me, obstacles, goal) and asks at most one clarifying question.
3. The advisor recommends one plan (1 month or 3 months) and explains why, quoting the person's own obstacles.
4. PayPal Checkout opens with that plan preselected. The person can switch plans, and nothing is charged without their approval in PayPal.
5. After the capture, the server checks the amount against its own catalog, signs an access pass and the AI writes the first step for today.

## Why this matters

Choosing between one month and three months is a guess for most people. A person with one recent fear does not need three months. A person whose obstacles have lasted for years, or touch the body and family patterns, will likely run out of a one-month plan before the work is done. The advisor makes that choice with the person, in their language, before they pay.

## How PayPal and AI work together

```
Browser                         Cloudflare Worker                     Services
-------                         -----------------                     --------
chat message  --------------->  /api/chat
                                  crisis check (no AI, no sale)
                                  advise() -------------------------> Workers AI (Llama 3.3 70B, JSON mode)
              <---------------  { ladder, plan id, reason }

PayPal Buttons createOrder ---> /api/orders { plan id, ladder }
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
```

Design rules:

- **The AI picks a plan id, never a price.** Amounts live only in `src/catalog.ts` on the server. The browser sends a plan id, and capture re-checks the captured amount against the catalog. A prompt injection cannot change what the person pays.
- **The person always approves.** The advisor recommends, PayPal asks. One payment, no auto-renewal.
- **Safety before sales.** Every user message passes a crisis check before the model is called. If a message signals danger, the advisor never sells: it shows verified emergency and trust lines for Kazakhstan and a reminder to call a local emergency number.
- **No health promises.** The advisor is told it is not a doctor or a therapist and never promises results.
- **Personal order lines.** The PayPal item description carries the plan and the person's goal, so the receipt says what they are working on.
- **No database for access.** The access pass is signed and carries plan, expiry and the PayPal capture id.
- **Privacy by design in the ledger.** The dashboard ledger keeps plan ids, counts, PayPal ids and statuses only. No goals, obstacles, names or emails are stored.

## PayPal features used

- Orders v2 API, server side: OAuth client credentials, create order with `intent: CAPTURE`, item breakdown, `DIGITAL_GOODS`, `PayPal-Request-Id` for idempotency, `experience_context` (brand name, `NO_SHIPPING`, `PAY_NOW`), capture.
- Orders v2 `GET` order details, to reconcile open orders on the dashboard.
- PayPal JavaScript SDK Buttons in the page (`createOrder`, `onApprove`, `onError`). A declined funding source (`INSTRUMENT_DECLINED` on capture) calls `actions.restart()`, so the person can choose another one.

## Payments dashboard (AG Grid)

`/dashboard` shows what the advisor and PayPal did, built with AG Grid Community:

- **Orders grid:** created time, PayPal status, the plan the AI recommended, the plan the person chose, whether they followed the advice, amount, number of steps on the ladder, language, PayPal order id and capture id. Floating filters, quick search, status buttons (paid, open, declined or expired), pagination, a pinned total row and CSV export.
- **KPI tiles** that recompute from the filtered rows: conversations, recommendations and the share of 3-month advice, safety handoffs, orders, paid share, captured revenue, how often people paid for the plan the AI recommended, and how many recommendations opened PayPal.
- **Advisor funnel by day:** conversations, recommendations (1 month and 3 months) and safety handoffs for the last 30 days.
- **Reconcile with PayPal:** orders that are still open after 2 minutes are checked against PayPal Orders v2 (`GET /v2/checkout/orders/:id`), so abandoned or approved orders show their real status.

How the data gets there:

- `/api/orders` saves an order record to Workers KV. The recommended plan comes from a token the server signed when the advisor answered, so the browser cannot fake "followed the AI".
- Capture updates the record to `COMPLETED` with the capture id, or to `INSTRUMENT_DECLINED`.
- Chat counters are one KV key per event with the counts in metadata. Workers KV is eventually consistent, so read-modify-write counters would lose events.
- The dashboard is public for judges. Order ids of unfinished orders are masked, so nobody can act on them.

## Prices

The live site sells in Kazakhstani tenge through Kaspi: 19,900 KZT for 1 month and 39,800 KZT for 3 months (the third month is free). The sandbox demo uses USD equivalents: $39 and $78. The live site gives a 14-day refund guarantee.

## Try it (sandbox)

1. Open the live demo.
2. Type a goal, or press one of the example buttons.
3. Read the ladder and the recommendation. Pick a plan.
4. Press the PayPal button and log in with the sandbox buyer below. No real money moves.
5. See the access pass, the expiry date, the PayPal capture id and your first step.

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

5. Run locally:

```bash
npm run dev
```

6. Deploy:

```bash
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler secret put PASS_SECRET
npm run deploy
```

Tests (catalog, safety check, AI output parsing, order building, pass and recommendation tokens, ledger):

```bash
npm test
```

## Project layout

- `src/index.ts`: routes and the capture check.
- `src/agent.ts`: advisor prompt, output parsing, first step.
- `src/paypal.ts`: Orders v2 create and capture.
- `src/catalog.ts`: the only place with prices.
- `src/safety.ts`: crisis check and help lines.
- `src/pass.ts`: signed access pass and recommendation token.
- `src/page.ts`: the page and PayPal Buttons.
- `src/ledger.ts`: order ledger and chat counters in Workers KV.
- `src/dashboard.ts`: the AG Grid payments dashboard.

## What was built during the hackathon

Ladder and 108psy.com existed before the submission period, with Kaspi payments in Kazakhstan. This repository is new: the AI plan advisor, the PayPal Orders v2 checkout, the server-side price guard, the crisis check before checkout, the signed access pass and the AG Grid payments dashboard were all written during the PayPal AI Hackathon (November 2026).

## License

MIT. See `LICENSE`. The Ladder method, its texts and videos on 108psy.com are not part of this license.
