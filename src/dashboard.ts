// Payments dashboard: every PayPal order the AI advisor led to, in AG Grid.
// Read-only and public for the judges. No goals, obstacles or names are stored.

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ladder Payments Dashboard</title>
<meta name="description" content="PayPal orders from the Ladder AI plan advisor, reconciled with PayPal Orders v2, in AG Grid (sandbox).">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ag-grid-community@32.3.3/styles/ag-grid.css" integrity="sha384-gIsz6JTVbF5eW0CcuAljKL2kOE400G4TjBH3CBtGXjf8BkjmC5x9jp4Y+bYa7HKA" crossorigin="anonymous">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ag-grid-community@32.3.3/styles/ag-theme-quartz.css" integrity="sha384-bH6bJyGdKmdCV+hlDWtv+dVLH5shFT5aKgGRKceh40t3vt171XksCejZ5ebqZVn0" crossorigin="anonymous">
<style>
  :root { --bg:#fff; --tile:#f5f5f7; --ink:#1d1d1f; --muted:#6e6e73; --blue:#0071e3; --link:#0066cc; --line:#d2d2d7; --ok:#1f7a3a; --okbg:#e8f5ec; --warn:#8a5a00; --warnbg:#fff4dc; --bad:#a1281e; --badbg:#fdecea; --slate:#5b7290; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:24px 16px 64px; }
  .banner { background:#fff8e1; border:1px solid #f0d58c; border-radius:10px; padding:10px 14px; font-size:14px; color:#5c4a00; }
  h1 { font-size:34px; line-height:1.1; letter-spacing:-0.02em; margin:24px 0 6px; }
  h2 { font-size:22px; letter-spacing:-0.01em; margin:36px 0 4px; }
  .sub { color:var(--muted); margin:0 0 8px; max-width:760px; }
  a { color:var(--link); }
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:20px 0 4px; }
  .kpi { background:var(--tile); border-radius:14px; padding:14px 16px; }
  .kpi .v { font-size:28px; font-weight:700; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; }
  .kpi .l { color:var(--muted); font-size:13px; }
  .bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:12px 0 10px; }
  .bar input { flex:1; min-width:180px; border:1px solid var(--line); border-radius:10px; padding:9px 12px; font:inherit; font-size:15px; }
  .bar button { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:10px; padding:8px 12px; font:500 14px/1 inherit; cursor:pointer; }
  .bar button.on { background:var(--blue); border-color:var(--blue); color:#fff; }
  .bar .right { margin-left:auto; display:flex; gap:8px; }
  .grid { width:100%; }
  .ag-theme-quartz { --ag-font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif; --ag-font-size:14px; --ag-active-color:var(--blue); --ag-header-background-color:var(--tile); --ag-border-radius:12px; --ag-wrapper-border-radius:12px; }
  .pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:12px; font-weight:600; line-height:20px; }
  .pill.ok { background:var(--okbg); color:var(--ok); }
  .pill.open { background:#eef4fb; color:var(--slate); }
  .pill.warn { background:var(--warnbg); color:var(--warn); }
  .pill.bad { background:var(--badbg); color:var(--bad); }
  .pill.plan3 { background:#e6f0fc; color:var(--blue); }
  .pill.plan1 { background:var(--tile); color:var(--ink); }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  .note { color:var(--muted); font-size:13px; margin-top:8px; }
  .ag-row-pinned { font-weight:600; }
  footer { margin-top:40px; color:var(--muted); font-size:13px; }
  @media (max-width:760px) { .kpis { grid-template-columns:repeat(2,1fr); } h1 { font-size:28px; } .bar .right { margin-left:0; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="banner">PayPal <b>sandbox</b>: no real money moves. Includes test runs by the author.</div>
  <h1>Payments dashboard</h1>
  <p class="sub">Every PayPal order the Ladder AI advisor led to: what the AI recommended, what the person chose, and what PayPal says now. Open orders are reconciled with PayPal Orders v2 each time this page loads.</p>
  <p class="note">Privacy: no goals, obstacles, names or emails are stored. Only plan ids, the number of steps, the language, PayPal ids and statuses. Ids of unpaid orders are masked. <a href="/">Back to the advisor</a></p>

  <div class="kpis" id="kpis"></div>

  <h2>Orders</h2>
  <p class="sub">Filter, sort and search. The cards above and the total row follow your filter.</p>
  <div class="bar">
    <input id="search" type="search" placeholder="Search orders, capture ids, plans" aria-label="Search orders">
    <div id="status-filter">
      <button type="button" data-f="all" class="on">All</button>
      <button type="button" data-f="paid">Paid</button>
      <button type="button" data-f="open">Open</button>
      <button type="button" data-f="problem">Declined or expired</button>
    </div>
    <div class="right">
      <button type="button" id="refresh">Reconcile with PayPal</button>
      <button type="button" id="csv">Export CSV</button>
    </div>
  </div>
  <div id="orders" class="grid ag-theme-quartz"></div>
  <p class="note" id="sync"></p>

  <h2>Advisor funnel by day</h2>
  <p class="sub">Conversations, AI recommendations and safety handoffs, next to PayPal orders and captures. A safety handoff means the advisor showed help lines instead of a checkout.</p>
  <div id="days" class="grid ag-theme-quartz"></div>

  <footer>Ladder method by Aizhan Li, author of the Ladder method. Grids: AG Grid Community. Payments: PayPal Orders v2 and JavaScript SDK. AI: Workers AI, Llama 3.3 70B.</footer>
</div>
<script src="https://cdn.jsdelivr.net/npm/ag-grid-community@32.3.3/dist/ag-grid-community.min.js" integrity="sha384-OEiOpwgvTUxOUC72SwfU8zDqZrWBwr0YNPNhovPbjCxdaTD0cLxMHBew/o8zuRln" crossorigin="anonymous"></script>
<script>
const PLAN = { ladder_1m: '1 month', ladder_3m: '3 months' };
const LANG = { en: 'English', ru: 'Russian', kk: 'Kazakh', '': '' };
const OPEN = ['CREATED', 'APPROVED', 'SAVED', 'PAYER_ACTION_REQUIRED'];
const PROBLEM = ['INSTRUMENT_DECLINED', 'VOIDED', 'EXPIRED', 'FAILED', 'DECLINED'];
const $ = (id) => document.getElementById(id);
let statusFilter = 'all';
let allDays = [];
let allOrders = [];

function pill(text, cls) {
  const s = document.createElement('span');
  s.className = 'pill ' + cls;
  s.textContent = text;
  return s;
}
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const statusClass = (s) => s === 'COMPLETED' ? 'ok' : PROBLEM.includes(s) ? 'bad' : s === 'APPROVED' ? 'warn' : 'open';
const statusText = (s) => ({ COMPLETED: 'Paid', CREATED: 'Checkout opened', APPROVED: 'Approved, not captured', PAYER_ACTION_REQUIRED: 'Waiting for the buyer', SAVED: 'Saved, not captured', INSTRUMENT_DECLINED: 'Card declined', VOIDED: 'Voided', EXPIRED: 'Expired' }[s] || s);

const ordersGrid = agGrid.createGrid($('orders'), {
  domLayout: 'autoHeight',
  pagination: true,
  paginationPageSize: 20,
  paginationPageSizeSelector: [20, 50, 100],
  rowData: [],
  overlayNoRowsTemplate: 'No orders yet. Open the advisor, get a recommendation and pay with a PayPal sandbox buyer.',
  defaultColDef: { sortable: true, resizable: true, filter: true, floatingFilter: true, minWidth: 110 },
  autoSizeStrategy: { type: 'fitGridWidth' },
  columnDefs: [
    { field: 'createdAt', headerName: 'Created', sort: 'desc', filter: 'agDateColumnFilter', minWidth: 140,
      valueFormatter: (p) => p.node.rowPinned ? 'Total' : when(p.value),
      filterParams: { comparator: (d, v) => { const x = new Date(v); x.setHours(0,0,0,0); return x < d ? -1 : x > d ? 1 : 0; } } },
    { field: 'status', headerName: 'PayPal status', minWidth: 170,
      cellRenderer: (p) => p.node.rowPinned ? p.value : pill(statusText(p.value), statusClass(p.value)),
      filterValueGetter: (p) => statusText(p.data.status) },
    { field: 'recommended', headerName: 'AI recommended', minWidth: 140,
      cellRenderer: (p) => p.node.rowPinned ? '' : p.value ? pill(PLAN[p.value], p.value === 'ladder_3m' ? 'plan3' : 'plan1') : 'n/a',
      filterValueGetter: (p) => PLAN[p.data.recommended] || 'n/a' },
    { field: 'chosen', headerName: 'Person chose', minWidth: 130,
      valueFormatter: (p) => p.node.rowPinned ? '' : PLAN[p.value] || p.value,
      filterValueGetter: (p) => PLAN[p.data.chosen] },
    { field: 'followedAdvice', headerName: 'Followed AI', minWidth: 120,
      valueFormatter: (p) => p.node.rowPinned ? (p.value || '') : p.value === null ? 'n/a' : p.value ? 'Yes' : 'Switched',
      filterValueGetter: (p) => p.data.followedAdvice === null ? 'n/a' : p.data.followedAdvice ? 'Yes' : 'Switched',
      cellClassRules: { 'ag-right-aligned-cell': () => false } },
    { field: 'amount', headerName: 'Amount', type: 'rightAligned', filter: 'agNumberColumnFilter', minWidth: 110,
      valueGetter: (p) => Number(p.data.amount), valueFormatter: (p) => money(p.value) },
    { field: 'steps', headerName: 'Steps on ladder', type: 'rightAligned', filter: 'agNumberColumnFilter', minWidth: 130 },
    { field: 'lang', headerName: 'Language', valueFormatter: (p) => LANG[p.value] ?? p.value, filterValueGetter: (p) => LANG[p.data.lang] },
    { field: 'orderId', headerName: 'PayPal order', cellClass: 'mono', minWidth: 170 },
    { field: 'captureId', headerName: 'PayPal capture', cellClass: 'mono', minWidth: 170 },
  ],
  isExternalFilterPresent: () => statusFilter !== 'all',
  doesExternalFilterPass: (node) => {
    const s = node.data.status;
    if (statusFilter === 'paid') return s === 'COMPLETED';
    if (statusFilter === 'open') return OPEN.includes(s);
    if (statusFilter === 'problem') return PROBLEM.includes(s);
    return true;
  },
  onFilterChanged: updateFromGrid,
  onRowDataUpdated: updateFromGrid,
});

const daysGrid = agGrid.createGrid($('days'), {
  domLayout: 'autoHeight',
  rowData: [],
  overlayNoRowsTemplate: 'No conversations recorded yet.',
  defaultColDef: { sortable: true, resizable: true, minWidth: 110, type: 'rightAligned' },
  autoSizeStrategy: { type: 'fitGridWidth' },
  columnDefs: [
    { field: 'date', headerName: 'Day (UTC)', sort: 'desc', type: undefined, minWidth: 120 },
    { field: 'conversations', headerName: 'Conversations' },
    { field: 'recommendations', headerName: 'AI recommendations' },
    { field: 'rec1m', headerName: '1 month' },
    { field: 'rec3m', headerName: '3 months' },
    { field: 'safetyHandoffs', headerName: 'Safety handoffs' },
    { field: 'orders', headerName: 'PayPal orders' },
    { field: 'paid', headerName: 'Paid' },
    { field: 'revenue', headerName: 'Revenue (sandbox)', valueFormatter: (p) => money(p.value), minWidth: 150 },
  ],
});

function shown() {
  const rows = [];
  ordersGrid.forEachNodeAfterFilter((n) => { if (n.data) rows.push(n.data); });
  return rows;
}

function updateFromGrid() {
  const rows = shown();
  const paid = rows.filter((r) => r.status === 'COMPLETED');
  const advised = rows.filter((r) => r.followedAdvice !== null);
  const followed = advised.filter((r) => r.followedAdvice).length;
  const paidAdvised = paid.filter((r) => r.followedAdvice !== null);
  const paidFollowed = paidAdvised.filter((r) => r.followedAdvice).length;
  const revenue = paid.reduce((s, r) => s + Number(r.amount), 0);
  ordersGrid.setGridOption('pinnedBottomRowData', [{
    createdAt: '', status: rows.length + ' orders', followedAdvice: advised.length ? Math.round(100 * followed / advised.length) + '% followed' : '',
    amount: revenue, orderId: paid.length + ' paid', captureId: '', steps: '', lang: '', recommended: '', chosen: '',
  }]);
  const conv = allDays.reduce((s, d) => s + d.conversations, 0);
  const recs = allDays.reduce((s, d) => s + d.recommendations, 0);
  const safety = allDays.reduce((s, d) => s + d.safetyHandoffs, 0);
  const r3 = allDays.reduce((s, d) => s + d.rec3m, 0);
  const kpis = [
    [conv, 'Conversations, 30 days'],
    [recs, 'AI recommendations' + (recs ? ', ' + Math.round(100 * r3 / recs) + '% for 3 months' : '')],
    [safety, 'Safety handoffs, no checkout shown'],
    [rows.length, 'PayPal orders' + (statusFilter !== 'all' || ordersGrid.isAnyFilterPresent() ? ' (filtered)' : '')],
    [paid.length, 'Paid' + (rows.length ? ', ' + Math.round(100 * paid.length / rows.length) + '% of orders' : '')],
    [money(revenue), 'Captured revenue (sandbox)'],
    [paidAdvised.length ? Math.round(100 * paidFollowed / paidAdvised.length) + '%' : 'n/a', 'Paid orders on the plan the AI recommended'],
    [recs ? Math.round(100 * allOrders.length / recs) + '%' : 'n/a', 'Recommendations that opened PayPal'],
  ];
  const box = $('kpis');
  box.replaceChildren(...kpis.map(([v, l]) => {
    const d = document.createElement('div'); d.className = 'kpi';
    const a = document.createElement('div'); a.className = 'v'; a.textContent = v;
    const b = document.createElement('div'); b.className = 'l'; b.textContent = l;
    d.append(a, b); return d;
  }));
}

function buildDays(days, orders) {
  const map = new Map(days.map((d) => [d.date, { ...d, orders: 0, paid: 0, revenue: 0 }]));
  for (const o of orders) {
    const date = o.createdAt.slice(0, 10);
    if (!map.has(date)) map.set(date, { date, conversations: 0, recommendations: 0, rec1m: 0, rec3m: 0, safetyHandoffs: 0, orders: 0, paid: 0, revenue: 0 });
    const d = map.get(date);
    d.orders++;
    if (o.status === 'COMPLETED') { d.paid++; d.revenue += Number(o.amount); }
  }
  const rows = [...map.values()];
  const total = rows.reduce((t, d) => {
    for (const k of ['conversations','recommendations','rec1m','rec3m','safetyHandoffs','orders','paid','revenue']) t[k] += d[k];
    return t;
  }, { date: 'Total', conversations: 0, recommendations: 0, rec1m: 0, rec3m: 0, safetyHandoffs: 0, orders: 0, paid: 0, revenue: 0 });
  return { rows, total };
}

async function load() {
  $('refresh').disabled = true;
  $('sync').textContent = 'Loading and reconciling with PayPal...';
  try {
    const data = await fetch('/api/dashboard', { cache: 'no-store' }).then((r) => r.json());
    allDays = data.days || [];
    allOrders = data.orders || [];
    ordersGrid.setGridOption('rowData', allOrders);
    const { rows, total } = buildDays(allDays, allOrders);
    daysGrid.setGridOption('rowData', rows);
    daysGrid.setGridOption('pinnedBottomRowData', rows.length ? [total] : []);
    $('sync').textContent = 'Updated ' + when(data.generatedAt) + '. ' + (data.reconciled ? data.reconciled + ' open order(s) checked with PayPal Orders v2 just now.' : 'No open orders needed a PayPal check.');
  } catch (e) {
    $('sync').textContent = 'Could not load the dashboard. Please try again.';
  } finally {
    $('refresh').disabled = false;
  }
}

$('search').addEventListener('input', (e) => ordersGrid.setGridOption('quickFilterText', e.target.value));
document.querySelectorAll('#status-filter button').forEach((b) => b.addEventListener('click', () => {
  statusFilter = b.dataset.f;
  document.querySelectorAll('#status-filter button').forEach((x) => x.classList.toggle('on', x === b));
  ordersGrid.onFilterChanged();
}));
$('refresh').addEventListener('click', load);
$('csv').addEventListener('click', () => ordersGrid.exportDataAsCsv({ fileName: 'ladder-paypal-orders.csv', skipPinnedBottom: true,
  processCellCallback: (p) => p.column.getColId() === 'createdAt' ? p.value : p.formatValue ? p.formatValue(p.value) : p.value }));
load();
</script>
</body>
</html>`;
}
