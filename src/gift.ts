import type { Plan } from './catalog.ts';

interface GiftProps {
  env: string;
  plans: Plan[];
  maxSeats: number;
}

// Team gift page: HR describes the gift, the gift agent prepares a DRAFT PayPal invoice,
// HR sends it, the company pays in PayPal, and the page shows one access code per seat.
export function renderGift({ env, plans, maxSeats }: GiftProps): string {
  const config = JSON.stringify({ env, plans, maxSeats }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ladder Team Gift</title>
<meta name="description" content="A company gives Ladder access to its team: an AI agent prepares a PayPal invoice, codes arrive after payment (sandbox demo).">
<style>
  :root { --bg:#fff; --tile:#f5f5f7; --ink:#1d1d1f; --muted:#6e6e73; --blue:#0071e3; --line:#d2d2d7; --ok:#1f7a3a; --warn:#b3261e; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif; }
  .wrap { max-width:720px; margin:0 auto; padding:24px 16px 64px; }
  .banner { background:#fff8e1; border:1px solid #f0d58c; border-radius:10px; padding:10px 14px; font-size:14px; color:#5c4a00; }
  h1 { font-size:36px; line-height:1.1; letter-spacing:-0.02em; margin:28px 0 8px; }
  .sub { color:var(--muted); margin:0 0 24px; }
  .chat { background:var(--tile); border-radius:16px; padding:16px; min-height:100px; }
  .msg { max-width:88%; padding:10px 14px; border-radius:14px; margin:8px 0; white-space:pre-wrap; }
  .msg.user { margin-left:auto; background:var(--blue); color:#fff; }
  .msg.assistant { background:#fff; border:1px solid var(--line); }
  .msg.help { background:#fff1f0; border:1px solid #f3b8b3; }
  .msg.tool { background:transparent; border:1px dashed var(--line); color:var(--muted); font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .msg.refused { background:#fff1f0; border:1px dashed #f3b8b3; color:var(--warn); font-size:14px; }
  form { display:flex; gap:8px; margin-top:12px; }
  textarea, input[type=text] { flex:1; border:1px solid var(--line); border-radius:12px; padding:12px; font:inherit; }
  textarea { resize:vertical; min-height:52px; }
  button { border:0; border-radius:12px; background:var(--blue); color:#fff; font:600 16px/1 inherit; padding:12px 18px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .ghost { background:#fff; color:var(--blue); border:1px solid var(--line); }
  .examples { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  .examples button { background:#fff; color:var(--blue); border:1px solid var(--line); font-weight:500; font-size:14px; padding:8px 12px; }
  .card { margin-top:24px; border:1px solid var(--line); border-radius:16px; padding:20px; }
  .card h2 { font-size:22px; margin:0 0 12px; letter-spacing:-0.01em; }
  .rows { display:grid; grid-template-columns:auto 1fr; gap:6px 16px; margin:0 0 14px; }
  .rows dt { color:var(--muted); }
  .rows dd { margin:0; font-weight:600; }
  .total { font-size:30px; font-weight:700; letter-spacing:-0.02em; }
  .note { background:var(--tile); border-radius:12px; padding:12px 14px; font-size:15px; margin-bottom:14px; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; }
  .fine { color:var(--muted); font-size:13px; margin-top:10px; }
  .ok { color:var(--ok); font-weight:600; }
  .codes { columns:2; font:15px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace; margin:8px 0 12px; padding:0; list-style:none; }
  .hidden { display:none; }
  a { color:#0066cc; }
  footer { margin-top:40px; color:var(--muted); font-size:13px; }
  @media (max-width:520px) { h1 { font-size:28px; } .codes { columns:1; } form { flex-direction:column; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="banner">Demo in the PayPal <b>sandbox</b>: no real money moves. The invoice is paid with a PayPal sandbox buyer account.</div>
  <h1>Give your team time for themselves.</h1>
  <p class="sub">For companies and unions that give Ladder to their own employees or members. Describe the gift in plain words. The gift agent prepares a PayPal invoice, you check and send it, and after payment you get one access code per person.</p>

  <div class="chat" id="chat" aria-live="polite">
    <div class="msg assistant">Who is the gift for, how many people, and for which occasion?</div>
  </div>
  <form id="form">
    <textarea id="input" placeholder="For example: Three months for the 20 people on our support team, as a New Year gift." required></textarea>
    <button id="send" type="submit">Send</button>
  </form>
  <div class="examples" id="examples">
    <button type="button" data-text="Three months for the 20 people on our support team, as a New Year gift.">Support team, New Year</button>
    <button type="button" data-text="One month for 8 colleagues in our accounting team for Nauryz.">Accounting, Nauryz</button>
    <button type="button" data-text="We are a union of 150 teachers. A 3-month gift for each member.">Teachers' union</button>
  </div>

  <section class="card hidden" id="draft">
    <h2>Draft PayPal invoice</h2>
    <dl class="rows">
      <dt>Invoice</dt><dd id="d-number"></dd>
      <dt>Plan</dt><dd id="d-plan"></dd>
      <dt>Seats</dt><dd id="d-seats"></dd>
      <dt>Per seat</dt><dd id="d-unit"></dd>
    </dl>
    <div class="total" id="d-total"></div>
    <p class="fine">The total comes from the server catalog: seats times the plan price. The AI chose the plan and the seat count only.</p>
    <div class="note" id="d-note"></div>
    <div class="actions">
      <button type="button" id="send-btn">Send invoice</button>
      <a class="hidden" id="pay-link" target="_blank" rel="noopener"><button type="button">Open the PayPal invoice</button></a>
      <button type="button" class="ghost hidden" id="check-btn">Check payment</button>
    </div>
    <p class="fine" id="d-status" aria-live="polite"></p>
  </section>

  <section class="card hidden" id="paid">
    <h2 class="ok">Paid. Access codes for your team</h2>
    <p>Give one code to each person. Each code opens the plan once, from the day it is used.</p>
    <ul class="codes" id="codes"></ul>
    <button type="button" class="ghost" id="copy-btn">Copy all codes</button>
    <p class="fine" id="copy-status" aria-live="polite"></p>
  </section>

  <section class="card">
    <h2>Have a code?</h2>
    <form id="redeem-form">
      <input type="text" id="code" placeholder="LDR-XXXX-XXXX" autocomplete="off" required>
      <button type="submit">Open access</button>
    </form>
    <p class="fine" id="redeem-status" aria-live="polite"></p>
  </section>

  <footer>Ladder method by Aizhan Li, author of the Ladder method. Live product: <a href="https://108psy.com">108psy.com</a>. A gift from a company or a union to its own people. Ladder does not diagnose and does not promise health results. <a href="/">Plan advisor</a>. <a href="/dashboard">Payments dashboard</a></footer>
</div>
<script>
const CONFIG = ${config};
const state = { messages: [], gift: null };
const $ = (id) => document.getElementById(id);
const usd = (v) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 });

function addMsg(role, text, cls) {
  const div = document.createElement('div');
  div.className = 'msg ' + (cls || role);
  div.textContent = text;
  $('chat').appendChild(div);
  div.scrollIntoView({ block: 'nearest' });
}

function remember(g) {
  try { localStorage.setItem('ladder-gift', JSON.stringify({ id: g.invoiceId, token: g.token, number: g.number, planName: g.planName, seats: g.seats, unit: g.unit, total: g.total, note: g.note })); } catch (e) {}
}

function showDraft(g) {
  state.gift = g;
  $('d-number').textContent = g.number || g.invoiceId;
  $('d-plan').textContent = g.planName;
  $('d-seats').textContent = String(g.seats);
  $('d-unit').textContent = usd(g.unit);
  $('d-total').textContent = usd(g.total);
  $('d-note').textContent = g.note;
  $('draft').classList.remove('hidden');
}

function showPayLink(url) {
  if (!url) return;
  $('pay-link').href = url;
  $('pay-link').classList.remove('hidden');
  $('check-btn').classList.remove('hidden');
  $('send-btn').classList.add('hidden');
}

async function ask(text) {
  addMsg('user', text);
  state.messages.push({ role: 'user', content: text });
  $('send').disabled = true;
  try {
    const res = await fetch('/api/gift/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: state.messages }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'error');
    if (data.tool) addMsg('tool', 'gift agent called ' + data.tool);
    if (data.stage === 'help') { addMsg('assistant', data.reply, 'help'); return; }
    if (data.stage === 'refused') { addMsg('assistant', data.reply, 'refused'); state.messages.push({ role: 'assistant', content: data.reply }); return; }
    if (data.stage === 'ask') { addMsg('assistant', data.reply); state.messages.push({ role: 'assistant', content: data.reply }); return; }
    const reply = 'I prepared a draft invoice: ' + data.planName + ' for ' + data.seats + ' people. Check it below and send it when it looks right.';
    addMsg('assistant', reply);
    state.messages.push({ role: 'assistant', content: reply });
    showDraft(data);
    remember(data);
  } catch (err) {
    addMsg('assistant', 'Something went wrong. Please try again.');
  } finally {
    $('send').disabled = false;
  }
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  ask(text);
});
$('examples').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (t) ask(t.dataset.text);
});

$('send-btn').addEventListener('click', async () => {
  const g = state.gift;
  if (!g) return;
  $('send-btn').disabled = true;
  $('d-status').textContent = 'Sending the invoice in PayPal...';
  try {
    const res = await fetch('/api/gift/' + g.invoiceId + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: g.token }) });
    const data = await res.json();
    if (!res.ok || !data.payerUrl) throw new Error(data.error || 'no link');
    showPayLink(data.payerUrl);
    $('d-status').textContent = 'Invoice sent. Open it to pay in PayPal, then press Check payment.';
  } catch (err) {
    $('d-status').textContent = 'PayPal did not send the invoice. Please try again.';
    $('send-btn').disabled = false;
  }
});

async function check(quiet) {
  const g = state.gift;
  if (!g) return;
  if (!quiet) $('d-status').textContent = 'Asking PayPal...';
  try {
    const res = await fetch('/api/gift/' + g.invoiceId + '?token=' + encodeURIComponent(g.token));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'error');
    if (data.payerUrl) showPayLink(data.payerUrl);
    if (data.codes && data.codes.length) {
      $('codes').innerHTML = '';
      for (const c of data.codes) { const li = document.createElement('li'); li.textContent = c; $('codes').appendChild(li); }
      $('paid').classList.remove('hidden');
      $('d-status').textContent = 'PayPal invoice status: PAID.';
      return;
    }
    $('d-status').textContent = 'PayPal invoice status: ' + data.status + '.';
  } catch (err) {
    if (!quiet) $('d-status').textContent = 'Could not reach PayPal. Please try again.';
  }
}
$('check-btn').addEventListener('click', () => check(false));

$('copy-btn').addEventListener('click', async () => {
  const text = [...$('codes').children].map((li) => li.textContent).join('\\n');
  try { await navigator.clipboard.writeText(text); $('copy-status').textContent = 'Copied.'; } catch (e) { $('copy-status').textContent = 'Select the codes and copy them.'; }
});

$('redeem-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('code').value.trim();
  $('redeem-status').textContent = 'Checking...';
  try {
    const res = await fetch('/api/gift/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'error');
    $('redeem-status').innerHTML = '';
    const b = document.createElement('span');
    b.className = 'ok';
    b.textContent = 'Access is active: ' + data.planName + ', until ' + new Date(data.expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) + '.';
    $('redeem-status').appendChild(b);
  } catch (err) {
    $('redeem-status').textContent = err.message === 'error' ? 'Something went wrong. Please try again.' : err.message;
  }
});

try {
  const saved = JSON.parse(localStorage.getItem('ladder-gift') || 'null');
  if (saved && saved.id && saved.token) {
    showDraft({ invoiceId: saved.id, token: saved.token, number: saved.number, planName: saved.planName, seats: saved.seats, unit: saved.unit, total: saved.total, note: saved.note });
    check(true);
  }
} catch (e) {}
</script>
</body>
</html>`;
}
