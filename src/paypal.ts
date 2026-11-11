// PayPal Orders v2, server side. Sandbox by default.
// The order is built from the server catalog; capture re-checks the amount.

import { giftTotal, type Plan } from './catalog.ts';
import type { Ladder } from './agent.ts';

export interface PayPalEnv {
  PAYPAL_ENV: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
}

export function apiBase(env: PayPalEnv): string {
  return env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

// The default client-credentials token has no invoicing scope even when Invoicing is
// enabled for the app; invoice calls ask for it explicitly and get a token with only that scope.
const INVOICING_SCOPE = 'https://uri.paypal.com/services/invoicing';

async function accessToken(env: PayPalEnv, scope?: string): Promise<string> {
  const res = await fetch(`${apiBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials' + (scope ? '&scope=' + encodeURIComponent(scope) : ''),
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

export interface CaptureInfo {
  status: string;
  amount: string;
  createTime: string;
  orderId: string;
  planId: string;
}

/** Payments v2 GET capture: the refund checks the real capture, not the browser. */
export async function getCapture(env: PayPalEnv, captureId: string): Promise<CaptureInfo | null> {
  if (!/^[A-Z0-9]{8,32}$/.test(captureId)) return null;
  const token = await accessToken(env);
  const res = await fetch(`${apiBase(env)}/v2/payments/captures/${captureId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`paypal capture get ${res.status}`);
  const d = (await res.json()) as any;
  return {
    status: d.status ?? '',
    amount: d.amount?.value ?? '',
    createTime: d.create_time ?? '',
    orderId: d.supplementary_data?.related_ids?.order_id ?? '',
    planId: d.custom_id ?? '',
  };
}

export interface RefundResult {
  id: string;
  status: string;
}

/** Payments v2 refund, full amount. PayPal-Request-Id makes a repeated click safe:
 *  PayPal returns the same refund instead of a second one. */
export async function refundCapture(env: PayPalEnv, captureId: string): Promise<RefundResult> {
  if (!/^[A-Z0-9]{8,32}$/.test(captureId)) throw new Error('bad capture id');
  const token = await accessToken(env);
  const res = await fetch(`${apiBase(env)}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `ladder-refund-${captureId}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ note_to_payer: 'Ladder 14-day refund guarantee' }),
  });
  const d = (await res.json()) as any;
  if (!res.ok || !d.id) throw new Error(`paypal refund ${res.status} ${d?.details?.[0]?.issue ?? d?.message ?? ''}`);
  return { id: d.id, status: d.status ?? '' };
}

export interface WebhookHeaders {
  transmissionId: string;
  transmissionTime: string;
  certUrl: string;
  authAlgo: string;
  transmissionSig: string;
}

export function webhookHeaders(h: Headers): WebhookHeaders | null {
  const w = {
    transmissionId: h.get('paypal-transmission-id') ?? '',
    transmissionTime: h.get('paypal-transmission-time') ?? '',
    certUrl: h.get('paypal-cert-url') ?? '',
    authAlgo: h.get('paypal-auth-algo') ?? '',
    transmissionSig: h.get('paypal-transmission-sig') ?? '',
  };
  return Object.values(w).every(Boolean) ? w : null;
}

