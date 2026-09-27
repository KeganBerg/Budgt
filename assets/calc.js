/* Budgt calculator flyout: add up costs and drop the result into a money field. */
(function () {
  'use strict';

  const TAPE_KEY = 'budgt:calc-tape';
  const EXPR_KEY = 'budgt:calc-expr';
  const $ = id => document.getElementById(id);
  const panel = $('calc'), toggle = $('calcToggle'), exprEl = $('calcExpr'), resultEl = $('calcResult');
  const tapeEl = $('calcTape'), insertBtn = $('calcInsert'), modal = $('modal');
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

  let tape = [];
  try { tape = JSON.parse(localStorage.getItem(TAPE_KEY)) || []; } catch (e) { tape = []; }
  let target = null;

  // ---------- safe expression parser (no eval) ----------
  // expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)* ; factor := ('+'|'-') factor | primary '%'? ; primary := number | '(' expr ')'
  function evaluate(src) {
    const s = src.replace(/[,$\s]/g, '').replace(/[x×]/gi, '*').replace(/÷/g, '/').replace(/−/g, '-');
    if (!s) return null;
    let i = 0;
    const peek = () => s[i];
    function expr() {
      let v = term();
      while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
      return v;
    }
    function term() {
      let v = factor();
      while (peek() === '*' || peek() === '/') {
        const op = s[i++]; const r = factor();
        if (op === '/' && r === 0) throw new Error("Can't divide by zero");
        v = op === '*' ? v * r : v / r;
      }
      return v;
    }
    function factor() {
      if (peek() === '-') { i++; return -factor(); }
      if (peek() === '+') { i++; return factor(); }
      let v;
      if (peek() === '(') { i++; v = expr(); if (peek() === ')') i++; }
      else {
        const m = /^\d*\.?\d+|^\d+\./.exec(s.slice(i));
        if (!m) throw new Error('Incomplete');
        i += m[0].length; v = parseFloat(m[0]);
      }
      if (peek() === '%') { i++; v = v / 100; }
      return v;
    }
    const v = expr();
    if (i < s.length) throw new Error('Incomplete');
    if (!isFinite(v)) throw new Error('Too big');
    return Math.round(v * 100) / 100;
  }

  function current() {
    try { return { value: evaluate(exprEl.value) }; } catch (e) { return { error: e.message }; }
  }

  function renderResult() {
    const r = current();
    resultEl.classList.toggle('err', !!r.error && r.error !== 'Incomplete');
    if (r.error) resultEl.textContent = r.error === 'Incomplete' ? resultEl.dataset.last || '0' : r.error;
    else { resultEl.textContent = r.value == null ? '0' : fmt.format(r.value); resultEl.dataset.last = resultEl.textContent; }
    if (r.value == null && !r.error) resultEl.dataset.last = '0';
    renderInsert();
    try { localStorage.setItem(EXPR_KEY, exprEl.value); } catch (e) { /* ignore */ }
  }

  function renderTape() {
    tapeEl.innerHTML = '';
    tape.forEach((t, idx) => {
      const li = document.createElement('li');
      const e = document.createElement('button'); e.type = 'button'; e.textContent = t.expr; e.title = 'Edit this calculation'; e.dataset.idx = idx; e.dataset.use = 'expr';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tape-res'; b.textContent = '= ' + fmt.format(t.result); b.title = 'Use this result'; b.dataset.idx = idx; b.dataset.use = 'result';
      li.append(e, b); tapeEl.append(li);
    });
    tapeEl.scrollTop = tapeEl.scrollHeight;
  }

  function saveTape() { try { localStorage.setItem(TAPE_KEY, JSON.stringify(tape.slice(-50))); } catch (e) { /* ignore */ } }

  function press(k) {
    const v = exprEl.value;
    if (k === 'C') { exprEl.value = ''; resultEl.dataset.last = '0'; }
    else if (k === 'back') exprEl.value = v.slice(0, -1);
    else if (k === '=') equals();
    else {
      // Replace a trailing operator instead of stacking two (keeps "5 + -" style negatives possible).
      if (/[+*/]$/.test(v) && /[+*/]/.test(k)) exprEl.value = v.slice(0, -1) + k;
      else exprEl.value = v + k;
    }
    renderResult();
    caretToEnd();
  }

  function caretToEnd() { const n = exprEl.value.length; exprEl.setSelectionRange(n, n); requestAnimationFrame(() => exprEl.setSelectionRange(exprEl.value.length, exprEl.value.length)); }

  function equals() {
    const r = current();
    if (r.error || r.value == null) return;
    const clean = exprEl.value.trim();
    if (clean !== String(r.value)) { tape.push({ expr: clean, result: r.value }); saveTape(); renderTape(); }
    exprEl.value = String(r.value);
    caretToEnd();
  }

  // ---------- inserting into money fields ----------
  function isMoneyField(el) { return el && el.tagName === 'INPUT' && el.inputMode === 'decimal' && !panel.contains(el); }

  function fieldLabel(el) {
    const f = el.closest('.field');
    if (f && f.querySelector('span')) return f.querySelector('span').textContent;
    return (el.getAttribute('aria-label') || 'field').replace(/^Monthly budget for /, '') + (el.dataset.catBudget ? ' budget' : '');
  }

  function setTarget(el) {
    if (target) target.classList.remove('calc-target');
    target = el;
    if (target && !panel.hidden) target.classList.add('calc-target');
    renderInsert();
  }

  function renderInsert() {
    if (target && !document.body.contains(target)) target = null;
    const r = current();
    if (!target) { insertBtn.disabled = true; insertBtn.textContent = 'Click a money field to insert'; return; }
    const ok = !r.error && r.value != null;
    insertBtn.disabled = !ok;
    insertBtn.textContent = ok ? 'Insert ' + money.format(r.value) + ' into ' + fieldLabel(target) : 'Insert into ' + fieldLabel(target);
  }

  function insert() {
    const r = current();
    if (!target || r.error || r.value == null) return;
    equals();
    const el = target;
    el.value = r.value.toFixed(2).replace(/\.00$/, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.classList.remove('calc-target');
    insertBtn.textContent = 'Inserted ' + money.format(r.value);
    insertBtn.disabled = true;
    target = null;
    setTimeout(renderInsert, 1400);
  }

  // ---------- open / close ----------
  // A modal <dialog> makes everything outside it inert, so the panel moves inside the dialog while one is open.
  function placePanel() {
    const host = modal.open ? modal : document.body;
    if (panel.parentNode !== host) host.appendChild(panel);
  }

  function open() {
    placePanel();
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    document.body.classList.add('calc-open');
    if (target) target.classList.add('calc-target');
    renderResult(); renderTape();
    if (!matchMedia('(max-width: 760px)').matches) exprEl.focus();
  }
  function close() {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('calc-open');
    if (target) target.classList.remove('calc-target');
  }

  toggle.addEventListener('click', () => (panel.hidden ? open() : close()));
  document.addEventListener('click', e => { if (e.target.closest('[data-calc-open]')) { const t = target; panel.hidden ? open() : close(); if (t) setTarget(t); } });
  exprEl.addEventListener('focus', caretToEnd);
  $('calcClose').addEventListener('click', close);
  $('calcKeys').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); });
  insertBtn.addEventListener('click', insert);
  $('calcClearTape').addEventListener('click', () => { tape = []; saveTape(); renderTape(); });
  tapeEl.addEventListener('click', e => {
    const b = e.target.closest('[data-use]'); if (!b) return;
    const t = tape[b.dataset.idx];
    if (b.dataset.use === 'expr') exprEl.value = t.expr;
    else exprEl.value = /[\d.)%]$/.test(exprEl.value) ? String(t.result) : exprEl.value + t.result;
    renderResult();
  });

  exprEl.addEventListener('input', () => { exprEl.value = exprEl.value.replace(/[^0-9+\-*/().%xX×÷−,$ ]/g, ''); renderResult(); });
  exprEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); equals(); renderResult(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });

  document.addEventListener('focusin', e => { if (isMoneyField(e.target)) setTarget(e.target); });

  new MutationObserver(() => {
    if (!modal.open) {
      // Fields inside a closed dialog can't receive a value any more.
      if (target && modal.contains(target)) setTarget(null);
    }
    if (!panel.hidden) placePanel();
  }).observe(modal, { attributes: true, attributeFilter: ['open'] });
  // Keep Esc inside the calculator from closing the whole transaction dialog.
  modal.addEventListener('cancel', e => { if (!panel.hidden && panel.contains(document.activeElement)) { e.preventDefault(); close(); } });
  modal.addEventListener('close', () => { if (panel.parentNode === modal) document.body.appendChild(panel); });

  try { exprEl.value = localStorage.getItem(EXPR_KEY) || ''; } catch (e) { /* ignore */ }
  renderTape(); renderResult();
})();
