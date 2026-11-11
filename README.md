# Ladder Plan Advisor: AI that picks the right plan, PayPal that lets the person decide

**Live demo (PayPal sandbox):** https://ladder-paypal-agent.liaizhan77.workers.dev

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
- **No database.** The access pass is signed and carries plan, expiry and the PayPal capture id.

## PayPal features used

- Orders v2 API, server side: OAuth client credentials, create order with `intent: CAPTURE`, item breakdown, `DIGITAL_GOODS`, `PayPal-Request-Id` for idempotency, `experience_context` (brand name, `NO_SHIPPING`, `PAY_NOW`), capture.
- PayPal JavaScript SDK Buttons in the page (`createOrder`, `onApprove`, `onError`). A declined funding source (`INSTRUMENT_DECLINED` on capture) calls `actions.restart()`, so the person can choose another one.

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
3. Create `.dev.vars` for local runs:

```
PAYPAL_CLIENT_SECRET=your_sandbox_secret
PASS_SECRET=any_long_random_string
```

4. Run locally:

```bash
npm run dev
```

5. Deploy:

```bash
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler secret put PASS_SECRET
npm run deploy
```

Tests (catalog, safety check, AI output parsing, order building, pass signing):

```bash
npm test
```

## Project layout

- `src/index.ts`: routes and the capture check.
- `src/agent.ts`: advisor prompt, output parsing, first step.
- `src/paypal.ts`: Orders v2 create and capture.
- `src/catalog.ts`: the only place with prices.
- `src/safety.ts`: crisis check and help lines.
- `src/pass.ts`: signed access pass.
- `src/page.ts`: the page and PayPal Buttons.

## What was built during the hackathon

Ladder and 108psy.com existed before the submission period, with Kaspi payments in Kazakhstan. This repository is new: the AI plan advisor, the PayPal Orders v2 checkout, the server-side price guard, the crisis check before checkout and the signed access pass were all written during the PayPal AI Hackathon (November 2026).

## License

MIT. See `LICENSE`. The Ladder method, its texts and videos on 108psy.com are not part of this license.
