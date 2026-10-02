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
      funds: [],    // yearly and irregular costs saved for a little each month (sinking funds)
      sweeps: {},   // month key -> what was done with that month's leftover budget
      openings: {}, // month key -> account balance on the 1st
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
  function num(v) {
    let t = String(v).trim();
    if (/^-?\$?\s?\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');   // decimal comma, e.g. 12,50
    const n = parseFloat(t.replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : NaN;
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // The item as it is in state now (another tab's save replaces state); re-added if that tab deleted it.
  function fresh(list, obj) {
    const cur = list.find(x => x.id === obj.id);
    if (cur) return cur;
    list.push(obj);
    return obj;
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
  function debtFor(t) { const l = t && t.liabilityId && state.liabilities.find(x => x.id === t.liabilityId); return l && l.type === 'debt' ? l : null; }
  // Put back what a logged debt payment took off the balance (the reverse of Mark paid).
  function refundDebtPayment(t) {
    const l = debtFor(t);
    if (!l) return;
    if (typeof t.balanceDelta === 'number') l.balance = round2(l.balance + t.balanceDelta);
    else { const r = (l.apr || 0) / 100 / 12; l.balance = round2((l.balance + t.amount) / (1 + r)); }   // payments logged before balanceDelta existed
  }

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
    // Margins grow with the label size, so on a narrow phone (big fs) axis labels never collide or spill out.
    const W = 600, P = { l: Math.max(46, Math.round(fs * 3.4)), r: 10, t: Math.max(14, Math.round(fs * 0.9)), b: Math.max(24, Math.round(fs * 2.4)) };
    const cur = cumulativeSeries(k);
    const prev = cumulativeSeries(shiftMonth(k, -1));
    const isCurrent = k === monthKey(new Date());
    const upTo = isCurrent ? new Date().getDate() : cur.length;
    const days = cur.length;
    const budget = totalBudget();
    const spentNow = cur[upTo - 1] || 0;
    const projected = isCurrent && upTo < days ? monthPace(k, upTo, spentNow).projected : 0;
    const inc = cumulativeSeries(k, 'income');
    const hasInc = inc[upTo - 1] > 0;
    const top = Math.max(1, spentNow, prev[prev.length - 1] || 0, budget, projected, hasInc ? inc[upTo - 1] : 0);
    // Gridlines about every 45px on screen, so a tall chart gets a finer dollar scale.
    const screenH = H * 11 / fs, screenW = 600 * 11 / fs;
    const step = niceStep(top, Math.max(4, Math.min(10, Math.round(screenH / 45))));
    const max = Math.ceil(top / step) * step;
    const x = (i, len) => P.l + (i / Math.max(1, len - 1)) * (W - P.l - P.r);
    const y = v => H - P.b - (v / max) * (H - P.t - P.b);
    const path = (arr, len) => smoothPath(arr.map((v, i) => [x(i, len), y(v)]));
    let svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" style="--axis-fs:' + fs.toFixed(1) + 'px" role="img" aria-label="Cumulative spending and income this month, compared with last month">';
    for (let v = 0; v <= max + 0.001; v += step) {
      svg += '<line class="grid-line" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="axis" x="' + (P.l - Math.max(8, fs * 0.6)) + '" y="' + (y(v) + fs * 0.35) + '" text-anchor="end">' + esc(compact(v)) + '</text>';
    }
    if (budget > 0) svg += '<line class="budget-line" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(budget) + '" y2="' + y(budget) + '"/><text class="axis budget-label" x="' + (W - P.r) + '" y="' + (y(budget) - fs * 0.55) + '" text-anchor="end">Budget ' + esc(money0(budget)) + '</text>';
    if (prev[prev.length - 1] > 0) svg += '<path class="line-prev" d="' + path(prev, prev.length) + '"/>';
    const curPts = cur.slice(0, upTo);
    if (hasInc) {
      // Shade the gap between income and spending: red where spending is ahead of income, dark where you're still in the black.
      const incPts = inc.slice(0, upTo);
      // Shade between the two curves; clip to above or below the spending curve to color each side.
      const top = y(max) - 2, base = y(0) + 2, xEnd = x(upTo - 1, days).toFixed(1), x0 = x(0, days).toFixed(1);
      const spRev = smoothPath(curPts.map((v, i) => [x(i, days), y(v)]).reverse()).replace(/^M/, 'L');
      const band = path(incPts, days) + ' ' + spRev + ' Z';
      const spLine = path(curPts, days);
      svg += '<defs><clipPath id="clipAbove"><path d="' + spLine + ' L' + xEnd + ' ' + top + ' L' + x0 + ' ' + top + ' Z"/></clipPath>' +
        '<clipPath id="clipBelow"><path d="' + spLine + ' L' + xEnd + ' ' + base + ' L' + x0 + ' ' + base + ' Z"/></clipPath></defs>';
      svg += '<path class="gap-pos" clip-path="url(#clipAbove)" d="' + band + '"/><path class="gap-neg" clip-path="url(#clipBelow)" d="' + band + '"/>';
      svg += '<path class="line-income" d="' + path(incPts, days) + '"/>';
    }
    svg += '<path class="line-cur line-spend" d="' + path(curPts, days) + '"/>';
    if (projected) svg += '<path class="line-proj" d="M' + x(upTo - 1, days) + ' ' + y(spentNow) + ' L' + x(days - 1, days) + ' ' + y(projected) + '"/><text class="axis proj-label" x="' + (W - P.r) + '" y="' + (y(projected) + (y(projected) < P.t + fs * 1.5 ? fs * 1.3 : -fs * 0.55)) + '" text-anchor="end">On pace for ' + esc(money0(projected)) + '</text>';
    svg += '<circle class="line-dot line-spend-dot" cx="' + x(upTo - 1, days) + '" cy="' + y(spentNow) + '" r="4.5"/>';
    if (hasInc) {
      const net = inc[upTo - 1] - spentNow;
      svg += '<text class="axis net-label ' + (net < 0 ? 'neg' : '') + '" x="' + (P.l + 10) + '" y="' + (P.t + fs * 1.6) + '">Net so far ' + (net < 0 ? '−' : '+') + esc(money0(Math.abs(net))) + '</text>';
    }
    // Hover, tap or arrow-key through the days to see the totals for each one (wired up in initChartHover).
    svg += '<g class="hover-mark" visibility="hidden"><line class="hover-line" y1="' + P.t + '" y2="' + (H - P.b) + '"/>' + (hasInc ? '<circle class="hover-dot hd-inc" r="4"/>' : '') + '<circle class="hover-dot hd-spend" r="4"/></g>';
    svg = svg.replace('<svg class="chart"', '<svg class="chart has-hover" tabindex="0" data-hover="' + esc(JSON.stringify({ k: k, cur: curPts.map(round2), inc: hasInc ? inc.slice(0, upTo).map(round2) : null, days: days, l: P.l, r: W - P.r, max: max, top: P.t, bottom: H - P.b })) + '"').replace('this month, compared with last month">', 'this month, compared with last month. Use the left and right arrow keys to step through the days.">');
    (fs > 16 ? [1, 15, days] : (() => { const every = screenW > 1000 ? 3 : screenW > 700 ? 5 : 7, out = []; for (let d = 1; d <= days - Math.ceil(every * 0.8); d += every) out.push(d); return out.concat(days); })()).forEach(d => { svg += '<text class="axis" x="' + x(d - 1, days) + '" y="' + (H - fs * 0.5) + '" text-anchor="' + (d === 1 ? 'start' : d === days ? 'end' : 'middle') + '">' + esc(monthName(k, { month: 'short' })) + ' ' + d + '</text>'; });
    return svg + '</svg>';
  }
  // Monotone cubic curve through the points (no overshoot, so running totals never dip).
  function smoothPath(pts) {
    const n = pts.length;
    if (n < 3) return pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const dx = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1); }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
      if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += ' C' + (pts[i][0] + h).toFixed(1) + ' ' + (pts[i][1] + t[i] * h).toFixed(1) + ' ' + (pts[i + 1][0] - h).toFixed(1) + ' ' + (pts[i + 1][1] - t[i + 1] * h).toFixed(1) + ' ' + pts[i + 1][0].toFixed(1) + ' ' + pts[i + 1][1].toFixed(1);
    }
    return d;
  }
  function compact(v) { return v >= 1000 ? '$' + (v / 1000).toFixed(v % 1000 ? 1 : 0).replace(/\.0$/, '') + 'k' : '$' + Math.round(v); }

  // Bills and debt payments land on fixed days (rent on the 1st), so they can't be averaged across the month.
  // Pace = this month's bills in full + everyday spending extrapolated from its own daily average.
  function billPayment(l, k) {
    const name = (l.name || '').trim().toLowerCase();
    return txnsIn(k).find(t => t.type === 'expense' && (t.liabilityId === l.id || (!t.liabilityId && name && (t.merchant || '').trim().toLowerCase() === name)));
  }
  function monthPace(k, upTo, spent) {
    const days = daysInMonth(k);
    const bills = state.liabilities.filter(l => l.payment > 0 && !(l.type === 'debt' && !(l.balance > 0) && !billPayment(l, k)));
    let paid = 0, left = 0;
    bills.forEach(l => { const t = billPayment(l, k); if (t) paid += t.amount; else left += l.payment; });
    const everyday = Math.max(0, spent - paid);
    const daily = everyday / Math.max(1, upTo);
    return { daily, billsLeft: round2(left), projected: round2(spent + left + daily * (days - upTo)) };
  }

  function spendingSummary(k) {
    const cur = cumulativeSeries(k);
    const isCurrent = k === monthKey(new Date());
    const upTo = isCurrent ? new Date().getDate() : cur.length;
    const spent = cur[upTo - 1] || 0;
    const prev = cumulativeSeries(shiftMonth(k, -1));
    const prevSame = prev[Math.min(upTo, prev.length) - 1] || 0;
    const budget = totalBudget();
    const daysLeft = cur.length - upTo;
    const pace = monthPace(k, upTo, spent);
    const room = budget - spent - pace.billsLeft;   // bills still due this month are already spoken for
    const items = [
      ['Spent so far', money0(spent), ''],
      ['Last month', money0(prevSame), spent > prevSame ? 'neg' : 'pos', 'What you had spent by day ' + upTo + ' last month'],
      ['Daily average', money0(pace.daily), '', 'Everyday spending per day, not counting bills and debt payments'],
      isCurrent && daysLeft > 0
        ? (budget ? ['Safe per day', money0(Math.max(0, room / daysLeft)), room < 0 ? 'neg' : 'pos', pace.billsLeft ? money0(pace.billsLeft) + ' of bills still due this month is set aside first' : ''] : ['Projected month-end', money0(pace.projected), ''])
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
    // Keep the chart at least 340px tall on screen (a little under square on a phone) and its labels about 11px, however wide the card is.
    const scale = 600 / w;
    const minH = w < 480 ? Math.max(220, Math.round(w * 0.82)) : 340;
    const target = Math.min(900, Math.max(Math.round(h * scale), Math.round(minH * scale)));
    const fs = 11 * scale;
    const current = svg.viewBox.baseVal.height;
    if (Math.abs(target - current) > 6 || Math.abs(fs - 11) > 0.5) wrap.innerHTML = lineChart(viewMonth, target, fs);
  }
  // SVG text scales with the chart's width; counter that so axis labels stay about 11px on screen.
  function fitAxisText(root) {
    root.querySelectorAll('svg.chart').forEach(svg => {
      if (svg.closest('.chart-fill') || !svg.clientWidth) return;
      svg.style.setProperty('--axis-fs', (11 * svg.viewBox.baseVal.width / svg.clientWidth).toFixed(1) + 'px');
    });
  }
  // Flyout over the spending chart: which day you're on, both totals and the gap between them.
  function initChartHover() {
    let tip;
    // While hovering, "Spent so far" and "Net so far" follow the day under the cursor; leaving puts back today's values.
    const live = svg => {
      const card = svg.closest('.card'), tile = card && card.querySelector('.chart-stats > div:first-child'), net = svg.querySelector('.net-label');
      return tile ? { label: tile.querySelector('span'), value: tile.querySelector('b'), net: net } : null;
    };
    const setLive = (svg, d, i) => {
      const el = live(svg); if (!el) return;
      if (!el.label.dataset.orig) { el.label.dataset.orig = el.label.textContent; el.value.dataset.orig = el.value.textContent; if (el.net) { el.net.dataset.orig = el.net.textContent; el.net.dataset.origNeg = el.net.classList.contains('neg') ? '1' : ''; } }
      const today = i === d.cur.length - 1, day = monthName(d.k, { month: 'short' }) + ' ' + (i + 1);
      el.label.textContent = today ? el.label.dataset.orig : 'Spent by ' + day;
      el.value.textContent = money0(d.cur[i]);
      if (el.net) { const n = d.inc[i] - d.cur[i]; el.net.textContent = (today ? 'Net so far ' : 'Net by ' + day + ' ') + (n < 0 ? '−' : '+') + money0(Math.abs(n)); el.net.classList.toggle('neg', n < 0); }
    };
    const resetLive = () => document.querySelectorAll('.chart.has-hover').forEach(svg => {
      const el = live(svg); if (!el || !el.label.dataset.orig) return;
      el.label.textContent = el.label.dataset.orig; el.value.textContent = el.value.dataset.orig;
      if (el.net) { el.net.textContent = el.net.dataset.orig; el.net.classList.toggle('neg', !!el.net.dataset.origNeg); }
    });
    const hide = () => {
      if (tip) tip.hidden = true;
      document.querySelectorAll('.chart.has-hover').forEach(svg => { delete svg.dataset.i; svg.querySelector('.hover-mark').setAttribute('visibility', 'hidden'); });
      resetLive();
    };
    const showDay = (svg, d, i, viaKeys) => {
      const step = (d.r - d.l) / Math.max(1, d.days - 1);
      const x = d.l + i * step, y = v => d.bottom - (v / d.max) * (d.bottom - d.top);
      svg.dataset.i = i;
      const g = svg.querySelector('.hover-mark'), dot = (sel, v) => { const c = g.querySelector(sel); if (c) { c.setAttribute('cx', x); c.setAttribute('cy', y(v)); } };
      g.querySelector('line').setAttribute('x1', x); g.querySelector('line').setAttribute('x2', x);
      dot('.hd-spend', d.cur[i]);
      if (d.inc) dot('.hd-inc', d.inc[i]);
      g.setAttribute('visibility', 'visible');
      setLive(svg, d, i);
      const wrap = svg.parentElement;
      if (!tip || !wrap.contains(tip)) { tip = document.createElement('div'); tip.className = 'chart-tip'; wrap.appendChild(tip); }
      // Only announce to screen readers when stepping with the keyboard, not on every mouse move.
      tip.setAttribute('aria-live', viaKeys ? 'polite' : 'off');
      let html = '<b>' + esc(monthName(d.k, { month: 'short' })) + ' ' + (i + 1) + '</b>';
      if (d.inc) {
        const net = d.inc[i] - d.cur[i];
        html += '<span><i class="tip-key tip-inc"></i>Income<em>' + esc(money0(d.inc[i])) + '</em></span>' +
          '<span><i class="tip-key tip-spend"></i>Spent<em>' + esc(money0(d.cur[i])) + '</em></span>' +
          '<span class="tip-net ' + (net < 0 ? 'neg' : '') + '">' + (net < 0 ? 'Spent more by' : net > 0 ? 'Ahead by' : 'Even') + '<em>' + (net ? esc(money0(Math.abs(net))) : '') + '</em></span>';
      } else {
        html += '<span><i class="tip-key tip-spend"></i>Spent<em>' + esc(money0(d.cur[i])) + '</em></span>';
      }
      tip.innerHTML = html;
      tip.hidden = false;
      const wr = wrap.getBoundingClientRect(), sr = svg.getBoundingClientRect(), scale = sr.width / svg.viewBox.baseVal.width;
      const px = sr.left - wr.left + x * scale, tw = tip.offsetWidth;
      const left = px + 12 + tw > wr.width ? px - 12 - tw : px + 12;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = (sr.top - wr.top + y(Math.max(d.cur[i], d.inc ? d.inc[i] : 0)) * scale) + 'px';
    };
    const show = (svg, clientX) => {
      const d = JSON.parse(svg.dataset.hover);
      const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = 0;
      const sx = pt.matrixTransform(svg.getScreenCTM().inverse()).x;
      const n = d.cur.length;
      if (!n || sx < d.l - 10 || sx > d.r + 10) return hide();
      const step = (d.r - d.l) / Math.max(1, d.days - 1);
      showDay(svg, d, Math.max(0, Math.min(n - 1, Math.round((sx - d.l) / step))), false);
    };
    const chartOf = e => e.target.closest && e.target.closest('.chart.has-hover');
    document.addEventListener('pointermove', e => { const svg = chartOf(e); if (svg) show(svg, e.clientX); else if (e.pointerType === 'mouse') hide(); });
    document.addEventListener('pointerdown', e => { const svg = chartOf(e); if (svg) show(svg, e.clientX); else hide(); });
    document.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
    window.addEventListener('scroll', () => { if (tip && !tip.hidden && matchMedia('(hover: none)').matches) hide(); }, { passive: true });
    // Keyboard: focus the chart, then Left/Right (Home/End) step through the days; Escape or leaving the chart closes it.
    document.addEventListener('keydown', e => {
      const svg = chartOf(e); if (!svg) return;
      const d = JSON.parse(svg.dataset.hover), n = d.cur.length; if (!n) return;
      const cur = svg.dataset.i === undefined ? n : +svg.dataset.i;
      const next = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: n - 1 }[e.key];
      if (e.key === 'Escape') return hide();
      if (next === undefined) return;
      e.preventDefault();
      showDay(svg, d, Math.max(0, Math.min(n - 1, next)), true);
    });
    document.addEventListener('focusout', e => { if (chartOf(e)) hide(); });
  }
  initChartHover();
  let fitTimer;
  window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => { if (currentView() === 'dashboard') renderDashboard(); else fitAxisText(document); }, 150); });

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
    $('#monthLabelShort').textContent = monthName(viewMonth, { month: 'short', year: 'numeric' });
    $('.month-picker').style.visibility = (v === 'goals' || v === 'liabilities') ? 'hidden' : '';
    ({ dashboard: renderDashboard, transactions: renderTransactions, budget: renderBudget, liabilities: renderLiabilities, goals: renderGoals })[v]();
    animateChanges($('#view-' + v), v);
  }

  // ---------- motion ----------
  // After a view re-renders, headline numbers count and bars slide from what was on screen before to their new
  // value, so changing month or marking a bill paid shows what moved. Uses the browser's Web Animations API (what
  // Motion's animate() is built on), so nothing extra loads. Everything is skipped under reduced motion.
  const seen = new Map();            // view|card|kind|index -> value last shown
  let lastChartMonth = '';
  const DUR = 450, EASE = 'cubic-bezier(.2,.7,.2,1)';
  const NUM_SEL = '.stat-value, .chart-stats b, .head-stat b, .meter-top b, .ss-mile-top b, .gc-amt b';
  const BAR_SEL = 'i[style*="width:"], i[style*="height:"]';

  function animateChanges(root, view) {
    const ok = !matchMedia('(prefers-reduced-motion: reduce)').matches && 'animate' in Element.prototype;
    const first = !seen.has(view);
    seen.set(view, true);
    const cards = [...root.querySelectorAll('.card')];
    const keyFor = (el, kind, n) => {
      const card = el.closest('.card');
      const name = card ? (card.querySelector('.card-head h3, .stat-label, h3') || {}).textContent || cards.indexOf(card) : '';
      return view + '|' + name + '|' + kind + '|' + n;
    };
    const each = (sel, kind, fn) => {
      const counts = new Map();
      root.querySelectorAll(sel).forEach(el => {
        const card = el.closest('.card'), n = counts.get(card) || 0;
        counts.set(card, n + 1);
        fn(el, keyFor(el, kind, n));
      });
    };

    each(NUM_SEL, 'num', (el, key) => {
      const node = [...el.childNodes].find(c => c.nodeType === 3 && /\d/.test(c.data));
      const m = node && readMoney(node.data);
      if (!m) { seen.delete(key); return; }
      const was = seen.get(key);
      seen.set(key, { v: m.v, pre: m.pre, post: m.post });
      // Only count when just the amount changed, not the sign or wording around it.
      if (ok && was && was.v !== m.v && was.pre === m.pre && was.post === m.post) countTo(node, m, was.v);
    });

    each(BAR_SEL, 'bar', (el, key) => {
      const prop = /(^|;)\s*width:/.test(el.getAttribute('style')) ? 'width' : 'height';
      const to = parseFloat(el.style[prop]) || 0;
      const from = seen.has(key) ? seen.get(key) : (first ? 0 : to);
      seen.set(key, to);
      if (ok && Math.abs(from - to) > 0.2) el.animate([{ [prop]: from + '%' }, { [prop]: to + '%' }], { duration: DUR, easing: EASE });
    });

    // Six-month income and spending bars grow from their old height.
    each('.chart rect[class^="bar-"]', 'col', (el, key) => {
      const to = el.height.baseVal.value, from = seen.has(key) ? seen.get(key) : (first ? 0 : to);
      seen.set(key, to);
      if (ok && to > 0 && Math.abs(from - to) > 0.5) el.animate([{ transform: 'scaleY(' + (from / to) + ')' }, { transform: 'none' }], { duration: DUR, easing: EASE });
    });

    each('.ring-fg', 'ring', (el, key) => {
      const to = el.getAttribute('stroke-dasharray'), from = seen.get(key) || (first ? '0 ' + to.split(' ')[1] : to);
      seen.set(key, to);
      if (ok && from !== to) el.animate([{ strokeDasharray: from }, { strokeDasharray: to }], { duration: DUR, easing: EASE });
    });

    // The spending chart draws in left to right when it shows a different month.
    if (view === 'dashboard') {
      const chart = root.querySelector('.chart-fill svg');
      if (chart && ok && lastChartMonth !== viewMonth) {
        chart.querySelectorAll('.line-spend, .line-income, .line-proj').forEach(p =>
          p.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 600, easing: EASE }));
        // The shaded gap and the labels fade in as the lines finish (the gap keeps its own clip path, so no wipe).
        chart.querySelectorAll('.gap-pos, .gap-neg, .line-dot, .proj-label, .net-label').forEach(p =>
          p.animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.6 }], { duration: 750 }));
      }
      if (chart) lastChartMonth = viewMonth;
    }
  }

  // Find the money amount in a label like "$1,240 over" so it can be counted, using the app's own formatters.
  function readMoney(text) {
    const run = text.match(/\d[\d.,\s  ']*/);
    if (!run) return null;
    const digits = Number(run[0].replace(/\D/g, ''));
    for (const [f, v] of [[money, digits / 100], [money0, digits]]) {
      const s = f(v), i = text.indexOf(s);
      if (i >= 0) return { v, f, pre: text.slice(0, i), post: text.slice(i + s.length), text };
    }
    return null;
  }

  function countTo(node, m, from) {
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / DUR), e = 1 - Math.pow(1 - k, 3);
      node.data = k < 1 ? m.pre + m.f(from + (m.v - from) * e) + m.post : m.text;
      if (k < 1 && node.isConnected) requestAnimationFrame(step);
    };
    node.data = m.pre + m.f(from) + m.post;
    requestAnimationFrame(step);
  }

  function emptyCard(title, text, actions) {
    return '<div class="card empty"><h3>' + title + '</h3><p>' + text + '</p><div class="row-actions">' + actions + '</div></div>';
  }

  function renderDashboard() {
    const el = $('#view-dashboard');
    if (!state.transactions.length && !state.liabilities.length && !state.goals.length) {
      el.innerHTML = emptyCard('Welcome to Budgt',
        'Add your first transaction with the + button, set a monthly budget, or load sample data to look around. You can clear it any time.',
        '<a class="btn" href="#budget">Set a budget</a><button class="btn btn-ghost" data-act="import-csv">Import bank CSV</button><button class="btn btn-ghost" data-act="sample">Load sample data</button>');
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
    const bal = balanceOn(isCurrent ? todayISO() : viewMonth + '-' + pad(daysInMonth(viewMonth)));

    let html = '<div class="stats' + (bal !== null ? ' five' : '') + '">';
    if (bal !== null) html += statCard('Balance', money0(bal), '<button type="button" class="link-btn small-link" data-act="catch-up">Update</button>', bal < 0 ? 'neg' : '');
    html += statCard('Left to spend', budget ? money0(left) : '—', budget ? (left >= 0 ? 'of ' + money0(budget) + ' budget' : money0(-left) + ' over budget') : '<a href="#budget">Set a budget</a>', left < 0 ? 'neg' : '');
    html += statCard('Spent', money0(spent), (diff <= 0 ? money0(-diff) + ' less' : money0(diff) + ' more') + ' than last month', diff > 0 ? 'neg' : 'pos');
    html += statCard('Income', money0(income), (income - spent >= 0 ? '+' : '−') + money0(Math.abs(income - spent)) + ' net', income - spent >= 0 ? 'pos' : 'neg');
    html += statCard('Total debt', money0(debt), state.liabilities.filter(l => l.type === 'debt').length + ' accounts', '');
    html += '</div>';
    html += catchUpBanner() || sweepBanner();
    html += strainBanner();

    html += '<div class="grid">';
    html += '<div class="card span-2 card-fill"><div class="card-head"><h3>Spending this month<button type="button" class="link-btn guide-link" data-act="chart-guide" aria-haspopup="dialog">How to read this</button></h3><div class="legend"><span class="lg lg-spend">Spending</span><span class="lg lg-incline">Income</span><span class="lg lg-prev">' + esc(monthName(shiftMonth(viewMonth, -1), { month: 'short' })) + '</span>' + (viewMonth === monthKey(new Date()) ? '<span class="lg lg-proj">Pace</span>' : '') + '</div></div>' + spendingSummary(viewMonth) + '<div class="chart-fill">' + lineChart(viewMonth) + '</div></div>';

    html += '<div class="card"><div class="card-head"><h3>Upcoming bills</h3><a href="#liabilities" class="small-link">Manage</a></div>' + upcomingBills() + '</div>';

    html += '<div class="card"><div class="card-head"><h3>Top spending' + info('Each category\'s share of this month\'s spending, and how it compares with the same point last month.') + '</h3><a href="#transactions" class="small-link">Details</a></div>' + topSpending(viewMonth) + '</div>';

    const cut = cutBackTips(viewMonth);
    html += '<div class="card span-2 card-fill"><div class="card-head"><h3>Ways to cut back' + info('Only Flexible categories get tips. Housing, groceries, transport and other essentials are left out. Change which categories are essential on the Budget page.') + '</h3>' + (cut.total ? '<span class="head-stat" title="' + (cut.goal ? 'Could go toward your ' + esc(cut.goal.name) : '') + '">Up to <b class="pos">' + money0(cut.total) + '/mo</b></span>' : '') + '</div>' + cut.html + '</div>';

    html += '<div class="card span-2"><div class="card-head"><h3>Income vs spending</h3><div class="legend"><span class="lg lg-inc">Income</span><span class="lg lg-exp">Spending</span></div></div>' + barChart(viewMonth) + '</div>';

    html += '<div class="card card-fill"><div class="card-head"><h3>Savings outlook</h3><a href="#goals" class="small-link">Goals</a></div>' + goalsOutlook(true) + (state.goals.length <= 2 ? savingsSnapshot(viewMonth) : '') + '</div>';

    html += '<div class="card span-2 card-fill"><div class="card-head"><h3>Budget by category' + info('Bubble size is what you spent. The dashed ring is the budget, so a bubble spilling past its ring is over. Drag bubbles around, or click one to see its purchases.') + '</h3><a href="#budget" class="small-link">Edit budget</a></div>' + bubbleChart(viewMonth) + '</div>';

    html += '<div class="card"><div class="card-head"><h3>Recent transactions</h3><a href="#transactions" class="small-link">See all</a></div>' + txnList(list.slice().sort(byDateDesc).slice(0, 6), true) + '</div>';
    html += '</div>';
    el.innerHTML = html;
    fitSpendingChart();
    fitAxisText(el);
    startBubbles();
  }

  // Small (i) marker: extra context lives in a hover/tap tooltip instead of a line of hint text.
  function info(text) { return '<span class="info" tabindex="0" role="note" aria-label="' + esc(text) + '" data-tip="' + esc(text) + '">i</span>'; }
  function statCard(label, value, sub, tone, note) {
    return '<div class="card stat"><p class="stat-label">' + label + (note ? info(note) : '') + '</p><p class="stat-value' + (!sub && tone ? ' ' + tone : '') + '">' + value + '</p>' + (sub ? '<p class="stat-sub ' + (tone || '') + '">' + sub + '</p>' : '') + '</div>';
  }

  // Bills and debt payments due in month k: a debt paid down to $0 has nothing due (unless it was paid off that month).
  function dueIn(k) { return state.liabilities.filter(l => !(l.type === 'debt' && !(l.balance > 0) && !paymentFor(l.id, k))); }

  function upcomingBills() {
    if (!state.liabilities.length && !(state.funds || []).length) return '<p class="muted">No bills yet. <a href="#liabilities">Add your rent, subscriptions or loan payments.</a></p>';
    const k = viewMonth;
    const days = daysInMonth(k);
    const due = dueIn(k);
    const rows = due.slice().sort((a, b) => (a.dueDay || 1) - (b.dueDay || 1)).map(l => {
      const paid = paymentFor(l.id, k);
      const d = Math.min(l.dueDay || 1, days);
      return '<li class="bill' + (paid ? ' paid' : '') + '"><span class="bill-date"><b>' + d + '</b>' + esc(monthName(k, { month: 'short' })) + '</span><span class="bill-name"><b>' + esc(l.name) + '</b><small>' + money0(l.payment) + (l.type === 'debt' ? ' · Debt' : '') + '</small></span>' +
        (paid ? '<button class="chip chip-done" data-act="unpay" data-id="' + l.id + '" title="Undo">Paid</button>' : k > monthKey(new Date()) ? '<span class="chip chip-later">Upcoming</span>' : '<button class="chip" data-act="pay" data-id="' + l.id + '">Mark paid</button>') + '</li>';
    });
    const cur = monthKey(new Date());
    (state.funds || []).filter(f => f.due === k || (k === cur && f.due < k)).forEach(f => {
      rows.push('<li class="bill"><span class="bill-date"><b>' + esc(monthName(f.due, { month: 'short' })) + '</b>' + esc(f.due.slice(0, 4)) + '</span><span class="bill-name"><b>' + esc(f.name) + '</b><small>' + money0(f.amount) + ' · Yearly cost</small></span>' +
        (k > cur ? '<span class="chip chip-later">Upcoming</span>' : '<button class="chip" data-act="fund-paid" data-id="' + f.id + '">Mark paid</button>') + '</li>');
    });
    const need = fundsMonthlyNeed();
    const total = due.reduce((a, l) => a + (l.payment || 0), 0);
    const paidTotal = due.reduce((a, l) => a + (paymentFor(l.id, k) ? l.payment || 0 : 0), 0);
    return '<div class="meter" title="' + money0(paidTotal) + ' of ' + money0(total) + ' paid this month"><div class="meter-top"><span>Paid</span><b>' + money0(paidTotal) + ' <small>/ ' + money0(total) + '</small></b></div><div class="meter-track"><i style="width:' + (total ? Math.min(100, paidTotal / total * 100) : 0).toFixed(1) + '%"></i></div></div><ul class="bills">' + rows.join('') + '</ul>' +
      (need ? '<a class="fund-note" href="#liabilities"><span>Set aside for yearly costs</span><b>' + money0(need) + '/mo</b></a>' : '');
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
      const trend = st.prev ? (diff > 0 ? '<span class="neg">▲ ' + money0(diff) + '</span>' : diff < 0 ? '<span class="pos">▼ ' + money0(-diff) + '</span>' : '<span>Same</span>') : '<span>New</span>';
      return '<li><span class="tc-rank">' + (i + 1) + '</span><div class="tc-body"><div class="tc-line"><button type="button" class="tc-name spent-link" data-act="view-cat" data-id="' + id + '" title="See these transactions">' + esc(c.name) + '</button><b class="tc-amt">' + money0(spent[id]) + '</b></div>' +
        '<span class="tc-bar"><i style="width:' + (spent[id] / max * 100).toFixed(1) + '%;background:' + catColor(id) + '"></i></span>' +
        '<small class="tc-meta muted"><span>' + Math.round(spent[id] / total * 100) + '%</span>' + trend + '</small></div></li>';
    }).join('') + '</ol>';
  }

  // Tip templates matched by category name. Each returns { headline, save, ideas }.
  const TIP_RULES = [
    { re: /dining|restaurant|eat|food|takeout|coffee|cafe|bar/i, build: (c, st) => {
      const skip = Math.max(1, Math.ceil(st.count / 3));
      return {
        move: 'Cook ' + skip + ' of ' + st.count + ' meals out at home',
        headline: 'You ate out ' + st.count + ' time' + (st.count === 1 ? '' : 's') + ' for ' + money0(st.total) + ' (about ' + money0(st.avg) + ' each). Swapping ' + skip + ' of those for a meal at home saves roughly ' + money0(skip * st.avg * 0.7) + '.',
        save: skip * st.avg * 0.7,
        ideas: ['Plan 3 or 4 dinners on the weekend so weeknights are easy', 'Pack lunch on workdays, even just twice a week', 'Make coffee at home and keep café trips as a treat', st.topMerchant ? 'Most went to ' + st.topMerchant + ' (' + money0(st.topMerchantAmt) + '). Set yourself a limit there first.' : 'Pick one "eat out" night a week and stick to it'],
      };
    } },
    { re: /entertain|stream|subscri|fun|hobb|game|movie|music/i, build: (c, st) => {
      const subs = state.liabilities.filter(l => l.type !== 'debt' && l.categoryId === c.id);
      const subTotal = subs.reduce((a, l) => a + l.payment, 0);
      return {
        move: subs.length ? 'Review ' + subs.length + ' subscription' + (subs.length === 1 ? '' : 's') : 'Trim it by a quarter',
        headline: 'Entertainment cost ' + money0(st.total) + ' this month' + (subs.length ? ', including ' + subs.length + ' subscription' + (subs.length === 1 ? '' : 's') + ' (' + money0(subTotal) + '/mo)' : '') + '. Cutting it by a quarter saves about ' + money0(st.total * 0.25) + '.',
        save: st.total * 0.25,
        ideas: [subs.length ? 'Review ' + subs.map(l => l.name).join(', ') + '. Cancel anything you haven\'t used in a month.' : 'List every subscription you pay for and cancel the ones you forgot about', 'Rotate streaming services: keep one at a time', 'Look for free local events, library passes and park days'],
      };
    } },
    { re: /shop|cloth|amazon|retail|online|gift|beauty/i, build: (c, st) => ({
      move: 'Wait 48 hours before buying',
      headline: 'Shopping came to ' + money0(st.total) + ' across ' + st.count + ' purchase' + (st.count === 1 ? '' : 's') + '. Waiting before you buy usually trims a fifth of that, about ' + money0(st.total * 0.2) + '.',
      save: st.total * 0.2,
      ideas: ['Use a 48-hour rule: leave it in the cart and decide later', 'Unsubscribe from store emails and turn off sale notifications', 'Make a list before you go and buy only what is on it'],
    }) },
    { re: /travel|vacation|trip/i, build: (c, st) => ({
      move: 'Book earlier, go off-peak',
      headline: 'Travel cost ' + money0(st.total) + '. Booking earlier and travelling off-peak often cuts 15%, about ' + money0(st.total * 0.15) + '.',
      save: st.total * 0.15,
      ideas: ['Set up fare alerts instead of booking last minute', 'Put trips on a savings goal so they don\'t hit one month'],
    }) },
  ];

  function cutBackTips(k) {
    const spent = spentByCat(k);
    const flex = state.categories.filter(c => !isEssential(c) && (spent[c.id] || 0) > 0).sort((a, b) => spent[b.id] - spent[a.id]).slice(0, 3);
    if (!flex.length) {
      return { total: 0, html: state.transactions.length
        ? '<p class="muted">No flexible spending this month. Mark which categories are essentials on the <a href="#budget">Budget</a> page.</p>'
        : '<p class="muted">Tips show up here once you log some spending.</p>' };
    }
    let totalSave = 0;
    const cards = flex.map(c => {
      const st = catStats(k, c.id);
      const rule = TIP_RULES.find(r => r.re.test(c.name));
      const tip = rule ? rule.build(c, st) : {
        move: 'Trim it by 15%',
        headline: c.name + ' came to ' + money0(st.total) + '. Trimming it by 15% frees up about ' + money0(st.total * 0.15) + '.',
        save: st.total * 0.15,
        ideas: ['Check the last few ' + c.name + ' purchases and flag the ones you wouldn\'t buy again', 'Give it a monthly limit on the Budget page so you see it filling up'],
      };
      const over = c.budget && st.total > c.budget ? st.total - c.budget : 0;
      const save = Math.min(tip.save, st.total);
      totalSave += save;
      const keep = st.total ? (st.total - save) / st.total * 100 : 0;
      return '<li class="tip"><div class="tip-head"><span class="dot" style="background:' + catColor(c.id) + '"></span><button type="button" class="tip-name spent-link" data-act="view-cat" data-id="' + c.id + '" title="See these transactions">' + esc(c.name) + '</button>' + (over ? '<span class="tag tag-high">' + money0(over) + ' over</span>' : '') + '</div>' +
        '<p class="tip-save" title="' + esc(tip.headline) + '"><b>' + money0(save) + '</b>/mo</p><p class="tip-move">' + esc(tip.move) + '</p>' +
        '<div class="tip-bar" aria-hidden="true"><i style="width:' + keep.toFixed(1) + '%"></i><i class="cut" style="width:' + (100 - keep).toFixed(1) + '%"></i></div>' +
        '<div class="tip-foot"><span>' + money0(st.total) + ' spent</span><details class="tip-more"><summary>Ideas</summary><ul class="tip-ideas">' + tip.ideas.slice(0, 2).map(i => '<li>' + esc(i) + '</li>').join('') + '</ul></details></div></li>';
    });
    const goal = state.goals.find(g => g.saved < g.target);
    return { total: totalSave, goal, html: '<ul class="tips">' + cards.join('') + '</ul>' };
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
    return '<div class="bubbles"><div class="bubble-stage" id="bubbleStage" role="group" aria-label="Spending by category, sized by amount">' +
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
    const incSum = used.reduce((a, x) => a + x.inc, 0), netSum = used.reduce((a, x) => a + x.net, 0);
    const rate = incSum > 0 ? netSum / incSum : 0;
    const cur = months[5];
    // Safety-net milestones (Vanguard): a $2,000 starter cushion, then 3 months of essential costs.
    const saved = state.goals.reduce((a, g) => a + g.saved, 0);
    const { avg } = catAverages();
    const needs = state.categories.filter(isEssential).reduce((a, c) => a + (avg[c.id] || c.budget || 0), 0);
    const cushion = Math.max(2000, Math.round(needs * 3 / 50) * 50);
    const target = saved < 2000 ? 2000 : cushion;
    const label = saved < 2000 ? '$2,000 starter cushion' : '3-month cushion';
    const done = saved >= cushion;
    return '<div class="savings-snap"><div class="ss-stats"><div><span>' + (cur.has ? 'Net this month' : 'Avg net per month') + '</span><b class="' + ((cur.has ? cur.net : netSum / used.length) >= 0 ? 'pos' : 'neg') + '">' + ((cur.has ? cur.net : netSum / used.length) < 0 ? '−' : '+') + money0(Math.abs(cur.has ? cur.net : netSum / used.length)) + '</b></div>' +
      '<div><span>Savings rate</span><b class="' + (rate >= 0 ? '' : 'neg') + '">' + Math.round(rate * 100) + '%</b><small>of income, last ' + used.length + ' mo</small></div></div>' +
      '<div class="ss-mile"><div class="ss-mile-top"><span>' + (done ? '3-month cushion reached' : label) + '</span><b>' + money0(Math.min(saved, target)) + ' / ' + money0(target) + '</b></div><div class="ss-track"><i style="width:' + Math.min(100, saved / target * 100).toFixed(1) + '%"></i></div>' +
      (done ? '' : '<small class="muted">' + money0(target - saved) + ' to go' + (netSum / used.length > 0 ? ' · about ' + Math.max(1, Math.ceil((target - saved) / (netSum / used.length))) + ' mo' : '') + '</small>') + '</div></div>';
  }

  function goalsOutlook(compact) {
    if (!state.goals.length) return '<p class="muted">No goals yet. <a href="#goals">Add a savings goal</a> to see when you\'ll reach it.</p>';
    const avg = avgMonthlySavings();
    return '<ul class="goals' + (compact ? ' compact' : '') + '">' + state.goals.map(g => {
      const o = goalOutlook(g, avg);
      return '<li>' + donut(g.saved / g.target, o.color) + '<div class="goal-text"><b>' + esc(g.name) + '</b><span>' + money0(g.saved) + ' / ' + money0(g.target) + '</span></div>' + goalChip(o) + '</li>';
    }).join('') + '</ul>';
  }

  function goalChip(o) { return o.short ? '<span class="status status-' + o.tone + '" title="' + esc(o.text) + '">' + o.short + '</span>' : ''; }
  function goalOutlook(g, avg) {
    const o = goalStatus(g, avg);
    o.short = o.short || o.text;
    return o;
  }
  function goalStatus(g, avg) {
    const remaining = Math.max(0, g.target - g.saved);
    if (remaining <= 0) return { text: 'Goal reached', short: 'Reached', tone: 'pos', color: 'var(--pos)' };
    const pace = g.monthly > 0 ? g.monthly : avg;
    const paceLabel = g.monthly > 0 ? 'at ' + money0(g.monthly) + '/mo' : 'at your recent savings rate';
    if (pace <= 0) return { text: g.monthly > 0 ? '' : 'Not saving yet. Set a monthly amount.', short: g.monthly > 0 ? '' : 'Not saving yet', tone: 'neg', color: 'var(--neg)' };
    const months = Math.ceil(remaining / pace);
    if (g.date && monthsUntil(g.date) < 0) return { text: 'Target date passed. ' + esc(monthsFromNow(months)) + ' ' + paceLabel + ', or set a new date.', short: 'Date passed', tone: 'warn', color: 'var(--warn)' };
    if (g.date) {
      const left = Math.max(1, monthsUntil(g.date));
      const need = remaining / left;
      if (months <= left) return { text: 'On track for ' + esc(monthsFromNow(months)) + ' ' + paceLabel, short: 'On track', tone: 'pos', color: 'var(--pos)' };
      return { text: 'Behind: need ' + money0(need) + '/mo to hit ' + esc(shortMonth(g.date)), short: 'Needs ' + money0(need) + '/mo', tone: 'warn', color: 'var(--warn)' };
    }
    return { text: 'Reach it by ' + esc(monthsFromNow(months)) + ' ' + paceLabel, short: 'By ' + esc(monthsFromNow(months)), tone: 'muted', color: 'var(--brand)' };
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
    el.innerHTML = '<div class="card"><div class="toolbar"><input type="search" id="txnSearch" aria-label="Search transactions" placeholder="Search merchants, notes, receipt items" value="' + esc(txnFilter.q) + '"><select id="txnCat" aria-label="Filter by category">' + opts + '</select><button type="button" class="btn btn-ghost btn-sm csv-btn" data-act="import-csv">Import CSV</button></div>' +
      viewTotals(list, all.length) + txnList(list, false) + '</div>';
    const s = $('#txnSearch');
    s.addEventListener('compositionend', () => s.dispatchEvent(new Event('input')));
    s.addEventListener('input', e => { if (e.isComposing) return; txnFilter.q = s.value; const pos = s.selectionStart; renderTransactions(); const n = $('#txnSearch'); n.focus(); n.setSelectionRange(pos, pos); });
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
      '<label class="income-field"><span>Balance on ' + esc(monthName(viewMonth, { month: 'short' })) + ' 1</span><span class="money-input big"><span>$</span><input inputmode="decimal" id="openingInput" value="' + ((state.openings || {})[viewMonth] ?? '') + '" placeholder="' + (openingFor(viewMonth) ?? '0') + '" aria-label="Starting balance for ' + esc(monthName(viewMonth)) + '"></span></label>' +
      '<p class="muted small">' + (state.income > 0 ? 'Used for budget plans and strain alerts.' + (det && Math.abs(det - state.income) > 1 ? ' Your logged income averages ' + money0(det) + '/mo.' : '') : det ? 'Using your ' + money0(det) + '/mo average. <button type="button" class="link-btn small-link" data-act="use-income">Use ' + money0(det) + '</button>' : 'After tax. Budget plans are built from this.') + '</p></div>' +
      '<nav class="subtabs" aria-label="Budget sections"><a href="#budget"' + (!sub ? ' class="on"' : '') + '>Categories</a><a href="#budget/plans"' + (sub === 'plans' ? ' class="on"' : '') + '><span class="lbl-long">Budget plans</span><span class="lbl-short">Plans</span></a><a href="#budget/patterns"' + (sub === 'patterns' ? ' class="on"' : '') + '>Patterns' + (alerts ? ' <span class="count">' + alerts + '</span>' : '') + '</a></nav><div id="budgetSub"></div>';
    const inc = $('#incomeInput');
    inc.addEventListener('input', () => { const v = num(inc.value); state.income = isFinite(v) && v > 0 ? round2(v) : 0; persist(); });
    inc.addEventListener('change', () => save());
    const op = $('#openingInput');
    op.addEventListener('input', () => {
      const v = num(op.value);
      state.openings = state.openings || {};
      if (op.value.trim() && isFinite(v)) state.openings[viewMonth] = round2(v); else delete state.openings[viewMonth];
      persist();
    });
    op.addEventListener('change', () => save());
    const el = $('#budgetSub');
    if (sub === 'plans') return renderPlans(el);
    if (sub === 'patterns') return renderPatterns(el);
    const spent = spentByCat(viewMonth);
    const budget = totalBudget();
    const spentTotal = sumBy(txnsIn(viewMonth), 'expense');
    const income = sumBy(txnsIn(viewMonth), 'income');
    let html = '<div class="stats three">' + statCard('Monthly budget', money0(budget), income ? money0(income) + ' income this month' : 'Across ' + state.categories.filter(c => c.budget > 0).length + ' categories', '') +
      statCard('Spent', money0(spentTotal), budget ? Math.round((spentTotal / budget) * 100) + '% of budget' : '', spentTotal > budget && budget ? 'neg' : '') +
      statCard('Remaining', money0(budget - spentTotal), budget - spentTotal < 0 ? 'Over budget' : 'Left for ' + monthName(viewMonth, { month: 'long' }), budget - spentTotal < 0 ? 'neg' : 'pos') + '</div>';
    html += '<div class="card"><div class="card-head"><h3>Categories' + info('Type a monthly limit for each category. Tap Essential or Flexible to choose which ones get cut-back tips.') + '</h3><button class="btn btn-ghost btn-sm" data-act="add-cat">+ Category</button></div><ul class="budget-rows">';
    html += state.categories.map(c => {
      const s = spent[c.id] || 0;
      const pct = c.budget ? s / c.budget : 0;
      const over = c.budget && s > c.budget;
      return '<li>' + donut(pct, over ? 'var(--neg)' : catColor(c.id)) + '<div class="br-name"><input class="inline" data-cat-name="' + c.id + '" value="' + esc(c.name) + '" aria-label="Category name"><small class="' + (over ? 'neg' : 'muted') + '">' + (s ? '<button type="button" class="spent-link" data-act="view-cat" data-id="' + c.id + '" title="See these transactions">' + money(s) + ' spent</button>' : money(s) + ' spent') + (c.budget ? ' · ' + (over ? money(s - c.budget) + ' over' : money(c.budget - s) + ' left') : '') + '</small></div>' +
        '<button type="button" class="tag tag-btn' + (isEssential(c) ? '' : ' tag-flex') + '" data-act="toggle-essential" data-id="' + c.id + '" title="Essentials are left out of cut-back tips">' + (isEssential(c) ? 'Essential' : 'Flexible') + '</button>' +
        '<label class="money-input"><span>$</span><input inputmode="decimal" data-cat-budget="' + c.id + '" value="' + (c.budget || '') + '" placeholder="0" aria-label="Monthly budget for ' + esc(c.name) + '"></label>' +
        '<button class="icon-btn" data-act="del-cat" data-id="' + c.id + '" aria-label="Delete ' + esc(c.name) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button></li>';
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
    const monthly = dueIn(monthKey(new Date())).reduce((a, l) => a + (l.payment || 0), 0);
    const debtTotal = debts.reduce((a, l) => a + (l.balance || 0), 0);
    const setAside = fundsMonthlyNeed();
    let html = '<div class="stats three">' + statCard('Monthly bills and payments', money0(monthly), setAside ? '+ ' + money0(setAside) + ' set aside' : state.liabilities.length + ' total', '') +
      statCard('Total debt', money0(debtTotal), debts.length + ' accounts', '') +
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
    html += fundsCard();
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
    let html = '<div class="stats three">' + statCard('Saved toward goals', money0(state.goals.reduce((a, g) => a + g.saved, 0)), 'of ' + money0(state.goals.reduce((a, g) => a + g.target, 0)) + ' total', '') +
      statCard('Your savings rate', (avg < 0 ? '−' : '') + money0(Math.abs(avg)) + '/mo', '', avg >= 0 ? 'pos' : 'neg', 'Average income minus spending over your recent months') +
      statCard('Goals', String(state.goals.length), state.goals.filter(g => g.saved >= g.target).length + ' reached', '') + '</div>';
    html += '<div class="card"><div class="card-head"><h3>Your goals</h3><button class="btn btn-ghost btn-sm" data-act="add-goal">+ Goal</button></div>';
    if (!state.goals.length) html += '<p class="muted">Emergency fund, vacation, down payment: add a goal and Budgt will show when you\'ll get there.</p>';
    else html += '<ul class="goal-cards">' + state.goals.map(g => {
      const o = goalOutlook(g, avg);
      const pct = Math.min(1, g.saved / g.target);
      return '<li class="goal-card"><div class="gc-top"><b>' + esc(g.name) + '</b>' + goalChip(o) + '</div>' +
        '<p class="gc-amt"><b>' + money0(g.saved) + '</b> of ' + money0(g.target) + '</p>' +
        '<div class="meter-track"><i style="width:' + (pct * 100).toFixed(1) + '%;background:' + o.color + '"></i></div>' +
        '<small class="muted">' + Math.round(pct * 100) + '%' + (g.date ? ' · by ' + esc(shortMonth(g.date)) : '') + '</small>' +
        '<div class="row-actions"><button class="btn btn-sm" data-act="contribute" data-id="' + g.id + '">+ Add money</button><button class="btn btn-ghost btn-sm" data-act="edit-goal" data-id="' + g.id + '">Edit</button></div></li>';
    }).join('') + '</ul>';
    html += '</div>';
    // Phones hide the sidebar, so backups live here too.
    html += '<p class="phone-backup muted small"><button type="button" class="link-btn" data-act="export">Export backup</button> · <button type="button" class="link-btn" data-act="import">Import backup</button><br>Your data stays in this browser. Keep a backup in case it\'s cleared.</p>';
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
    return fundsMonthlyNeed() + state.goals.reduce((a, g) => {
      const rem = Math.max(0, g.target - g.saved);
      if (!rem) return a;
      if (g.monthly > 0) return a + g.monthly;
      if (g.date && monthsUntil(g.date) >= 0) return a + rem / Math.max(1, monthsUntil(g.date));
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
      notes.push(goalNeed > 0 ? 'Your goals' + ((state.funds || []).length ? ' and yearly costs' : '') + ' need about ' + money0(goalNeed) + '/mo, so that is set aside before wants.' : 'No dated goals yet, so 15% is set aside for savings first.');
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
      // Needs under the plan's share: the spare money would otherwise go nowhere, so it's saved.
      else if (over < 0) { S -= over; notes.push('Your needs are ' + Math.round(N / Math.max(1, I) * 100) + '% of income, under this plan\'s ' + Math.round(plan.needs * 100) + '%, so the spare ' + money0(-over) + '/mo goes to savings.'); }
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
    // Only debts with a balance: paid-off ones are already left out of the monthly savings figure, so their payment isn't "freed" again.
    const debts = state.liabilities.filter(l => l.type === 'debt' && l.balance > 0).map(l => ({ bal: l.balance, apr: l.apr || 0, pay: l.payment || 0 }));
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
    fitAxisText(el);
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

  // Bill and debt payments logged by hand (no link to a bill) are obligations, not habits.
  const PAYMENT_RE = /\b(debt|loan|credit ?card|card payment|payment|minimum|interest|mortgage|rent|bill|installment|instalment|transfer|repay\w*|payoff|pay ?off)\b/i;
  function looksLikePayment(t) {
    const names = state.liabilities.map(l => (l.name || '').trim().toLowerCase()).filter(Boolean);
    const m = (t.merchant || '').trim().toLowerCase();
    return (m && names.includes(m)) || PAYMENT_RE.test(t.merchant || '') || PAYMENT_RE.test(t.note || '');
  }

  function findPatterns() {
    const cur = monthKey(new Date());
    const start = shiftMonth(cur, -2) + '-01';
    const txns = state.transactions.filter(t => t.type === 'expense' && t.date >= start && !t.liabilityId && !isEssential(catById(t.categoryId)) && !looksLikePayment(t));
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
      // Name a store only when every purchase in the group was made there; a note word like "subscription" can span many stores.
      const stores = Object.keys(g.merchants).sort((a, b) => g.merchants[b] - g.merchants[a]);
      const topMerchant = stores.length === 1 && g.merchants[stores[0]] === g.txns.size ? stores[0] : '';
      return Object.assign(g, { monthly, share, level, perMonth: g.txns.size / monthsSpan, recent, topMerchant, stores, flexShare: flexMonthly ? monthly / flexMonthly : 0 });
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

  // How a pattern is named inside a sentence. Note words are common nouns ("vape"), so they go lowercase
  // mid-sentence; store names and receipt items keep the case they were typed in.
  function patternName(g, atStart) {
    const n = g.kind === 'note' ? g.label.toLowerCase() : g.label;
    return atStart ? n.charAt(0).toUpperCase() + n.slice(1) : n;
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function patternMessage(g) {
    const I = monthlyIncome();
    const at = g.kind === 'merchant' ? 'at ' + g.label : 'on ' + patternName(g) + (g.topMerchant ? ' at ' + g.topMerchant : g.stores.length > 1 ? ' at ' + storeList(g.stores) : '');
    const per = Math.max(1, Math.round(g.perMonth));
    let text = 'You spend about ' + money0(g.monthly) + ' a month ' + at + ', over ' + plural(per, 'purchase') + ' a month.';
    text += I > 0 ? ' That\'s ' + (g.share * 100).toFixed(g.share < 0.1 ? 1 : 0) + '% of your income, or ' + money0(g.monthly * 12) + ' a year.' : ' That\'s ' + money0(g.monthly * 12) + ' a year.';
    const goal = state.goals.find(x => x.saved < x.target);
    const rate = avgMonthlySavings();
    const half = g.monthly / 2;
    let impact = 'Cutting this in half would free up ' + money0(half) + ' a month.';
    if (goal) {
      const rem = goal.target - goal.saved;
      if (rate > 0) {
        const a = Math.ceil(rem / rate), b = Math.ceil(rem / (rate + half));
        impact = a - b >= 1 ? 'Cutting this in half would get you to your ' + goal.name + ' goal ' + plural(a - b, 'month') + ' sooner.' : impact;
      } else impact = 'Cutting this in half would free up ' + money0(half) + ' a month for your ' + goal.name + ' goal.';
    }
    const kindText = g.kind === 'note' ? 'matched by your notes' : g.kind === 'item' ? 'matched by receipt items' : 'at the same store';
    return { text, impact, kindText };
  }

  // The same numbers as patternMessage, as short label/value pairs.
  function patternFacts(g) {
    const I = monthlyIncome();
    const f = [[money0(g.monthly * 12), 'a year'], [Math.round(g.perMonth) + '×', 'a month']];
    if (I > 0) f.push([(g.share * 100).toFixed(g.share < 0.1 ? 1 : 0) + '%', 'of income']);
    return '<dl class="facts">' + f.map(x => '<div><dt>' + x[1] + '</dt><dd>' + x[0] + '</dd></div>').join('') + '</dl>';
  }
  function patternWhere(g) { return g.kind === 'merchant' ? '' : g.topMerchant || (g.stores.length ? storeList(g.stores) : ''); }

  function storeList(stores) {
    if (stores.length > 3) return stores.slice(0, 2).join(', ') + ' and ' + (stores.length - 2) + ' other stores';
    return stores.length === 3 ? stores[0] + ', ' + stores[1] + ' and ' + stores[2] : stores.join(' and ');
  }

  function renderPatterns(el) {
    const pats = findPatterns();
    const alerts = pats.filter(p => p.level !== 'low');
    let html = '<div class="card"><div class="card-head"><h3>Spending patterns' + info('Budgt checks the last 3 months of Flexible spending for purchases that keep coming back, by store, by words in your notes and by receipt items, including anything filed under Other. Essential categories are never flagged.') + '</h3></div>';
    if (!pats.length) html += '<p class="muted">No repeating non-essential purchases yet. Patterns show up once something repeats 3 or more times.</p>';
    html += alerts.map(g => {
      const m = patternMessage(g);
      const where = patternWhere(g);
      return '<div class="pattern pattern-' + g.level + '"><div class="pt-head"><b>' + esc(g.label) + '</b>' + (where ? '<span class="muted small">' + esc(where) + '</span>' : '') + '<span class="tag ' + (g.level === 'high' ? 'tag-high' : 'tag-flex') + '">' + (g.level === 'high' ? 'High strain' : 'Moderate strain') + '</span><span class="pt-amt">' + money0(g.monthly) + '<small>/mo</small></span></div>' +
        patternFacts(g) +
        '<p class="muted small" title="' + esc(m.text) + ' Based on ' + g.txns.size + ' purchases ' + esc(m.kindText) + '.">' + esc(m.impact) + '</p>' +
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
  // {x} is the name mid-sentence, {X} the name starting a sentence. Each line puts the name after a
  // preposition or verb ("spending on snacks", "you keep going back to Target"), so it reads right for
  // any noun, singular or plural, and never as a "habit" of a bill or debt.
  const STRAIN_LINES = {
    medium: {
      thing: ['Spending on {x} is adding up.', 'You keep buying {x}.', 'Spending on {x} has become a regular expense.', 'Small purchases of {x} are stacking up.'],
      store: ['Your {x} purchases are adding up.', 'Spending at {x} has become a regular expense.', 'You keep going back to {x}.', 'Small purchases at {x} are stacking up.'],
    },
    high: {
      thing: ['Spending on {x} is putting a strain on your budget.', 'Spending on {x} is taking a big bite out of your income.', 'You\'re spending a lot on {x}.', 'Spending on {x} is weighing heavily on your budget.'],
      store: ['Spending at {x} is putting a strain on your budget.', 'Your {x} purchases are taking a big bite out of your income.', 'Spending at {x} is costing you a lot.', 'Spending at {x} is weighing heavily on your budget.'],
    },
  };
  function strainHeadline(g) {
    const lines = STRAIN_LINES[g.level === 'high' ? 'high' : 'medium'][g.kind === 'merchant' ? 'store' : 'thing'];
    let h = 0;
    for (const ch of g.key + monthKey(new Date())) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return lines[h % lines.length].replace('{x}', patternName(g)).replace('{X}', patternName(g, true));
  }

  function strainBanner() {
    const high = findPatterns().filter(p => p.level === 'high' || p.level === 'medium');
    const dismissed = (state.dismissedStrain || {})[monthKey(new Date())] || [];
    const show = high.filter(g => !dismissed.includes(g.key));
    if (!show.length) return '';
    const g = show[0];
    const m = patternMessage(g);
    return '<div class="strain-banner" role="status"><span class="sb-icon" aria-hidden="true">!</span><div><b>' + esc(strainHeadline(g)) + '</b><p class="sb-facts" title="' + esc(m.text) + '"><span><b>' + money0(g.monthly) + '</b>/mo</span><span><b>' + money0(g.monthly * 12) + '</b>/yr</span>' + (patternWhere(g) ? '<span>' + esc(patternWhere(g)) + '</span>' : '') + (show.length > 1 ? '<span>+' + (show.length - 1) + ' more</span>' : '') + '</p></div>' +
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
    if (id && kind !== 'cat' && !find(kind === 'txn' ? state.transactions : kind === 'liab' ? state.liabilities : /^fund/.test(kind) ? state.funds : state.goals)) { clearDraft(); return; }
    if (kind === 'txn') txnForm(find(state.transactions));
    else if (kind === 'liab') liabForm(find(state.liabilities), type);
    else if (kind === 'goal') goalForm(find(state.goals));
    else if (kind === 'contribute') contributeForm(find(state.goals));
    else if (kind === 'cat') catForm();
    else if (kind === 'fund') fundForm(find(state.funds));
    else if (kind === 'fund-add') fundAddForm(find(state.funds));
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
    return '<li class="item-row"><input class="it-name" placeholder="Item" value="' + esc(it ? it.name : '') + '" aria-label="Item name"><input class="it-amt" inputmode="decimal" placeholder="0.00" value="' + (it ? it.amount : '') + '" aria-label="Item amount"><button type="button" class="icon-btn" data-rm-item aria-label="Remove item"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button></li>';
  }

  function txnForm(t) {
    const isNew = !t;
    t = t || { type: 'expense', amount: '', date: viewMonth === monthKey(new Date()) ? todayISO() : viewMonth + '-01', merchant: '', categoryId: lastCategory(), note: '', items: [] };
    const body =
      '<div class="scan-row"><button type="button" class="btn btn-ghost btn-sm scan-btn" id="scanBtn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><span>Scan receipt</span></button><input type="file" id="scanFile" accept="image/*" hidden><span class="scan-status" id="scanStatus" role="status"></span></div>' +
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
      if (!isNew) t = fresh(state.transactions, t);
      const rec = isNew ? { id: uid(), created: Date.now() } : t;
      // A changed debt payment moves the debt balance by the difference.
      const debt = !isNew && debtFor(t);
      if (debt && type === 'expense' && t.balanceDelta !== 0) {
        // Move the balance by the change in amount (only for payments that reduced it in the first place).
        const before = debt.balance;
        debt.balance = round2(Math.max(0, debt.balance - (round2(amount) - t.amount)));
        if (typeof t.balanceDelta === 'number') t.balanceDelta = round2(t.balanceDelta + before - debt.balance);
      } else if (debt) refundDebtPayment(t);
      Object.assign(rec, { type, amount: round2(amount), date, merchant: val('f-merchant'), categoryId: type === 'income' ? 'income' : val('f-cat'), note: val('f-note'), items });
      if (debt && type !== 'expense') delete rec.liabilityId;
      if (isNew) state.transactions.push(rec);
      viewMonth = date.slice(0, 7);
    }, isNew ? null : () => { refundDebtPayment(t); state.transactions = state.transactions.filter(x => x.id !== t.id); }, null, { kind: 'txn', id: isNew ? null : t.id });

    modal.querySelectorAll('input[name=ttype]').forEach(r => r.addEventListener('change', () => {
      const inc = r.value === 'income' && r.checked;
      if (r.checked) $('#f-cat').innerHTML = catOptions(inc ? 'income' : (t.categoryId !== 'income' ? t.categoryId : ''), inc);
    }));
    $('#scanBtn').addEventListener('click', () => $('#scanFile').click());
    $('#scanFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) scanReceipt(f); });
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
  // ---------- receipt scanning ----------
  // Text recognition runs in the browser with Tesseract.js; the photo never leaves the device.
  // Only the recognition engine and its English data are downloaded, the first time you scan.
  const TESS_JS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const TESS_SRI = 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F';
  const TESS_LANG = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int';
  let tessLoading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    return tessLoading || (tessLoading = new Promise((ok, no) => {
      const sc = document.createElement('script'); sc.src = TESS_JS; sc.async = true; sc.crossOrigin = 'anonymous'; sc.integrity = TESS_SRI;
      sc.onload = ok; sc.onerror = () => { tessLoading = null; no(new Error('load')); };
      document.head.appendChild(sc);
    }));
  }
  // Downscale, grayscale and stretch contrast: receipts are faint and phone photos are huge.
  async function prepReceipt(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0, c.width, c.height);
    const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) { const v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; d[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) { const v = (d[i] - lo) / span * 255; d[i] = d[i + 1] = d[i + 2] = v; }
    g.putImageData(img, 0, 0);
    return c;
  }
  const PRICE_END = /(-?)\$?\s?(\d{1,5}(?:,\d{3})*[.,]\s?\d{2})\s*-?\s*[A-Z*]{0,2}\s*$/;
  const NOT_ITEM = /sub\s*-?total|total|tax|change|cash|visa|master|amex|discover|debit|credit|card|balance|tender|payment|paid|auth|approv|saving|you saved|discount|coupon|tip|gratuity|rounding|points|reward|refund|items? sold|qty|account|member/i;
  function parseReceipt(text) {
    const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const price = l => { const m = l.match(PRICE_END); return m ? (m[1] ? -1 : 1) * parseFloat(m[2].replace(/,(?=\d{3})/g, '').replace(/,\s?(\d{2})$/, '.$1').replace(/\s/g, '')) : null; };
    // Total: the last "total" line that isn't a subtotal, savings or tax line.
    let total = null, totalIdx = -1;
    lines.forEach((l, i) => {
      if (/(^|\s)(grand\s*)?total|amount\s*due|balance\s*due|total\s*due/i.test(l) && !/sub\s*-?total|saving|tax|items/i.test(l)) {
        const p = price(l); if (p > 0) { total = p; totalIdx = i; }
      }
    });
    const prices = lines.map(price);
    if (total == null) {
      // No "total" line: trust a card charge, never cash handed over or change; otherwise stop at the first payment line.
      const card = lines.findIndex((l, i) => prices[i] > 0 && /visa|master|amex|discover|debit|credit|card/i.test(l));
      const pay = lines.findIndex((l, i) => prices[i] > 0 && /cash|tender|change|visa|master|amex|discover|debit|credit|card|payment/i.test(l));
      if (card >= 0) { total = prices[card]; totalIdx = card; }
      else if (pay >= 0) totalIdx = pay;
    }
    // Items: priced lines above the total that aren't payment or tax lines.
    const items = [];
    lines.forEach((l, i) => {
      if (totalIdx >= 0 && i >= totalIdx) return;
      const p = prices[i]; if (p == null || p === 0 || NOT_ITEM.test(l)) return;
      let name = l.replace(PRICE_END, '').replace(/^(?:[A-Z]\s+)?\d{4,}\s+/, '').replace(/^[\d\s#@x*.-]+(?=[A-Za-z])/, '').replace(/\b\d{6,}\b/g, '').replace(/[^A-Za-z0-9&'%/ .-]/g, ' ').replace(/\s+/g, ' ').trim();
      if ((name.match(/[A-Za-z]/g) || []).length < 2) return;
      name = name.toLowerCase().replace(/\b[a-z]/g, ch => ch.toUpperCase()).slice(0, 40);
      items.push({ name, amount: round2(p) });
    });
    if (total == null && items.length) total = round2(items.reduce((a, it) => a + it.amount, 0));
    // Date: first date-looking string that isn't in the future.
    let date = null;
    const today = todayISO();
    for (const l of lines) {
      let m = l.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/), y, mo, da;
      if (m) { y = +m[1]; mo = +m[2]; da = +m[3]; }
      else if ((m = l.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})\b/))) { mo = +m[1]; da = +m[2]; y = +m[3]; if (y < 100) y += 2000; if (mo > 12 && da <= 12) [mo, da] = [da, mo]; }
      if (!m || mo < 1 || mo > 12 || da < 1 || da > 31) continue;
      const iso = y + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0');
      if (iso <= today && iso >= shiftMonth(today.slice(0, 7), -18)) { date = iso; break; }
    }
    // Store: the first line near the top that reads like a name, not an address, phone or number.
    let merchant = '';
    for (const l of lines.slice(0, 6)) {
      const letters = (l.match(/[A-Za-z]/g) || []).length;
      if (letters < 3 || letters < l.replace(/\s/g, '').length * 0.6) continue;
      if (/^\d/.test(l) || /\d{3}[-.\s)]\d{3}|www\.|\.com|street|\b(st|ave|rd|blvd|dr|ln|hwy|pkwy)\b\.?|road|suite|receipt|welcome|store\s*#|tel|phone/i.test(l)) continue;
      merchant = l.replace(/[^A-Za-z0-9&' .-]/g, '').trim();
      if (merchant === merchant.toUpperCase()) merchant = merchant.toLowerCase().replace(/\b[a-z]/g, ch => ch.toUpperCase());
      break;
    }
    return { total: total != null ? round2(total) : null, items, date, merchant };
  }

  async function scanReceipt(file) {
    const status = $('#scanStatus');
    const say = (txt, cls) => { if (status) { status.textContent = txt; status.className = 'scan-status ' + (cls || ''); } };
    const form = $('#f-amount');   // the form this scan belongs to; ignore the result if it was closed or replaced
    say('Reading receipt…');
    let text, worker;
    try {
      await loadTesseract();
      const canvas = await prepReceipt(file);
      worker = await Tesseract.createWorker('eng', 1, { langPath: TESS_LANG, logger: m => { if (m.status === 'recognizing text') say('Reading receipt… ' + Math.round(m.progress * 100) + '%'); } });
      ({ data: { text } } = await worker.recognize(canvas));
    } catch (err) {
      if (!form || !form.isConnected) return;
      say('Couldn\'t load the scanner. Check your connection and try again.', 'neg');
      return;
    } finally {
      if (worker) worker.terminate().catch(() => {});
    }
    if (!modal.open || !form || !form.isConnected) return;
    const r = parseReceipt(text || '');
    if (!r.total && !r.items.length) { say('Couldn\'t find prices. Try a flat, well-lit photo.', 'neg'); return; }
    const exp = modal.querySelector('input[name=ttype][value="expense"]');
    if (exp && !exp.checked) { exp.checked = true; exp.dispatchEvent(new Event('change', { bubbles: true })); }
    if (r.total) $('#f-amount').value = r.total.toFixed(2);
    if (r.date) $('#f-date').value = r.date;
    if (r.merchant && !val('f-merchant')) {
      // Reuse the spelling and category of a store you've logged before.
      const key = r.merchant.toLowerCase();
      const past = pastEntries(x => [[x.merchant]]).find(e => e.value.toLowerCase() === key || e.value.toLowerCase().startsWith(key.split(' ')[0]) && key.split(' ')[0].length > 3);
      $('#f-merchant').value = past ? past.value : r.merchant;
      const cat = $('#f-cat');
      if (past && cat && Array.from(cat.options).some(o => o.value === past.last.categoryId)) cat.value = past.last.categoryId;
    }
    if (r.items.length) {
      $('#itemRows').innerHTML = r.items.map(itemRow).join('');
      $('#receiptBox').open = true;
    }
    updateItemsSum();
    saveDraft();
    say('');
  }

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
    box.id = 'ac-' + uid();
    input.after(box);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', box.id);
    input.setAttribute('aria-expanded', 'false');
    const mark = () => {
      box.querySelectorAll('li').forEach((li, i) => { li.classList.toggle('on', i === active); li.setAttribute('aria-selected', i === active ? 'true' : 'false'); });
      if (active >= 0 && !box.hidden) input.setAttribute('aria-activedescendant', box.id + '-' + active); else input.removeAttribute('aria-activedescendant');
      input.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
    };
    let items = [], active = -1;
    function show() {
      const q = input.value.trim().toLowerCase();
      const all = source();
      items = all.filter(e => !q || e.value.toLowerCase().includes(q)).filter(e => e.value.toLowerCase() !== q)
        .sort((a, b) => (b.value.toLowerCase().startsWith(q) - a.value.toLowerCase().startsWith(q)) || b.count - a.count).slice(0, 6);
      active = items.length && q ? 0 : -1;
      if (!items.length) { box.hidden = true; mark(); return; }
      box.innerHTML = items.map((e, i) => '<li role="option" id="' + box.id + '-' + i + '" data-i="' + i + '" class="' + (i === active ? 'on' : '') + '"><span>' + esc(e.value) + '</span>' + (e.sub ? '<small>' + esc(e.sub) + '</small>' : '') + '</li>').join('');
      box.hidden = false;
      mark();
    }
    function hide() { box.hidden = true; active = -1; mark(); }
    function choose(i) { const e = items[i]; if (!e) return; input.value = e.value; hide(); if (onPick) onPick(e); input.dispatchEvent(new Event('input', { bubbles: true })); hide(); }
    input.addEventListener('input', e => { if (e.isTrusted) show(); });
    input.addEventListener('focus', show);
    input.addEventListener('blur', () => setTimeout(hide, 120));
    input.addEventListener('keydown', e => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        mark();
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
      if (!isNew) l = fresh(state.liabilities, l);
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
      if (!isNew) g = fresh(state.goals, g);
      const rec = isNew ? { id: uid() } : g;
      Object.assign(rec, { name, target: round2(target), saved: isFinite(saved) && saved > 0 ? round2(saved) : 0, date: d ? d + '-01' : '', monthly: isFinite(monthly) && monthly > 0 ? round2(monthly) : 0 });
      if (isNew) state.goals.push(rec);
    }, isNew ? null : () => { state.goals = state.goals.filter(x => x.id !== g.id); }, null, { kind: 'goal', id: isNew ? null : g.id });
  }

  function contributeForm(g) {
    openModal('Add money to ' + g.name, field('Amount', '<input id="c-amt" inputmode="decimal" placeholder="0.00">'), () => {
      const a = num(val('c-amt')); if (!isFinite(a) || a === 0) return fail('Enter an amount.');
      g = fresh(state.goals, g);
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

  // ---------- bank CSV import ----------
  // Everything happens in the browser: the file is read, matched to columns, and turned into transactions.
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const head = text.split(/\r?\n/).slice(0, 15).join('\n');
    const delim = [',', ';', '\t'].map(d => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell.trim()); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell.trim()); cell = '';
        if (row.some(c => c)) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell.trim());
    if (row.some(c => c)) rows.push(row);
    return rows;
  }

  // "$1,234.56", "-12.00", "(12.00)", "12,50" and "1.234,56" all read correctly. NaN when blank.
  function parseAmount(s) {
    let t = String(s || '').trim();
    if (!t) return NaN;
    const neg = /^\(.*\)$/.test(t) || /^-|-$|^[^\d]*-/.test(t) || /\bDR\b/i.test(t);
    t = t.replace(/[^\d.,]/g, '');
    if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(t) || /^\d+,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
    const n = parseFloat(t);
    return isFinite(n) ? (neg ? -n : n) : NaN;
  }

  // Returns YYYY-MM-DD or ''. order is 'mdy' (US) or 'dmy' for dates like 05/09/2026.
  function parseDate(s, order) {
    const t = String(s || '').trim();
    let y, m, d, mt;
    if ((mt = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
    else if ((mt = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) {
      y = +mt[3]; if (y < 100) y += 2000;
      if (order === 'dmy') { d = +mt[1]; m = +mt[2]; } else { m = +mt[1]; d = +mt[2]; }
    } else if ((mt = t.match(/^(\d{4})(\d{2})(\d{2})$/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
    else {
      const p = Date.parse(t);
      if (!/[a-z]{3}/i.test(t) || isNaN(p)) return '';
      const dt = new Date(p); y = dt.getFullYear(); m = dt.getMonth() + 1; d = dt.getDate();
    }
    const dt = new Date(y, m - 1, d);
    if (y < 1990 || y > 2100 || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
    return y + '-' + pad(m) + '-' + pad(d);
  }

  // Bank descriptions are noisy ("POS PURCHASE STARBUCKS #1234   SEATTLE WA"); keep the part a person would write.
  function cleanMerchant(s) {
    let t = String(s || '').trim().split(/\s{3,}/)[0];
    t = t.replace(/\s+/g, ' ');
    t = t.replace(/^purchase authorized on \d{1,2}\/\d{1,2}\s*/i, '');
    for (let i = 0; i < 3; i++) t = t.replace(/^(pos|debit card|debit|dbt|checkcard|check card|card|visa|mc|purchase|recurring|preauthorized|pre-authorized|ach|electronic|withdrawal|point of sale|contactless)\b[\s:#*-]*/i, '');
    t = t.replace(/^(sq|tst|sp|pp|paypal|py|dd|ic|in)\s?\*\s*/i, '');
    t = t.replace(/^(.{3,}?)\*.*$/, '$1').replace(/\s+(ppd|web|ccd|ach)\s+id:.*$/i, '').replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\b.*$/, '').replace(/\s*#?\s*\d{4,}.*$/, '').replace(/\s+#\d+\b/, '').replace(/\s+(x{2,}|\*{2,})\S*.*$/i, '').replace(/[\s*#-]+$/, '').trim();
    if (t && !/[a-z]/.test(t)) t = t.toLowerCase().replace(/(^|[\s&/-])([a-z])/g, (a, b, c) => b + c.toUpperCase()).replace(/\b(Atm|Usa|Cvs|Bp|Ups|Usps)\b/g, w => w.toUpperCase());
    return (t || String(s || '').trim()).slice(0, 60);
  }
  function merchantKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  const CAT_HINTS = [
    [/hous|rent|mortgage/i, /\b(rent|mortgage|landlord|property|hoa)\b/i],
    [/grocer|food/i, /grocer|market|safeway|kroger|trader joe|aldi|whole foods|costco|publix|wegmans|sprouts|instacart|food lion|heb\b|albertsons|lidl|tesco|sainsbury/i],
    [/dining|restaurant|eat/i, /restaurant|cafe|coffee|starbucks|dunkin|mcdonald|burger|pizza|taco|sushi|grill|kitchen|bakery|chipotle|subway|doordash|uber ?eats|grubhub|deliveroo|bar\b|pub\b|bistro|diner/i],
    [/transport|car|auto|gas/i, /\b(shell|chevron|exxon|mobil|bp|texaco|arco|valero|sunoco|gas|fuel|uber|lyft|parking|transit|metro|toll|dmv|jiffy)\b/i],
    [/util|bill/i, /electric|power|water|energy|comcast|xfinity|verizon|at&t|t-mobile|spectrum|internet|utility|pg&e|con ed/i],
    [/health|medical/i, /pharmacy|cvs|walgreens|rite aid|doctor|dental|dentist|clinic|hospital|medical|optical|vision/i],
    [/entertain|fun|leisure/i, /netflix|spotify|hulu|disney|hbo|max\b|youtube|apple\.com|cinema|theat|movie|steam|playstation|xbox|nintendo|ticket/i],
    [/shop/i, /amazon|amzn|target|walmart|best buy|ikea|etsy|ebay|home depot|lowe|macy|nordstrom|tj ?maxx|old navy/i],
  ];
  const TRANSFER_RE = /\b(transfer|xfer|thank you|autopay|auto pay|online pmt|epay|crd pmt|card payment|credit card|cc payment|to savings|from savings|from checking|to checking)\b/i;

  function guessCategory(merchant, learned) {
    const k = merchantKey(merchant);
    if (learned[k]) return learned[k];
    for (const [catRe, re] of CAT_HINTS) {
      if (!re.test(merchant)) continue;
      const c = state.categories.find(x => catRe.test(x.name));
      if (c) return c.id;
    }
    const other = state.categories.find(c => /other|misc/i.test(c.name)) || state.categories[0];
    return other ? other.id : '';
  }

  // Which column holds what, from the header names, or from the values when the file has no header.
  function guessColumns(rows) {
    let h = -1;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const r = rows[i].map(c => c.toLowerCase());
      if (r.length >= 2 && r.some(c => /date|datum|fecha/.test(c)) && r.some(c => /amount|debit|credit|withdraw|deposit|description|payee|merchant|name|memo|detail/.test(c))) { h = i; break; }
    }
    if (h < 0 && rows.length > 2 && !rows[0].some(c => parseDate(c, 'mdy') || parseDate(c, 'dmy')) && rows[1].some(c => parseDate(c, 'mdy') || parseDate(c, 'dmy'))) h = 0;
    const headers = h >= 0 ? rows[h] : [];
    const data = rows.slice(h + 1).filter(r => r.length >= 2);
    const n = Math.max(0, ...data.slice(0, 50).map(r => r.length));
    const names = Array.from({ length: n }, (_, i) => headers[i] || 'Column ' + (i + 1));
    const find = re => names.findIndex(x => re.test(x));
    const sample = data.slice(0, 40);
    const share = (i, test) => sample.length ? sample.filter(r => test(r[i] || '')).length / sample.length : 0;
    let date = h >= 0 ? find(/date|datum|fecha/i) : -1;
    if (date < 0) for (let i = 0; i < n; i++) if (share(i, v => parseDate(v, 'mdy') || parseDate(v, 'dmy')) > 0.6) { date = i; break; }
    let amount = h >= 0 ? find(/^amount|amount$|^amt$|transaction amount|bedrag|betrag|montant|importe|importo/i) : -1;
    let debit = h >= 0 ? find(/debit|withdraw|money out|paid out|outflow|spent/i) : -1;
    let credit = h >= 0 ? find(/credit|deposit|money in|paid in|inflow|received/i) : -1;
    if (amount < 0 && (debit < 0 || credit < 0)) {
      for (let i = 0; i < n; i++) if (i !== date && share(i, v => isFinite(parseAmount(v)) && !parseDate(v, 'mdy')) > 0.6) { amount = i; break; }
    }
    if (amount >= 0) { debit = -1; credit = -1; }
    let desc = -1;
    if (h >= 0) for (const re of [/description|omschrijving|beschreibung|libell|concepto/i, /payee|merchant|^name$/i, /narrative|transaction$|details/i, /memo|reference/i]) { desc = find(re); if (desc >= 0) break; }
    if (desc < 0) {
      let best = -1, len = 0;
      for (let i = 0; i < n; i++) {
        if ([date, amount, debit, credit].includes(i)) continue;
        const avg = sample.reduce((a, r) => a + (/[a-z]/i.test(r[i] || '') ? (r[i] || '').length : 0), 0) / Math.max(1, sample.length);
        if (avg > len) { len = avg; best = i; }
      }
      desc = best;
    }
    const dates = sample.map(r => String(r[date] || '').match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/)).filter(Boolean);
    const order = dates.some(x => +x[1] > 12) ? 'dmy' : 'mdy';
    let sign = 'neg';
    if (amount >= 0) { const v = data.map(r => parseAmount(r[amount])).filter(isFinite); sign = v.filter(x => x < 0).length >= v.filter(x => x > 0).length ? 'neg' : 'pos'; }
    return { names, data, map: { date, desc, amount, credit: amount >= 0 ? -1 : credit, debit, order, sign } };
  }

  function csvRows(data, map) {
    const learned = {};
    state.transactions.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach(t => { learned[merchantKey(t.merchant)] = t.categoryId; });
    // Count what's already logged per date+amount+type, so re-importing the same file adds nothing twice.
    const have = {};
    state.transactions.forEach(t => { const k = t.date + '|' + t.type + '|' + round2(t.amount); have[k] = (have[k] || 0) + 1; });
    const billsUsed = new Set();
    const out = [];
    data.forEach(r => {
      const date = parseDate(r[map.date], map.order);
      if (!date) return;
      let type, amount;
      if (map.amount >= 0) {
        const v = parseAmount(r[map.amount]);
        if (!isFinite(v) || !v) return;
        type = (map.sign === 'neg' ? v < 0 : v > 0) ? 'expense' : 'income';
        amount = Math.abs(v);
      } else {
        const dv = Math.abs(parseAmount(r[map.debit])), cv = Math.abs(parseAmount(r[map.credit]));
        if (dv > 0) { type = 'expense'; amount = dv; } else if (cv > 0) { type = 'income'; amount = cv; } else return;
      }
      amount = round2(amount);
      const raw = r[map.desc] || '';
      const merchant = cleanMerchant(raw) || (type === 'income' ? 'Income' : 'Purchase');
      const key = date + '|' + type + '|' + amount;
      const dup = have[key] > 0;
      if (dup) have[key]--;
      const transfer = TRANSFER_RE.test(raw);
      let categoryId = type === 'income' ? 'income' : guessCategory(merchant, learned);
      let liabilityId = '';
      if (type === 'expense' && !dup) {
        // A bill paid from the bank shows as paid in Upcoming bills instead of asking to be marked again.
        const mk = merchantKey(merchant);
        const bill = state.liabilities.find(l => l.type !== 'debt' && !billsUsed.has(l.id + date.slice(0, 7)) && merchantKey(l.name).length > 2 && mk.includes(merchantKey(l.name)) && !paymentFor(l.id, date.slice(0, 7)));
        if (bill) { billsUsed.add(bill.id + date.slice(0, 7)); liabilityId = bill.id; if (bill.categoryId) categoryId = bill.categoryId; }
      }
      out.push({ date, type, amount, merchant, categoryId, liabilityId, dup, transfer, on: !dup && !transfer });
    });
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  function importCSV(file, text) {
    const rows = parseCSV(text);
    const g = guessColumns(rows);
    if (!g.data.length || g.map.date < 0 || (g.map.amount < 0 && g.map.debit < 0)) { alert('Budgt couldn\'t find dates and amounts in that file. Export a CSV from your bank\'s website and try again.'); return; }
    let map = g.map, list = csvRows(g.data, map);
    const colOpts = (sel, none) => (none ? '<option value="-1">' + none + '</option>' : '') + g.names.map((n, i) => '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
    const mapping = () => '<details class="csv-map"' + (list.length ? '' : ' open') + '><summary>Columns</summary><div class="form-grid">' +
      field('Date', '<select id="cm-date">' + colOpts(map.date) + '</select>') +
      field('Description', '<select id="cm-desc">' + colOpts(map.desc) + '</select>') +
      field(map.amount >= 0 ? 'Amount' : 'Money out', '<select id="cm-amount">' + colOpts(map.amount >= 0 ? map.amount : map.debit) + '</select>') +
      field('Money in', '<select id="cm-credit">' + colOpts(map.credit, 'Same column') + '</select>') +
      (map.amount >= 0 ? field('Spending shows as', '<select id="cm-sign"><option value="neg"' + (map.sign === 'neg' ? ' selected' : '') + '>Negative (−)</option><option value="pos"' + (map.sign === 'pos' ? ' selected' : '') + '>Positive</option></select>') : '') +
      field('Dates are', '<select id="cm-order"><option value="mdy"' + (map.order === 'mdy' ? ' selected' : '') + '>Month first</option><option value="dmy"' + (map.order === 'dmy' ? ' selected' : '') + '>Day first</option></select>') +
      '</div></details>';
    const rowHtml = (t, i) => '<li class="csv-row' + (t.on ? '' : ' off') + '"><input type="checkbox" data-csv-on="' + i + '"' + (t.on ? ' checked' : '') + ' aria-label="Import ' + esc(t.merchant) + '">' +
      '<span class="csv-main"><b>' + esc(t.merchant) + '</b><small>' + esc(shortDate(t.date)) + (t.dup ? ' · <span class="warn">Already added</span>' : t.transfer ? ' · <span class="warn">Transfer?</span>' : '') + '</small></span>' +
      '<span class="csv-amt' + (t.type === 'income' ? ' pos' : '') + '">' + (t.type === 'income' ? '+' : '−') + money(t.amount) + '</span>' +
      (t.type === 'income' ? '<span class="csv-cat muted small">Income</span>' : '<select class="csv-cat" data-csv-cat="' + i + '" aria-label="Category for ' + esc(t.merchant) + '">' + catOptions(t.categoryId) + '</select>') + '</li>';
    const count = () => list.filter(t => t.on).length;
    const summary = () => {
      const on = list.filter(t => t.on), skipped = list.length - on.length;
      return '<p class="csv-sum"><b>' + on.length + '</b> to import' + (skipped ? ' · ' + skipped + ' skipped' : '') + (on.length ? ' · <span class="neg">−' + money0(sumBy(on, 'expense')) + '</span> <span class="pos">+' + money0(sumBy(on, 'income')) + '</span>' : '') + '</p>';
    };
    const paint = () => {
      $('#csvBody').innerHTML = summary() + mapping() + (list.length ? '<ul class="csv-rows">' + list.map(rowHtml).join('') + '</ul>' : '<p class="muted">No rows match these columns. Pick the right ones above.</p>');
      $('#modalSave').textContent = 'Import ' + count();
    };
    openModal('Import ' + (file.name.length > 28 ? 'bank CSV' : file.name), '<p class="muted small csv-hint">Categories are guessed from your past entries. Untick transfers between your own accounts.</p><div id="csvBody"></div>', () => {
      const on = list.filter(t => t.on);
      if (!on.length) return fail('Nothing is ticked to import.');
      const now = Date.now();
      on.forEach((t, i) => {
        const txn = { id: uid(), created: now + i, type: t.type, amount: t.amount, date: t.date, merchant: t.merchant, categoryId: t.categoryId, note: '', items: [] };
        if (t.liabilityId && !paymentFor(t.liabilityId, t.date.slice(0, 7))) txn.liabilityId = t.liabilityId;
        state.transactions.push(txn);
      });
      viewMonth = on.reduce((a, t) => (t.date > a ? t.date : a), '').slice(0, 7);
      txnFilter = { q: '', cat: '' };
      if (location.hash !== '#transactions') location.hash = '#transactions';
    }, null, 'Import');
    paint();
    const body = $('#csvBody');
    body.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.csvOn) { list[+t.dataset.csvOn].on = t.checked; t.closest('li').classList.toggle('off', !t.checked); body.querySelector('.csv-sum').outerHTML = summary(); $('#modalSave').textContent = 'Import ' + count(); return; }
      if (t.dataset.csvCat) { list[+t.dataset.csvCat].categoryId = t.value; return; }
      if (!/^cm-/.test(t.id)) return;
      const v = +t.value;
      if (t.id === 'cm-date') map.date = v;
      if (t.id === 'cm-desc') map.desc = v;
      if (t.id === 'cm-order') map.order = t.value;
      if (t.id === 'cm-sign') map.sign = t.value;
      if (t.id === 'cm-amount') { if (map.amount >= 0) map.amount = v; else map.debit = v; }
      if (t.id === 'cm-credit') {
        if (v < 0) { map.amount = map.amount >= 0 ? map.amount : map.debit; map.debit = -1; map.credit = -1; }
        else { if (map.amount >= 0) { map.debit = map.amount; map.amount = -1; } map.credit = v; }
      }
      list = csvRows(g.data, map);
      paint();
      const open = body.querySelector('.csv-map'); if (open) open.open = true;
    });
  }

  // ---------- yearly costs (sinking funds) ----------
  function monthsBetween(a, b) { const A = parseMonth(a), B = parseMonth(b); return (B.getFullYear() - A.getFullYear()) * 12 + B.getMonth() - A.getMonth(); }
  // What to set aside this month so the cost is covered by its due month.
  function fundNeed(f) {
    const rem = Math.max(0, f.amount - f.saved);
    if (!rem) return 0;
    const m = monthsBetween(monthKey(new Date()), f.due);
    return round2(m <= 0 ? rem : rem / m);
  }
  function fundsMonthlyNeed() { return round2((state.funds || []).reduce((a, f) => a + fundNeed(f), 0)); }
  const EVERY = [[12, 'Every year'], [6, 'Every 6 months'], [3, 'Every 3 months'], [24, 'Every 2 years'], [0, 'Just once']];
  function everyLabel(n) { return n === 12 ? 'yearly' : n === 0 ? 'once' : n === 24 ? 'every 2 yrs' : 'every ' + n + ' mo'; }
  function fundChip(f) {
    const cur = monthKey(new Date());
    if (f.saved >= f.amount) return '<span class="status status-pos">Ready</span>';
    if (f.due <= cur) return '<span class="status status-warn">Due</span>';
    return '';
  }

  function fundsCard() {
    const funds = state.funds || [];
    const need = fundsMonthlyNeed();
    const cur = monthKey(new Date());
    let html = '<div class="card"><div class="card-head"><h3>Yearly costs' + info('Insurance, gifts, car repairs: costs that don\'t come every month. Each is split into a monthly amount to set aside, so it\'s covered when it\'s due.') + '</h3>' +
      (need ? '<span class="head-stat">Set aside <b>' + money0(need) + '/mo</b></span>' : '') + '<button class="btn btn-ghost btn-sm" data-act="add-fund">+ Yearly cost</button></div>';
    if (!funds.length) return html + '<p class="muted">Car insurance, holidays, gifts, annual subscriptions.</p></div>';
    html += '<ul class="liabs funds">' + funds.slice().sort((a, b) => a.due.localeCompare(b.due)).map(f => {
      const pct = f.amount ? Math.min(1, f.saved / f.amount) : 0;
      const n = fundNeed(f);
      return '<li><button class="liab" data-act="edit-fund" data-id="' + f.id + '"><span class="liab-main"><b>' + esc(f.name) + '</b><small>' + esc(monthName(f.due, { month: 'short', year: 'numeric' })) + ' · ' + everyLabel(f.every) + '</small></span><span class="liab-right"><b>' + money0(f.amount) + '</b><small class="muted">' + (n ? money0(n) + '/mo' : '&nbsp;') + '</small></span></button>' +
        '<div class="fund-bar"><div class="meter-track" title="' + money0(f.saved) + ' of ' + money0(f.amount) + ' set aside"><i style="width:' + (pct * 100).toFixed(1) + '%"></i></div><small>' + money0(f.saved) + '</small>' + fundChip(f) +
        '<button type="button" class="chip" data-act="fund-add" data-id="' + f.id + '">+ Set aside</button>' + (f.due <= cur ? '<button type="button" class="chip" data-act="fund-paid" data-id="' + f.id + '">Paid</button>' : '') + '</div></li>';
    }).join('') + '</ul></div>';
    return html;
  }

  function fundForm(f) {
    const isNew = !f;
    const cur = monthKey(new Date());
    f = f || { name: '', amount: '', every: 12, due: shiftMonth(cur, 3), saved: '', categoryId: (state.categories.find(c => /other|misc/i.test(c.name)) || state.categories[0] || {}).id };
    const body = '<div class="form-grid">' +
      field('Name', '<input id="f-name" placeholder="e.g. Car insurance, Holiday gifts" value="' + esc(f.name) + '" required>', 'full') +
      field('Amount', '<input id="f-amount" inputmode="decimal" placeholder="0.00" value="' + (f.amount || '') + '">') +
      field('Repeats', '<select id="f-every">' + EVERY.map(([n, l]) => '<option value="' + n + '"' + (n === f.every ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>') +
      field('Next due', '<input id="f-due" type="month" value="' + esc(f.due) + '">') +
      field('Set aside so far', '<input id="f-saved" inputmode="decimal" placeholder="0.00" value="' + (f.saved || '') + '">') +
      field('Category when paid', '<select id="f-cat">' + catOptions(f.categoryId) + '</select>', 'full') +
      '</div>';
    openModal(isNew ? 'Add yearly cost' : 'Edit yearly cost', body, () => {
      const name = val('f-name'); if (!name) return fail('Give it a name.');
      const amount = num(val('f-amount')); if (!(amount > 0)) return fail('Enter the amount.');
      const due = val('f-due'); if (!/^\d{4}-\d{2}$/.test(due)) return fail('Pick the month it\'s due.');
      const saved = num(val('f-saved'));
      if (!isNew) f = fresh(state.funds, f);
      const rec = isNew ? { id: uid() } : f;
      Object.assign(rec, { name, amount: round2(amount), every: parseInt(val('f-every'), 10) || 0, due, saved: isFinite(saved) && saved > 0 ? round2(saved) : 0, categoryId: val('f-cat') });
      if (isNew) state.funds.push(rec);
    }, isNew ? null : () => { state.funds = state.funds.filter(x => x.id !== f.id); }, null, { kind: 'fund', id: isNew ? null : f.id });
  }

  function fundAddForm(f) {
    const n = fundNeed(f);
    openModal('Set aside for ' + f.name, field('Amount', '<input id="fa-amt" inputmode="decimal" placeholder="0.00" value="' + (n ? Math.ceil(n) : '') + '">'), () => {
      const a = num(val('fa-amt')); if (!isFinite(a) || a === 0) return fail('Enter an amount.');
      f = fresh(state.funds, f);
      f.saved = round2(Math.max(0, f.saved + a));
    }, null, 'Add', { kind: 'fund-add', id: f.id });
  }

  // Paying the cost logs it as a transaction, uses up what was set aside, and rolls the due date on.
  function fundPaidForm(f) {
    openModal(f.name + ' paid', field('Amount paid', '<input id="fp-amt" inputmode="decimal" value="' + f.amount + '">'), () => {
      const a = num(val('fp-amt')); if (!(a > 0)) return fail('Enter what you paid.');
      f = fresh(state.funds, f);
      const cur = monthKey(new Date());
      state.transactions.push({ id: uid(), created: Date.now(), type: 'expense', amount: round2(a), date: todayISO(), merchant: f.name, categoryId: f.categoryId, note: 'Yearly cost', items: [], fundId: f.id });
      f.saved = round2(Math.max(0, f.saved - a));
      if (f.every > 0) { do { f.due = shiftMonth(f.due, f.every); } while (f.due <= cur); }
      else state.funds = state.funds.filter(x => x.id !== f.id);
    }, null, 'Log payment');
  }

  // ---------- sweep last month's leftover into savings ----------
  let sweptNote = null;
  function sweepLeftover() {
    const cur = monthKey(new Date());
    const prev = shiftMonth(cur, -1);
    const list = txnsIn(prev);
    if (!list.some(t => t.type === 'expense')) return null;
    const spent = spentByCat(prev);
    const cats = state.categories.filter(c => c.budget > 0).map(c => ({ c, left: round2(c.budget - (spent[c.id] || 0)) })).filter(x => x.left > 0).sort((a, b) => b.left - a.left);
    const inc = sumBy(list, 'income'), out = sumBy(list, 'expense');
    let left = totalBudget() > 0 ? cats.reduce((a, x) => a + x.left, 0) : 0;
    // Money left in a budget is only real if income covered the month.
    if (inc > 0) left = totalBudget() > 0 ? Math.min(left, inc - out) : inc - out;
    left = Math.floor(left);
    return left >= 5 ? { month: prev, left, cats } : null;
  }

  function sweepBanner() {
    if (viewMonth !== monthKey(new Date())) return '';
    if (sweptNote) {
      return '<div class="sweep-banner done" role="status"><span class="sb-icon" aria-hidden="true">✓</span><div><b>' + money0(sweptNote.amount) + ' moved to ' + esc(sweptNote.name) + '</b></div><div class="row-actions"><button type="button" class="btn btn-ghost btn-sm" data-act="undo-sweep">Undo</button></div></div>';
    }
    const s = sweepLeftover();
    if (!s || (state.sweeps || {})[s.month]) return '';
    const targets = state.goals.filter(g => g.saved < g.target).map(g => ['g:' + g.id, g.name]).concat((state.funds || []).filter(f => f.saved < f.amount).map(f => ['f:' + f.id, f.name]));
    const facts = s.cats.slice(0, 3).map(x => '<span>' + esc(x.c.name) + ' <b>' + money0(x.left) + '</b></span>').join('');
    return '<div class="sweep-banner" role="region" aria-label="Leftover from ' + esc(monthName(s.month, { month: 'long' })) + '"><span class="sb-icon" aria-hidden="true">↑</span><div><b>' + esc(monthName(s.month, { month: 'long' })) + ': ' + money0(s.left) + ' left over</b>' + (facts ? '<p class="sb-facts">' + facts + '</p>' : '') + '</div>' +
      '<div class="row-actions">' + (targets.length
        ? '<label class="money-input sweep-amt"><span>$</span><input id="sweepAmt" inputmode="decimal" value="' + s.left + '" aria-label="Amount to move"></label><select id="sweepTo" aria-label="Move to">' + targets.map(([id, n]) => '<option value="' + id + '">' + esc(n) + '</option>').join('') + '</select><button type="button" class="btn btn-sm" data-act="sweep" data-id="' + s.month + '">Save it</button>'
        : '<a class="btn btn-sm" href="#goals">Add a goal</a>') +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="skip-sweep" data-id="' + s.month + '">Not now</button></div></div>';
  }

  function doSweep(month) {
    const amt = round2(num($('#sweepAmt').value));
    if (!(amt > 0)) { $('#sweepAmt').focus(); return; }
    const [kind, id] = $('#sweepTo').value.split(':');
    const target = (kind === 'g' ? state.goals : state.funds).find(x => x.id === id);
    if (!target) return;
    target.saved = round2(target.saved + amt);
    state.sweeps = state.sweeps || {};
    state.sweeps[month] = { amount: amt, to: kind + ':' + id };
    sweptNote = { month, amount: amt, name: target.name };
    save();
  }
  function undoSweep() {
    if (!sweptNote) return;
    const rec = (state.sweeps || {})[sweptNote.month];
    if (rec && rec.to) {
      const [kind, id] = rec.to.split(':');
      const target = (kind === 'g' ? state.goals : state.funds).find(x => x.id === id);
      if (target) target.saved = round2(Math.max(0, target.saved - rec.amount));
      delete state.sweeps[sweptNote.month];
    }
    sweptNote = null;
    save();
  }

  // ---------- account balance and catching up after time away ----------
  // state.openings[month] is the balance on the 1st, before that day's entries. A month without one
  // carries over from the nearest earlier month that has one, plus every month's net in between.
  function netOf(list) { return list.reduce((a, t) => a + (t.type === 'income' ? t.amount : -t.amount), 0); }
  function openingFor(k, extra) {
    const o = state.openings || {};
    const all = state.transactions.concat(extra || []);
    let m = Object.keys(o).filter(x => x <= k).sort().pop();
    if (!m) return null;
    let b = o[m];
    while (m < k) { const mm = m; b += netOf(all.filter(t => t.date.slice(0, 7) === mm)); m = shiftMonth(m, 1); if (m in o) b = o[m]; }
    return round2(b);
  }
  function balanceOn(iso, extra) {
    const open = openingFor(iso.slice(0, 7), extra);
    if (open === null) return null;
    const k = iso.slice(0, 7);
    return round2(open + netOf(state.transactions.concat(extra || []).filter(t => t.date.slice(0, 7) === k && t.date <= iso)));
  }
  function daysApart(a, b) { const p = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((p(b) - p(a)) / 864e5); }
  function lastActive() { return state.lastSeen || state.transactions.reduce((a, t) => (t.date <= todayISO() && t.date > a ? t.date : a), '') || ''; }

  // Mark when the app is opened. Coming back after a week, or in a new month, offers a catch-up.
  (function markVisit() {
    if (!state.transactions.length && !state.liabilities.length) return;
    const today = todayISO(), last = lastActive();
    if (last && !state.catchUpFrom && last < today && (daysApart(last, today) >= 7 || last.slice(0, 7) < today.slice(0, 7))) state.catchUpFrom = last;
    if (state.lastSeen !== today) { state.lastSeen = today; persist(); }
  })();

  // Paychecks and bills that came due between `from` and today and aren't logged yet.
  function missedEntries(from) {
    const today = todayISO(), cur = monthKey(new Date());
    const out = [];
    const logged = (type, name, amount, date) => {
      const key = merchantKey(name);
      return state.transactions.some(t => t.type === type && Math.abs(daysApart(t.date, date)) <= 3 && (merchantKey(t.merchant).includes(key) || round2(t.amount) === round2(amount)));
    };
    // Income that repeats: the same payer in at least two of the months before you left.
    const [fy, fm, fd] = from.split('-').map(Number);
    const s = new Date(fy, fm - 1, fd - 100), since = s.getFullYear() + '-' + pad(s.getMonth() + 1) + '-' + pad(s.getDate());
    const groups = {};
    state.transactions.filter(t => t.type === 'income' && t.date <= from && t.date >= since).forEach(t => { (groups[merchantKey(t.merchant)] = groups[merchantKey(t.merchant)] || []).push(t); });
    Object.values(groups).forEach(g => {
      // Paydays are the days of the month seen in two or more months, paid what that payer paid last.
      const seen = {};
      g.forEach(t => { const d = Number(t.date.slice(8, 10)); (seen[d] = seen[d] || new Set()).add(t.date.slice(0, 7)); });
      const days = Object.keys(seen).filter(d => seen[d].size >= 2).map(Number);
      const latest = g.slice().sort((a, b) => a.date.localeCompare(b.date)).pop();
      for (let m = from.slice(0, 7); m <= cur; m = shiftMonth(m, 1)) {
        days.forEach(day => {
          const t = latest;
          const date = m + '-' + pad(Math.min(day, daysInMonth(m)));
          if (date <= from || date > today || logged('income', t.merchant, t.amount, date)) return;
          out.push({ type: 'income', amount: t.amount, date, merchant: t.merchant, categoryId: 'income', on: true });
        });
      }
    });
    // Bills and debt payments due since you left (or earlier that month) that aren't marked paid.
    for (let m = from.slice(0, 7); m <= cur; m = shiftMonth(m, 1)) {
      dueIn(m).filter(l => l.payment > 0).forEach(l => {
        const date = m + '-' + pad(Math.min(l.dueDay || 1, daysInMonth(m)));
        if (date > today || paymentFor(l.id, m) || logged('expense', l.name, l.payment, date)) return;
        out.push({ type: 'expense', amount: l.payment, date, merchant: l.name, categoryId: l.categoryId, liabilityId: l.id, on: true });
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  function catchUpBanner() {
    if (viewMonth !== monthKey(new Date()) || !state.catchUpFrom) return '';
    const from = state.catchUpFrom;
    const list = missedEntries(from);
    const inc = list.filter(t => t.type === 'income').length, bills = list.length - inc;
    const facts = (inc ? '<span><b>' + inc + '</b> paycheck' + (inc > 1 ? 's' : '') + '</span>' : '') + (bills ? '<span><b>' + bills + '</b> bill' + (bills > 1 ? 's' : '') + '</span>' : '');
    return '<div class="sweep-banner catchup-banner" role="region" aria-label="Catch up"><span class="sb-icon" aria-hidden="true">↻</span><div><b>Away since ' + esc(shortDate(from)) + '</b><p class="sb-facts">' + (facts || '<span>Enter your balance to pick up where you left off</span>') + '</p></div>' +
      '<div class="row-actions"><button type="button" class="btn btn-sm" data-act="catch-up">Catch up</button><button type="button" class="btn btn-ghost btn-sm" data-act="skip-catch-up">Not now</button></div></div>';
  }

  // Ask for today's balance, add what came due while away, and log any gap as one entry to edit later.
  function catchUpForm() {
    const today = todayISO(), cur = monthKey(new Date());
    const list = state.catchUpFrom ? missedEntries(state.catchUpFrom) : [];
    const other = state.categories.find(c => /^other/i.test(c.name)) || state.categories[state.categories.length - 1] || { id: '' };
    const known = balanceOn(today) !== null;
    const rowHtml = (t, i) => '<li class="csv-row' + (t.on ? '' : ' off') + '"><input type="checkbox" data-cu-on="' + i + '"' + (t.on ? ' checked' : '') + ' aria-label="Add ' + esc(t.merchant) + '">' +
      '<span class="csv-main"><b>' + esc(t.merchant) + '</b><small>' + esc(shortDate(t.date)) + (t.liabilityId ? ' · Bill' : '') + '</small></span>' +
      '<span class="csv-amt' + (t.type === 'income' ? ' pos' : '') + '">' + (t.type === 'income' ? '+' : '−') + money(t.amount) + '</span></li>';
    let logGap = true;
    const gapOf = () => {
      const b = num(val('cu-bal'));
      const expected = balanceOn(today, list.filter(t => t.on));
      return { b, expected, gap: isFinite(b) && expected !== null ? round2(expected - b) : null };
    };
    const summary = () => {
      const { b, expected, gap } = gapOf();
      if (expected === null) return '<p class="csv-sum">First balance. Budgt tracks it from here.</p>';
      let html = '<div class="cu-facts"><div><b>' + money(expected) + '</b><small>Expected</small></div>';
      if (gap !== null && Math.abs(gap) >= 0.01) html += '<div><b class="' + (gap > 0 ? 'neg' : 'pos') + '">' + (gap > 0 ? '−' : '+') + money(Math.abs(gap)) + '</b><small>' + (gap > 0 ? 'Unlogged spending' : 'Unlogged income') + '</small></div>';
      else if (isFinite(b)) html += '<div><b class="pos">✓</b><small>Matches</small></div>';
      return html + '</div>' + (gap !== null && Math.abs(gap) >= 0.01 ? '<label class="cu-log"><input type="checkbox" id="cu-log"' + (logGap ? ' checked' : '') + '> Log the gap so the numbers match</label>' : '');
    };
    const body = field('Balance today', '<span class="money-input big"><span>$</span><input id="cu-bal" inputmode="decimal" placeholder="' + (known ? balanceOn(today, list) : '0.00') + '" aria-label="Balance today"></span>', 'full') +
      '<div id="cuSum"></div>' +
      (list.length ? '<p class="cu-head">Since ' + esc(shortDate(state.catchUpFrom)) + '</p><ul class="csv-rows">' + list.map(rowHtml).join('') + '</ul>' : '');
    openModal('Catch up', body, () => {
      const { b, gap } = gapOf();
      if (!isFinite(b)) return fail('Enter your balance today.');
      const now = Date.now();
      list.filter(t => t.on).forEach((t, i) => {
        const txn = { id: uid(), created: now + i, type: t.type, amount: t.amount, date: t.date, merchant: t.merchant, categoryId: t.categoryId, note: t.liabilityId ? 'Bill' : '', items: [] };
        const l = t.liabilityId && state.liabilities.find(x => x.id === t.liabilityId);
        if (l) {
          txn.liabilityId = l.id;
          if (l.type === 'debt') { txn.note = 'Debt payment'; const before = l.balance || 0; l.balance = round2(Math.max(0, before - Math.max(0, l.payment - before * ((l.apr || 0) / 100 / 12)))); txn.balanceDelta = round2(before - l.balance); }
        }
        state.transactions.push(txn);
      });
      if (gap !== null && Math.abs(gap) >= 0.01 && logGap) {
        // Spread the gap over the days away, one entry per month, so each month's budget gets its share.
        const from = state.catchUpFrom && state.catchUpFrom < today ? state.catchUpFrom : today;
        const total = Math.max(1, daysApart(from, today));
        let left = Math.abs(gap);
        for (let m = from.slice(0, 7); m <= cur; m = shiftMonth(m, 1)) {
          const end = m === cur ? today : m + '-' + pad(daysInMonth(m));
          const start = m === from.slice(0, 7) ? from : m + '-01';
          const amt = m === cur ? round2(left) : round2(Math.abs(gap) * (daysApart(start, end) + (start === from ? 0 : 1)) / total);
          left = round2(left - amt);
          if (amt >= 0.01) state.transactions.push({ id: uid(), created: now + list.length, type: gap > 0 ? 'expense' : 'income', amount: amt, date: end, merchant: gap > 0 ? 'Unlogged spending' : 'Unlogged income', categoryId: gap > 0 ? other.id : 'income', note: 'From catching up. Edit or split it once you know what it was.', items: [], adjust: true });
        }
      }
      // Anchor this month so today's balance is exactly what was entered.
      state.openings = state.openings || {};
      state.openings[cur] = round2(b - netOf(txnsIn(cur).filter(t => t.date <= today)));
      delete state.catchUpFrom;
      viewMonth = cur;
    }, null, 'Catch up');
    const sumBox = $('#cuSum');
    const paint = () => { sumBox.innerHTML = summary(); };
    paint();
    $('#cu-bal').addEventListener('input', paint);
    sumBox.addEventListener('change', e => { if (e.target.id === 'cu-log') logGap = e.target.checked; });
    modal.querySelectorAll('[data-cu-on]').forEach(cb => cb.addEventListener('change', () => {
      list[+cb.dataset.cuOn].on = cb.checked; cb.closest('li').classList.toggle('off', !cb.checked); paint();
    }));
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
      case 'chart-guide': $('#chartGuide').showModal(); break;
      case 'pick-plan': selectedPlan = id; render(); break;
      case 'apply-plan': applyPlan(id); break;
      case 'use-income': state.income = detectedIncome(); save(); break;
      case 'search-pattern': txnFilter = { q: b.dataset.q, cat: '' }; viewMonth = monthKey(new Date()); if (location.hash === '#transactions') render(); else location.hash = '#transactions'; window.scrollTo(0, 0); break;
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
        const txn = { id: uid(), created: Date.now(), type: 'expense', amount: l.payment, date: d, merchant: l.name, categoryId: l.categoryId, note: l.type === 'debt' ? 'Debt payment' : 'Bill', items: [], liabilityId: l.id };
        if (l.type === 'debt') {
          // The balance is today's balance, so only this month's payment lowers it. Catching up an old month just logs the payment.
          const before = l.balance || 0;
          if (isCurrent) { const interest = before * ((l.apr || 0) / 100 / 12); l.balance = round2(Math.max(0, before - Math.max(0, l.payment - interest))); }
          txn.balanceDelta = round2(before - l.balance);
        }
        state.transactions.push(txn);
        save(); break;
      }
      case 'unpay': {
        const t = paymentFor(id, viewMonth);
        const l = state.liabilities.find(x => x.id === id);
        if (t) {
          refundDebtPayment(t);
          state.transactions = state.transactions.filter(x => x !== t);
        }
        save(); break;
      }
      case 'sample': loadSample(); break;
      case 'import-csv': $('#csvFile').click(); break;
      case 'add-fund': fundForm(); break;
      case 'edit-fund': fundForm(state.funds.find(f => f.id === id)); break;
      case 'fund-add': fundAddForm(state.funds.find(f => f.id === id)); break;
      case 'fund-paid': fundPaidForm(state.funds.find(f => f.id === id)); break;
      case 'sweep': doSweep(id); break;
      case 'skip-sweep': state.sweeps = state.sweeps || {}; state.sweeps[id] = { skipped: true }; save(); break;
      case 'undo-sweep': undoSweep(); break;
      case 'catch-up': catchUpForm(); break;
      case 'skip-catch-up': delete state.catchUpFrom; save(); break;
      case 'export': $('#exportBtn').click(); break;
      case 'import': $('#importFile').click(); break;
    }
  });

  $('#addTxnBtn').addEventListener('click', () => txnForm());
  $('#csvFile').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(txt => importCSV(f, txt)).catch(() => alert('Budgt couldn\'t read that file.')).finally(() => { e.target.value = ''; });
  });
  $('#prevMonth').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, -1); render(); });
  $('#nextMonth').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, 1); render(); });
  window.addEventListener('hashchange', () => { sweptNote = null; render(); });

  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'budgt-backup-' + todayISO() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(txt => {
      const s = JSON.parse(txt);
      if (!s || !Array.isArray(s.categories) || !Array.isArray(s.transactions)) throw new Error('bad');
      const okTxn = t => t && typeof t.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && isFinite(t.amount) && (t.type === 'expense' || t.type === 'income');
      if (!s.transactions.every(okTxn) || !s.categories.every(c => c && typeof c.id === 'string' && typeof c.name === 'string')) throw new Error('bad');
      const idOk = x => x && /^[A-Za-z0-9_-]{1,40}$/.test(x.id);
      const n0 = v => (isFinite(+v) ? +v : 0);
      s.liabilities = Array.isArray(s.liabilities) ? s.liabilities : [];
      s.goals = Array.isArray(s.goals) ? s.goals : [];
      s.funds = Array.isArray(s.funds) ? s.funds : [];
      if (![s.transactions, s.categories, s.liabilities, s.goals, s.funds].every(list => list.every(idOk))) throw new Error('bad');
      s.transactions.forEach(t => { t.amount = +t.amount; if (!Array.isArray(t.items)) t.items = []; t.items = t.items.filter(i => i && typeof i.name === 'string').map(i => ({ name: i.name, amount: n0(i.amount) })); });
      s.categories.forEach(c => { c.budget = n0(c.budget); });
      s.liabilities.forEach(l => { l.name = String(l.name || ''); ['payment', 'balance', 'apr', 'dueDay'].forEach(f => { l[f] = n0(l[f]); }); });
      s.goals.forEach(g => { g.name = String(g.name || ''); ['target', 'saved', 'monthly'].forEach(f => { g[f] = n0(g[f]); }); if (!/^\d{4}-\d{2}(-\d{2})?$/.test(g.date || '')) g.date = ''; });
      s.funds.forEach(f => { f.name = String(f.name || ''); ['amount', 'saved', 'every'].forEach(k => { f[k] = n0(f[k]); }); if (!/^\d{4}-\d{2}$/.test(f.due || '')) f.due = monthKey(new Date()); });
      s.sweeps = s.sweeps && typeof s.sweeps === 'object' && !Array.isArray(s.sweeps) ? s.sweeps : {};
      s.income = n0(s.income);
      const op = s.openings && typeof s.openings === 'object' && !Array.isArray(s.openings) ? s.openings : {};
      s.openings = {}; Object.keys(op).forEach(k => { if (/^\d{4}-\d{2}$/.test(k) && isFinite(+op[k])) s.openings[k] = +op[k]; });
      ['lastSeen', 'catchUpFrom'].forEach(k => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s[k] || '')) delete s[k]; });
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
    s.funds = [
      { id: uid(), name: 'Car insurance', amount: 900, every: 6, due: shiftMonth(cur, 3), saved: 450, categoryId: cat('Transport') },
      { id: uid(), name: 'Holiday gifts', amount: 600, every: 12, due: shiftMonth(cur, 5), saved: 100, categoryId: cat('Shopping') },
    ];
    s.lastSeen = todayISO();
    state = s; viewMonth = cur; sweptNote = null;
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
