// The page PayPal sends the person back to after they approve an order made over MCP.
// The server has already captured the payment and checked the amount against the catalog.

export type ReturnView =
  | { kind: 'paid'; planName: string; amount: string; captureId: string; expires: string; pass: string }
  | { kind: 'error'; message: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function renderReturn(view: ReturnView): string {
  const body =
    view.kind === 'paid'
      ? `<h1 class="ok">Access is active</h1>
<p>${esc(view.planName)}, $${esc(view.amount)}, paid with PayPal. Access until ${esc(view.expires.slice(0, 10))}.</p>
<p class="fine">PayPal capture ${esc(view.captureId)}. Your AI agent prepared the order; you approved it in PayPal. One payment, no auto-renewal.</p>
<button type="button" id="refund-btn">Request a refund (14-day guarantee)</button>
<p class="fine" id="refund-status" aria-live="polite"></p>
<script>
const PASS = ${JSON.stringify(view.pass).replace(/</g, '\\u003c')};
let armed = false;
const btn = document.getElementById('refund-btn');
const out = document.getElementById('refund-status');
btn.addEventListener('click', async () => {
  if (!armed) { armed = true; btn.textContent = 'Yes, refund the full amount and close my access'; return; }
  btn.disabled = true; out.textContent = 'Asking PayPal for the refund...';
  try {
    const res = await fetch('/api/refund', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: PASS }) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'refund failed');
    out.textContent = 'Refunded' + (r.amount ? ' $' + r.amount : '') + '. PayPal refund ' + r.refundId + '.';
  } catch (e) {
    btn.disabled = false;
    out.textContent = e.message === 'refund window closed' ? 'The 14-day refund window has closed.' : 'The refund did not go through. Please try again.';
  }
});
</script>`
      : `<h1>Payment not finished</h1>
<p>${esc(view.message)}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Ladder Payment</title>
<style>
  body { margin:0; background:#fff; color:#1d1d1f; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif; }
  .wrap { max-width:560px; margin:0 auto; padding:48px 16px; }
  h1 { font-size:32px; letter-spacing:-0.02em; margin:0 0 12px; }
  .ok { color:#1f7a3a; }
  .fine { color:#6e6e73; font-size:13px; }
  button { border:1px solid #d2d2d7; border-radius:12px; background:#fff; color:#0071e3; font:600 15px/1 inherit; padding:12px 16px; cursor:pointer; margin-top:8px; }
  a { color:#0066cc; }
</style>
</head>
<body><div class="wrap">
${body}
<p class="fine"><a href="/">Back to Ladder Plan Advisor</a>. Sandbox demo, no real money moves.</p>
</div></body>
</html>`;
}
