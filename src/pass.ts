// A signed access pass: plan, expiry and PayPal capture id, HMAC-SHA256.
// No database: the pass itself proves access until it expires.
// No auto-renewal by design: the person chooses to pay again.

export interface AccessPass {
  plan: string;
  captureId: string;
  expires: string; // ISO date
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

export async function signPass(secret: string, pass: AccessPass): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(pass)));
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifyPass(secret: string, token: string, now = new Date()): Promise<AccessPass | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const sigBytes = Uint8Array.from(fromB64url(sig), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('HMAC', await key(secret), sigBytes, enc.encode(body));
  if (!ok) return null;
  const pass = JSON.parse(fromB64url(body)) as AccessPass;
  return new Date(pass.expires) > now ? pass : null;
}
