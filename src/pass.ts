// A signed access pass: plan, expiry and PayPal capture id, HMAC-SHA256.
// No database: the pass itself proves access until it expires.
// No auto-renewal by design: the person chooses to pay again.

export interface AccessPass {
  plan: string;
  captureId: string;
  expires: string; // ISO date
  orderId?: string; // PayPal order, so a refund finds its ledger row
  invoiceId?: string; // a team gift seat, paid by the company through a PayPal invoice
}

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): string {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return atob(pad);
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export function expiryFrom(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

async function signData(secret: string, data: unknown): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(data)));
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

async function verifyData(secret: string, token: string): Promise<Record<string, unknown> | null> {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return null;
  try {
    const sigBytes = Uint8Array.from(fromB64url(sig), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('HMAC', await key(secret), sigBytes, enc.encode(body));
    return ok ? (JSON.parse(fromB64url(body)) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function signPass(secret: string, pass: AccessPass): Promise<string> {
  return signData(secret, { kind: 'pass', ...pass });
}

export async function verifyPass(secret: string, token: string, now = new Date()): Promise<AccessPass | null> {
  const data = await verifyData(secret, token);
  if (!data || data.kind !== 'pass') return null;
  const pass: AccessPass = { plan: String(data.plan), captureId: String(data.captureId), expires: String(data.expires) };
  if (typeof data.orderId === 'string') pass.orderId = data.orderId;
  if (typeof data.invoiceId === 'string') pass.invoiceId = data.invoiceId;
  return new Date(pass.expires) > now ? pass : null;
}

/** What the AI advisor recommended, signed by the server, so the dashboard
 *  can compare advice with the person's choice without trusting the browser. */
export interface Recommendation {
  plan: string;
  steps: number;
  lang: string;
}

export async function signRecommendation(secret: string, rec: Recommendation): Promise<string> {
  return signData(secret, { kind: 'rec', ...rec });
}

export async function verifyRecommendation(secret: string, token: unknown): Promise<Recommendation | null> {
  const data = await verifyData(secret, String(token ?? ''));
  if (!data || data.kind !== 'rec') return null;
  return { plan: String(data.plan), steps: Number(data.steps) || 0, lang: String(data.lang) };
}

/** Proves that this browser created the gift draft, so only it can send the
 *  invoice and see the access codes after the company pays. */
export async function signGift(secret: string, invoiceId: string): Promise<string> {
  return signData(secret, { kind: 'gift', invoiceId });
}

export async function verifyGift(secret: string, token: unknown, invoiceId: string): Promise<boolean> {
  const data = await verifyData(secret, String(token ?? ''));
  return !!data && data.kind === 'gift' && data.invoiceId === invoiceId;
}
