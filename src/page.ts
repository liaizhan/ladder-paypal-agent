import type { Plan } from './catalog.ts';

interface PageProps {
  clientId: string;
  plans: Plan[];
  env: string;
}

export function renderPage({ clientId, plans, env }: PageProps): string {
  const config = JSON.stringify({ clientId, plans, env }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ladder Checkout Agent</title>
<meta name="description" content="An AI plan advisor for the Ladder method with PayPal agentic checkout (sandbox demo).">
<style>
  :root { --bg:#fff; --tile:#f5f5f7; --ink:#1d1d1f; --muted:#6e6e73; --blue:#0071e3; --line:#d2d2d7; --goal:#0071e3; --obst:#5b7290; --me:#3a3a3c; --ok:#1f7a3a; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif; }
  .wrap { max-width:720px; margin:0 auto; padding:24px 16px 64px; }
  .banner { background:#fff8e1; border:1px solid #f0d58c; border-radius:10px; padding:10px 14px; font-size:14px; color:#5c4a00; }
  h1 { font-size:36px; line-height:1.1; letter-spacing:-0.02em; margin:28px 0 8px; }
  .sub { color:var(--muted); margin:0 0 24px; }
  .chat { background:var(--tile); border-radius:16px; padding:16px; min-height:120px; }
  .msg { max-width:88%; padding:10px 14px; border-radius:14px; margin:8px 0; white-space:pre-wrap; }
  .msg.user { margin-left:auto; background:var(--blue); color:#fff; }
  .msg.assistant { background:#fff; border:1px solid var(--line); }
  .msg.help { background:#fff1f0; border:1px solid #f3b8b3; }
  .msg.tool { background:transparent; border:1px dashed var(--line); color:var(--muted); font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .ghost { background:#fff; color:var(--blue); border:1px solid var(--line); padding:12px 16px; font-size:15px; margin-top:12px; }
  form { display:flex; gap:8px; margin-top:12px; }
  textarea { flex:1; resize:vertical; min-height:52px; border:1px solid var(--line); border-radius:12px; padding:12px; font:inherit; }
  button { border:0; border-radius:12px; background:var(--blue); color:#fff; font:600 16px/1 inherit; padding:0 18px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .examples { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  .examples button { background:#fff; color:var(--blue); border:1px solid var(--line); font-weight:500; font-size:14px; padding:8px 12px; }
  .card { margin-top:24px; border:1px solid var(--line); border-radius:16px; padding:20px; }
  .card h2 { font-size:22px; margin:0 0 12px; letter-spacing:-0.01em; }
  .ladder { display:flex; flex-direction:column; gap:6px; margin:8px 0 16px; }
  .step { border-radius:10px; padding:10px 14px; color:#fff; font-size:15px; }
  .step.goal { background:var(--goal); }
  .step.obst { background:var(--obst); }
  .step.me { background:var(--me); }
  .step small { display:block; opacity:.75; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .plans { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:12px 0; }
  .plan { border:2px solid var(--line); border-radius:14px; padding:14px; cursor:pointer; background:#fff; text-align:left; color:var(--ink); font-weight:400; }
  .plan.selected { border-color:var(--blue); }
  .plan .price { font-size:28px; font-weight:700; letter-spacing:-0.02em; }
  .plan .tag { display:inline-block; font-size:12px; font-weight:600; color:var(--blue); margin-bottom:4px; min-height:18px; }
  .reason { background:var(--tile); border-radius:12px; padding:12px 14px; font-size:15px; }
  .fine { color:var(--muted); font-size:13px; margin-top:10px; }
  .plan-box { margin-top:12px; }
  .plan-gantt { height:380px; border:1px solid var(--line); border-radius:12px; overflow:hidden; margin-top:8px; }
  .plan-cap { color:var(--muted); font-size:13px; margin:8px 0 0; }
  .plan-cap code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:var(--ink); word-break:break-all; }
  .ok { color:var(--ok); font-weight:600; }
  #paypal-buttons { margin-top:14px; min-height:50px; }
  .guards { display:flex; flex-wrap:wrap; gap:6px; margin:12px 0 4px; }
  .chip { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; line-height:1.3; padding:5px 10px; border-radius:999px; background:#eef6ee; color:#1d6b2f; border:1px solid #cfe5d3; }
  .chip::before { content:'\\2713'; font-weight:700; }
  .chip.blocked { background:#fff4f2; color:#a1301f; border-color:#f3c9c2; }
  .chip.blocked::before { content:'\\2715'; }
  .guard-test { margin-top:10px; display:flex; flex-direction:column; gap:6px; }
  .guard-test .prompt { font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); border:1px dashed var(--line); border-radius:10px; padding:8px 10px; }
  .guard-test .chip { border-radius:10px; align-items:flex-start; }
  .hidden { display:none; }
  footer { margin-top:40px; color:var(--muted); font-size:13px; }
  footer a { color:#0066cc; }
  @media (max-width:520px) { h1 { font-size:28px; } .plans { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="banner">Demo in the PayPal <b>sandbox</b>: no real money moves. Pay with a PayPal sandbox buyer account.</div>
  <h1>Between you and your goal there are steps.</h1>
  <p class="sub">Tell the Ladder advisor what you want and what stops you. It maps your ladder, picks the plan that fits, and prepares a PayPal checkout that you approve.</p>

  <div class="chat" id="chat" aria-live="polite">
    <div class="msg assistant">Hi! What goal do you want to reach, and what has been stopping you so far?</div>
  </div>
  <form id="form">
    <textarea id="input" placeholder="For example: I want to start my own business, but I am afraid of mistakes and I never finish what I start." required></textarea>
    <button id="send" type="submit">Send</button>
  </form>
  <div class="examples" id="examples">
    <button type="button" data-text="I want to launch my online course this winter, but I keep postponing it because I am afraid nobody will buy.">Launch a course</button>
    <button type="button" data-text="I have wanted to lose weight for ten years. I start, quit after a week, my mother always said I am lazy, and stress makes me eat at night.">Lose weight</button>
    <button type="button" data-text="Хочу найти работу за границей, но боюсь, что мой английский слабый.">По-русски</button>
  </div>

  <section class="card hidden" id="rec">
    <h2>Your ladder</h2>
    <div class="ladder" id="ladder"></div>
    <div class="reason" id="reason"></div>
    <div class="guards" id="guards" aria-label="Guardrails that ran on this turn"></div>
    <div class="plans" id="plans"></div>
    <button type="button" class="ghost" id="plan-btn">See your plan on a timeline</button>
    <div class="plan-box" id="plan-preview" aria-live="polite"></div>
    <div id="paypal-buttons"></div>
    <p id="pay-status" class="sub" aria-live="polite"></p>
    <button type="button" class="ghost" id="break-btn">Try to make it $1</button>
    <div class="guard-test" id="guard-test" aria-live="polite"></div>
    <p class="fine">One payment, no auto-renewal. 14-day refund guarantee, one click after payment. Prices are sandbox demo equivalents in USD; on 108psy.com the plans cost 19,900 KZT and 39,800 KZT.</p>
  </section>

  <section class="card hidden" id="done">
    <h2 class="ok">Access is active</h2>
    <p id="done-text"></p>
    <div class="reason" id="first-step"></div>
    <div class="plan-box" id="plan-done" aria-live="polite"></div>
    <p class="fine" id="pass-check"></p>
    <button type="button" class="ghost" id="refund-btn">Request a refund (14-day guarantee)</button>
    <p class="fine" id="refund-status" aria-live="polite"></p>
  </section>

  <footer>Ladder method by Aizhan Li, author of the Ladder method. Live product: <a href="https://108psy.com">108psy.com</a>. The advisor is not a doctor or a therapist and does not diagnose. <a href="/dashboard">Payments dashboard</a>. <a href="/gift">Team gift for companies</a></footer>
</div>
<script>
const CONFIG = ${config};
const state = { messages: [], ladder: null, plan: null, recommended: null, recToken: null, agentOrder: null, pass: null, sdkLoaded: false };
const $ = (id) => document.getElementById(id);

function addMsg(role, text, cls) {
  const div = document.createElement('div');
  div.className = 'msg ' + (cls || role);
  div.textContent = text;
  $('chat').appendChild(div);
  div.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return div;
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  $('examples').classList.add('hidden');
  addMsg('user', text);
  state.messages.push({ role: 'user', content: text });
  $('input').value = '';
  $('send').disabled = true;
  const thinking = addMsg('assistant', 'Thinking about your ladder...');
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: state.messages }) });
    const turn = await res.json();
    thinking.remove();
    if (!res.ok) throw new Error(turn.error || 'error');
    addMsg('assistant', turn.reply, turn.stage === 'help' ? 'help' : 'assistant');
    state.messages.push({ role: 'assistant', content: turn.reply });
    if (turn.stage === 'help') { $('form').classList.add('hidden'); return; }
    if (turn.stage === 'recommend') {
      state.agentOrder = turn.agentOrder || null;
      if (state.agentOrder) addMsg('assistant', 'Agent tool call: ' + state.agentOrder.tool + '\\nPayPal order ' + state.agentOrder.id + ' is ready and waiting for your approval. Nothing is charged until you approve it in PayPal.', 'tool');
      showRecommendation(turn);
      showGuards($('guards'), turn.guards || [], false);
    }
  } catch (e) {
    thinking.textContent = 'Something went wrong. Please try again.';
  } finally {
    $('send').disabled = false;
  }
}

function showGuards(box, guards, blocked) {
  box.innerHTML = '';
  guards.forEach((g) => {
    const c = document.createElement('span');
    c.className = 'chip' + (blocked ? ' blocked' : '');
    c.textContent = g.text;
    box.appendChild(c);
  });
}

async function breakIt() {
  const box = $('guard-test');
  const btn = $('break-btn');
  btn.disabled = true;
  box.textContent = 'Sending a prompt injection to the checkout agent...';
  try {
    const res = await fetch('/api/guard-test', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error('error');
    box.innerHTML = '';
    const p = document.createElement('div');
    p.className = 'prompt';
    p.textContent = 'Attack: ' + data.prompt;
    box.appendChild(p);
    const list = document.createElement('div');
    list.className = 'guard-test';
    showGuards(list, data.checks, true);
    box.appendChild(list);
    const n = document.createElement('p');
    n.className = 'fine';
    n.textContent = 'Blocked by code, not by the model. ' + data.note;
    box.appendChild(n);
  } catch (e) {
    box.textContent = 'The test did not run. Please try again.';
  } finally {
    btn.disabled = false;
  }
}

function showRecommendation(turn) {
  state.ladder = turn.ladder;
  state.recommended = turn.plan;
  state.recToken = turn.recToken || null;
  state.plan = turn.plan;
  const ladder = $('ladder');
  ladder.innerHTML = '';
  const step = (cls, label, text) => {
    const d = document.createElement('div');
    d.className = 'step ' + cls;
    const s = document.createElement('small'); s.textContent = label;
    d.appendChild(s); d.appendChild(document.createTextNode(text));
    ladder.appendChild(d);
  };
  if (turn.ladder) {
    step('goal', 'Goal', turn.ladder.goal);
    [...turn.ladder.obstacles].reverse().forEach((o, i, arr) => step('obst', 'Step ' + (arr.length - i), o));
    step('me', 'Me now', turn.ladder.me);
  }
  $('reason').textContent = turn.reason || '';
  renderPlans();
  $('rec').classList.remove('hidden');
  $('rec').scrollIntoView({ behavior: 'smooth' });
  loadPayPal();
}

function renderPlans() {
  const box = $('plans');
  box.innerHTML = '';
  CONFIG.plans.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'plan' + (p.id === state.plan ? ' selected' : '');
    b.innerHTML = '<span class="tag"></span><div class="price"></div><div class="name"></div><div class="fine"></div>';
    b.querySelector('.tag').textContent = p.id === state.recommended ? 'Recommended for you' : '';
    b.querySelector('.price').textContent = '$' + Number(p.amount).toFixed(0);
    b.querySelector('.name').textContent = p.name;
    b.querySelector('.fine').textContent = p.note;
    b.onclick = () => { state.plan = p.id; renderPlans(); };
    box.appendChild(b);
  });
  const chosen = CONFIG.plans.find((p) => p.id === state.plan);
  $('plan-btn').textContent = 'See your ' + (chosen ? chosen.days : 30) + '-day plan on a timeline';
}

// Bryntum Gantt (trial build) loads only when someone asks for the timeline.
const BRY = 'https://cdn.jsdelivr.net/npm/@bryntum/gantt-trial@7.3.8/';
const BRY_CSS = [
  ['fontawesome/css/fontawesome.css', 'sha384-N/HxUPjGYXuq90qENJW4UQ6Vq8yZ3/QICew+C8+4qRK01TPldW3DoXtdBFW1z7Cw'],
  ['fontawesome/css/solid.css', 'sha384-d0/7jDoEiY/WF2esXosaOUW5d0p4j5ydbnE5M4i05cBN4x7k4gZVMDgq1x0mcF1P'],
  ['gantt.css', 'sha384-xv6n/FQ9l+WW9IFONv3kb/CeNtAM08R0ECuGxShdhJymM7x4TbMPlEODqru0FaTM'],
  ['stockholm-light.css', 'sha384-/BMbHl9I2Ie1/FgBwQ0oVmRT7CX0yAedq7q/L0jHP5ndUhCWqfMOZG0cpcEyVv+w'],
];
let bryntumReady = null;
function loadBryntum() {
  if (bryntumReady) return bryntumReady;
  bryntumReady = new Promise((resolve, reject) => {
    BRY_CSS.forEach(([f, h]) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = BRY + f; l.integrity = h; l.crossOrigin = 'anonymous';
      if (f === 'stockholm-light.css') l.setAttribute('data-bryntum-theme', '');
      document.head.appendChild(l);
    });
    const sc = document.createElement('script');
    sc.src = BRY + 'gantt.umd.js';
    sc.integrity = 'sha384-g8MbJtJxFZKBvEs/RABtMHbV7fkWRAapZ2jES+HkwX5PeXAdAp6+JCj+f0lRMPey';
    sc.crossOrigin = 'anonymous';
    sc.onload = () => resolve(window.bryntum.gantt);
    sc.onerror = () => { bryntumReady = null; reject(new Error('gantt did not load')); };
    document.head.appendChild(sc);
  });
  return bryntumReady;
}

const gantts = {};
const longDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
async function showPlan(boxId, body) {
  const box = $(boxId);
  if (gantts[boxId]) { gantts[boxId].destroy(); delete gantts[boxId]; }
  box.replaceChildren();
  const cap = document.createElement('p');
  cap.className = 'plan-cap';
  cap.textContent = 'The AI is splitting your access period between the steps...';
  box.append(cap);
  try {
    const res = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'plan failed');
    const B = await loadBryntum();
    const colors = { payment: 'green', 'refund-window': 'orange', step: r.status === 'draft' ? 'gray' : 'blue', goal: r.status === 'draft' ? 'gray' : 'indigo', refund: 'red' };
    const tasks = r.tasks.map((t) => ({ id: t.id, name: t.name, startDate: t.startDate, duration: t.duration, manuallyScheduled: !!t.manuallyScheduled, note: t.note || '', inactive: !!t.inactive, eventColor: colors[t.kind] || 'blue' }));
    const holder = document.createElement('div');
    holder.className = 'plan-gantt';
    box.append(holder);
    gantts[boxId] = new B.Gantt({
      appendTo: holder,
      project: { startDate: r.startDate, tasksData: tasks, dependenciesData: r.dependencies },
      columns: [{ type: 'name', width: 210 }, { type: 'startdate', width: 110 }, { type: 'duration', width: 90 }, { type: 'note', text: 'Practice', width: 230 }],
      subGridConfigs: { locked: { width: Math.round(Math.min(440, holder.clientWidth * 0.45)) } },
      viewPreset: 'weekAndMonth',
      features: { projectLines: false },
    });
    // Show the whole access period at once, from the payment to the goal.
    try { await gantts[boxId].project.commitAsync(); gantts[boxId].zoomToFit({ leftMargin: 20, rightMargin: 40 }); } catch (e) {}
    const lead = r.status === 'draft'
      ? 'Draft plan, ' + longDate(r.startDate) + ' to ' + longDate(r.endDate) + '. It turns on when PayPal confirms the payment, and the dates move to the payment day.'
      : r.status === 'refunded'
        ? 'Plan closed by the PayPal refund. The steps are switched off.'
        : 'Your plan from ' + longDate(r.startDate) + ' to ' + longDate(r.endDate) + ', tied to the PayPal payment. Drag a step and the next steps move with it.';
    const how = r.source === 'ai'
      ? ' The AI chose the days and a practice for each step; the server fitted them into your ' + r.totalDays + '-day access.'
      : ' The AI did not answer, so the days are split evenly.';
    cap.textContent = lead + how;
    if (r.toolCall) {
      const raw = document.createElement('p');
      raw.className = 'plan-cap';
      raw.append('Tool call the model wrote: ');
      const code = document.createElement('code'); code.textContent = 'schedule_ladder_steps ' + r.toolCall; raw.append(code);
      box.append(raw);
    }
  } catch (e) {
    cap.textContent = 'The timeline could not load. Your ladder and payment are not affected.';
  }
}
$('plan-btn').addEventListener('click', () => { if (state.ladder) showPlan('plan-preview', { ladder: state.ladder, plan: state.plan }); });

function loadPayPal() {
  if (state.sdkLoaded) return;
  if (!CONFIG.clientId) { $('paypal-buttons').textContent = 'PayPal client id is not configured.'; return; }
  state.sdkLoaded = true;
  const s = document.createElement('script');
  s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(CONFIG.clientId) + '&currency=USD&intent=capture&components=buttons';
  s.onload = renderButtons;
  document.head.appendChild(s);
}

function renderButtons() {
  paypal.Buttons({
    style: { layout: 'vertical', shape: 'rect', label: 'pay' },
    createOrder: async () => {
      // Reuse the order the checkout agent prepared, if the person kept that plan.
      if (state.agentOrder && state.agentOrder.plan === state.plan && !state.agentOrder.used) {
        state.agentOrder.used = true;
        return state.agentOrder.id;
      }
      const res = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: state.plan, ladder: state.ladder, recToken: state.recToken }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'order failed');
      return data.id;
    },
    onApprove: async (data, actions) => {
      $('pay-status').textContent = 'Confirming your payment...';
      const res = await fetch('/api/orders/' + data.orderID + '/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ladder: state.ladder }) });
      const r = await res.json();
      if (r.error === 'INSTRUMENT_DECLINED') { $('pay-status').textContent = 'This payment method was declined. Please choose another one in PayPal.'; return actions.restart(); }
      if (!res.ok) { $('pay-status').textContent = 'Payment was not completed. You can try again.'; return; }
      $('pay-status').textContent = '';
      $('rec').classList.add('hidden');
      const until = new Date(r.expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      $('done-text').textContent = 'Thank you' + (r.payerName ? ', ' + r.payerName : '') + '. ' + r.planName + ' is active until ' + until + '. PayPal capture ' + r.captureId + ', $' + r.amount + '.';
      $('first-step').textContent = r.firstStep ? 'Your first step today: ' + r.firstStep : '';
      $('done').classList.remove('hidden');
      $('done').scrollIntoView({ behavior: 'smooth' });
      state.pass = r.pass;
      try { localStorage.setItem('ladderPass', r.pass); } catch (e) {}
      const check = await fetch('/api/pass?token=' + encodeURIComponent(r.pass)).then((x) => x.json());
      $('pass-check').textContent = check.active ? 'Signed access pass verified by the server: ' + check.plan + ', expires ' + check.expires.slice(0, 10) + '.' : '';
      if (state.ladder) showPlan('plan-done', { ladder: state.ladder, pass: r.pass });
    },
    onError: () => { $('pay-status').textContent = 'PayPal could not complete the payment. Please try again.'; },
  }).render('#paypal-buttons');
}

$('refund-btn').addEventListener('click', async () => {
  if (!state.pass) return;
  // Two clicks instead of a modal: the first one asks, the second one refunds.
  if (!state.refundArmed) {
    state.refundArmed = true;
    $('refund-btn').textContent = 'Yes, refund the full amount and close my access';
    return;
  }
  $('refund-btn').disabled = true;
  $('refund-status').textContent = 'Asking PayPal for the refund...';
  try {
    const res = await fetch('/api/refund', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: state.pass }) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'refund failed');
    const check = await fetch('/api/pass?token=' + encodeURIComponent(state.pass)).then((x) => x.json());
    $('refund-status').textContent = 'Refunded' + (r.amount ? ' $' + r.amount : '') + '. PayPal refund ' + r.refundId + '. Access pass is now ' + (check.active ? 'active' : 'closed') + '.';
    $('pass-check').textContent = '';
    try { localStorage.removeItem('ladderPass'); } catch (e) {}
    if (state.ladder) showPlan('plan-done', { ladder: state.ladder, pass: state.pass });
  } catch (e) {
    $('refund-btn').disabled = false;
    $('refund-status').textContent = e.message === 'refund window closed' ? 'The 14-day refund window has closed.' : 'The refund did not go through. Please try again.';
  }
});

$('form').addEventListener('submit', (e) => { e.preventDefault(); send($('input').value); });
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('input').value); } });
$('break-btn').addEventListener('click', breakIt);
document.querySelectorAll('#examples button').forEach((b) => b.addEventListener('click', () => send(b.dataset.text)));
</script>
</body>
</html>`;
}
