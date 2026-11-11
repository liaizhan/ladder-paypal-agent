// PayPal Orders v2, server side. Sandbox by default.
// The order is built from the server catalog; capture re-checks the amount.

import type { Plan } from './catalog.ts';
import type { Ladder } from './agent.ts';

export interface PayPalEnv {
  PAYPAL_ENV: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
}

export function apiBase(env: PayPalEnv): string {
  return env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function accessToken(env: PayPalEnv): Promise<string> {
  const res = await fetch(`${apiBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`paypal token ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/** Short personal line for the PayPal item: the plan plus the person's goal. */
export function itemDescription(plan: Plan, ladder: Ladder | null): string {
  const goal = ladder?.goal?.trim();
  const base = `${plan.note}.`;
  const text = goal ? `${base} Goal: ${goal}` : base;
  return text.slice(0, 127); // PayPal item description limit
}

export function buildOrder(plan: Plan, ladder: Ladder | null) {
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: plan.id,
        custom_id: plan.id,
        description: plan.name,
        amount: {
          currency_code: 'USD',
          value: plan.amount,
          breakdown: { item_total: { currency_code: 'USD', value: plan.amount } },
        },
        items: [
          {
            name: plan.name,
            description: itemDescription(plan, ladder),
            quantity: '1',
            category: 'DIGITAL_GOODS',
            unit_amount: { currency_code: 'USD', value: plan.amount },
          },
        ],
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Ladder by Aizhan Li',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
        },
      },
    },
  };
}

export async function createOrder(env: PayPalEnv, plan: Plan, ladder: Ladder | null): Promise<string> {
  const token = await accessToken(env);
  const res = await fetch(`${apiBase(env)}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify(buildOrder(plan, ladder)),
  });
  const data = (await res.json()) as { id?: string; message?: string };
  if (!res.ok || !data.id) throw new Error(`paypal create ${res.status} ${data.message ?? ''}`);
  return data.id;
}

export interface CaptureResult {
  status: string;
  planId: string;
  amount: string;
  captureId: string;
  payerName: string;
}

export async function captureOrder(env: PayPalEnv, orderId: string): Promise<CaptureResult> {
  if (!/^[A-Z0-9]{8,32}$/.test(orderId)) throw new Error('bad order id');
  const token = await accessToken(env);
  const res = await fetch(`${apiBase(env)}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const data = (await res.json()) as any;
  if (res.status === 422 && data?.details?.[0]?.issue === 'INSTRUMENT_DECLINED') {
    // PayPal best practice: let the buyer pick another funding source.
    return { status: 'INSTRUMENT_DECLINED', planId: '', amount: '', captureId: '', payerName: '' };
  }
  if (!res.ok) throw new Error(`paypal capture ${res.status} ${data?.message ?? ''}`);
  const unit = data.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  return {
    status: data.status,
    planId: unit?.reference_id ?? capture?.custom_id ?? '',
    amount: capture?.amount?.value ?? '',
    captureId: capture?.id ?? '',
    payerName: data.payer?.name?.given_name ?? '',
  };
}

/** Orders v2 GET: the dashboard reconciles unfinished orders with PayPal (one token for all). */
export async function getOrderStatuses(env: PayPalEnv, orderIds: string[]): Promise<Record<string, string>> {
  const ids = orderIds.filter((id) => /^[A-Z0-9]{8,32}$/.test(id));
  if (!ids.length) return {};
  const token = await accessToken(env);
  const pairs = await Promise.all(
    ids.map(async (id) => {
      const res = await fetch(`${apiBase(env)}/v2/checkout/orders/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 404) return [id, 'EXPIRED'] as const;
      if (!res.ok) return [id, ''] as const;
      const data = (await res.json()) as { status?: string };
      return [id, data.status ?? ''] as const;
    }),
  );
  return Object.fromEntries(pairs.filter(([, st]) => st));
}
