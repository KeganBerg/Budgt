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
  const PALETTE = ['#0f766e', '#2563eb', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#65a30d', '#db2777', '#64748b'];

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
  function cumulativeSeries(k) {
    const days = daysInMonth(k);
    const daily = new Array(days).fill(0);
    txnsIn(k).forEach(t => { if (t.type === 'expense') daily[Number(t.date.slice(8, 10)) - 1] += t.amount; });
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
    const top = Math.max(1, spentNow, prev[prev.length - 1] || 0, budget, projected);
    const step = niceStep(top, H > 300 ? 5 : 4);
    const max = Math.ceil(top / step) * step;
    const x = (i, len) => P.l + (i / Math.max(1, len - 1)) * (W - P.l - P.r);
    const y = v => H - P.b - (v / max) * (H - P.t - P.b);
    const path = (arr, len) => arr.map((v, i) => (i ? 'L' : 'M') + x(i, len).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    let svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" style="--axis-fs:' + fs.toFixed(1) + 'px" role="img" aria-label="Cumulative spending this month compared with last month">';
    for (let v = 0; v <= max + 0.001; v += step) {
      svg += '<line class="grid-line" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="axis" x="' + (P.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + esc(compact(v)) + '</text>';
    }
    if (budget > 0) svg += '<line class="budget-line" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(budget) + '" y2="' + y(budget) + '"/><text class="axis budget-label" x="' + (W - P.r) + '" y="' + (y(budget) - 6) + '" text-anchor="end">Budget ' + esc(money0(budget)) + '</text>';
    if (prev[prev.length - 1] > 0) svg += '<path class="line-prev" d="' + path(prev, prev.length) + '"/>';
    const curPts = cur.slice(0, upTo);
    svg += '<path class="line-area" d="' + path(curPts, days) + ' L' + x(upTo - 1, days) + ' ' + y(0) + ' L' + x(0, days) + ' ' + y(0) + ' Z"/>';
    svg += '<path class="line-cur" d="' + path(curPts, days) + '"/>';
    if (projected) svg += '<path class="line-proj" d="M' + x(upTo - 1, days) + ' ' + y(spentNow) + ' L' + x(days - 1, days) + ' ' + y(projected) + '"/><text class="axis proj-label" x="' + (W - P.r) + '" y="' + (y(projected) + (y(projected) < P.t + 16 ? 14 : -6)) + '" text-anchor="end">On pace for ' + esc(money0(projected)) + '</text>';
    svg += '<circle class="line-dot" cx="' + x(upTo - 1, days) + '" cy="' + y(spentNow) + '" r="4.5"/>';
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

  function currentView() { const v = location.hash.slice(1); return views.includes(v) ? v : 'dashboard'; }

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

    html += '<div class="grid">';
    html += '<div class="card span-2 card-fill"><div class="card-head"><h3>Spending this month</h3><div class="legend"><span class="lg lg-cur">' + esc(monthName(viewMonth, { month: 'short' })) + '</span><span class="lg lg-prev">' + esc(monthName(shiftMonth(viewMonth, -1), { month: 'short' })) + '</span>' + (viewMonth === monthKey(new Date()) ? '<span class="lg lg-proj">Pace</span>' : '') + '</div></div>' + spendingSummary(viewMonth) + '<div class="chart-fill">' + lineChart(viewMonth) + '</div></div>';

    html += '<div class="card"><div class="card-head"><h3>Upcoming bills</h3><a href="#liabilities" class="small-link">Manage</a></div>' + upcomingBills() + '</div>';

    html += '<div class="card"><div class="card-head"><h3>Top spending</h3><a href="#transactions" class="small-link">Details</a></div>' + topSpending(viewMonth) + '</div>';

    html += '<div class="card span-2"><div class="card-head"><h3>Ways to cut back</h3><a href="#budget" class="small-link">Essentials</a></div>' + cutBackTips(viewMonth) + '</div>';

    html += '<div class="card span-2"><div class="card-head"><h3>Income vs spending</h3><div class="legend"><span class="lg lg-inc">Income</span><span class="lg lg-exp">Spending</span></div></div>' + barChart(viewMonth) + '</div>';

    html += '<div class="card"><div class="card-head"><h3>Savings outlook</h3><a href="#goals" class="small-link">Goals</a></div>' + goalsOutlook(true) + '</div>';

    html += '<div class="card span-2"><div class="card-head"><h3>Budget by category</h3><a href="#budget" class="small-link">Edit budget</a></div>' + categoryBars(viewMonth, 6) + '</div>';

    html += '<div class="card"><div class="card-head"><h3>Recent transactions</h3><a href="#transactions" class="small-link">See all</a></div>' + txnList(list.slice().sort(byDateDesc).slice(0, 6), true) + '</div>';
    html += '</div>';
    el.innerHTML = html;
    fitSpendingChart();
  }

  function statCard(label, value, sub, tone) {
    return '<div class="card stat"><p class="stat-label">' + label + '</p><p class="stat-value">' + value + '</p><p class="stat-sub ' + (tone || '') + '">' + sub + '</p></div>';
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
      return '<li><span class="tc-rank">' + (i + 1) + '</span><div class="tc-body"><div class="tc-line"><span class="tc-name">' + esc(c.name) + '</span><span class="tag' + (isEssential(c) ? '' : ' tag-flex') + '">' + (isEssential(c) ? 'Essential' : 'Flexible') + '</span><b class="tc-amt">' + money0(spent[id]) + '</b></div>' +
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
      return '<li class="tip"><div class="tip-head"><span class="dot" style="background:' + catColor(c.id) + '"></span><b>' + esc(c.name) + '</b><span class="tip-save">Save ~' + money0(tip.save) + '/mo</span></div><p>' + esc(tip.headline) + '</p><ul class="tip-ideas">' + tip.ideas.slice(0, 3).map(i => '<li>' + esc(i) + '</li>').join('') + '</ul></li>';
    });
    const goal = state.goals.find(g => g.saved < g.target);
    const lead = '<p class="tip-lead">Cutting back here could free up about <b>' + money0(totalSave) + ' a month</b>' + (goal ? ' for your ' + esc(goal.name) : '') + '. Housing, groceries, transport and other essentials are left out.</p>';
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
      return '<li><span class="dot" style="background:' + catColor(c.id) + '"></span><span class="cb-name">' + esc(c.name) + '</span><span class="cb-bar"><i style="width:' + Math.min(100, pct * 100).toFixed(1) + '%;background:' + (over ? 'var(--neg)' : catColor(c.id)) + '"></i></span><span class="cb-amt' + (over ? ' neg' : '') + '">' + money0(s) + (c.budget ? '<small> / ' + money0(c.budget) + '</small>' : '') + '</span></li>';
    }).join('') + '</ul>';
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
      '<p class="muted small">' + list.length + ' transactions · In ' + money(sumBy(all, 'income')) + ' · Out ' + money(sumBy(all, 'expense')) + '</p>' + txnList(list, false) + '</div>';
    const s = $('#txnSearch');
    s.addEventListener('input', () => { txnFilter.q = s.value; const pos = s.selectionStart; renderTransactions(); const n = $('#txnSearch'); n.focus(); n.setSelectionRange(pos, pos); });
    $('#txnCat').addEventListener('change', e => { txnFilter.cat = e.target.value; renderTransactions(); });
  }

  function renderBudget() {
    const el = $('#view-budget');
    const spent = spentByCat(viewMonth);
    const budget = totalBudget();
    const spentTotal = sumBy(txnsIn(viewMonth), 'expense');
    const income = sumBy(txnsIn(viewMonth), 'income');
    let html = '<div class="stats three">' + statCard('Monthly budget', money(budget), income ? money0(income) + ' income this month' : 'Across ' + state.categories.filter(c => c.budget > 0).length + ' categories', '') +
      statCard('Spent', money(spentTotal), budget ? Math.round((spentTotal / budget) * 100) + '% of budget' : '', spentTotal > budget && budget ? 'neg' : '') +
      statCard('Remaining', money(budget - spentTotal), budget - spentTotal < 0 ? 'Over budget' : 'Left for ' + monthName(viewMonth, { month: 'long' }), budget - spentTotal < 0 ? 'neg' : 'pos') + '</div>';
    html += '<div class="card"><div class="card-head"><h3>Categories</h3><button class="btn btn-ghost btn-sm" data-act="add-cat">+ Category</button></div><p class="muted small">Type a monthly limit for each category. Tap Essential or Flexible to choose which ones get cut-back tips.</p><ul class="budget-rows">';
    html += state.categories.map(c => {
      const s = spent[c.id] || 0;
      const pct = c.budget ? s / c.budget : 0;
      const over = c.budget && s > c.budget;
      return '<li>' + donut(pct, over ? 'var(--neg)' : catColor(c.id)) + '<div class="br-name"><input class="inline" data-cat-name="' + c.id + '" value="' + esc(c.name) + '" aria-label="Category name"><small class="' + (over ? 'neg' : 'muted') + '">' + money(s) + ' spent' + (c.budget ? ' · ' + (over ? money(s - c.budget) + ' over' : money(c.budget - s) + ' left') : '') + '</small></div>' +
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
      statCard('Debt-free by', debtFreeDate(debts), 'Paying the minimums', '') + '</div>';
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
      statCard('Your savings rate', money0(avg) + '/mo', 'Average income minus spending, recent months', avg >= 0 ? 'pos' : 'neg') +
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
    $('#f-amount').addEventListener('input', updateItemsSum);
    updateItemsSum();
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
