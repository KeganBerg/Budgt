/* Budgt: a small, dependency-free budgeting app. All data lives in localStorage. */
(function () {
  'use strict';

  const STORE_KEY = 'budgt:v1';
  const DRAFT_KEY = 'budgt:draft';
  const DEFAULT_CATEGORIES = [
    ['Housing', 0], ['Groceries', 0], ['Dining', 0], ['Transport', 0],
    ['Utilities', 0], ['Health', 0], ['Entertainment', 0], ['Shopping', 0], ['Other', 0],
  ];
  const INCOME_CATEGORY = { id: 'income', name: 'Income' };
  const PALETTE = ['#3f7564', '#4f6f9a', '#c28a3a', '#80609a', '#b8574a', '#4d8a8c', '#7f8c45', '#a9627e', '#7b776e'];

  // ---------- state ----------
  let state = load();
  let viewMonth = monthKey(new Date());
  let txnFilter = { q: '', cat: '' };

  function blankState() {
    return {
      categories: DEFAULT_CATEGORIES.map(([name, budget]) => ({ id: uid(), name, budget })),
      transactions: [],
      liabilities: [],
      goals: [],
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.categories)) return Object.assign(blankState(), s);
      }
    } catch (e) { /* fall through to a fresh state */ }
    return blankState();
  }

  // Write state to localStorage. Returns false (and warns once) if the browser refuses.
  let saveWarned = false, persistAsked = false;
  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      if (localStorage.getItem(STORE_KEY) === null) throw new Error('not stored');
    } catch (e) {
      setSaveStatus('Not saved: this browser is blocking storage', true);
      if (!saveWarned) { saveWarned = true; alert('Budgt couldn\'t save your changes. Your browser may be in private mode or out of storage. Use Export backup in the sidebar so you don\'t lose anything.'); }
      return false;
    }
    setSaveStatus('All changes saved');
    // Ask the browser not to clear our storage when space runs low.
    if (!persistAsked && navigator.storage && navigator.storage.persist) { persistAsked = true; navigator.storage.persist().catch(() => {}); }
    return true;
  }

  function save() {
    persist();
    render();
  }

  function setSaveStatus(text, bad) {
    const el = document.getElementById('saveStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('neg', !!bad);
  }

  // ---------- helpers ----------
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function monthKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function todayISO() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseMonth(k) { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1); }
  function shiftMonth(k, n) { const d = parseMonth(k); d.setMonth(d.getMonth() + n); return monthKey(d); }
  function daysInMonth(k) { const d = parseMonth(k); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }
  function monthName(k, opts) { return parseMonth(k).toLocaleDateString(undefined, opts || { month: 'long', year: 'numeric' }); }
  function shortDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }

  const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
  const fmt0 = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function money(n) { return fmt.format(n || 0); }
  function money0(n) { return fmt0.format(n || 0); }
  function num(v) { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : NaN; }
  function round2(n) { return Math.round(n * 100) / 100; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function catById(id) { return id === 'income' ? INCOME_CATEGORY : state.categories.find(c => c.id === id) || { id: '', name: 'Uncategorized' }; }
  function catColor(id) { const i = state.categories.findIndex(c => c.id === id); return i < 0 ? '#94a3b8' : PALETTE[i % PALETTE.length]; }

  function txnsIn(k) { return state.transactions.filter(t => t.date.slice(0, 7) === k); }
  function sumBy(list, type) { return round2(list.filter(t => t.type === type).reduce((a, t) => a + t.amount, 0)); }
  function spentByCat(k) {
    const m = {};
    txnsIn(k).forEach(t => { if (t.type === 'expense') m[t.categoryId] = (m[t.categoryId] || 0) + t.amount; });
    return m;
  }
  function totalBudget() { return round2(state.categories.reduce((a, c) => a + (c.budget || 0), 0)); }

  // Average monthly net savings (income - spending) across the last 3 months before the current one that have any data.
  function avgMonthlySavings() {
    const cur = monthKey(new Date());
    const nets = [];
    for (let i = 1; i <= 6 && nets.length < 3; i++) {
      const list = txnsIn(shiftMonth(cur, -i));
      if (list.length) nets.push(sumBy(list, 'income') - sumBy(list, 'expense'));
    }
    if (!nets.length) {
      const list = txnsIn(cur);
      if (list.length) nets.push(sumBy(list, 'income') - sumBy(list, 'expense'));
    }
    return nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : 0;
  }

  // Months to pay off a balance at a given APR and monthly payment. Infinity if payment doesn't cover interest.
  function payoffMonths(balance, apr, payment) {
    if (balance <= 0) return 0;
    if (payment <= 0) return Infinity;
    const r = (apr || 0) / 100 / 12;
    if (r === 0) return Math.ceil(balance / payment);
    if (payment <= balance * r) return Infinity;
    return Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r));
  }
  function monthsFromNow(n) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n); return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); }
  function monthsUntil(iso) {
    const [y, m] = iso.split('-').map(Number);
    const now = new Date();
    return (y - now.getFullYear()) * 12 + (m - 1 - now.getMonth());
  }

  function paymentFor(liabilityId, k) { return state.transactions.find(t => t.liabilityId === liabilityId && t.date.slice(0, 7) === k); }

  // ---------- charts (plain SVG) ----------
  function cumulativeSeries(k, type) {
    const days = daysInMonth(k);
    const daily = new Array(days).fill(0);
    txnsIn(k).forEach(t => { if (t.type === (type || 'expense')) daily[Number(t.date.slice(8, 10)) - 1] += t.amount; });
    let run = 0;
    return daily.map(v => (run += v));
  }

  function niceStep(max, n) {
    const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }

  function lineChart(k, H, fs) {
    H = Math.max(200, H || 220);
    fs = fs || 11;
    const W = 600, P = { l: 46, r: 10, t: 14, b: 24 };
    const cur = cumulativeSeries(k);
    const prev = cumulativeSeries(shiftMonth(k, -1));
    const isCurrent = k === monthKey(new Date());
    const upTo = isCurrent ? new Date().getDate() : cur.length;
    const days = cur.length;
    const budget = totalBudget();
    const spentNow = cur[upTo - 1] || 0;
    const projected = isCurrent && upTo < days ? spentNow / upTo * days : 0;
    const inc = cumulativeSeries(k, 'income');
    const hasInc = inc[upTo - 1] > 0;
    const top = Math.max(1, spentNow, prev[prev.length - 1] || 0, budget, projected, hasInc ? inc[upTo - 1] : 0);
    const step = niceStep(top, H > 300 ? 5 : 4);
    const max = Math.ceil(top / step) * step;
    const x = (i, len) => P.l + (i / Math.max(1, len - 1)) * (W - P.l - P.r);
    const y = v => H - P.b - (v / max) * (H - P.t - P.b);
    const path = (arr, len) => arr.map((v, i) => (i ? 'L' : 'M') + x(i, len).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    let svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" style="--axis-fs:' + fs.toFixed(1) + 'px" role="img" aria-label="Cumulative spending and income this month, compared with last month">';
    for (let v = 0; v <= max + 0.001; v += step) {
      svg += '<line class="grid-line" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="axis" x="' + (P.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + esc(compact(v)) + '</text>';
    }
    if (budget > 0) svg += '<line class="budget-line" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(budget) + '" y2="' + y(budget) + '"/><text class="axis budget-label" x="' + (W - P.r) + '" y="' + (y(budget) - 6) + '" text-anchor="end">Budget ' + esc(money0(budget)) + '</text>';
    if (prev[prev.length - 1] > 0) svg += '<path class="line-prev" d="' + path(prev, prev.length) + '"/>';
    const curPts = cur.slice(0, upTo);
    if (hasInc) {
      // Shade the gap between income and spending: red where spending is ahead of income, dark where you're still in the black.
      const incPts = inc.slice(0, upTo);
      const segs = [];
      let seg = null;
      for (let i = 0; i < upTo; i++) {
        const d = incPts[i] - curPts[i], sign = d >= 0;
        if (seg && seg.sign !== sign) {
          const d0 = incPts[i - 1] - curPts[i - 1], t = d0 / (d0 - d);
          const xi = i - 1 + t, vi = curPts[i - 1] + (curPts[i] - curPts[i - 1]) * t;
          seg.pts.push([xi, vi, vi]); segs.push(seg); seg = { sign, pts: [[xi, vi, vi]] };
        }
        if (!seg) seg = { sign, pts: [] };
        seg.pts.push([i, incPts[i], curPts[i]]);
      }
      if (seg) segs.push(seg);
      segs.forEach(g => {
        if (g.pts.length < 2) return;
        const top = g.pts.map((p, j) => (j ? 'L' : 'M') + x(p[0], days).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
        const bot = g.pts.slice().reverse().map(p => 'L' + x(p[0], days).toFixed(1) + ' ' + y(p[2]).toFixed(1)).join(' ');
        svg += '<path class="gap-' + (g.sign ? 'pos' : 'neg') + '" d="' + top + ' ' + bot + ' Z"/>';
      });
      svg += '<path class="line-income" d="' + path(incPts, days) + '"/>';
    }
    svg += '<path class="line-cur line-spend" d="' + path(curPts, days) + '"/>';
    if (projected) svg += '<path class="line-proj" d="M' + x(upTo - 1, days) + ' ' + y(spentNow) + ' L' + x(days - 1, days) + ' ' + y(projected) + '"/><text class="axis proj-label" x="' + (W - P.r) + '" y="' + (y(projected) + (y(projected) < P.t + 16 ? 14 : -6)) + '" text-anchor="end">On pace for ' + esc(money0(projected)) + '</text>';
    svg += '<circle class="line-dot line-spend-dot" cx="' + x(upTo - 1, days) + '" cy="' + y(spentNow) + '" r="4.5"/>';
    if (hasInc) {
      const net = inc[upTo - 1] - spentNow;
      svg += '<text class="axis net-label ' + (net < 0 ? 'neg' : '') + '" x="' + (P.l + 10) + '" y="' + (P.t + 12) + '">Net so far ' + (net < 0 ? '−' : '+') + esc(money0(Math.abs(net))) + '</text>';
    }
    (fs > 16 ? [1, 15, days] : [1, 8, 15, 22, days]).forEach(d => { svg += '<text class="axis" x="' + x(d - 1, days) + '" y="' + (H - 6) + '" text-anchor="' + (d === 1 ? 'start' : d === days ? 'end' : 'middle') + '">' + esc(monthName(k, { month: 'short' })) + ' ' + d + '</text>'; });
    return svg + '</svg>';
  }
  function compact(v) { return v >= 1000 ? '$' + (v / 1000).toFixed(v % 1000 ? 1 : 0).replace(/\.0$/, '') + 'k' : '$' + Math.round(v); }

  function spendingSummary(k) {
    const cur = cumulativeSeries(k);
    const isCurrent = k === monthKey(new Date());
    const upTo = isCurrent ? new Date().getDate() : cur.length;
    const spent = cur[upTo - 1] || 0;
    const prev = cumulativeSeries(shiftMonth(k, -1));
    const prevSame = prev[Math.min(upTo, prev.length) - 1] || 0;
    const budget = totalBudget();
    const daysLeft = cur.length - upTo;
    const items = [
      ['Spent so far', money0(spent), ''],
      ['Last month', money0(prevSame), spent > prevSame ? 'neg' : 'pos', 'What you had spent by day ' + upTo + ' last month'],
      ['Daily average', money0(spent / Math.max(1, upTo)), ''],
      isCurrent && daysLeft > 0
        ? (budget ? ['Safe per day', money0(Math.max(0, (budget - spent) / daysLeft)), budget - spent < 0 ? 'neg' : 'pos'] : ['Projected month-end', money0(spent / upTo * cur.length), ''])
        : ['vs budget', budget ? (spent > budget ? money0(spent - budget) + ' over' : money0(budget - spent) + ' under') : '—', budget && spent > budget ? 'neg' : 'pos'],
    ];
    return '<div class="chart-stats">' + items.map(([l, v, t, tip]) => '<div' + (tip ? ' title="' + esc(tip) + '"' : '') + '><span>' + esc(l) + '</span><b class="' + t + '">' + esc(v) + '</b></div>').join('') + '</div>';
  }

  // Grow the spending chart to fill its card when the card beside it is taller.
  function fitSpendingChart() {
    const wrap = document.querySelector('#view-dashboard .chart-fill');
    if (!wrap) return;
    const svg = wrap.querySelector('svg');
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !svg) return;
    // Keep the chart at least 240px tall on screen and its labels about 11px, however wide the card is.
    const scale = 600 / w;
    const target = Math.min(900, Math.max(Math.round(h * scale), Math.round(240 * scale)));
    const fs = 11 * scale;
    const current = svg.viewBox.baseVal.height;
    if (Math.abs(target - current) > 6 || Math.abs(fs - 11) > 0.5) wrap.innerHTML = lineChart(viewMonth, target, fs);
  }
  let fitTimer;
  window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => { if (currentView() === 'dashboard') renderDashboard(); }, 150); });

  function barChart(endK) {
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(shiftMonth(endK, -i));
    const data = months.map(k => { const l = txnsIn(k); return { k, inc: sumBy(l, 'income'), exp: sumBy(l, 'expense') }; });
    const W = 600, H = 200, P = { l: 8, r: 8, t: 12, b: 22 };
    const max = Math.max(1, ...data.map(d => Math.max(d.inc, d.exp)));
    const gw = (W - P.l - P.r) / data.length, bw = Math.min(26, gw / 3.2);
    const y = v => H - P.b - (v / max) * (H - P.t - P.b);
    let svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Income and spending over the last six months">';
    data.forEach((d, i) => {
      const cx = P.l + gw * i + gw / 2;
      const sel = d.k === endK ? ' sel' : '';
      svg += '<rect class="bar-inc' + sel + '" x="' + (cx - bw - 2) + '" y="' + y(d.inc) + '" width="' + bw + '" height="' + (y(0) - y(d.inc)) + '" rx="4"><title>Income ' + esc(money(d.inc)) + '</title></rect>';
      svg += '<rect class="bar-exp' + sel + '" x="' + (cx + 2) + '" y="' + y(d.exp) + '" width="' + bw + '" height="' + (y(0) - y(d.exp)) + '" rx="4"><title>Spending ' + esc(money(d.exp)) + '</title></rect>';
      svg += '<text class="axis" x="' + cx + '" y="' + (H - 5) + '" text-anchor="middle">' + esc(monthName(d.k, { month: 'short' })) + '</text>';
    });
    return svg + '</svg>';
  }

  function donut(pct, color) {
    const r = 16, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct));
    return '<svg class="ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="' + r + '" class="ring-bg"/><circle cx="20" cy="20" r="' + r + '" class="ring-fg" style="stroke:' + color + '" stroke-dasharray="' + (c * p).toFixed(2) + ' ' + c.toFixed(2) + '" transform="rotate(-90 20 20)"/></svg>';
  }

  // ---------- views ----------
  const $ = sel => document.querySelector(sel);
  const views = ['dashboard', 'transactions', 'budget', 'liabilities', 'goals'];
  const titles = { dashboard: 'Dashboard', transactions: 'Transactions', budget: 'Budget', liabilities: 'Bills & debt', goals: 'Savings goals' };

  function currentView() { const v = location.hash.slice(1).split('/')[0]; return views.includes(v) ? v : 'dashboard'; }
  function subView() { return location.hash.slice(1).split('/')[1] || ''; }

  function render() {
    const v = currentView();
    views.forEach(n => { $('#view-' + n).hidden = n !== v; });
    document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.view === v));
    $('#viewTitle').textContent = titles[v];
    $('#monthLabel').textContent = monthName(viewMonth);
    $('.month-picker').style.visibility = (v === 'goals' || v === 'liabilities') ? 'hidden' : '';
    ({ dashboard: renderDashboard, transactions: renderTransactions, budget: renderBudget, liabilities: renderLiabilities, goals: renderGoals })[v]();
  }

  function emptyCard(title, text, actions) {
    return '<div class="card empty"><h3>' + title + '</h3><p>' + text + '</p><div class="row-actions">' + actions + '</div></div>';
  }

  function renderDashboard() {
    const el = $('#view-dashboard');
    if (!state.transactions.length && !state.liabilities.length && !state.goals.length) {
      el.innerHTML = emptyCard('Welcome to Budgt',
        'Start by adding a transaction, setting your monthly budget, or listing your bills and debts. Want to look around first? Load some sample data and clear it whenever you like.',
        '<button class="btn" data-act="add-txn">Add a transaction</button><a class="btn btn-ghost" href="#budget">Set a budget</a><button class="btn btn-ghost" data-act="sample">Load sample data</button>');
      return;
    }
    const list = txnsIn(viewMonth);
    const income = sumBy(list, 'income');
    const spent = sumBy(list, 'expense');
    const budget = totalBudget();
    const prevList = txnsIn(shiftMonth(viewMonth, -1));
    const isCurrent = viewMonth === monthKey(new Date());
    const day = isCurrent ? new Date().getDate() : daysInMonth(viewMonth);
    const prevToDate = round2(prevList.filter(t => t.type === 'expense' && Number(t.date.slice(8, 10)) <= day).reduce((a, t) => a + t.amount, 0));
    const diff = spent - prevToDate;
    const debt = round2(state.liabilities.filter(l => l.type === 'debt').reduce((a, l) => a + (l.balance || 0), 0));
    const left = budget - spent;

    let html = '<div class="stats">';
    html += statCard('Left to spend', budget ? money(left) : '—', budget ? (left >= 0 ? 'of ' + money0(budget) + ' budget' : money0(-left) + ' over budget') : '<a href="#budget">Set a budget</a>', left < 0 ? 'neg' : '');
    html += statCard('Spent', money(spent), (diff <= 0 ? money0(-diff) + ' less' : money0(diff) + ' more') + ' than last month so far', diff > 0 ? 'neg' : 'pos');
    html += statCard('Income', money(income), 'Net ' + (income - spent >= 0 ? '+' : '−') + money0(Math.abs(income - spent)) + ' this month', income - spent >= 0 ? 'pos' : 'neg');
    html += statCard('Total debt', money(debt), state.liabilities.filter(l => l.type === 'debt').length + ' accounts', '');
    html += '</div>';
    html += strainBanner();

    html += '<div class="grid">';
    html += '<div class="card span-2 card-fill"><div class="card-head"><h3>Spending this month</h3><div class="legend"><span class="lg lg-spend">Spending</span><span class="lg lg-incline">Income</span><span class="lg lg-prev">' + esc(monthName(shiftMonth(viewMonth, -1), { month: 'short' })) + '</span>' + (viewMonth === monthKey(new Date()) ? '<span class="lg lg-proj">Pace</span>' : '') + '</div></div>' + spendingSummary(viewMonth) + '<div class="chart-fill">' + lineChart(viewMonth) + '</div></div>';

    html += '<div class="card"><div class="card-head"><h3>Upcoming bills</h3><a href="#liabilities" class="small-link">Manage</a></div>' + upcomingBills() + '</div>';

    html += '<div class="card"><div class="card-head"><h3>Top spending</h3><a href="#transactions" class="small-link">Details</a></div>' + topSpending(viewMonth) + '</div>';

    html += '<div class="card span-2"><div class="card-head"><h3>Ways to cut back' + info('Only Flexible categories get tips. Housing, groceries, transport and other essentials are left out. Change which categories are essential on the Budget page.') + '</h3></div>' + cutBackTips(viewMonth) + '</div>';

    html += '<div class="card span-2"><div class="card-head"><h3>Income vs spending</h3><div class="legend"><span class="lg lg-inc">Income</span><span class="lg lg-exp">Spending</span></div></div>' + barChart(viewMonth) + '</div>';

    html += '<div class="card card-fill"><div class="card-head"><h3>Savings outlook</h3><a href="#goals" class="small-link">Goals</a></div>' + goalsOutlook(true) + (state.goals.length <= 2 ? savingsSnapshot(viewMonth) : '') + '</div>';

    html += '<div class="card span-2 card-fill"><div class="card-head"><h3>Budget by category' + info('Bubble size is what you spent. The dashed ring is the budget, so a bubble spilling past its ring is over. Drag bubbles around, or click one to see its purchases.') + '</h3><a href="#budget" class="small-link">Edit budget</a></div>' + bubbleChart(viewMonth) + '</div>';

    html += '<div class="card"><div class="card-head"><h3>Recent transactions</h3><a href="#transactions" class="small-link">See all</a></div>' + txnList(list.slice().sort(byDateDesc).slice(0, 6), true) + '</div>';
    html += '</div>';
    el.innerHTML = html;
    fitSpendingChart();
    startBubbles();
  }

  // Small (i) marker: extra context lives in a hover/tap tooltip instead of a line of hint text.
  function info(text) { return '<span class="info" tabindex="0" role="note" aria-label="' + esc(text) + '" data-tip="' + esc(text) + '">i</span>'; }
  function statCard(label, value, sub, tone, note) {
    return '<div class="card stat"><p class="stat-label">' + label + (note ? info(note) : '') + '</p><p class="stat-value' + (!sub && tone ? ' ' + tone : '') + '">' + value + '</p>' + (sub ? '<p class="stat-sub ' + (tone || '') + '">' + sub + '</p>' : '') + '</div>';
  }

  function upcomingBills() {
    if (!state.liabilities.length) return '<p class="muted">No bills yet. <a href="#liabilities">Add your rent, subscriptions or loan payments.</a></p>';
    const k = viewMonth;
    const days = daysInMonth(k);
    const rows = state.liabilities.slice().sort((a, b) => (a.dueDay || 1) - (b.dueDay || 1)).map(l => {
      const paid = paymentFor(l.id, k);
      const d = Math.min(l.dueDay || 1, days);
      return '<li class="bill' + (paid ? ' paid' : '') + '"><span class="bill-date"><b>' + d + '</b>' + esc(monthName(k, { month: 'short' })) + '</span><span class="bill-name"><b>' + esc(l.name) + '</b><small>' + money(l.payment) + ' · ' + (l.type === 'debt' ? 'Debt payment' : 'Bill') + '</small></span>' +
        (paid ? '<button class="chip chip-done" data-act="unpay" data-id="' + l.id + '" title="Undo">Paid</button>' : '<button class="chip" data-act="pay" data-id="' + l.id + '">Mark paid</button>') + '</li>';
    });
    const total = state.liabilities.reduce((a, l) => a + (l.payment || 0), 0);
    const paidTotal = state.liabilities.reduce((a, l) => a + (paymentFor(l.id, k) ? l.payment || 0 : 0), 0);
    return '<p class="muted small">' + money0(paidTotal) + ' of ' + money0(total) + ' paid this month</p><ul class="bills">' + rows.join('') + '</ul>';
  }

  // ---------- top spending and cut-back tips ----------
  const ESSENTIAL_RE = /hous|rent|mortgage|transport|gas\b|fuel|car\b|auto|grocer|util|electric|water|phone|internet|health|medical|pharm|insur|child|daycare|debt|loan|tuition/i;
  function isEssential(c) { return typeof c.essential === 'boolean' ? c.essential : ESSENTIAL_RE.test(c.name); }

  function catStats(k, catId) {
    const list = txnsIn(k).filter(t => t.type === 'expense' && t.categoryId === catId);
    const total = round2(list.reduce((a, t) => a + t.amount, 0));
    const byMerchant = {};
    list.forEach(t => { const m = (t.merchant || '').trim(); if (m) byMerchant[m] = (byMerchant[m] || 0) + t.amount; });
    const top = Object.keys(byMerchant).sort((a, b) => byMerchant[b] - byMerchant[a])[0];
    const prev = round2(txnsIn(shiftMonth(k, -1)).filter(t => t.type === 'expense' && t.categoryId === catId).reduce((a, t) => a + t.amount, 0));
    return { count: list.length, total, avg: list.length ? total / list.length : 0, prev, topMerchant: top, topMerchantAmt: top ? byMerchant[top] : 0 };
  }

  function topSpending(k) {
    const spent = spentByCat(k);
    const total = Object.values(spent).reduce((a, b) => a + b, 0);
    const rows = Object.keys(spent).filter(id => spent[id] > 0).sort((a, b) => spent[b] - spent[a]).slice(0, 5);
    if (!rows.length) return '<p class="muted">No spending logged this month yet.</p>';
    const max = spent[rows[0]];
    return '<ol class="topcats">' + rows.map((id, i) => {
      const c = catById(id);
      const st = catStats(k, id);
      const diff = round2(st.total - st.prev);
      const trend = st.prev ? (diff > 0 ? '<span class="neg">▲ ' + money0(diff) + '</span>' : diff < 0 ? '<span class="pos">▼ ' + money0(-diff) + '</span>' : '<span class="muted">Same</span>') + ' vs last month' : '<span class="muted">New this month</span>';
      return '<li><span class="tc-rank">' + (i + 1) + '</span><div class="tc-body"><div class="tc-line"><button type="button" class="tc-name spent-link" data-act="view-cat" data-id="' + id + '" title="See these transactions">' + esc(c.name) + '</button><b class="tc-amt">' + money0(spent[id]) + '</b></div>' +
        '<span class="tc-bar"><i style="width:' + (spent[id] / max * 100).toFixed(1) + '%;background:' + catColor(id) + '"></i></span>' +
        '<small class="muted">' + Math.round(spent[id] / total * 100) + '% of spending · ' + trend + '</small></div></li>';
    }).join('') + '</ol>';
  }

  // Tip templates matched by category name. Each returns { headline, save, ideas }.
  const TIP_RULES = [
    { re: /dining|restaurant|eat|food|takeout|coffee|cafe|bar/i, build: (c, st) => {
      const skip = Math.max(1, Math.ceil(st.count / 3));
      return {
        headline: 'You ate out ' + st.count + ' time' + (st.count === 1 ? '' : 's') + ' for ' + money0(st.total) + ' (about ' + money0(st.avg) + ' each). Swapping ' + skip + ' of those for a meal at home saves roughly ' + money0(skip * st.avg * 0.7) + '.',
        save: skip * st.avg * 0.7,
        ideas: ['Plan 3 or 4 dinners on the weekend so weeknights are easy', 'Pack lunch on workdays, even just twice a week', 'Make coffee at home and keep café trips as a treat', st.topMerchant ? 'Most went to ' + st.topMerchant + ' (' + money0(st.topMerchantAmt) + '). Set yourself a limit there first.' : 'Pick one "eat out" night a week and stick to it'],
      };
    } },
    { re: /entertain|stream|subscri|fun|hobb|game|movie|music/i, build: (c, st) => {
      const subs = state.liabilities.filter(l => l.type !== 'debt' && l.categoryId === c.id);
      const subTotal = subs.reduce((a, l) => a + l.payment, 0);
      return {
        headline: 'Entertainment cost ' + money0(st.total) + ' this month' + (subs.length ? ', including ' + subs.length + ' subscription' + (subs.length === 1 ? '' : 's') + ' (' + money0(subTotal) + '/mo)' : '') + '. Cutting it by a quarter saves about ' + money0(st.total * 0.25) + '.',
        save: st.total * 0.25,
        ideas: [subs.length ? 'Review ' + subs.map(l => l.name).join(', ') + '. Cancel anything you haven\'t used in a month.' : 'List every subscription you pay for and cancel the ones you forgot about', 'Rotate streaming services: keep one at a time', 'Look for free local events, library passes and park days'],
      };
    } },
    { re: /shop|cloth|amazon|retail|online|gift|beauty/i, build: (c, st) => ({
      headline: 'Shopping came to ' + money0(st.total) + ' across ' + st.count + ' purchase' + (st.count === 1 ? '' : 's') + '. Waiting before you buy usually trims a fifth of that, about ' + money0(st.total * 0.2) + '.',
      save: st.total * 0.2,
      ideas: ['Use a 48-hour rule: leave it in the cart and decide later', 'Unsubscribe from store emails and turn off sale notifications', 'Make a list before you go and buy only what is on it'],
    }) },
    { re: /travel|vacation|trip/i, build: (c, st) => ({
      headline: 'Travel cost ' + money0(st.total) + '. Booking earlier and travelling off-peak often cuts 15%, about ' + money0(st.total * 0.15) + '.',
      save: st.total * 0.15,
      ideas: ['Set up fare alerts instead of booking last minute', 'Put trips on a savings goal so they don\'t hit one month'],
    }) },
  ];

  function cutBackTips(k) {
    const spent = spentByCat(k);
    const flex = state.categories.filter(c => !isEssential(c) && (spent[c.id] || 0) > 0).sort((a, b) => spent[b.id] - spent[a.id]).slice(0, 3);
    if (!flex.length) {
      return state.transactions.length
        ? '<p class="muted">No flexible spending this month. Nice work. Mark which categories are essentials on the <a href="#budget">Budget</a> page.</p>'
        : '<p class="muted">Tips show up here once you log some spending.</p>';
    }
    let totalSave = 0;
    const cards = flex.map(c => {
      const st = catStats(k, c.id);
      const rule = TIP_RULES.find(r => r.re.test(c.name));
      const tip = rule ? rule.build(c, st) : {
        headline: c.name + ' came to ' + money0(st.total) + '. Trimming it by 15% frees up about ' + money0(st.total * 0.15) + '.',
        save: st.total * 0.15,
        ideas: ['Check the last few ' + c.name + ' purchases and flag the ones you wouldn\'t buy again', 'Give it a monthly limit on the Budget page so you see it filling up'],
      };
      if (c.budget && st.total > c.budget) tip.ideas.unshift('You\'re ' + money0(st.total - c.budget) + ' over your ' + money0(c.budget) + ' budget here.');
      totalSave += tip.save;
      return '<li class="tip"><div class="tip-head"><span class="dot" style="background:' + catColor(c.id) + '"></span><b>' + esc(c.name) + '</b><span class="tip-save">Save ~' + money0(tip.save) + '/mo</span></div><p>' + esc(tip.headline) + '</p><ul class="tip-ideas">' + tip.ideas.slice(0, 2).map(i => '<li>' + esc(i) + '</li>').join('') + '</ul></li>';
    });
    const goal = state.goals.find(g => g.saved < g.target);
    const lead = '<p class="tip-lead">Cutting back here could free up about <b>' + money0(totalSave) + ' a month</b>' + (goal ? ' for your ' + esc(goal.name) : '') + '.</p>';
    return lead + '<ul class="tips">' + cards.join('') + '</ul>';
  }

  function categoryBars(k, limit) {
    const spent = spentByCat(k);
    let cats = state.categories.map(c => ({ c, s: spent[c.id] || 0 })).filter(x => x.c.budget > 0 || x.s > 0);
    cats.sort((a, b) => b.s - a.s);
    if (limit) cats = cats.slice(0, limit);
    if (!cats.length) return '<p class="muted">Set monthly limits on the <a href="#budget">Budget</a> page to track them here.</p>';
    return '<ul class="catbars">' + cats.map(({ c, s }) => {
      const pct = c.budget ? s / c.budget : (s ? 1 : 0);
      const over = c.budget && s > c.budget;
      return '<li><span class="dot" style="background:' + catColor(c.id) + '"></span><button type="button" class="cb-name spent-link" data-act="view-cat" data-id="' + c.id + '" title="See these transactions">' + esc(c.name) + '</button><span class="cb-bar"><i style="width:' + Math.min(100, pct * 100).toFixed(1) + '%;background:' + (over ? 'var(--neg)' : catColor(c.id)) + '"></i></span><span class="cb-amt' + (over ? ' neg' : '') + '">' + money0(s) + (c.budget ? '<small> / ' + money0(c.budget) + '</small>' : '') + '</span></li>';
    }).join('') + '</ul>';
  }

  // ---------- budget bubbles ----------
  // Each category is a bubble whose area is what was spent this month. A dashed ring shows the budget,
  // so a bubble spilling past its ring is over budget. Bubbles settle with a small physics loop and can be dragged.
  let bubbleData = null, bubbleRaf = 0;
  function bubbleChart(k) {
    const spent = spentByCat(k);
    const cats = state.categories.map(c => ({ c, s: spent[c.id] || 0 })).filter(x => x.c.budget > 0 || x.s > 0).sort((a, b) => b.s - a.s);
    if (!cats.length) { bubbleData = null; return '<p class="muted">Set monthly limits on the <a href="#budget">Budget</a> page to track them here.</p>'; }
    const live = cats.filter(x => x.s > 0), idle = cats.filter(x => !(x.s > 0));
    bubbleData = live;
    return '<div class="bubbles"><div class="bubble-stage" id="bubbleStage" role="img" aria-label="Spending by category as bubbles, largest first: ' + esc(live.map(x => x.c.name + ' ' + money0(x.s)).join(', ')) + '">' +
      (live.length ? '<svg id="bubbleSvg"></svg><div class="bubble-tip" id="bubbleTip" hidden></div>' : '<p class="muted">No spending yet this month.</p>') + '</div>' +
      '<div class="bubble-side"><ol class="bubble-rank">' + live.map((x, i) => {
        const over = x.c.budget > 0 && x.s > x.c.budget;
        return '<li data-bid="' + x.c.id + '"><button type="button" data-act="view-cat" data-id="' + x.c.id + '"><span class="dot" style="background:' + catColor(x.c.id) + '"></span><span class="br-name">' + esc(x.c.name) + '</span><span class="br-amt' + (over ? ' neg' : '') + '">' + money0(x.s) + (x.c.budget ? '<small> / ' + money0(x.c.budget) + '</small>' : '') + '</span></button></li>';
      }).join('') + '</ol>' +
      (idle.length ? '<p class="muted small bubble-idle">Nothing spent yet: ' + esc(idle.map(x => x.c.name).join(', ')) + '</p>' : '') +
      '</div></div>';
  }

  function startBubbles() {
    cancelAnimationFrame(bubbleRaf);
    const stage = document.getElementById('bubbleStage'), svg = document.getElementById('bubbleSvg'), tip = document.getElementById('bubbleTip');
    if (!stage || !svg || !bubbleData || !bubbleData.length) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    const total = bubbleData.reduce((a, x) => a + Math.max(x.s, x.c.budget || 0), 0);
    // Scale so the bubbles (or their budget rings, whichever is bigger) cover about half the stage.
    let k = Math.sqrt(0.34 * W * H / (Math.PI * total));
    const biggest = Math.max(...bubbleData.map(x => Math.max(x.s, x.c.budget || 0)));
    k = Math.min(k, (Math.min(W, H) / 2 - 6) / Math.sqrt(biggest));
    const cx = W / 2, cy = H / 2;
    const nodes = bubbleData.map((x, i) => {
      const a = i * 2.4, d = 12 * Math.sqrt(i);
      return { id: x.c.id, name: x.c.name, s: x.s, budget: x.c.budget || 0, color: catColor(x.c.id), r: Math.max(6, Math.sqrt(x.s) * k), rb: x.c.budget ? Math.sqrt(x.c.budget) * k : 0,
        x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, vx: 0, vy: 0 };
    });
    const reach = n => Math.max(n.r, n.rb);
    // Settle the layout off-screen first, then scale the whole cluster up so it fills the stage edge to edge.
    for (let it = 0; it < 500; it++) {
      for (const n of nodes) { n.x += (cx - n.x) * 0.01; n.y += (cy - n.y) * Math.min(0.5, 0.01 * Math.pow(W / H, 2)); }
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const A = nodes[i], B = nodes[j];
        let dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 0.01;
        const min = reach(A) + reach(B) + 3;
        if (d < min) { const push = (min - d) / d * 0.5; A.x -= dx * push; A.y -= dy * push; B.x += dx * push; B.y += dy * push; }
      }
    }
    {
      const x0 = Math.min(...nodes.map(n => n.x - reach(n))), x1 = Math.max(...nodes.map(n => n.x + reach(n)));
      const y0 = Math.min(...nodes.map(n => n.y - reach(n))), y1 = Math.max(...nodes.map(n => n.y + reach(n)));
      const pad = 10, f = Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0));
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      nodes.forEach(n => { n.x = cx + (n.x - mx) * f; n.y = cy + (n.y - my) * f; n.r *= f; n.rb *= f; });
    }
    svg.innerHTML = nodes.map((n, i) => {
      const over = n.budget && n.s > n.budget;
      const label = n.r >= 30;
      return '<g class="bubble' + (over ? ' over' : '') + '" data-i="' + i + '" tabindex="0" role="button" aria-label="' + esc(n.name + ', ' + money0(n.s) + (n.budget ? ' of ' + money0(n.budget) : '')) + '">' +
        (n.rb ? '<circle class="b-ring" r="' + n.rb.toFixed(1) + '"/>' : '') +
        '<circle class="b-fill" r="' + n.r.toFixed(1) + '" style="--c:' + n.color + '"/>' +
        (label ? '<text class="b-name" y="-4" style="font-size:' + Math.min(15, n.r / 3.6).toFixed(1) + 'px">' + esc(n.name.length > 12 && n.r < 50 ? n.name.slice(0, 11) + '…' : n.name) + '</text><text class="b-amt" y="' + (Math.min(15, n.r / 3.6) + 2).toFixed(1) + '" style="font-size:' + Math.min(14, n.r / 4).toFixed(1) + 'px">' + money0(n.s) + '</text>' : '') + '</g>';
    }).join('');
    const els = Array.from(svg.querySelectorAll('.bubble'));
    let drag = null, heat = 1;
    const tick = () => {
      for (const n of nodes) {
        if (n === (drag && drag.n)) continue;
        n.vx += (cx - n.x) * 0.004; n.vy += (cy - n.y) * 0.004 * (W / H);
      }
      for (let pass = 0; pass < 3; pass++) for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
        const min = reach(a) + reach(b) + 3;
        if (d < min) {
          const push = (min - d) / d * 0.5; dx *= push; dy *= push;
          const fa = drag && drag.n === a ? 0 : 1, fb = drag && drag.n === b ? 0 : 1, t = fa + fb || 1;
          a.x -= dx * fa / t * 2 * 0.5; a.y -= dy * fa / t * 2 * 0.5; b.x += dx * fb / t * 2 * 0.5; b.y += dy * fb / t * 2 * 0.5;
        }
      }
      let energy = 0;
      for (const n of nodes) {
        if (n === (drag && drag.n)) continue;
        n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy;
        const m = reach(n) + 2;
        n.x = Math.min(W - m, Math.max(m, n.x)); n.y = Math.min(H - m, Math.max(m, n.y));
        energy += n.vx * n.vx + n.vy * n.vy;
      }
      nodes.forEach((n, i) => els[i].setAttribute('transform', 'translate(' + n.x.toFixed(1) + ' ' + n.y.toFixed(1) + ')'));
      heat = drag ? 1 : heat * 0.995;
      if (drag || energy > 0.01 || heat > 0.3) bubbleRaf = requestAnimationFrame(tick);
    };
    const wake = () => { heat = 1; cancelAnimationFrame(bubbleRaf); bubbleRaf = requestAnimationFrame(tick); };
    const rank = document.querySelectorAll('.bubble-rank li');
    const show = (i, on) => {
      els.forEach((e, j) => e.classList.toggle('dim', on && j !== i));
      rank.forEach(li => li.classList.toggle('hot', on && li.dataset.bid === nodes[i].id));
      if (!on) { tip.hidden = true; return; }
      const n = nodes[i];
      const over = n.budget && n.s > n.budget;
      tip.innerHTML = '<b>' + esc(n.name) + '</b><span>' + money(n.s) + (n.budget ? ' of ' + money0(n.budget) : '') + '</span>' +
        (n.budget ? '<span class="' + (over ? 'neg' : 'pos') + '">' + (over ? money0(n.s - n.budget) + ' over budget' : money0(n.budget - n.s) + ' left') + '</span>' : '<span class="muted">No budget set</span>');
      tip.hidden = false;
      const tx = Math.min(W - 170, Math.max(4, n.x + reach(n) * 0.7)), ty = Math.max(4, n.y - reach(n) * 0.7 - 20);
      tip.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
    };
    const pt = e => { const r = svg.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };
    els.forEach((el, i) => {
      el.addEventListener('pointerenter', () => { if (!drag) show(i, true); });
      el.addEventListener('pointerleave', () => { if (!drag) show(i, false); });
      el.addEventListener('focus', () => show(i, true));
      el.addEventListener('blur', () => show(i, false));
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCategory(nodes[i].id); } });
      el.addEventListener('pointerdown', e => {
        const p = pt(e); drag = { n: nodes[i], dx: nodes[i].x - p.x, dy: nodes[i].y - p.y, moved: 0, i };
        el.setPointerCapture(e.pointerId); el.classList.add('grab'); wake();
      });
      el.addEventListener('pointermove', e => {
        if (!drag || drag.i !== i) return;
        const p = pt(e), n = drag.n, nx = p.x + drag.dx, ny = p.y + drag.dy;
        drag.moved += Math.hypot(nx - n.x, ny - n.y);
        const m = reach(n) + 2;
        n.x = Math.min(W - m, Math.max(m, nx)); n.y = Math.min(H - m, Math.max(m, ny)); n.vx = n.vy = 0;
        show(i, true);
      });
      const end = () => {
        if (!drag || drag.i !== i) return;
        const click = drag.moved < 4;
        drag = null; el.classList.remove('grab'); wake();
        if (click) openCategory(nodes[i].id);
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', () => { drag = null; el.classList.remove('grab'); wake(); });
    });
    rank.forEach(li => {
      const i = nodes.findIndex(n => n.id === li.dataset.bid);
      li.addEventListener('pointerenter', () => show(i, true));
      li.addEventListener('pointerleave', () => show(i, false));
    });
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { for (let s = 0; s < 400; s++) { heat = 1; tick(); cancelAnimationFrame(bubbleRaf); } }
    else bubbleRaf = requestAnimationFrame(tick);
  }
  function openCategory(id) { txnFilter = { q: '', cat: id }; location.hash = '#transactions'; window.scrollTo(0, 0); }

  // Fills the savings card when there are only a goal or two: 6-month net savings, savings rate, and the next safety-net milestone.
  function savingsSnapshot(k) {
    const months = [];
    for (let i = 5; i >= 0; i--) { const m = shiftMonth(k, -i), l = txnsIn(m); months.push({ m, has: l.length > 0, inc: sumBy(l, 'income'), net: sumBy(l, 'income') - sumBy(l, 'expense') }); }
    const used = months.filter(x => x.has);
    if (!used.length) return '';
    const max = Math.max(1, ...used.map(x => Math.abs(x.net)));
    const incSum = used.reduce((a, x) => a + x.inc, 0), netSum = used.reduce((a, x) => a + x.net, 0);
    const rate = incSum > 0 ? netSum / incSum : 0;
    const cur = months[5];
    const bars = months.map(x => {
      const h = x.has ? Math.max(3, Math.abs(x.net) / max * 100) : 0;
      return '<div class="ss-col" title="' + esc(monthName(x.m, { month: 'long' })) + ': ' + (x.has ? (x.net >= 0 ? 'saved ' : 'overspent ') + money0(Math.abs(x.net)) : 'no data') + '"><div class="ss-half up">' + (x.has && x.net >= 0 ? '<i style="height:' + h.toFixed(0) + '%"></i>' : '') + '</div><div class="ss-half down">' + (x.has && x.net < 0 ? '<i style="height:' + h.toFixed(0) + '%"></i>' : '') + '</div><span>' + esc(monthName(x.m, { month: 'short' })) + '</span></div>';
    }).join('');
    // Safety-net milestones (Vanguard): a $2,000 starter cushion, then 3 months of essential costs.
    const saved = state.goals.reduce((a, g) => a + g.saved, 0);
    const { avg } = catAverages();
    const needs = state.categories.filter(isEssential).reduce((a, c) => a + (avg[c.id] || c.budget || 0), 0);
    const cushion = Math.max(2000, Math.round(needs * 3 / 50) * 50);
    const target = saved < 2000 ? 2000 : cushion;
    const label = saved < 2000 ? '$2,000 starter cushion' : '3 months of essentials';
    const done = saved >= cushion;
    const anyNeg = used.some(x => x.net < 0);
    return '<div class="savings-snap' + (anyNeg ? '' : ' no-neg') + '"><div class="ss-stats"><div><span>' + (cur.has ? 'Net this month' : 'Avg net per month') + '</span><b class="' + ((cur.has ? cur.net : netSum / used.length) >= 0 ? 'pos' : 'neg') + '">' + ((cur.has ? cur.net : netSum / used.length) < 0 ? '−' : '+') + money0(Math.abs(cur.has ? cur.net : netSum / used.length)) + '</b></div>' +
      '<div><span>Savings rate</span><b class="' + (rate >= 0 ? '' : 'neg') + '">' + Math.round(rate * 100) + '%</b><small>of income, last ' + used.length + ' mo</small></div></div>' +
      '<div class="ss-chart" aria-hidden="true">' + bars + '</div>' +
      '<div class="ss-mile"><div class="ss-mile-top"><span>' + (done ? '3-month safety net reached' : 'Next: ' + label) + '</span><b>' + money0(Math.min(saved, target)) + ' / ' + money0(target) + '</b></div><div class="ss-track"><i style="width:' + Math.min(100, saved / target * 100).toFixed(1) + '%"></i></div>' +
      (done ? '' : '<small class="muted">' + money0(target - saved) + ' to go' + (netSum / used.length > 0 ? ', about ' + Math.max(1, Math.ceil((target - saved) / (netSum / used.length))) + ' months at your usual pace' : '') + '</small>') + '</div></div>';
  }

  function goalsOutlook(compact) {
    if (!state.goals.length) return '<p class="muted">No goals yet. <a href="#goals">Add a savings goal</a> to see when you\'ll reach it.</p>';
    const avg = avgMonthlySavings();
    return '<ul class="goals' + (compact ? ' compact' : '') + '">' + state.goals.map(g => {
      const o = goalOutlook(g, avg);
      return '<li>' + donut(g.saved / g.target, o.color) + '<div class="goal-text"><b>' + esc(g.name) + '</b><span>' + money0(g.saved) + ' of ' + money0(g.target) + '</span><span class="' + o.tone + '">' + o.text + '</span></div></li>';
    }).join('') + '</ul>';
  }

  function goalOutlook(g, avg) {
    const remaining = Math.max(0, g.target - g.saved);
    if (remaining <= 0) return { text: 'Goal reached', tone: 'pos', color: 'var(--pos)' };
    const pace = g.monthly > 0 ? g.monthly : avg;
    const paceLabel = g.monthly > 0 ? 'at ' + money0(g.monthly) + '/mo' : 'at your recent savings rate';
    if (pace <= 0) return { text: g.monthly > 0 ? '' : 'Not saving yet. Set a monthly amount.', tone: 'neg', color: 'var(--neg)' };
    const months = Math.ceil(remaining / pace);
    if (g.date) {
      const left = Math.max(1, monthsUntil(g.date));
      const need = remaining / left;
      if (months <= left) return { text: 'On track for ' + esc(monthsFromNow(months)) + ' ' + paceLabel, tone: 'pos', color: 'var(--pos)' };
      return { text: 'Behind: need ' + money0(need) + '/mo to hit ' + esc(shortMonth(g.date)), tone: 'warn', color: 'var(--warn)' };
    }
    return { text: 'Reach it by ' + esc(monthsFromNow(months)) + ' ' + paceLabel, tone: 'muted', color: 'var(--brand)' };
  }
  function shortMonth(iso) { const [y, m] = iso.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); }

  function byDateDesc(a, b) { return b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0); }

  function txnList(list, compact) {
    if (!list.length) return '<p class="muted">No transactions this month.</p>';
    return '<ul class="txns' + (compact ? ' compact' : '') + '">' + list.map(t => {
      const c = catById(t.categoryId);
      const items = t.items && t.items.length ? '<span class="badge">' + t.items.length + ' items</span>' : '';
      return '<li><button class="txn" data-act="edit-txn" data-id="' + t.id + '"><span class="dot" style="background:' + (t.type === 'income' ? 'var(--pos)' : catColor(t.categoryId)) + '"></span><span class="txn-main"><b>' + esc(t.merchant || c.name) + '</b><small>' + esc(shortDate(t.date)) + ' · ' + esc(c.name) + (t.note ? ' · ' + esc(t.note) : '') + '</small></span>' + items + '<span class="txn-amt ' + (t.type === 'income' ? 'pos' : '') + '">' + (t.type === 'income' ? '+' : '−') + money(t.amount) + '</span></button>' +
        (!compact && t.items && t.items.length ? '<ul class="items">' + t.items.map(i => '<li><span>' + esc(i.name) + '</span><span>' + money(i.amount) + '</span></li>').join('') + '</ul>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function renderTransactions() {
    const el = $('#view-transactions');
    let list = txnsIn(viewMonth).sort(byDateDesc);
    const q = txnFilter.q.toLowerCase();
    if (q) list = list.filter(t => [t.merchant, t.note, catById(t.categoryId).name].concat((t.items || []).map(i => i.name)).join(' ').toLowerCase().includes(q));
    if (txnFilter.cat) list = list.filter(t => t.categoryId === txnFilter.cat);
    const opts = '<option value="">All categories</option><option value="income"' + (txnFilter.cat === 'income' ? ' selected' : '') + '>Income</option>' + state.categories.map(c => '<option value="' + c.id + '"' + (txnFilter.cat === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
    const all = txnsIn(viewMonth);
    el.innerHTML = '<div class="card"><div class="toolbar"><input type="search" id="txnSearch" placeholder="Search merchants, notes, receipt items" value="' + esc(txnFilter.q) + '"><select id="txnCat">' + opts + '</select></div>' +
      viewTotals(list, all.length) + txnList(list, false) + '</div>';
    const s = $('#txnSearch');
    s.addEventListener('input', () => { txnFilter.q = s.value; const pos = s.selectionStart; renderTransactions(); const n = $('#txnSearch'); n.focus(); n.setSelectionRange(pos, pos); });
    $('#txnCat').addEventListener('change', e => { txnFilter.cat = e.target.value; renderTransactions(); });
    const clr = $('#clearFilters');
    if (clr) clr.addEventListener('click', () => { txnFilter = { q: '', cat: '' }; renderTransactions(); });
  }

  // Totals for exactly the transactions on screen, so a search or filter shows its own net.
  function viewTotals(list, allCount) {
    const inc = sumBy(list, 'income'), out = sumBy(list, 'expense'), net = round2(inc - out);
    const filtered = list.length !== allCount || txnFilter.q || txnFilter.cat;
    const label = filtered ? 'Showing ' + list.length + ' of ' + allCount + ' · <button type="button" class="link-btn" id="clearFilters">Clear filters</button>' : list.length + ' transaction' + (list.length === 1 ? '' : 's') + ' in ' + esc(monthName(viewMonth, { month: 'long' }));
    return '<div class="view-totals"><div class="vt-count">' + label + '</div>' +
      '<div class="vt-cell"><span>In</span><b class="pos">+' + money(inc) + '</b></div>' +
      '<div class="vt-cell"><span>Out</span><b>−' + money(out) + '</b></div>' +
      '<div class="vt-cell vt-net"><span>Net</span><b class="' + (net > 0 ? 'pos' : net < 0 ? 'neg' : '') + '">' + (net > 0 ? '+' : net < 0 ? '−' : '') + money(Math.abs(net)) + '</b></div></div>';
  }

  function renderBudget() {
    const root = $('#view-budget');
    const sub = ['plans', 'patterns'].includes(subView()) ? subView() : '';
    const det = detectedIncome();
    const alerts = findPatterns().filter(p => p.level !== 'low').length;
    root.innerHTML = '<div class="card income-card"><label class="income-field"><span>Monthly take-home income</span><span class="money-input big"><span>$</span><input inputmode="decimal" id="incomeInput" value="' + (state.income || '') + '" placeholder="' + (det ? det : '0') + '" aria-label="Monthly take-home income"></span></label>' +
      '<p class="muted small">' + (state.income > 0 ? 'Used for budget plans and strain alerts.' + (det && Math.abs(det - state.income) > 1 ? ' Your logged income averages ' + money0(det) + '/mo.' : '') : det ? 'Not set, so Budgt is using your logged income average of ' + money0(det) + '/mo. <button type="button" class="link-btn small-link" data-act="use-income">Use ' + money0(det) + '</button>' : 'After tax. Budget plans are built from this.') + '</p></div>' +
      '<nav class="subtabs" aria-label="Budget sections"><a href="#budget"' + (!sub ? ' class="on"' : '') + '>Categories</a><a href="#budget/plans"' + (sub === 'plans' ? ' class="on"' : '') + '>Budget plans</a><a href="#budget/patterns"' + (sub === 'patterns' ? ' class="on"' : '') + '>Patterns' + (alerts ? ' <span class="count">' + alerts + '</span>' : '') + '</a></nav><div id="budgetSub"></div>';
    const inc = $('#incomeInput');
    inc.addEventListener('input', () => { const v = num(inc.value); state.income = isFinite(v) && v > 0 ? round2(v) : 0; persist(); });
    inc.addEventListener('change', () => save());
    const el = $('#budgetSub');
    if (sub === 'plans') return renderPlans(el);
    if (sub === 'patterns') return renderPatterns(el);
    const spent = spentByCat(viewMonth);
    const budget = totalBudget();
    const spentTotal = sumBy(txnsIn(viewMonth), 'expense');
    const income = sumBy(txnsIn(viewMonth), 'income');
    let html = '<div class="stats three">' + statCard('Monthly budget', money(budget), income ? money0(income) + ' income this month' : 'Across ' + state.categories.filter(c => c.budget > 0).length + ' categories', '') +
      statCard('Spent', money(spentTotal), budget ? Math.round((spentTotal / budget) * 100) + '% of budget' : '', spentTotal > budget && budget ? 'neg' : '') +
      statCard('Remaining', money(budget - spentTotal), budget - spentTotal < 0 ? 'Over budget' : 'Left for ' + monthName(viewMonth, { month: 'long' }), budget - spentTotal < 0 ? 'neg' : 'pos') + '</div>';
    html += '<div class="card"><div class="card-head"><h3>Categories' + info('Type a monthly limit for each category. Tap Essential or Flexible to choose which ones get cut-back tips.') + '</h3><button class="btn btn-ghost btn-sm" data-act="add-cat">+ Category</button></div><ul class="budget-rows">';
    html += state.categories.map(c => {
      const s = spent[c.id] || 0;
      const pct = c.budget ? s / c.budget : 0;
      const over = c.budget && s > c.budget;
      return '<li>' + donut(pct, over ? 'var(--neg)' : catColor(c.id)) + '<div class="br-name"><input class="inline" data-cat-name="' + c.id + '" value="' + esc(c.name) + '" aria-label="Category name"><small class="' + (over ? 'neg' : 'muted') + '">' + (s ? '<button type="button" class="spent-link" data-act="view-cat" data-id="' + c.id + '" title="See these transactions">' + money(s) + ' spent</button>' : money(s) + ' spent') + (c.budget ? ' · ' + (over ? money(s - c.budget) + ' over' : money(c.budget - s) + ' left') : '') + '</small></div>' +
        '<button type="button" class="tag tag-btn' + (isEssential(c) ? '' : ' tag-flex') + '" data-act="toggle-essential" data-id="' + c.id + '" title="Essentials are left out of cut-back tips">' + (isEssential(c) ? 'Essential' : 'Flexible') + '</button>' +
        '<label class="money-input"><span>$</span><input inputmode="decimal" data-cat-budget="' + c.id + '" value="' + (c.budget || '') + '" placeholder="0" aria-label="Monthly budget for ' + esc(c.name) + '"></label>' +
        '<button class="icon-btn" data-act="del-cat" data-id="' + c.id + '" aria-label="Delete ' + esc(c.name) + '">✕</button></li>';
    }).join('');
    html += '</ul></div>';
    el.innerHTML = html;
    // Save on every keystroke so nothing is lost on reload; re-render once the field is left.
    el.querySelectorAll('[data-cat-budget]').forEach(inp => {
      const apply = () => { const c = state.categories.find(x => x.id === inp.dataset.catBudget); const v = num(inp.value); c.budget = isFinite(v) && v > 0 ? round2(v) : 0; };
      inp.addEventListener('input', () => { apply(); persist(); });
      inp.addEventListener('change', () => { apply(); save(); });
    });
    el.querySelectorAll('[data-cat-name]').forEach(inp => {
      const apply = () => { const c = state.categories.find(x => x.id === inp.dataset.catName); const v = inp.value.trim(); if (v) c.name = v; };
      inp.addEventListener('input', () => { apply(); persist(); });
      inp.addEventListener('change', () => { apply(); save(); });
    });
  }

  function renderLiabilities() {
    const el = $('#view-liabilities');
    const debts = state.liabilities.filter(l => l.type === 'debt');
    const bills = state.liabilities.filter(l => l.type !== 'debt');
    const monthly = state.liabilities.reduce((a, l) => a + (l.payment || 0), 0);
    const debtTotal = debts.reduce((a, l) => a + (l.balance || 0), 0);
    let html = '<div class="stats three">' + statCard('Monthly bills and payments', money(monthly), state.liabilities.length + ' total', '') +
      statCard('Total debt', money(debtTotal), debts.length + ' accounts', '') +
      statCard('Debt-free by', debtFreeDate(debts), '', '', 'If you keep paying just the minimums') + '</div>';
    html += '<div class="card"><div class="card-head"><h3>Debts</h3><button class="btn btn-ghost btn-sm" data-act="add-liab" data-type="debt">+ Debt</button></div>';
    html += debts.length ? '<ul class="liabs">' + debts.map(l => {
      const m = payoffMonths(l.balance, l.apr, l.payment);
      return '<li><button class="liab" data-act="edit-liab" data-id="' + l.id + '"><span class="liab-main"><b>' + esc(l.name) + '</b><small>' + (l.apr ? l.apr + '% APR · ' : '') + money(l.payment) + '/mo · due on the ' + ordinal(l.dueDay) + '</small></span><span class="liab-right"><b>' + money(l.balance) + '</b><small class="' + (m === Infinity ? 'neg' : 'muted') + '">' + (m === Infinity ? 'Payment doesn\'t cover interest' : m === 0 ? 'Paid off' : 'Paid off ' + esc(monthsFromNow(m))) + '</small></span></button></li>';
    }).join('') + '</ul>' : '<p class="muted">Add loans and credit cards to track balances and see when you\'ll be debt-free.</p>';
    html += '</div>';
    html += '<div class="card"><div class="card-head"><h3>Recurring bills</h3><button class="btn btn-ghost btn-sm" data-act="add-liab" data-type="bill">+ Bill</button></div>';
    html += bills.length ? '<ul class="liabs">' + bills.map(l => '<li><button class="liab" data-act="edit-liab" data-id="' + l.id + '"><span class="liab-main"><b>' + esc(l.name) + '</b><small>' + esc(catById(l.categoryId).name) + ' · due on the ' + ordinal(l.dueDay) + '</small></span><span class="liab-right"><b>' + money(l.payment) + '</b><small class="muted">per month</small></span></button></li>').join('') + '</ul>' : '<p class="muted">Add rent, utilities, phone and subscriptions so nothing sneaks up on you.</p>';
    html += '</div>';
    el.innerHTML = html;
  }

  function debtFreeDate(debts) {
    if (!debts.length) return '—';
    const m = Math.max(...debts.map(l => payoffMonths(l.balance, l.apr, l.payment)));
    return m === Infinity ? 'Not yet' : m === 0 ? 'Now' : monthsFromNow(m);
  }
  function ordinal(n) { n = n || 1; const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  function renderGoals() {
    const el = $('#view-goals');
    const avg = avgMonthlySavings();
    let html = '<div class="stats three">' + statCard('Saved toward goals', money(state.goals.reduce((a, g) => a + g.saved, 0)), 'of ' + money0(state.goals.reduce((a, g) => a + g.target, 0)) + ' total', '') +
      statCard('Your savings rate', (avg < 0 ? '−' : '') + money0(Math.abs(avg)) + '/mo', '', avg >= 0 ? 'pos' : 'neg', 'Average income minus spending over your recent months') +
      statCard('Goals', String(state.goals.length), state.goals.filter(g => g.saved >= g.target).length + ' reached', '') + '</div>';
    html += '<div class="card"><div class="card-head"><h3>Your goals</h3><button class="btn btn-ghost btn-sm" data-act="add-goal">+ Goal</button></div>';
    if (!state.goals.length) html += '<p class="muted">Emergency fund, vacation, down payment: add a goal and Budgt will show when you\'ll get there.</p>';
    else html += '<ul class="goal-cards">' + state.goals.map(g => {
      const o = goalOutlook(g, avg);
      const pct = Math.min(1, g.saved / g.target);
      return '<li class="goal-card"><div class="gc-top">' + donut(pct, o.color) + '<div><b>' + esc(g.name) + '</b><small class="muted">' + Math.round(pct * 100) + '% · ' + money0(g.saved) + ' of ' + money0(g.target) + (g.date ? ' · by ' + esc(shortMonth(g.date)) : '') + '</small></div></div><p class="' + o.tone + ' small">' + o.text + '</p><div class="row-actions"><button class="btn btn-sm" data-act="contribute" data-id="' + g.id + '">+ Add money</button><button class="btn btn-ghost btn-sm" data-act="edit-goal" data-id="' + g.id + '">Edit</button></div></li>';
    }).join('') + '</ul>';
    html += '</div>';
    el.innerHTML = html;
  }

  // ---------- income, budget plans, outlook and spending patterns ----------
  // Average income logged over recent months (skipping empty ones); used when no income is entered.
  function detectedIncome() {
    const cur = monthKey(new Date());
    const vals = [];
    for (let i = 1; i <= 6 && vals.length < 3; i++) { const v = sumBy(txnsIn(shiftMonth(cur, -i)), 'income'); if (v > 0) vals.push(v); }
    if (!vals.length) { const v = sumBy(txnsIn(cur), 'income'); if (v > 0) vals.push(v); }
    return vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  }
  function monthlyIncome() { return state.income > 0 ? state.income : detectedIncome(); }

  function isDebtPayment(t) { const l = t.liabilityId && state.liabilities.find(x => x.id === t.liabilityId); return !!(l && l.type === 'debt'); }

  // Average monthly spend per category over the last 3 months that have data (debt payments excluded; they're counted separately).
  function catAverages() {
    const cur = monthKey(new Date());
    const months = [];
    for (let i = 1; i <= 6 && months.length < 3; i++) { const k = shiftMonth(cur, -i); if (txnsIn(k).some(t => t.type === 'expense')) months.push(k); }
    if (!months.length) months.push(cur);
    const sums = {};
    months.forEach(k => txnsIn(k).forEach(t => { if (t.type === 'expense' && !isDebtPayment(t)) sums[t.categoryId] = (sums[t.categoryId] || 0) + t.amount; }));
    const avg = {};
    Object.keys(sums).forEach(id => { avg[id] = sums[id] / months.length; });
    return { avg, months: months.length };
  }

  const PLANS = [
    { id: '50-30-20', split: '50% needs, 30% wants, 20% savings and extra debt payments', name: '50/30/20', tagline: '50% needs · 30% wants · 20% savings', needs: 0.5, wants: 0.3, save: 0.2,
      about: 'The most widely used split. Needs (including minimum debt payments) stay under half your take-home pay, wants get 30%, and 20% goes to savings and extra debt payments.',
      source: 'Elizabeth Warren & Amelia Warren Tyagi, All Your Worth (2005)', bestFor: 'A balanced starting point' },
    { id: '70-20-10', split: '70% living costs, 20% savings, 10% extra debt or giving', name: '70/20/10', tagline: '70% living · 20% savings · 10% debt', living: 0.7, save: 0.2, debt: 0.1,
      about: 'Everything you live on, needs and wants together, fits in 70%. 20% is saved and 10% goes to paying down debt faster (or to giving once you\'re debt-free).',
      source: 'Common financial-planner rule of thumb', bestFor: 'Paying off debt while still saving' },
    { id: '60-solution', split: '60% committed; 10% retirement, 10% long-term, 10% irregular, 10% fun', name: '60% solution', tagline: '60% committed · 30% saved · 10% fun', needs: 0.6, wants: 0.1, save: 0.3,
      about: 'Committed costs stay at 60%. The rest is split into 10% retirement, 10% long-term savings, 10% for irregular costs like gifts and car repairs, and a guilt-free 10% for fun.',
      source: 'Richard Jenkins, MSN Money (2006)', bestFor: 'Building savings fast',
      buckets: ['Retirement', 'Long-term savings', 'Irregular costs (gifts, repairs)'] },
    { id: 'pay-first', split: '20% saved first, spend the other 80% freely', name: 'Pay yourself first', tagline: 'Save 20% first · spend the rest freely', living: 0.8, save: 0.2,
      about: 'Move 20% to savings the day you\'re paid, then spend what\'s left without tracking every category. The CFPB finds automatic, up-front saving is one of the most reliable ways to save.',
      source: 'Classic "pay yourself first" rule; CFPB evidence review (2020)', bestFor: 'People who hate tracking categories' },
    { id: 'zero-based', split: 'Needs, then goals, then wants; the rest is saved', name: 'Zero-based', tagline: 'Every dollar gets a job', zero: true,
      about: 'Income minus needs, minus what your goals need each month, minus wants equals zero. Wants are held to what you actually spend, and anything left over goes to savings.',
      source: 'Popularised by Dave Ramsey and YNAB', bestFor: 'Hitting specific goals on time' },
    { id: 'envelope', split: 'Flexible categories capped at 90% of your usual spending', name: 'Envelope', tagline: 'Hard caps 10% below your usual spending', envelope: true,
      about: 'Each flexible category gets a fixed "envelope" 10% smaller than what you usually spend. When it\'s empty, you stop. Everything you don\'t spend is saved.',
      source: 'Cash-envelope system', bestFor: 'Reining in overspending' },
  ];
  let selectedPlan = null;

  function goalsMonthlyNeed() {
    return state.goals.reduce((a, g) => {
      const rem = Math.max(0, g.target - g.saved);
      if (!rem) return a;
      if (g.monthly > 0) return a + g.monthly;
      if (g.date) return a + rem / Math.max(1, monthsUntil(g.date));
      return a;
    }, 0);
  }
  function r5(n) { return Math.round(n / 5) * 5; }

  function computePlan(plan) {
    const I = monthlyIncome();
    const { avg } = catAverages();
    // Essentials are locked: their budgets are never changed. The plan sizes needs from what you actually spend on them
    // (or the budget when there's no history yet), so padding in an essential budget doesn't shrink your wants or savings.
    const essentials = state.categories.filter(isEssential).map(c => ({ c, amt: c.budget > 0 ? c.budget : r5(avg[c.id] || 0), avg: avg[c.id] || 0, expect: avg[c.id] > 0 ? avg[c.id] : (c.budget || 0) }));
    const flex = state.categories.filter(c => !isEssential(c)).map(c => ({ c, avg: avg[c.id] || 0 }));
    const debts = state.liabilities.filter(l => l.type === 'debt' && l.balance > 0);
    const debtMin = debts.reduce((a, l) => a + (l.payment || 0), 0);
    const N = essentials.reduce((a, e) => a + e.expect, 0) + debtMin;
    const flexAvg = flex.reduce((a, f) => a + f.avg, 0);
    const notes = [];
    let W, S, X = 0;
    if (plan.zero) {
      const goalNeed = goalsMonthlyNeed();
      const S0 = goalNeed > 0 ? goalNeed : I * 0.15;
      W = Math.min(flexAvg, Math.max(0, I - N - S0));
      S = I - N - W;
      notes.push(goalNeed > 0 ? 'Your goals need about ' + money0(goalNeed) + '/mo, so that is set aside before wants.' : 'No dated goals yet, so 15% is set aside for savings first.');
    } else if (plan.envelope) {
      W = flexAvg * 0.9;
      S = I - N - W;
    } else if (plan.living) {
      W = I * plan.living - N;
      S = I * plan.save;
      X = plan.debt ? I * plan.debt : 0;
      if (X && !debts.length) { S += X; X = 0; notes.push('You have no debts listed, so the 10% debt share goes to savings.'); }
    } else {
      W = I * plan.wants;
      S = I * plan.save;
      const over = N - I * plan.needs;
      if (over > 0) { W -= over; notes.push('Your essentials are ' + Math.round(N / Math.max(1, I) * 100) + '% of income, above this plan\'s ' + Math.round(plan.needs * 100) + '%. The difference comes out of wants first; essentials are not cut.'); }
    }
    if (W < 0) { S += W; X = Math.max(0, X + Math.min(0, S)); if (S > 0) notes.push('Your needs are more than this plan\'s share of income, so wants are set to $0 and savings shrink by ' + money0(-W) + ' to cover the rest. Essentials are not cut.'); W = 0; }
    // Keep wants realistic: never more than 10% above what you actually spend; the surplus is saved instead.
    const cap = flexAvg > 0 ? flexAvg * 1.1 : W;
    if (!plan.zero && W > cap) { S += W - cap; if (flexAvg > 0) notes.push('You spend less on wants than this plan allows, so the extra ' + money0(W - cap) + '/mo goes to savings.'); W = cap; }
    const deficit = I - N - W - S - X < -1 ? I - N - W - S - X : 0;
    if (S < 0) { notes.push('Your essentials and debt payments are more than your income. Budgt can\'t balance this plan without cutting essentials.'); S = 0; }
    // Split wants across flexible categories by recent spending (evenly if there is no history).
    const alloc = flex.map(f => {
      const share = flexAvg > 0 ? f.avg / flexAvg : 1 / Math.max(1, flex.length);
      return { c: f.c, avg: f.avg, planned: r5(W * share) };
    });
    const wantsCut = flexAvg > 0 ? 1 - W / flexAvg : 0;
    if (wantsCut > 0.3) notes.unshift('This plan cuts your flexible spending by ' + Math.round(wantsCut * 100) + '% from what you usually spend (' + money0(flexAvg) + ' down to ' + money0(W) + ' a month). That\'s a big change, so plan for it or pick a gentler plan.');
    return { plan, income: I, needs: N, essentials, debtMin, wants: alloc.reduce((a, x) => a + x.planned, 0), alloc, savings: Math.max(0, S), extraDebt: X, deficit, notes, wantsCut, flexAvg };
  }

  function recommendPlan() {
    const results = PLANS.map(computePlan);
    const ok = results.filter(r => r.savings > 0 && r.wantsCut <= 0.3 && !r.notes.some(n => /more than your income/.test(n)));
    const pool = ok.length ? ok : results;
    pool.sort((a, b) => (b.savings + b.extraDebt) - (a.savings + a.extraDebt));
    return pool[0].plan.id;
  }

  // 12-month projection of savings and debt, current habits vs a plan.
  function simulate(monthlySave, extraDebt) {
    const debts = state.liabilities.filter(l => l.type === 'debt').map(l => ({ bal: l.balance || 0, apr: l.apr || 0, pay: l.payment || 0 }));
    let savings = state.goals.reduce((a, g) => a + g.saved, 0);
    const pts = [{ savings, debt: debts.reduce((a, d) => a + d.bal, 0) }];
    for (let m = 1; m <= 12; m++) {
      let extra = extraDebt, freed = 0;
      debts.forEach(d => { if (d.bal <= 0) { freed += d.pay; return; } d.bal = d.bal * (1 + d.apr / 1200); const p = Math.min(d.bal, d.pay); d.bal -= p; if (d.bal <= 0.005) d.bal = 0; });
      extra += extraDebt > 0 ? freed : 0;
      debts.slice().sort((a, b) => b.apr - a.apr).forEach(d => { if (extra <= 0 || d.bal <= 0) return; const p = Math.min(d.bal, extra); d.bal -= p; extra -= p; });
      savings += monthlySave + extra + (extraDebt > 0 ? 0 : freed);
      pts.push({ savings, debt: debts.reduce((a, d) => a + d.bal, 0) });
    }
    return pts;
  }

  function currentMonthlySave() {
    const { avg } = catAverages();
    const spend = Object.values(avg).reduce((a, b) => a + b, 0);
    const debtMin = state.liabilities.filter(l => l.type === 'debt' && l.balance > 0).reduce((a, l) => a + (l.payment || 0), 0);
    return monthlyIncome() - spend - debtMin;
  }

  function outlookChart(r) {
    const cur = simulate(currentMonthlySave(), 0);
    const plan = simulate(r.savings, r.extraDebt);
    const net = p => p.savings - p.debt;
    const W = 600, H = 240, P = { l: 52, r: 12, t: 16, b: 26 };
    const vals = cur.concat(plan).map(net);
    let lo = Math.min(0, ...vals), hi = Math.max(1, ...vals);
    const step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const x = i => P.l + i / 12 * (W - P.l - P.r);
    const y = v => H - P.b - (v - lo) / (hi - lo) * (H - P.t - P.b);
    const line = pts => pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(net(p)).toFixed(1)).join(' ');
    let svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Projected net worth over 12 months: current habits versus ' + esc(r.plan.name) + '">';
    for (let v = lo; v <= hi + 0.001; v += step) svg += '<line class="grid-line' + (Math.abs(v) < 0.001 ? ' zero-line' : '') + '" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="axis" x="' + (P.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + esc((v < 0 ? '−' : '') + compact(Math.abs(v))) + '</text>';
    svg += '<path class="line-prev" d="' + line(cur) + '"/>';
    svg += '<path class="line-cur" d="' + line(plan) + '"/>';
    svg += '<circle class="line-dot" cx="' + x(12) + '" cy="' + y(net(plan[12])) + '" r="4.5"/>';
    [0, 3, 6, 9, 12].forEach(i => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + i); svg += '<text class="axis" x="' + x(i) + '" y="' + (H - 7) + '" text-anchor="' + (i === 0 ? 'start' : i === 12 ? 'end' : 'middle') + '">' + (i === 0 ? 'Now' : esc(d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }))) + '</text>'; });
    svg += '</svg>';
    const diff = net(plan[12]) - net(cur[12]);
    const debtNow = plan[0].debt, debtPlan = plan[12].debt, debtCur = cur[12].debt;
    const facts = [
      ['Net worth in 12 months', money0(net(plan[12])), 'Current habits: ' + money0(net(cur[12]))],
      ['Difference', (diff >= 0 ? '+' : '−') + money0(Math.abs(diff)), diff >= 0 ? 'Better than your current path' : 'Worse than your current path'],
    ];
    if (debtNow > 0) facts.push(['Debt in 12 months', money0(debtPlan), 'Current habits: ' + money0(debtCur)]);
    const goal = state.goals.find(g => g.saved < g.target);
    if (goal) {
      const hit = pts => { for (let i = 0; i < pts.length; i++) if (pts[i].savings - (pts[0].savings - goal.saved) >= goal.target) return i; return -1; };
      const hp = hit(plan), hc = hit(cur);
      facts.push([goal.name, hp >= 0 ? (hp === 0 ? 'Reached' : 'Reached ' + monthsFromNow(hp)) : 'Not within a year', hc >= 0 ? 'Current habits: ' + (hc === 0 ? 'reached' : monthsFromNow(hc)) : 'Current habits: not within a year']);
    }
    // Vanguard: a $2,000 cushion, then 3 to 6 months of expenses, are the savings levels linked to less money stress.
    const cushion = r5(r.needs * 3);
    const reach = (pts, amt) => { for (let i = 0; i < pts.length; i++) if (pts[i].savings >= amt) return i; return -1; };
    const when = i => i < 0 ? 'not within a year' : i === 0 ? 'reached' : monthsFromNow(i);
    if (cushion > 0) {
      const s2 = reach(plan, 2000), s3 = reach(plan, cushion);
      facts.push(['3-month safety net', s3 < 0 ? 'Not within a year' : s3 === 0 ? 'Reached' : 'Reached ' + monthsFromNow(s3), money0(cushion) + ' of needs. $2,000 starter: ' + when(s2)]);
    }
    return '<div class="card-head"><h3>12-month outlook' + info('Net worth: your savings minus what you owe, month by month, including interest on debts.') + '</h3><div class="legend"><span class="lg lg-cur">' + esc(r.plan.name) + '</span><span class="lg lg-prev">Current habits</span></div></div>' +
      svg +
      '<div class="outlook-facts">' + facts.map(([l, v, s]) => '<div><span>' + esc(l) + '</span><b>' + esc(v) + '</b><small>' + esc(s) + '</small></div>').join('') + '</div>';
  }

  function renderPlans(el) {
    const I = monthlyIncome();
    if (!(I > 0)) {
      el.innerHTML = '<div class="card empty"><h3>Add your income first</h3><p>Budget plans are built from your monthly take-home pay. Enter it above, or log an income transaction.</p></div>';
      return;
    }
    const rec = recommendPlan();
    if (!selectedPlan || !PLANS.some(p => p.id === selectedPlan)) selectedPlan = rec;
    const results = PLANS.map(computePlan);
    const r = results.find(x => x.plan.id === selectedPlan);
    const active = state.plan && state.plan.id;
    let html = '<div class="plans-layout"><ul class="plan-list">' + results.map(x => {
      const sel = x.plan.id === selectedPlan;
      const saveRate = Math.round((x.savings + x.extraDebt) / I * 100);
      return '<li><button type="button" class="plan-item' + (sel ? ' sel' : '') + '" data-act="pick-plan" data-id="' + x.plan.id + '"><span class="pi-top"><b>' + esc(x.plan.name) + '</b>' +
        (x.plan.id === active ? '<span class="tag tag-on">Active</span>' : x.plan.id === rec ? '<span class="tag tag-rec">Best fit</span>' : '') + '</span><small>' + esc(x.plan.tagline) + '</small>' +
        '<span class="pi-save">Saves ' + money0(x.savings + x.extraDebt) + '/mo · ' + saveRate + '%</span>' + (x.wantsCut > 0.05 ? '<span class="pi-cut' + (x.wantsCut > 0.3 ? ' neg' : '') + '">Wants −' + Math.round(x.wantsCut * 100) + '% vs usual</span>' : '') + '</button></li>';
    }).join('') + '</ul>';

    const pct = v => Math.round(v / I * 100);
    const seg = (cls, v, label) => v > 0 ? '<i class="' + cls + '" style="width:' + Math.min(100, v / I * 100).toFixed(1) + '%" title="' + esc(label) + '"></i>' : '';
    html += '<div class="plan-detail"><div class="card"><div class="card-head"><h3>' + esc(r.plan.name) + info('Source: ' + r.plan.source) + '</h3><span class="muted small">Best for: ' + esc(r.plan.bestFor) + '</span></div>' +
      '<p class="plan-about">' + esc(r.plan.about) + '</p>' +
      '<div class="split-bar">' + seg('sb-needs', r.needs, 'Needs') + seg('sb-wants', r.wants, 'Wants') + seg('sb-save', r.savings, 'Savings') + seg('sb-debt', r.extraDebt, 'Extra debt') + '</div>' +
      '<div class="split-legend"><span><i class="sb-needs"></i>Needs ' + money0(r.needs) + ' · ' + pct(r.needs) + '%</span><span><i class="sb-wants"></i>Wants ' + money0(r.wants) + ' · ' + pct(r.wants) + '%</span><span><i class="sb-save"></i>Savings ' + money0(r.savings) + ' · ' + pct(r.savings) + '%</span>' + (r.extraDebt ? '<span><i class="sb-debt"></i>Extra debt ' + money0(r.extraDebt) + ' · ' + pct(r.extraDebt) + '%</span>' : '') + '</div>' +
      (r.notes.length ? '<ul class="plan-notes">' + r.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '') +
      '<table class="plan-table"><thead><tr><th>Category</th><th>Usually spend</th><th>Plan</th></tr></thead><tbody>' +
      r.essentials.filter(e => e.amt > 0 || e.avg > 0).map(e => '<tr class="locked"><td>' + esc(e.c.name) + ' <span class="tag">Essential · locked</span></td><td>' + money0(e.avg) + '</td><td>' + money0(e.amt) + (e.c.budget > 0 ? ' <small>budget kept</small>' : '') + '</td></tr>').join('') +
      (r.debtMin ? '<tr class="locked"><td>Minimum debt payments <span class="tag">locked</span></td><td>' + money0(r.debtMin) + '</td><td>' + money0(r.debtMin) + '</td></tr>' : '') +
      r.alloc.map(a => { const d = a.planned - a.avg; return '<tr><td>' + esc(a.c.name) + ' <span class="tag tag-flex">Flexible</span></td><td>' + money0(a.avg) + '</td><td>' + money0(a.planned) + (Math.abs(d) >= 5 ? ' <small class="' + (d < 0 ? 'warn' : 'pos') + '">' + (d < 0 ? '−' : '+') + money0(Math.abs(d)) + '</small>' : '') + '</td></tr>'; }).join('') +
      '<tr class="save-row"><td>Savings</td><td>' + money0(Math.max(0, currentMonthlySave())) + '</td><td>' + money0(r.savings) + '</td></tr>' +
      (r.plan.buckets && r.savings > 0 ? r.plan.buckets.map(b => '<tr class="sub-row"><td>' + esc(b) + '</td><td></td><td>' + money0(r5(r.savings / r.plan.buckets.length)) + '</td></tr>').join('') : '') +
      (r.extraDebt ? '<tr class="save-row"><td>Extra debt payments (highest interest first)</td><td>' + money0(0) + '</td><td>' + money0(r.extraDebt) + '</td></tr>' : '') +
      '</tbody></table>' +
      '<div class="row-actions plan-actions"><button type="button" class="btn" data-act="apply-plan" data-id="' + r.plan.id + '">' + (active === r.plan.id ? 'Re-apply ' : 'Use ') + esc(r.plan.name) + '</button>' + info('Sets your Flexible category budgets. Essentials keep their current amounts.') + '</div></div>' +
      '<div class="card">' + outlookChart(r) + '</div></div></div>' + planGuide();
    el.innerHTML = html;
  }

  const SOURCES = {
    bankrate: 'https://www.bankrate.com/personal-finance/what-is-the-50-30-20-rule',
    cfpb: 'https://www.consumerfinance.gov/archive/blog/report-synthesizes-evidence-based-strategies-build-emergency-savings/',
    vanguard: 'https://corporate.vanguard.com/content/dam/corp/research/pdf/relationship_between_emergency_savings_financial_well_being_financial_stress.pdf',
  };
  const ext = (href, text) => '<a href="' + href + '" target="_blank" rel="noopener">' + esc(text) + '</a>';

  function planGuide() {
    return '<details class="card guide"><summary><span>How these plans work</span><small class="muted">Methods, sources and how Budgt uses your data</small></summary>' +
      '<div class="guide-body"><div class="table-wrap"><table class="plan-table guide-table"><thead><tr><th>Plan</th><th>Split</th><th>Origin</th><th>Best for</th></tr></thead><tbody>' +
      PLANS.map(p => '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.split) + '</td><td>' + esc(p.source) + '</td><td>' + esc(p.bestFor) + '</td></tr>').join('') + '</tbody></table></div>' +
      '<div class="guide-cols"><div><h4>How Budgt builds a plan</h4><ol>' +
      '<li>Income is what you enter above, or the average income you\'ve logged recently.</li>' +
      '<li>Needs are your Essential categories plus minimum debt payments. Essentials are locked and never cut.</li>' +
      '<li>The plan sizes savings and wants. If needs go over the plan\'s share, wants shrink first, then savings, and the plan tells you.</li>' +
      '<li>Wants are split across Flexible categories by your last 3 months of spending, and never set more than 10% above what you actually spend. The surplus is saved.</li>' +
      '<li>The outlook simulates 12 months of savings and debt, with interest and minimum payments. Extra debt money goes to the highest-interest debt first.</li></ol></div>' +
      '<div><h4>Why this works</h4><ul>' +
      '<li>Minimum debt payments are needs; anything above the minimum counts as saving (' + ext(SOURCES.bankrate, 'Bankrate') + ').</li>' +
      '<li>Saving first, automatically, with a clear number to aim for is what reliably builds savings (' + ext(SOURCES.cfpb, 'CFPB') + '). That\'s why each plan shows a monthly savings amount and Budgt flags costly habits.</li>' +
      '<li>$2,000 of emergency savings is linked to 21% higher financial well-being, and 3 to 6 months of expenses adds another 13% (' + ext(SOURCES.vanguard, 'Vanguard, 2025') + '). The outlook shows when you\'ll reach both.</li></ul></div></div></div></details>';
  }

  function applyPlan(id) {
    const r = computePlan(PLANS.find(p => p.id === id));
    if (!confirm('Use the ' + r.plan.name + ' plan? This sets budgets for your ' + r.alloc.length + ' Flexible categories. Essential budgets stay as they are.')) return;
    r.alloc.forEach(a => { a.c.budget = a.planned; });
    r.essentials.forEach(e => { if (!(e.c.budget > 0) && e.amt > 0) e.c.budget = e.amt; });
    state.plan = { id, appliedAt: todayISO(), savings: round2(r.savings), extraDebt: round2(r.extraDebt) };
    save();
  }

  // ---------- spending patterns ----------
  const STOP = new Set('the and for with from this that was were got some new day week month bought paid pay buy for, just also then into our your you are not but all one two had has have its his her him she they them per via at on in of to a an'.split(' '));
  function words(s) { return (s || '').toLowerCase().match(/[a-z][a-z'&-]{2,}/g) || []; }

  function findPatterns() {
    const cur = monthKey(new Date());
    const start = shiftMonth(cur, -2) + '-01';
    const txns = state.transactions.filter(t => t.type === 'expense' && t.date >= start && !t.liabilityId && !isEssential(catById(t.categoryId)));
    if (!txns.length) return [];
    const monthsSpan = Math.max(1, new Set(state.transactions.filter(t => t.date >= start).map(t => t.date.slice(0, 7))).size);
    const groups = new Map();
    const add = (key, label, kind, t, amt) => {
      const g = groups.get(key) || { key, label, kind, txns: new Set(), total: 0, months: new Set(), merchants: {}, dates: [] };
      if (!g.txns.has(t.id)) { g.dates.push(t.date); }
      g.txns.add(t.id); g.total += amt; g.months.add(t.date.slice(0, 7));
      if (t.merchant) g.merchants[t.merchant] = (g.merchants[t.merchant] || 0) + 1;
      groups.set(key, g);
    };
    txns.forEach(t => {
      new Set(words(t.note).filter(w => !STOP.has(w))).forEach(w => add('n:' + w, w.charAt(0).toUpperCase() + w.slice(1), 'note', t, t.amount));
      if (t.merchant) add('m:' + t.merchant.trim().toLowerCase(), t.merchant.trim(), 'merchant', t, t.amount);
      (t.items || []).forEach(i => add('i:' + i.name.trim().toLowerCase(), i.name.trim(), 'item', t, i.amount));
    });
    const I = monthlyIncome();
    const flexMonthly = txns.reduce((a, t) => a + t.amount, 0) / monthsSpan;
    const cands = Array.from(groups.values()).filter(g => g.txns.size >= 3).map(g => {
      const monthly = g.total / monthsSpan;
      const share = I > 0 ? monthly / I : 0;
      const perMonth = g.txns.size / monthsSpan;
      // A habit is something bought at least twice a month, or a big recurring cost.
      const habitual = perMonth >= 2 || monthly >= 100;
      const level = !habitual ? 'low' : (I > 0 && share >= 0.05) || monthly >= 150 ? 'high' : (I > 0 && share >= 0.02) || monthly >= 60 ? 'medium' : 'low';
      const recent = g.dates.filter(d => d.slice(0, 7) === cur).length;
      const topMerchant = Object.keys(g.merchants).sort((a, b) => g.merchants[b] - g.merchants[a])[0];
      return Object.assign(g, { monthly, share, level, perMonth: g.txns.size / monthsSpan, recent, topMerchant, flexShare: flexMonthly ? monthly / flexMonthly : 0 });
    }).sort((a, b) => b.monthly - a.monthly);
    // Keep the most expensive grouping of each set of purchases (e.g. a "vape" note over its store name).
    const picked = [], covered = new Set();
    cands.forEach(g => {
      const overlap = Array.from(g.txns).filter(id => covered.has(id)).length / g.txns.size;
      if (overlap >= 0.5) return;
      picked.push(g); g.txns.forEach(id => covered.add(id));
    });
    return picked.slice(0, 8);
  }

  function patternMessage(g) {
    const I = monthlyIncome();
    const where = g.kind !== 'merchant' && g.topMerchant ? ' at ' + g.topMerchant : '';
    const kindText = g.kind === 'note' ? 'from your notes' : g.kind === 'item' ? 'from receipt items' : 'by store';
    let text = g.label + where + ' costs about ' + money0(g.monthly) + ' a month (' + Math.round(g.perMonth) + ' purchase' + (Math.round(g.perMonth) === 1 ? '' : 's') + ' a month)';
    if (I > 0) text += ', ' + (g.share * 100).toFixed(g.share < 0.1 ? 1 : 0) + '% of your income';
    text += '. That\'s ' + money0(g.monthly * 12) + ' a year.';
    const goal = state.goals.find(x => x.saved < x.target);
    const rate = avgMonthlySavings();
    let impact = '';
    if (goal) {
      const rem = goal.target - goal.saved;
      const half = g.monthly / 2;
      if (rate > 0) {
        const a = Math.ceil(rem / rate), b = Math.ceil(rem / (rate + half));
        if (a - b >= 1) impact = 'Cutting it in half would reach your ' + goal.name + ' ' + (a - b) + ' month' + (a - b === 1 ? '' : 's') + ' sooner.';
      } else impact = 'Cutting it in half would free up ' + money0(half) + ' a month toward your ' + goal.name + '.';
    } else impact = 'Cutting it in half would free up ' + money0(g.monthly / 2) + ' a month.';
    return { text, impact, kindText };
  }

  function renderPatterns(el) {
    const pats = findPatterns();
    const alerts = pats.filter(p => p.level !== 'low');
    let html = '<div class="card"><div class="card-head"><h3>Spending patterns' + info('Budgt checks the last 3 months of Flexible spending for purchases that keep coming back, by store, by words in your notes and by receipt items, including anything filed under Other. Essential categories are never flagged.') + '</h3></div>';
    if (!pats.length) html += '<p class="muted">No repeating non-essential purchases yet. Patterns show up once something repeats 3 or more times.</p>';
    html += alerts.map(g => {
      const m = patternMessage(g);
      return '<div class="pattern pattern-' + g.level + '"><div class="pt-head"><b>' + esc(g.label) + '</b><span class="tag ' + (g.level === 'high' ? 'tag-high' : 'tag-flex') + '">' + (g.level === 'high' ? 'High strain' : 'Moderate strain') + '</span><span class="pt-amt">' + money0(g.monthly) + '/mo</span></div>' +
        '<p>' + esc(m.text) + (g.level === 'high' ? ' <b>This habit is putting a lot of strain on your finances.</b>' : ' It\'s adding up.') + '</p>' +
        '<p class="muted small">' + esc(m.impact) + ' Found ' + esc(m.kindText) + ' in ' + g.txns.size + ' purchases.</p>' +
        '<button type="button" class="link-btn small-link" data-act="search-pattern" data-q="' + esc(g.kind === 'merchant' ? g.label : g.label.toLowerCase()) + '">See these purchases</button></div>';
    }).join('');
    const minor = pats.filter(p => p.level === 'low');
    if (minor.length) html += '<h4 class="minor-head">Other repeat purchases</h4><ul class="minor-list">' + minor.map(g => '<li><span>' + esc(g.label) + (g.topMerchant && g.kind !== 'merchant' ? ' · ' + esc(g.topMerchant) : '') + '</span><span class="muted">' + g.txns.size + '× · ' + money0(g.monthly) + '/mo</span></li>').join('') + '</ul>';
    html += '<details class="guide guide-inline"><summary><span>How alerts work</span></summary><div class="guide-body"><ul>' +
      '<li>Budgt checks the last 3 months of non-essential spending, including Other, and groups purchases by store, by words in your notes, and by receipt items.</li>' +
      '<li>Something counts as a habit when it repeats at least 3 times and is bought twice a month or more, or costs $100+ a month.</li>' +
      '<li><b>High strain:</b> 5% or more of your income, or $150+ a month. <b>Moderate strain:</b> 2% or more, or $60+ a month.</li>' +
      '<li>Essential categories and debt payments are never flagged.</li></ul></div></details></div>';
    el.innerHTML = html;
  }

  // Headline wording varies by habit and month, but stays put between page loads so it doesn't flicker.
  const STRAIN_LINES = {
    medium: ['{x} is a habit that is adding up.', '{x} keeps showing up in your spending.', 'Those {x} runs are starting to add up.', '{x} has become a regular expense.', 'Small {x} purchases are stacking up.', 'Your {x} spending has turned into a pattern.'],
    high: ['{x} is putting a lot of strain on your budget.', '{x} is one of your biggest money leaks.', '{x} is taking a big bite out of your income.', 'Your {x} habit is costing you a lot.', '{x} is weighing heavily on your budget.'],
  };
  function strainHeadline(g) {
    const lines = STRAIN_LINES[g.level === 'high' ? 'high' : 'medium'];
    let h = 0;
    for (const ch of g.key + monthKey(new Date())) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return lines[h % lines.length].replace('{x}', g.label);
  }

  function strainBanner() {
    const high = findPatterns().filter(p => p.level === 'high' || p.level === 'medium');
    const dismissed = (state.dismissedStrain || {})[monthKey(new Date())] || [];
    const show = high.filter(g => !dismissed.includes(g.key));
    if (!show.length) return '';
    const g = show[0];
    const m = patternMessage(g);
    return '<div class="strain-banner" role="status"><span class="sb-icon" aria-hidden="true">!</span><div><b>' + esc(strainHeadline(g)) + '</b><p>' + esc(m.text) + (show.length > 1 ? ' ' + (show.length - 1) + ' more habit' + (show.length > 2 ? 's' : '') + ' flagged.' : '') + '</p></div>' +
      '<div class="row-actions"><a class="btn btn-sm" href="#budget/patterns">See patterns</a><button type="button" class="btn btn-ghost btn-sm" data-act="dismiss-strain" data-id="' + esc(g.key) + '">Dismiss</button></div></div>';
  }

  // ---------- modal forms ----------
  const modal = $('#modal');
  let onSave = null, onDelete = null;

  let draftDesc = null;
  function openModal(title, body, saveFn, deleteFn, saveLabel, desc) {
    draftDesc = desc || null;
    $('#modalNote').textContent = '';
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    $('#modalError').textContent = '';
    $('#modalSave').textContent = saveLabel || 'Save';
    $('#modalDelete').hidden = !deleteFn;
    onSave = saveFn; onDelete = deleteFn;
    modal.showModal();
    const first = modal.querySelector('#modalBody input:not([type=hidden]), #modalBody select');
    if (first) first.focus();
  }
  function closeModal() { modal.close(); onSave = onDelete = null; }
  function fail(msg) { $('#modalError').textContent = msg; return false; }
  function field(label, inner, cls) { return '<label class="field ' + (cls || '') + '"><span>' + label + '</span>' + inner + '</label>'; }
  function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }

  // ---------- unsaved form drafts ----------
  // Whatever is typed into an open form is kept in localStorage, so a reload or a closed tab reopens it as it was.
  function saveDraft() {
    if (!draftDesc || !modal.open) return;
    const values = {};
    modal.querySelectorAll('#modalBody input[id], #modalBody select[id]').forEach(e => { values[e.id] = e.value; });
    const tt = modal.querySelector('input[name=ttype]:checked');
    const items = Array.from(modal.querySelectorAll('.item-row')).map(r => [r.querySelector('.it-name').value, r.querySelector('.it-amt').value]);
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ desc: draftDesc, values, ttype: tt ? tt.value : null, items })); } catch (e) { /* ignore */ }
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ } }

  function restoreDraft() {
    let d;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (e) { d = null; }
    if (!d || !d.desc) return;
    const { kind, id, type } = d.desc;
    const find = list => (id ? list.find(x => x.id === id) : null);
    if (id && kind !== 'cat' && !find(kind === 'txn' ? state.transactions : kind === 'liab' ? state.liabilities : state.goals)) { clearDraft(); return; }
    if (kind === 'txn') txnForm(find(state.transactions));
    else if (kind === 'liab') liabForm(find(state.liabilities), type);
    else if (kind === 'goal') goalForm(find(state.goals));
    else if (kind === 'contribute') contributeForm(find(state.goals));
    else if (kind === 'cat') catForm();
    else { clearDraft(); return; }
    if (d.ttype) {
      const r = modal.querySelector('input[name=ttype][value="' + d.ttype + '"]');
      if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    Object.keys(d.values || {}).forEach(k => { const e = document.getElementById(k); if (e && modal.contains(e)) e.value = d.values[k]; });
    if (d.items && d.items.length && $('#itemRows')) {
      $('#itemRows').innerHTML = d.items.map(([n, a]) => itemRow({ name: n, amount: a })).join('');
      $('#receiptBox').open = true;
      updateItemsSum();
    }
    $('#modalNote').textContent = 'Restored what you were typing before the page closed.';
  }

  modal.addEventListener('input', saveDraft);
  modal.addEventListener('change', saveDraft);
  modal.addEventListener('click', e => { if (e.target.closest('#addItem, [data-rm-item], #useItems')) setTimeout(saveDraft); });
  // 'close' fires for Save, Cancel, Esc and Delete, but not when the page itself is closed or reloaded.
  modal.addEventListener('close', () => { draftDesc = null; clearDraft(); });

  $('#modalForm').addEventListener('submit', e => {
    e.preventDefault();
    if (onSave && onSave() !== false) { closeModal(); save(); }
  });
  modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  $('#modalDelete').addEventListener('click', () => {
    if (onDelete && confirm('Delete this? This can\'t be undone.')) { onDelete(); closeModal(); save(); }
  });

  function catOptions(selected, includeIncome) {
    return (includeIncome ? '<option value="income"' + (selected === 'income' ? ' selected' : '') + '>Income</option>' : '') +
      state.categories.map(c => '<option value="' + c.id + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
  }

  function itemRow(it) {
    return '<li class="item-row"><input class="it-name" placeholder="Item" value="' + esc(it ? it.name : '') + '" aria-label="Item name"><input class="it-amt" inputmode="decimal" placeholder="0.00" value="' + (it ? it.amount : '') + '" aria-label="Item amount"><button type="button" class="icon-btn" data-rm-item aria-label="Remove item">✕</button></li>';
  }

  function txnForm(t) {
    const isNew = !t;
    t = t || { type: 'expense', amount: '', date: viewMonth === monthKey(new Date()) ? todayISO() : viewMonth + '-01', merchant: '', categoryId: lastCategory(), note: '', items: [] };
    const body =
      '<div class="seg" role="radiogroup"><label><input type="radio" name="ttype" value="expense"' + (t.type === 'expense' ? ' checked' : '') + '><span>Expense</span></label><label><input type="radio" name="ttype" value="income"' + (t.type === 'income' ? ' checked' : '') + '><span>Income</span></label></div>' +
      '<div class="form-grid">' +
      field('Amount', '<input id="f-amount" inputmode="decimal" placeholder="0.00" value="' + (t.amount || '') + '" required>') +
      field('Date', '<input id="f-date" type="date" value="' + t.date + '" required>') +
      field('Merchant or source', '<input id="f-merchant" placeholder="e.g. Trader Joe\'s" value="' + esc(t.merchant) + '">', 'full') +
      field('Category', '<select id="f-cat">' + catOptions(t.type === 'income' ? 'income' : t.categoryId, t.type === 'income') + '</select>') +
      field('Note', '<input id="f-note" placeholder="Optional" value="' + esc(t.note) + '">') +
      '</div>' +
      '<details class="receipt" id="receiptBox"' + (t.items && t.items.length ? ' open' : '') + '><summary>Itemize receipt <span class="muted small" id="itemsSum"></span></summary>' +
      '<ul class="item-rows" id="itemRows">' + (t.items || []).map(itemRow).join('') + '</ul>' +
      '<div class="row-actions"><button type="button" class="btn btn-ghost btn-sm" id="addItem">+ Add item</button><button type="button" class="btn btn-ghost btn-sm" id="useItems">Use items total as amount</button></div></details>';

    openModal(isNew ? 'Add transaction' : 'Edit transaction', body, () => {
      const type = modal.querySelector('input[name=ttype]:checked').value;
      const amount = num(val('f-amount'));
      if (!(amount > 0)) return fail('Enter an amount greater than zero.');
      const date = val('f-date');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Pick a date.');
      const items = readItems();
      if (items === null) return fail('Each receipt item needs a name and an amount.');
      const rec = isNew ? { id: uid(), created: Date.now() } : t;
      Object.assign(rec, { type, amount: round2(amount), date, merchant: val('f-merchant'), categoryId: type === 'income' ? 'income' : val('f-cat'), note: val('f-note'), items });
      if (isNew) state.transactions.push(rec);
      viewMonth = date.slice(0, 7);
    }, isNew ? null : () => { state.transactions = state.transactions.filter(x => x.id !== t.id); }, null, { kind: 'txn', id: isNew ? null : t.id });

    modal.querySelectorAll('input[name=ttype]').forEach(r => r.addEventListener('change', () => {
      const inc = r.value === 'income' && r.checked;
      if (r.checked) $('#f-cat').innerHTML = catOptions(inc ? 'income' : (t.categoryId !== 'income' ? t.categoryId : ''), inc);
    }));
    $('#addItem').addEventListener('click', () => { $('#itemRows').insertAdjacentHTML('beforeend', itemRow()); $('#itemRows').lastElementChild.querySelector('input').focus(); updateItemsSum(); });
    $('#useItems').addEventListener('click', () => { const s = itemsTotal(); if (s > 0) $('#f-amount').value = s.toFixed(2); updateItemsSum(); });
    $('#itemRows').addEventListener('click', e => { if (e.target.closest('[data-rm-item]')) { e.target.closest('li').remove(); updateItemsSum(); } });
    $('#itemRows').addEventListener('input', updateItemsSum);

    // Autocomplete: picking a past merchant also fills its usual category, amount and note.
    attachAutocomplete($('#f-merchant'), () => pastEntries(x => [[x.merchant]]).map(e => {
      const t = e.last;
      e.sub = (t.type === 'income' ? '+' : '') + money(t.amount) + ' · ' + catById(t.categoryId).name + ' · ' + e.count + '×';
      return e;
    }), e => {
      const last = e.last;
      const radio = modal.querySelector('input[name=ttype][value="' + last.type + '"]');
      if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
      const cat = $('#f-cat');
      if (cat && Array.from(cat.options).some(o => o.value === last.categoryId)) cat.value = last.categoryId;
      const amt = $('#f-amount');
      if (!amt.value.trim()) { amt.value = last.amount; updateItemsSum(); }
      if (!val('f-note') && last.note) $('#f-note').value = last.note;
      saveDraft();
    });
    attachAutocomplete($('#f-note'), () => pastEntries(x => [[x.note]]));
    const itemSource = () => pastEntries(x => (x.items || []).map(i => [i.name, i])).map(e => { e.sub = money(e.last.amount); return e; });
    const wireItem = row => {
      const name = row.querySelector('.it-name');
      if (!name || name.dataset.ac) return;
      name.dataset.ac = '1';
      attachAutocomplete(name, itemSource, e => { const a = row.querySelector('.it-amt'); if (!a.value.trim()) { a.value = e.last.amount; updateItemsSum(); saveDraft(); } });
    };
    modal.querySelectorAll('.item-row').forEach(wireItem);
    new MutationObserver(() => modal.querySelectorAll('.item-row').forEach(wireItem)).observe($('#itemRows'), { childList: true });
    $('#f-amount').addEventListener('input', updateItemsSum);
    updateItemsSum();
  }

  // ---------- autocomplete from past entries ----------
  // Remembers merchants, notes and receipt items you've typed before, most used first.
  function pastEntries(pick) {
    const map = new Map();
    state.transactions.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.created || 0) - (b.created || 0)).forEach(t => {
      pick(t).forEach(([text, extra]) => {
        const v = (text || '').trim(); if (!v) return;
        const key = v.toLowerCase();
        const e = map.get(key) || { value: v, count: 0 };
        e.count++; e.value = v; e.last = extra || t; map.set(key, e);
      });
    });
    return Array.from(map.values());
  }

  function attachAutocomplete(input, source, onPick) {
    const wrap = input.parentNode;
    wrap.classList.add('ac-wrap');
    const box = document.createElement('ul');
    box.className = 'ac-list'; box.hidden = true; box.setAttribute('role', 'listbox');
    input.after(box);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-autocomplete', 'list');
    let items = [], active = -1;
    function show() {
      const q = input.value.trim().toLowerCase();
      const all = source();
      items = all.filter(e => !q || e.value.toLowerCase().includes(q)).filter(e => e.value.toLowerCase() !== q)
        .sort((a, b) => (b.value.toLowerCase().startsWith(q) - a.value.toLowerCase().startsWith(q)) || b.count - a.count).slice(0, 6);
      active = items.length && q ? 0 : -1;
      if (!items.length) { box.hidden = true; return; }
      box.innerHTML = items.map((e, i) => '<li role="option" data-i="' + i + '" class="' + (i === active ? 'on' : '') + '"><span>' + esc(e.value) + '</span>' + (e.sub ? '<small>' + esc(e.sub) + '</small>' : '') + '</li>').join('');
      box.hidden = false;
    }
    function hide() { box.hidden = true; active = -1; }
    function choose(i) { const e = items[i]; if (!e) return; input.value = e.value; hide(); if (onPick) onPick(e); input.dispatchEvent(new Event('input', { bubbles: true })); hide(); }
    input.addEventListener('input', e => { if (e.isTrusted) show(); });
    input.addEventListener('focus', show);
    input.addEventListener('blur', () => setTimeout(hide, 120));
    input.addEventListener('keydown', e => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        box.querySelectorAll('li').forEach((li, i) => li.classList.toggle('on', i === active));
      } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }
    });
    box.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
  }

  function lastCategory() {
    const t = state.transactions.filter(x => x.type === 'expense' && !x.liabilityId && x.created > 0).sort((x, y) => (y.created || 0) - (x.created || 0))[0];
    if (t && state.categories.some(c => c.id === t.categoryId)) return t.categoryId;
    const g = state.categories.find(c => /grocer/i.test(c.name)) || state.categories[0];
    return g ? g.id : '';
  }
  function itemsTotal() { let s = 0; modal.querySelectorAll('.item-row').forEach(r => { const v = num(r.querySelector('.it-amt').value); if (isFinite(v)) s += v; }); return round2(s); }
  function updateItemsSum() {
    const rows = modal.querySelectorAll('.item-row').length;
    const s = itemsTotal(), a = num(val('f-amount'));
    const el = $('#itemsSum');
    if (!rows) { el.textContent = ''; el.className = 'muted small'; return; }
    const diff = isFinite(a) ? round2(a - s) : 0;
    el.textContent = rows + ' items · ' + money(s) + (diff ? (diff > 0 ? ' · ' + money(diff) + ' unassigned' : ' · ' + money(-diff) + ' more than amount') : ' · matches');
    el.className = 'small ' + (diff ? 'warn' : 'pos');
  }
  function readItems() {
    const out = [];
    let bad = false;
    modal.querySelectorAll('.item-row').forEach(r => {
      const name = r.querySelector('.it-name').value.trim(), amt = num(r.querySelector('.it-amt').value);
      if (!name && !r.querySelector('.it-amt').value.trim()) return;
      if (!name || !isFinite(amt)) { bad = true; return; }
      out.push({ name, amount: round2(amt) });
    });
    return bad ? null : out;
  }

  function liabForm(l, type) {
    const isNew = !l;
    l = l || { type: type || 'bill', name: '', payment: '', dueDay: 1, balance: '', apr: '', categoryId: (state.categories.find(c => /util|hous/i.test(c.name)) || state.categories[0] || {}).id };
    const debt = l.type === 'debt';
    const body = '<div class="form-grid">' +
      field('Name', '<input id="l-name" placeholder="' + (debt ? 'e.g. Visa card, Car loan' : 'e.g. Rent, Phone, Netflix') + '" value="' + esc(l.name) + '" required>', 'full') +
      field(debt ? 'Monthly payment' : 'Amount per month', '<input id="l-pay" inputmode="decimal" placeholder="0.00" value="' + (l.payment || '') + '">') +
      field('Due day of month', '<input id="l-due" type="number" min="1" max="31" value="' + (l.dueDay || 1) + '">') +
      (debt ? field('Current balance', '<input id="l-bal" inputmode="decimal" placeholder="0.00" value="' + (l.balance || '') + '">') + field('Interest rate (APR %)', '<input id="l-apr" inputmode="decimal" placeholder="e.g. 19.99" value="' + (l.apr || '') + '">') : '') +
      field('Category for payments', '<select id="l-cat">' + catOptions(l.categoryId) + '</select>', 'full') +
      '</div>';
    openModal(isNew ? (debt ? 'Add debt' : 'Add bill') : 'Edit ' + (debt ? 'debt' : 'bill'), body, () => {
      const name = val('l-name'); if (!name) return fail('Give it a name.');
      const pay = num(val('l-pay')); if (!(pay > 0)) return fail('Enter the monthly amount.');
      const due = Math.min(31, Math.max(1, parseInt(val('l-due'), 10) || 1));
      const rec = isNew ? { id: uid(), type: l.type } : l;
      Object.assign(rec, { name, payment: round2(pay), dueDay: due, categoryId: val('l-cat') });
      if (debt) {
        const bal = num(val('l-bal')); if (!(bal >= 0)) return fail('Enter the current balance.');
        const apr = num(val('l-apr'));
        rec.balance = round2(bal); rec.apr = isFinite(apr) && apr > 0 ? apr : 0;
      }
      if (isNew) state.liabilities.push(rec);
    }, isNew ? null : () => { state.liabilities = state.liabilities.filter(x => x.id !== l.id); }, null, { kind: 'liab', id: isNew ? null : l.id, type: l.type });
  }

  function goalForm(g) {
    const isNew = !g;
    g = g || { name: '', target: '', saved: '', date: '', monthly: '' };
    const body = '<div class="form-grid">' +
      field('Goal', '<input id="g-name" placeholder="e.g. Emergency fund" value="' + esc(g.name) + '" required>', 'full') +
      field('Target amount', '<input id="g-target" inputmode="decimal" placeholder="0.00" value="' + (g.target || '') + '">') +
      field('Saved so far', '<input id="g-saved" inputmode="decimal" placeholder="0.00" value="' + (g.saved || '') + '">') +
      field('Target date (optional)', '<input id="g-date" type="month" value="' + (g.date ? g.date.slice(0, 7) : '') + '">') +
      field('Monthly contribution (optional)', '<input id="g-monthly" inputmode="decimal" placeholder="Uses your savings rate" value="' + (g.monthly || '') + '">') +
      '</div>';
    openModal(isNew ? 'Add goal' : 'Edit goal', body, () => {
      const name = val('g-name'); if (!name) return fail('Name your goal.');
      const target = num(val('g-target')); if (!(target > 0)) return fail('Enter a target amount.');
      const saved = num(val('g-saved')); const monthly = num(val('g-monthly'));
      const d = val('g-date');
      const rec = isNew ? { id: uid() } : g;
      Object.assign(rec, { name, target: round2(target), saved: isFinite(saved) && saved > 0 ? round2(saved) : 0, date: d ? d + '-01' : '', monthly: isFinite(monthly) && monthly > 0 ? round2(monthly) : 0 });
      if (isNew) state.goals.push(rec);
    }, isNew ? null : () => { state.goals = state.goals.filter(x => x.id !== g.id); }, null, { kind: 'goal', id: isNew ? null : g.id });
  }

  function contributeForm(g) {
    openModal('Add money to ' + g.name, field('Amount', '<input id="c-amt" inputmode="decimal" placeholder="0.00">'), () => {
      const a = num(val('c-amt')); if (!isFinite(a) || a === 0) return fail('Enter an amount.');
      g.saved = round2(Math.max(0, g.saved + a));
    }, null, 'Add', { kind: 'contribute', id: g.id });
  }

  function catForm() {
    openModal('Add category', '<div class="form-grid">' + field('Name', '<input id="k-name" placeholder="e.g. Pets" required>') + field('Monthly budget', '<input id="k-budget" inputmode="decimal" placeholder="0.00">') + '</div>', () => {
      const name = val('k-name'); if (!name) return fail('Name the category.');
      const b = num(val('k-budget'));
      state.categories.push({ id: uid(), name, budget: isFinite(b) && b > 0 ? round2(b) : 0 });
    }, null, null, { kind: 'cat' });
  }

  // ---------- actions ----------
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case 'add-txn': txnForm(); break;
      case 'edit-txn': txnForm(state.transactions.find(t => t.id === id)); break;
      case 'add-liab': liabForm(null, b.dataset.type); break;
      case 'edit-liab': liabForm(state.liabilities.find(l => l.id === id)); break;
      case 'add-goal': goalForm(); break;
      case 'edit-goal': goalForm(state.goals.find(g => g.id === id)); break;
      case 'contribute': contributeForm(state.goals.find(g => g.id === id)); break;
      case 'add-cat': catForm(); break;
      case 'pick-plan': selectedPlan = id; render(); break;
      case 'apply-plan': applyPlan(id); break;
      case 'use-income': state.income = detectedIncome(); save(); break;
      case 'search-pattern': txnFilter = { q: b.dataset.q, cat: '' }; location.hash = '#transactions'; window.scrollTo(0, 0); break;
      case 'dismiss-strain': { const k = monthKey(new Date()); state.dismissedStrain = state.dismissedStrain || {}; (state.dismissedStrain[k] = state.dismissedStrain[k] || []).push(id); save(); break; }
      case 'view-cat': txnFilter = { q: '', cat: id }; if (location.hash === '#transactions') render(); else location.hash = '#transactions'; window.scrollTo(0, 0); break;
      case 'toggle-essential': { const c = state.categories.find(x => x.id === id); if (c) { c.essential = !isEssential(c); save(); } break; }
      case 'del-cat': {
        const c = state.categories.find(x => x.id === id);
        const used = state.transactions.some(t => t.categoryId === id);
        if (confirm('Delete "' + c.name + '"?' + (used ? ' Its transactions will become uncategorized.' : ''))) {
          state.categories = state.categories.filter(x => x.id !== id); save();
        }
        break;
      }
      case 'pay': {
        const l = state.liabilities.find(x => x.id === id);
        const days = daysInMonth(viewMonth);
        const isCurrent = viewMonth === monthKey(new Date());
        const d = isCurrent ? todayISO() : viewMonth + '-' + pad(Math.min(l.dueDay || 1, days));
        state.transactions.push({ id: uid(), created: Date.now(), type: 'expense', amount: l.payment, date: d, merchant: l.name, categoryId: l.categoryId, note: l.type === 'debt' ? 'Debt payment' : 'Bill', items: [], liabilityId: l.id });
        if (l.type === 'debt') { const interest = (l.balance || 0) * ((l.apr || 0) / 100 / 12); l.balance = round2(Math.max(0, l.balance - Math.max(0, l.payment - interest))); }
        save(); break;
      }
      case 'unpay': {
        const t = paymentFor(id, viewMonth);
        const l = state.liabilities.find(x => x.id === id);
        if (t) {
          if (l && l.type === 'debt') { const r = (l.apr || 0) / 100 / 12; l.balance = round2((l.balance + t.amount) / (1 + r)); }
          state.transactions = state.transactions.filter(x => x !== t);
        }
        save(); break;
      }
      case 'sample': loadSample(); break;
    }
  });

  $('#addTxnBtn').addEventListener('click', () => txnForm());
  $('#prevMonth').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, -1); render(); });
  $('#nextMonth').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, 1); render(); });
  window.addEventListener('hashchange', render);

  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'budgt-backup-' + todayISO() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importFile').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(txt => {
      const s = JSON.parse(txt);
      if (!s || !Array.isArray(s.categories) || !Array.isArray(s.transactions)) throw new Error('bad');
      if (confirm('Replace everything in Budgt with this backup?')) { state = Object.assign(blankState(), s); save(); }
    }).catch(() => alert('That file isn\'t a Budgt backup.')).finally(() => { e.target.value = ''; });
  });

  // ---------- sample data ----------
  function loadSample() {
    const s = blankState();
    const cat = n => s.categories.find(c => c.name === n).id;
    const budgets = { Housing: 1600, Groceries: 600, Dining: 250, Transport: 300, Utilities: 220, Health: 100, Entertainment: 120, Shopping: 200, Other: 100 };
    s.categories.forEach(c => { c.budget = budgets[c.name] || 0; });
    const cur = monthKey(new Date());
    const today = new Date().getDate();
    let seed = 7;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const add = (k, day, type, amount, merchant, catName, items) => {
      if (k === cur && day > today) return;
      s.transactions.push({ id: uid(), created: 0, type, amount: round2(amount), date: k + '-' + pad(Math.min(day, daysInMonth(k))), merchant, categoryId: type === 'income' ? 'income' : cat(catName), note: '', items: items || [] });
    };
    for (let i = 5; i >= 0; i--) {
      const k = shiftMonth(cur, -i);
      add(k, 1, 'income', 2150, 'Paycheck', null); add(k, 15, 'income', 2150, 'Paycheck', null);
      add(k, 1, 'expense', 1450, 'Rent', 'Housing'); add(k, 12, 'expense', 95 + rnd() * 40, 'Power & water', 'Utilities'); add(k, 18, 'expense', 65, 'Phone', 'Utilities');
      for (let w = 0; w < 4; w++) add(k, 3 + w * 7, 'expense', 90 + rnd() * 70, ['Trader Joe\'s', 'Safeway', 'Costco', 'Aldi'][w], 'Groceries');
      for (let d = 0; d < 5; d++) add(k, 2 + Math.floor(rnd() * 27), 'expense', 12 + rnd() * 45, ['Chipotle', 'Blue Bottle', 'Pizza night', 'Thai Basil', 'Sushi Go'][d], 'Dining');
      add(k, 6, 'expense', 48 + rnd() * 20, 'Shell', 'Transport'); add(k, 20, 'expense', 44 + rnd() * 20, 'Chevron', 'Transport');
      add(k, 9, 'expense', 15.99, 'Netflix', 'Entertainment'); add(k, 22, 'expense', 30 + rnd() * 60, 'Movie tickets', 'Entertainment');
      add(k, 14, 'expense', 40 + rnd() * 140, 'Target', 'Shopping');
      if (rnd() > 0.5) add(k, 25, 'expense', 25 + rnd() * 60, 'CVS Pharmacy', 'Health');
    }
    for (let i = 2; i >= 0; i--) {
      const k = shiftMonth(cur, -i);
      [4, 11, 18, 25].forEach(d => { if (!(k === cur && d > today)) s.transactions.push({ id: uid(), created: 0, type: 'expense', amount: 27.99, date: k + '-' + pad(d), merchant: 'Corner Mart', categoryId: cat('Other'), note: 'Vape', items: [] }); });
    }
    add(cur, Math.min(today, 2), 'expense', 64.37, 'Target', 'Shopping', [{ name: 'Towels', amount: 24.99 }, { name: 'Laundry detergent', amount: 13.49 }, { name: 'Phone charger', amount: 19.99 }, { name: 'Tax', amount: 5.9 }]);
    s.liabilities = [
      { id: uid(), type: 'bill', name: 'Rent', payment: 1450, dueDay: 1, categoryId: cat('Housing') },
      { id: uid(), type: 'bill', name: 'Phone', payment: 65, dueDay: 18, categoryId: cat('Utilities') },
      { id: uid(), type: 'bill', name: 'Netflix', payment: 15.99, dueDay: 9, categoryId: cat('Entertainment') },
      { id: uid(), type: 'debt', name: 'Car loan', payment: 310, dueDay: 5, balance: 8420, apr: 6.4, categoryId: cat('Transport') },
      { id: uid(), type: 'debt', name: 'Visa card', payment: 120, dueDay: 24, balance: 2150, apr: 22.9, categoryId: cat('Other') },
    ];
    s.transactions.forEach(t => { const l = s.liabilities.find(x => x.type === 'bill' && x.name === (t.merchant === 'Phone' ? 'Phone' : t.merchant)); if (l) t.liabilityId = l.id; });
    const in9 = new Date(); in9.setMonth(in9.getMonth() + 9);
    s.goals = [
      { id: uid(), name: 'Emergency fund', target: 10000, saved: 4200, date: monthKey(in9) + '-01', monthly: 500 },
      { id: uid(), name: 'Vacation', target: 2500, saved: 650, date: '', monthly: 0 },
    ];
    state = s; viewMonth = cur;
    save();
  }

  // Another open tab changed the data: pick it up instead of overwriting it later.
  window.addEventListener('storage', e => {
    if (e.key === STORE_KEY && e.newValue) { state = load(); render(); }
  });

  render();
  if (localStorage.getItem(STORE_KEY)) setSaveStatus('All changes saved');
  restoreDraft();
})();