/** PayPal checks the signature of its own webhook (Notifications API). */
export async function verifyWebhook(env: PayPalEnv & { PAYPAL_WEBHOOK_ID?: string }, h: WebhookHeaders, event: unknown): Promise<boolean> {
  if (!env.PAYPAL_WEBHOOK_ID) return false;
  const token = await accessToken(env);
  const res = await fetch(`${apiBase(env)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transmission_id: h.transmissionId,
      transmission_time: h.transmissionTime,
      cert_url: h.certUrl,
      auth_algo: h.authAlgo,
      transmission_sig: h.transmissionSig,
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    }),
  });
  if (!res.ok) return false;
  const d = (await res.json()) as { verification_status?: string };
  return d.verification_status === 'SUCCESS';
}

export interface WebhookUpdate {
  orderId: string;
  captureId: string;
  status: string;
}

/** Turns a PayPal event into a ledger update. Unknown events are ignored. */
export function eventToUpdate(event: any): WebhookUpdate | null {
  const type = String(event?.event_type ?? '');
  const r = event?.resource ?? {};
  const upCapture = () => {
    const up = (r.links ?? []).find((l: any) => l.rel === 'up')?.href ?? '';
    return String(up).match(/captures\/([A-Z0-9]+)/)?.[1] ?? '';
  };
  switch (type) {
    case 'CHECKOUT.ORDER.APPROVED':
      return { orderId: String(r.id ?? ''), captureId: '', status: 'APPROVED' };
    case 'PAYMENT.CAPTURE.COMPLETED':
      return { orderId: String(r.supplementary_data?.related_ids?.order_id ?? ''), captureId: String(r.id ?? ''), status: 'COMPLETED' };
    case 'PAYMENT.CAPTURE.DENIED':
      return { orderId: String(r.supplementary_data?.related_ids?.order_id ?? ''), captureId: String(r.id ?? ''), status: 'DECLINED' };
    case 'PAYMENT.CAPTURE.REFUNDED':
      return { orderId: '', captureId: upCapture(), status: 'REFUNDED' };
    case 'PAYMENT.CAPTURE.REVERSED':
      return { orderId: '', captureId: upCapture() || String(r.id ?? ''), status: 'REVERSED' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Team gifts with PayPal Invoicing v2. The invoice is created as a DRAFT, the
// HR person reads it and presses Send, and PayPal returns the payer link.
// Access codes are issued only when PayPal says the invoice is PAID in full.

export const INVOICE_ID = /^INV2(-[A-Z0-9]{4}){4}$/;

export interface GiftDraft {
  plan: Plan;
  seats: number;
  note: string; // written by the AI, checked by the server
  company: string;
}

export function buildGiftInvoice(g: GiftDraft) {
  const team = g.company ? ` for the team at ${g.company}` : ' for your team';
  return {
    detail: {
      currency_code: 'USD',
      reference: `gift:${g.plan.id}`,
      note: g.note.slice(0, 1000),
      terms_and_conditions:
        'Each seat is one access code to the Ladder video practices for the plan period. Codes are issued after the invoice is paid in full. Sandbox demo: no real money moves.',
      payment_term: { term_type: 'DUE_ON_RECEIPT' },
    },
    invoicer: { business_name: 'Ladder by Aizhan Li' },
    items: [
      {
        name: `${g.plan.name}, gift seat`,
        description: `${g.plan.note}. One access code per seat${team}.`.slice(0, 1000),
        quantity: String(g.seats),
        unit_amount: { currency_code: 'USD', value: g.plan.amount },
        unit_of_measure: 'QUANTITY',
      },
    ],
    configuration: { allow_tip: false, tax_inclusive: false, partial_payment: { allow_partial_payment: false } },
  };
}

async function invoiceFetch(env: PayPalEnv, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken(env, INVOICING_SCOPE);
  return fetch(`${apiBase(env)}/v2/invoicing/invoices${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

export interface InvoiceInfo {
  id: string;
  number: string;
  status: string; // DRAFT, SENT, UNPAID, PAID, CANCELLED, PARTIALLY_PAID, MARKED_AS_PAID, ...
  total: string;
  paid: string;
  planId: string;
  seats: number;
}

export function readInvoice(d: any): InvoiceInfo {
  const ref = String(d?.detail?.reference ?? '');
  return {
    id: String(d?.id ?? ''),
    number: String(d?.detail?.invoice_number ?? ''),
    status: String(d?.status ?? ''),
    total: String(d?.amount?.value ?? ''),
    paid: String(d?.payments?.paid_amount?.value ?? ''),
    planId: ref.startsWith('gift:') ? ref.slice(5) : '',
    seats: Number(d?.items?.[0]?.quantity) || 0,
  };
}

export async function createGiftInvoice(env: PayPalEnv, g: GiftDraft): Promise<InvoiceInfo> {
  const res = await invoiceFetch(env, '', {
    method: 'POST',
    headers: { Prefer: 'return=representation', 'PayPal-Request-Id': crypto.randomUUID() },
    body: JSON.stringify(buildGiftInvoice(g)),
  });
  const d = (await res.json()) as any;
  if (!res.ok || !d?.id) throw new Error(`paypal invoice create ${res.status} ${d?.details?.[0]?.issue ?? d?.message ?? ''}`);
  const info = readInvoice(d);
  if (info.total !== giftTotal(g.plan, g.seats)) throw new Error('invoice total mismatch');
  return info;
}

/** Sends the draft without PayPal email (there is no recipient) and returns the payer link. */
export async function sendInvoice(env: PayPalEnv, id: string): Promise<string> {
  if (!INVOICE_ID.test(id)) throw new Error('bad invoice id');
  const res = await invoiceFetch(env, `/${id}/send`, {
    method: 'POST',
    headers: { 'PayPal-Request-Id': `ladder-send-${id}` },
    body: JSON.stringify({ send_to_recipient: false, send_to_invoicer: false }),
  });
  const d = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`paypal invoice send ${res.status} ${d?.details?.[0]?.issue ?? d?.message ?? ''}`);
  const href = String(d?.href ?? (d?.links ?? []).find((l: any) => l.rel === 'payer-view')?.href ?? '');
  return href.startsWith('https://www.sandbox.paypal.com/') || href.startsWith('https://www.paypal.com/') ? href : '';
}

export async function getInvoice(env: PayPalEnv, id: string): Promise<InvoiceInfo | null> {
  if (!INVOICE_ID.test(id)) return null;
  const res = await invoiceFetch(env, `/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`paypal invoice get ${res.status}`);
  return readInvoice(await res.json());
}

/** Invoice id from an INVOICING.INVOICE.* webhook (resource is the invoice, or wraps it). */
export function invoiceEventId(event: any): string {
  const r = event?.resource ?? {};
  const id = String(r?.invoice?.id ?? r?.id ?? '');
  return INVOICE_ID.test(id) ? id : '';
}
