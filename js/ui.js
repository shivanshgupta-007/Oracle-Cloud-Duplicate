/* Ledgerline Suite — ui.js
 * App shell: router, nav, drawer, toasts, tables, actions, persistence, global
 * search, and the shared drill-down detail panels used by every module.
 * See PLAN.md "UI conventions" for how views plug in.
 */
(function () {
  'use strict';
  const E = window.Engine;
  const U = E.util;
  const STORE_KEY = 'ledgerline-suite-v1';
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => U.money(+n || 0);
  const fmt0 = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(+n || 0)).toLocaleString('en-US');
  const num = (n) => (+n || 0).toLocaleString('en-US');
  const fdate = (d) => { if (!d) return ''; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]} ${y}`; };

  const STATUS_TONE = {
    Posted: 'good', Approved: 'good', Validated: 'accent', Paid: 'good', Closed: 'good', Received: 'accent', Invoiced: 'good', Active: 'good', Ordered: 'accent', Open: 'info',
    'Pending Approval': 'warn', Pending: 'warn', 'On Hold': 'bad', 'Credit Hold': 'bad', Rejected: 'bad', Cancelled: '', Terminated: '', Future: '', Entered: 'info',
    'Partially Received': 'info', 'Partially Paid': 'warn', Booked: 'info', Overdue: 'bad',
  };
  const pill = (status, tone) => `<span class="pill ${tone ?? STATUS_TONE[status] ?? ''}">${esc(status)}</span>`;

  // ---------- registry ----------
  const views = {}; const order = []; const acts = {};
  const NAV = [
    ['Overview', ['home', 'approvals']],
    ['Financials', ['journals', 'accounts', 'reports', 'periods', 'payables', 'receivables']],
    ['Supply chain', ['purchasing', 'inventory', 'orders']],
    ['People', ['workforce', 'absence', 'payroll']],
    ['Administration', ['audit', 'security']],
  ];
  const ui = { tab: {}, filter: {} }; // per-view UI state (tabs, filters); not persisted in engine state

  const App = {
    E, U, esc, fmt, fmt0, num, fdate, pill, ui, $, $$,
    view(name, def) { views[name] = def; order.push(name); },
    act(name, fn) { acts[name] = fn; },
    get role() { return E.S.role; },
    can(perm) { return E.can(E.S.role, perm); },
    current: 'home',
  };

  // ---------- persistence ----------
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(E.S)); } catch (e) { /* storage unavailable: session-only */ } }
  function loadOrSeed() {
    try { const raw = localStorage.getItem(STORE_KEY); if (raw) { const s = JSON.parse(raw); if (s && s.version === 1 && s.accounts?.length) { E.load(s); return; } } } catch (e) { /* ignore */ }
    window.seedDemo(); save();
  }

  // ---------- action runner: atomic with rollback ----------
  /** Runs fn; on error restores the snapshot and rethrows. Saves + re-renders on success. */
  App.run = function (fn, okMsg) {
    const snap = JSON.stringify(E.S);
    try {
      const res = fn();
      save(); render(); refreshDrawer();
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(res) : okMsg);
      return res;
    } catch (err) {
      E.load(JSON.parse(snap));
      toast(err.message || String(err), 'bad');
      throw err;
    }
  };
  /** Like run, but swallows the error (already toasted). For click handlers. */
  App.try = function (fn, okMsg) { try { return App.run(fn, okMsg); } catch (e) { return undefined; } };

  // ---------- toasts ----------
  function toast(msg, tone) {
    const t = document.createElement('div'); t.className = 'toast ' + (tone || ''); t.textContent = msg; t.setAttribute('role', tone === 'bad' ? 'alert' : 'status');
    $('#toasts').appendChild(t); setTimeout(() => t.remove(), tone === 'bad' ? 7000 : 3800);
  }
  App.toast = toast;

  // ---------- building blocks ----------
  /** btn(label, act, data, perm, cls) — disabled with a reason when the role lacks perm */
  App.btn = function (label, act, data = {}, perm, cls = '') {
    const ok = !perm || App.can(perm);
    const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
    return `<button type="button" class="btn ${cls}" data-act="${esc(act)}" ${attrs} ${ok ? '' : `disabled title="Your role (${esc(E.S.role)}) cannot do this. Switch role in the top bar."`}>${label}</button>`;
  };
  /** link(kind, id, label) — opens the shared detail drawer */
  App.link = (kind, id, label) => id ? `<button type="button" class="btn link mono" data-act="open" data-kind="${esc(kind)}" data-id="${esc(id)}">${esc(label ?? id)}</button>` : '';
  /** table(cols, rows, {empty, foot}) — cols: [{h, f(row), num, cls}] */
  App.table = function (cols, rows, opts = {}) {
    if (!rows.length) return `<div class="empty">${opts.empty || 'Nothing here yet.'}</div>`;
    const th = cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.h}</th>`).join('');
    const tb = rows.map((r) => `<tr class="${opts.rowCls ? opts.rowCls(r) : ''}">${cols.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.f(r)}</td>`).join('')}</tr>`).join('');
    const tf = opts.foot ? `<tfoot><tr>${opts.foot.map((x, i) => `<td class="${cols[i]?.num ? 'num' : ''}">${x ?? ''}</td>`).join('')}</tr></tfoot>` : '';
    return `<div class="tbl-wrap"><table class="t"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody>${tf}</table></div>`;
  };
  /** tabs(viewName, [[key,label]]) returns html; App.tabOf(view, default) reads current */
  App.tabs = (view, list) => { const cur = App.tabOf(view, list[0][0]); return `<div class="tabs" role="tablist">${list.map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === cur}" class="${k === cur ? 'on' : ''}" data-act="tab" data-view="${view}" data-tab="${k}">${l}</button>`).join('')}</div>`; };
  App.tabOf = (view, def) => ui.tab[view] || def;
  App.head = (crumb, title, desc, actionsHtml = '') => `<div class="page-head"><div><div class="crumb">${esc(crumb)}</div><h1>${esc(title)}</h1>${desc ? `<p>${desc}</p>` : ''}</div><div class="actions">${actionsHtml}</div></div>`;
  App.kpi = (label, value, sub = '') => `<div class="kpi"><div class="l">${label}</div><div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  App.field = (label, inner, hint = '') => `<label class="field"><span>${label}</span>${inner}${hint ? `<small class="hint">${hint}</small>` : ''}</label>`;
  App.input = (id, value = '', type = 'text', extra = '') => `<input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${extra}>`;
  App.select = (id, options, value = '', extra = '') => `<select id="${id}" name="${id}" ${extra}>${options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
  App.openPeriods = () => E.periods().filter((p) => p.status === 'Open').map((p) => p.period);
  App.accountOptions = () => E.S.accounts.map((a) => [a.code, `${a.code} ${a.name}`]);
  App.itemOptions = () => E.S.items.map((i) => [i.sku, `${i.sku} ${i.name}`]);
  App.val = (form, id) => { const el = form.querySelector('#' + id); return el ? el.value : ''; };

  /** Line editor: App.lines(id, cols, rows) where cols=[{key, label, type:'select'|'number'|'text', options, width}]
   *  Read back with App.readLines(form, id) -> [{key: value}] */
  App.lines = function (id, cols, rows = [{}]) {
    const cell = (c, r, i) => c.type === 'select'
      ? `<select class="cell-in" data-k="${c.key}" id="${id}-${c.key}-${i}">${(c.options || []).map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(r[c.key] ?? '') ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`
      : `<input class="cell-in ${c.type === 'number' ? 'num' : ''}" data-k="${c.key}" id="${id}-${c.key}-${i}" type="${c.type === 'number' ? 'number' : 'text'}" step="any" value="${esc(r[c.key] ?? '')}" ${c.readonly ? 'readonly' : ''}>`;
    const row = (r, i) => `<tr data-line="${i}">${cols.map((c) => `<td style="${c.width ? 'width:' + c.width : ''}">${cell(c, r, i)}</td>`).join('')}<td style="width:34px"><button type="button" class="btn sm" data-act="line-del" aria-label="Remove line">&times;</button></td></tr>`;
    const tpl = esc(JSON.stringify(cols));
    return `<div class="tbl-wrap"><table class="t lines-tbl" id="${id}" data-cols="${tpl}"><thead><tr>${cols.map((c) => `<th class="${c.type === 'number' ? 'num' : ''}">${c.label}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>
      <div><button type="button" class="btn sm" data-act="line-add" data-table="${id}">Add line</button></div>`;
  };
  App.readLines = (form, id) => $$(`#${id} tbody tr`, form).map((tr) => { const o = {}; $$('[data-k]', tr).forEach((el) => (o[el.dataset.k] = el.value)); return o; });
  App.act('line-add', (ds) => {
    const t = document.getElementById(ds.table); const cols = JSON.parse(t.dataset.cols); const i = Date.now() % 100000;
    const tmp = document.createElement('tbody'); tmp.innerHTML = App.lines(ds.table + '__tmp', cols, [{}]).match(/<tbody>([\s\S]*)<\/tbody>/)[1].replaceAll(ds.table + '__tmp', ds.table).replace(/-0"/g, `-${i}"`);
    t.tBodies[0].appendChild(tmp.firstElementChild); t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  App.act('line-del', (ds, el) => { const tb = el.closest('tbody'); if (tb.rows.length > 1) { el.closest('tr').remove(); tb.dispatchEvent(new Event('input', { bubbles: true })); } });

  // ---------- drawer ----------
  let drawerState = null;
  /** drawer(title, html | () => html, {submitLabel, onSubmit(form) -> truthy closes, oninput(form), wide}) */
  App.drawer = function (title, html, opts = {}) {
    closeDrawer();
    drawerState = { title, html, opts, ret: document.activeElement };
    const scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.id = 'scrim'; scrim.addEventListener('click', closeDrawer);
    const d = document.createElement('form'); d.className = 'drawer'; d.id = 'drawer'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', title); d.noValidate = true;
    d.innerHTML = `<header><h2>${esc(title)}</h2><button type="button" class="btn sm" data-act="close-drawer">Close</button></header>
      <div class="body">${typeof html === 'function' ? html() : html}</div>
      <footer><span class="err" id="drawerErr"></span>${opts.extraButtons || ''}${opts.onSubmit ? `<button type="button" class="btn" data-act="close-drawer">Cancel</button><button type="submit" class="btn primary">${esc(opts.submitLabel || 'Save')}</button>` : ''}</footer>`;
    d.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const snap = JSON.stringify(E.S);
      try { const r = opts.onSubmit(d); save(); closeDrawer(); render(); if (opts.success) toast(typeof opts.success === 'function' ? opts.success(r) : opts.success); }
      catch (err) { E.load(JSON.parse(snap)); $('#drawerErr', d).textContent = err.message || String(err); }
    });
    if (opts.oninput) { d.addEventListener('input', () => opts.oninput(d)); d.addEventListener('change', () => opts.oninput(d)); }
    document.body.append(scrim, d);
    if (opts.oninput) opts.oninput(d);
    const first = d.querySelector('.body input, .body select, .body textarea, .body button'); (first || d.querySelector('header button')).focus();
  };
  function closeDrawer() { $('#drawer')?.remove(); $('#scrim')?.remove(); const r = drawerState?.ret; drawerState = null; if (r && document.contains(r)) r.focus(); }
  function refreshDrawer() { if (drawerState && drawerState.opts.detail) App.open(drawerState.opts.detail.kind, drawerState.opts.detail.id); }
  App.closeDrawer = closeDrawer;
  App.act('close-drawer', closeDrawer);
  /** In-page confirmation (native confirm() is unavailable in the viewer). */
  App.confirm = (title, message, label, fn, okMsg) => App.drawer(title, `<p>${message}</p>`, { submitLabel: label, onSubmit: () => fn(), success: okMsg });

  // ---------- detail panels (drill-down from anywhere) ----------
  const details = {};
  App.detail = (kind, fn) => (details[kind] = fn);
  App.open = function (kind, id) {
    const fn = details[kind]; if (!fn) { toast(`No detail view for ${kind}.`, 'bad'); return; }
    const r = fn(id); if (!r) { toast(`${id} was not found.`, 'bad'); return; }
    App.drawer(r.title, r.html, { detail: { kind, id }, extraButtons: r.buttons || '' });
  };
  App.act('open', (ds) => App.open(ds.kind, ds.id));
  const dl = (pairs) => `<div class="dl">${pairs.filter(Boolean).map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('')}</div>`;
  App.dl = dl;
  const journalLines = (j) => App.table([
    { h: 'Account', f: (l) => `${App.link('acct', l.acct)} ${esc(E.acct(l.acct)?.name)}` },
    { h: 'Memo', f: (l) => esc(l.memo) },
    { h: 'Debit', num: true, f: (l) => (l.dr ? fmt(l.dr) : '') }, { h: 'Credit', num: true, f: (l) => (l.cr ? fmt(l.cr) : '') },
  ], j.lines, { foot: ['Total', '', fmt(U.sum(j.lines, (l) => l.dr)), fmt(U.sum(j.lines, (l) => l.cr))] });
  App.journalLines = journalLines;
  const refLink = (ref) => {
    if (!ref) return '<span class="muted">None</span>';
    const k = ref.startsWith('PO-') ? 'po' : ref.startsWith('SO-') ? 'so' : ref.startsWith('APINV-') ? 'apinv' : ref.startsWith('ARINV-') ? 'arinv' : ref.startsWith('PR-') ? 'payrun' : ref.startsWith('PAY-') ? 'pay' : ref.startsWith('JE-') ? 'je' : E.item(ref) ? 'item' : null;
    return k ? App.link(k, ref) : esc(ref);
  };
  App.refLink = refLink;
  const journalsFor = (ref) => E.S.journals.filter((j) => j.ref === ref);
  const jeList = (list) => App.table([
    { h: 'Journal', f: (j) => App.link('je', j.id) }, { h: 'Date', f: (j) => fdate(j.date) }, { h: 'Description', f: (j) => esc(j.desc) }, { h: 'Amount', num: true, f: (j) => fmt(j.total) }, { h: 'Status', f: (j) => pill(j.status) },
  ], list, { empty: 'No accounting yet.' });
  App.jeList = jeList;

  App.detail('je', (id) => { const j = E.je(id); if (!j) return null;
    return { title: `Journal ${j.id}`, html: dl([['Status', pill(j.status)], ['Date', fdate(j.date)], ['Period', U.periodLabel(j.period)], ['Source', esc(j.source)], ['Source document', refLink(j.ref)], ['Entered by', esc(j.createdBy)], j.approvedBy && ['Approved by', esc(j.approvedBy)], j.rejectReason && ['Rejection reason', esc(j.rejectReason)]])
      + `<p>${esc(j.desc)}</p>` + journalLines(j),
      buttons: j.status === 'Pending Approval' ? App.btn('Reject', 'je-reject', { id }, 'gl.approve', 'danger') + App.btn('Approve and post', 'je-approve', { id }, 'gl.approve', 'primary') : '' };
  });
  App.act('je-approve', (ds) => App.try(() => E.approveJournal(ds.id), `${ds.id} approved and posted.`));
  App.act('je-reject', (ds) => App.try(() => E.rejectJournal(ds.id, 'Rejected by reviewer'), `${ds.id} rejected.`));

  App.detail('acct', (code) => { const a = E.acct(code); if (!a) return null;
    let run = 0; const rows = [];
    E.S.journals.filter((j) => j.status === 'Posted').sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id)).forEach((j) => j.lines.filter((l) => l.acct === code).forEach((l) => { run = U.r2(run + l.dr - l.cr); rows.push({ j, l, run }); }));
    const bal = E.natural(code, run);
    return { title: `${a.code} ${a.name}`, html: dl([['Type', esc(a.type)], ['Normal balance', E.natural(code, 1) > 0 ? 'Debit' : 'Credit'], ['Balance', `<span class="num">${fmt(bal)}</span>`], ['Postings', num(rows.length)]])
      + App.table([{ h: 'Date', f: (r) => fdate(r.j.date) }, { h: 'Journal', f: (r) => App.link('je', r.j.id) }, { h: 'Description', f: (r) => esc(r.j.desc) }, { h: 'Debit', num: true, f: (r) => (r.l.dr ? fmt(r.l.dr) : '') }, { h: 'Credit', num: true, f: (r) => (r.l.cr ? fmt(r.l.cr) : '') }, { h: 'Running (Dr-Cr)', num: true, f: (r) => fmt(r.run) }], rows.slice().reverse(), { empty: 'No postings to this account.' }) };
  });

  const stepFlow = (steps, cur) => `<div class="flow">${steps.map((s, i) => `<span class="step ${i < cur ? 'done' : i === cur ? 'cur' : ''}">${esc(s)}</span>${i < steps.length - 1 ? '<span class="arrow">&rarr;</span>' : ''}`).join('')}</div>`;
  App.stepFlow = stepFlow;

  App.detail('req', (id) => { const r = E.req(id); if (!r) return null;
    const cur = { 'Pending Approval': 1, Approved: 2, Ordered: 3, Rejected: 1 }[r.status];
    return { title: `Requisition ${r.id}`, html: stepFlow(['Submitted', 'Approval', 'Approved', 'Ordered'], cur) + dl([['Status', pill(r.status)], ['Date', fdate(r.date)], ['Requester', esc(r.requester)], ['Total', `<span class="num">${fmt(r.total)}</span>`], ['Purchase order', r.poId ? App.link('po', r.poId) : '<span class="muted">Not ordered</span>'], r.approvedBy && ['Approved by', esc(r.approvedBy)]]) + (r.justification ? `<p>${esc(r.justification)}</p>` : '')
      + App.table([{ h: 'Item', f: (l) => App.link('item', l.sku) + ' ' + esc(E.item(l.sku)?.name) }, { h: 'Qty', num: true, f: (l) => num(l.qty) }, { h: 'Est. price', num: true, f: (l) => fmt(l.price) }, { h: 'Amount', num: true, f: (l) => fmt(l.qty * l.price) }], r.lines),
      buttons: r.status === 'Pending Approval' ? App.btn('Reject', 'req-reject', { id }, 'req.approve', 'danger') + App.btn('Approve', 'req-approve', { id }, 'req.approve', 'primary') : '' };
  });
  App.act('req-approve', (ds) => App.try(() => E.approveReq(ds.id), `${ds.id} approved.`));
  App.act('req-reject', (ds) => App.try(() => E.rejectReq(ds.id, 'Rejected by approver'), `${ds.id} rejected.`));

  App.detail('po', (id) => { const p = E.po(id); if (!p) return null;
    const cur = { Open: 1, 'Partially Received': 1, Received: 2, Closed: 4 }[p.status];
    const invs = E.S.apInvoices.filter((i) => i.poId === id);
    return { title: `Purchase order ${p.id}`, html: stepFlow(['Ordered', 'Received', 'Invoiced', 'Paid'], p.status === 'Closed' ? (invs.every((i) => i.status === 'Paid') ? 4 : 3) : cur)
      + dl([['Status', pill(p.status)], ['Supplier', App.link('sup', p.supplierId, E.sup(p.supplierId)?.name)], ['Order date', fdate(p.date)], ['Buyer', esc(p.buyer)], ['Requisition', p.reqId ? App.link('req', p.reqId) : '<span class="muted">None</span>'], ['Total', `<span class="num">${fmt(p.total)}</span>`]])
      + '<h3 style="margin:0;font-size:14px">Three-way match: ordered, received, billed</h3>'
      + App.table([{ h: 'Item', f: (l) => App.link('item', l.sku) }, { h: 'Ordered', num: true, f: (l) => num(l.qty) }, { h: 'Received', num: true, f: (l) => num(l.received) }, { h: 'Billed', num: true, f: (l) => num(l.invoiced) }, { h: 'PO price', num: true, f: (l) => fmt(l.price) }, { h: 'Accrued, not billed', num: true, f: (l) => fmt((l.received - l.invoiced) * l.price) }], p.lines)
      + '<h3 style="margin:0;font-size:14px">Supplier invoices</h3>'
      + App.table([{ h: 'Invoice', f: (i) => App.link('apinv', i.id) }, { h: 'Supplier no.', f: (i) => esc(i.number) }, { h: 'Date', f: (i) => fdate(i.date) }, { h: 'Amount', num: true, f: (i) => fmt(i.total) }, { h: 'Status', f: (i) => pill(i.status) }], invs, { empty: 'Not billed yet.' })
      + '<h3 style="margin:0;font-size:14px">Accounting</h3>' + jeList(journalsFor(id)),
      buttons: (['Open', 'Partially Received'].includes(p.status) ? App.btn('Receive goods', 'po-receive', { id }, 'po.receive', 'primary') : '') + (p.lines.some((l) => l.received > l.invoiced) ? App.btn('Enter invoice', 'ap-enter', { po: id }, 'ap.enter') : '') };
  });

  App.detail('apinv', (id) => { const i = E.apinv(id); if (!i) return null;
    const pay = E.S.payments.find((p) => p.id === i.paymentId);
    return { title: `Payables invoice ${i.id}`, html: stepFlow(['Entered', 'Matched', 'Validated', 'Paid'], { 'On Hold': 1, Validated: 3, Paid: 4, Cancelled: 0 }[i.status] ?? 0)
      + dl([['Status', pill(i.status)], ['Supplier', App.link('sup', i.supplierId, E.sup(i.supplierId)?.name)], ['Supplier invoice no.', esc(i.number)], ['Purchase order', App.link('po', i.poId)], ['Invoice date', fdate(i.date)], ['Due', fdate(i.due)], ['Amount', `<span class="num">${fmt(i.total)}</span>`], ['Payment', pay ? App.link('pay', pay.id) : '<span class="muted">Unpaid</span>']])
      + (i.holds?.length ? `<div class="callout bad"><b>Match holds</b><br>${i.holds.map(esc).join('<br>')}</div>` : '') + (i.holdsReleased?.length ? `<div class="callout warn">Hold released by ${esc(i.releasedBy)}: ${i.holdsReleased.map(esc).join('; ')}</div>` : '')
      + App.table([{ h: 'Item', f: (l) => App.link('item', l.sku) }, { h: 'Qty', num: true, f: (l) => num(l.qty) }, { h: 'Invoice price', num: true, f: (l) => fmt(l.price) }, { h: 'PO price', num: true, f: (l) => fmt(l.poPrice) }, { h: 'Variance', num: true, f: (l) => fmt((l.price - l.poPrice) * l.qty) }, { h: 'Amount', num: true, f: (l) => fmt(l.qty * l.price) }], i.lines)
      + '<h3 style="margin:0;font-size:14px">Accounting</h3>' + jeList(E.S.journals.filter((j) => j.ref === id || (pay && j.id === pay.journal))),
      buttons: (i.status === 'On Hold' ? App.btn('Cancel invoice', 'ap-cancel', { id }, 'ap.enter', 'danger') + App.btn('Release hold and validate', 'ap-release', { id }, 'ap.release', 'primary') : '') + (i.status === 'Validated' ? App.btn('Pay invoice', 'ap-pay', { id }, 'ap.pay', 'primary') : '') };
  });
  App.detail('pay', (id) => { const p = E.S.payments.find((x) => x.id === id); if (!p) return null;
    return { title: `Payment ${p.id}`, html: dl([['Supplier', App.link('sup', p.supplierId, E.sup(p.supplierId)?.name)], ['Date', fdate(p.date)], ['Method', esc(p.method)], ['Amount', `<span class="num">${fmt(p.amount)}</span>`], ['Journal', App.link('je', p.journal)]]) + '<h3 style="margin:0;font-size:14px">Invoices paid</h3>' + App.table([{ h: 'Invoice', f: (id2) => App.link('apinv', id2) }, { h: 'Supplier no.', f: (id2) => esc(E.apinv(id2).number) }, { h: 'Amount', num: true, f: (id2) => fmt(E.apinv(id2).total) }], p.invoices) };
  });

  App.detail('so', (id) => { const o = E.so(id); if (!o) return null; const inv = o.invoiceId && E.arinv(o.invoiceId);
    return { title: `Sales order ${o.id}`, html: stepFlow(['Booked', 'Credit check', 'Shipped', 'Invoiced', 'Paid'], o.status === 'Credit Hold' ? 1 : o.status === 'Booked' ? 2 : o.status === 'Invoiced' ? (inv?.status === 'Paid' ? 5 : 4) : 0)
      + dl([['Status', pill(o.status)], ['Customer', App.link('cust', o.customerId, E.cust(o.customerId)?.name)], ['Order date', fdate(o.date)], ['Customer PO', esc(o.poNumber) || '<span class="muted">None</span>'], ['Total', `<span class="num">${fmt(o.total)}</span>`], ['Ship date', o.shipDate ? fdate(o.shipDate) : '<span class="muted">Not shipped</span>'], ['Invoice', inv ? App.link('arinv', inv.id) : '<span class="muted">None</span>'], o.margin != null && ['Gross margin', `<span class="num">${fmt(o.margin)} (${Math.round((o.margin / o.total) * 100)}%)</span>`]])
      + (o.hold && o.status === 'Credit Hold' ? `<div class="callout bad">${esc(o.hold)}</div>` : '')
      + App.table([{ h: 'Item', f: (l) => App.link('item', l.sku) + ' ' + esc(E.item(l.sku)?.name) }, { h: 'Qty', num: true, f: (l) => num(l.qty) }, { h: 'On hand', num: true, f: (l) => num(E.item(l.sku)?.onHand) }, { h: 'Price', num: true, f: (l) => fmt(l.price) }, { h: 'Amount', num: true, f: (l) => fmt(l.qty * l.price) }, { h: 'Unit cost', num: true, f: (l) => (l.unitCost != null ? fmt(l.unitCost) : '') }], o.lines)
      + '<h3 style="margin:0;font-size:14px">Accounting</h3>' + jeList(E.S.journals.filter((j) => j.ref === id || (inv && j.ref === inv.id))),
      buttons: (o.status === 'Credit Hold' ? App.btn('Release credit hold', 'so-release', { id }, 'so.release', 'primary') : '') + (['Booked', 'Credit Hold'].includes(o.status) ? App.btn('Cancel order', 'so-cancel', { id }, 'so.create', 'danger') : '') + (o.status === 'Booked' ? App.btn('Ship and invoice', 'so-ship', { id }, 'so.ship', 'primary') : '') };
  });

  App.detail('arinv', (id) => { const i = E.arinv(id); if (!i) return null; const late = U.daysBetween(i.due, E.S.today);
    return { title: `Receivables invoice ${i.id}`, html: dl([['Status', pill(i.status !== 'Paid' && late > 0 ? 'Overdue' : i.status)], ['Customer', App.link('cust', i.customerId, E.cust(i.customerId)?.name)], ['Sales order', App.link('so', i.soId)], ['Invoice date', fdate(i.date)], ['Due', fdate(i.due) + (i.status !== 'Paid' && late > 0 ? ` <span class="muted">(${late} days late)</span>` : '')], ['Amount', `<span class="num">${fmt(i.total)}</span>`], ['Received', `<span class="num">${fmt(i.paid)}</span>`], ['Open', `<span class="num">${fmt(i.total - i.paid)}</span>`]])
      + '<h3 style="margin:0;font-size:14px">Receipts</h3>' + App.table([{ h: 'Receipt', f: (r) => esc(r.id) }, { h: 'Date', f: (r) => fdate(r.date) }, { h: 'Reference', f: (r) => esc(r.reference) }, { h: 'Amount', num: true, f: (r) => fmt(r.amount) }, { h: 'Journal', f: (r) => App.link('je', r.journal) }], E.S.receipts.filter((r) => r.invoiceId === id), { empty: 'No receipts yet.' })
      + '<h3 style="margin:0;font-size:14px">Accounting</h3>' + jeList(journalsFor(id)),
      buttons: i.status !== 'Paid' ? App.btn('Record receipt', 'ar-receipt', { id }, 'ar.receipt', 'primary') : '' };
  });

  App.detail('item', (sku) => { const it = E.item(sku); if (!it) return null;
    return { title: `${it.sku} ${it.name}`, html: dl([['On hand', `<span class="num">${num(it.onHand)} ${esc(it.uom)}</span>`], ['Average cost', `<span class="num">${fmt(it.avgCost)}</span>`], ['Inventory value', `<span class="num">${fmt(it.onHand * it.avgCost)}</span>`], ['List price', `<span class="num">${fmt(it.price)}</span>`], ['Reorder point', `<span class="num">${num(it.reorder)}</span>`], ['Status', it.onHand <= it.reorder ? pill('Below reorder point', 'warn') : pill('In stock', 'good')]])
      + App.table([{ h: 'Date', f: (t) => fdate(t.date) }, { h: 'Type', f: (t) => esc(t.type) }, { h: 'Reference', f: (t) => refLink(t.ref) }, { h: 'Qty', num: true, f: (t) => (t.qty > 0 ? '+' : '') + num(t.qty) }, { h: 'Unit cost', num: true, f: (t) => fmt(t.unitCost) }, { h: 'On hand after', num: true, f: (t) => num(t.onHandAfter) }], E.S.invTxns.filter((t) => t.sku === sku), { empty: 'No movements.' }),
      buttons: App.btn('Adjust quantity', 'inv-adjust', { sku }, 'inv.adjust') };
  });

  App.detail('sup', (id) => { const s = E.sup(id); if (!s) return null; const invs = E.S.apInvoices.filter((i) => i.supplierId === id);
    return { title: s.name, html: dl([['Supplier', esc(s.id)], ['Site', esc(s.site)], ['Payment terms', `Net ${s.terms}`], ['Open payables', `<span class="num">${fmt(U.sum(invs.filter((i) => i.status === 'Validated'), (i) => i.total - i.paid))}</span>`], ['Spend to date', `<span class="num">${fmt(U.sum(invs.filter((i) => i.status !== 'Cancelled'), (i) => i.total))}</span>`]])
      + '<h3 style="margin:0;font-size:14px">Purchase orders</h3>' + App.table([{ h: 'PO', f: (p) => App.link('po', p.id) }, { h: 'Date', f: (p) => fdate(p.date) }, { h: 'Total', num: true, f: (p) => fmt(p.total) }, { h: 'Status', f: (p) => pill(p.status) }], E.S.pos.filter((p) => p.supplierId === id))
      + '<h3 style="margin:0;font-size:14px">Invoices</h3>' + App.table([{ h: 'Invoice', f: (i) => App.link('apinv', i.id) }, { h: 'Number', f: (i) => esc(i.number) }, { h: 'Due', f: (i) => fdate(i.due) }, { h: 'Amount', num: true, f: (i) => fmt(i.total) }, { h: 'Status', f: (i) => pill(i.status) }], invs) };
  });
  App.detail('cust', (id) => { const c = E.cust(id); if (!c) return null; const invs = E.S.arInvoices.filter((i) => i.customerId === id); const open = E.openAR(id);
    return { title: c.name, html: dl([['Customer', esc(c.id)], ['Segment', esc(c.segment)], ['Terms', `Net ${c.terms}`], ['Credit limit', `<span class="num">${fmt(c.creditLimit)}</span>`], ['Open receivables', `<span class="num">${fmt(open)}</span>`], ['Available credit', `<span class="num">${fmt(c.creditLimit - open)}</span>`]])
      + '<h3 style="margin:0;font-size:14px">Sales orders</h3>' + App.table([{ h: 'Order', f: (o) => App.link('so', o.id) }, { h: 'Date', f: (o) => fdate(o.date) }, { h: 'Total', num: true, f: (o) => fmt(o.total) }, { h: 'Status', f: (o) => pill(o.status) }], E.S.sos.filter((o) => o.customerId === id).slice().reverse())
      + '<h3 style="margin:0;font-size:14px">Invoices</h3>' + App.table([{ h: 'Invoice', f: (i) => App.link('arinv', i.id) }, { h: 'Due', f: (i) => fdate(i.due) }, { h: 'Amount', num: true, f: (i) => fmt(i.total) }, { h: 'Open', num: true, f: (i) => fmt(i.total - i.paid) }, { h: 'Status', f: (i) => pill(i.status) }], invs.slice().reverse()) };
  });

  App.detail('emp', (id) => { const e = E.emp(id); if (!e) return null; const m = E.emp(e.managerId); const reports = E.S.employees.filter((x) => x.managerId === id && x.status === 'Active');
    const slips = E.S.payruns.map((r) => ({ r, s: r.slips.find((s) => s.empId === id) })).filter((x) => x.s);
    return { title: e.name, html: dl([['Employee', esc(e.id)], ['Status', pill(e.status)], ['Job title', esc(e.title)], ['Department', esc(e.dept)], ['Manager', m ? App.link('emp', m.id, m.name) : '<span class="muted">None</span>'], ['Hire date', fdate(e.hireDate)], ['Annual salary', `<span class="num">${fmt(e.salary)}</span>`], ['Vacation balance', `${e.ptoBalance} days`], ['Location', esc(e.location)], e.termDate && ['Termination date', fdate(e.termDate)]])
      + '<h3 style="margin:0;font-size:14px">Direct reports</h3>' + App.table([{ h: 'Name', f: (x) => App.link('emp', x.id, x.name) }, { h: 'Title', f: (x) => esc(x.title) }], reports, { empty: 'No direct reports.' })
      + '<h3 style="margin:0;font-size:14px">Absences</h3>' + App.table([{ h: 'Request', f: (a) => esc(a.id) }, { h: 'Type', f: (a) => esc(a.type) }, { h: 'Dates', f: (a) => `${fdate(a.start)} to ${fdate(a.end)}` }, { h: 'Days', num: true, f: (a) => a.days }, { h: 'Status', f: (a) => pill(a.status) }], E.S.absences.filter((a) => a.empId === id), { empty: 'No absences.' })
      + '<h3 style="margin:0;font-size:14px">Payslips</h3>' + App.table([{ h: 'Run', f: (x) => App.link('payrun', x.r.id) }, { h: 'Period', f: (x) => U.periodLabel(x.r.period) }, { h: 'Gross', num: true, f: (x) => fmt(x.s.gross) }, { h: 'Tax withheld', num: true, f: (x) => fmt(x.s.tax) }, { h: 'Net', num: true, f: (x) => fmt(x.s.net) }], slips, { empty: 'No payslips.' }),
      buttons: e.status === 'Active' ? App.btn('Request absence', 'abs-new', { emp: id }, 'hr.absence.create') + App.btn('Terminate', 'emp-terminate', { id }, 'hr.edit', 'danger') : '' };
  });
  App.detail('payrun', (id) => { const r = E.payrun(id); if (!r) return null;
    return { title: `Payroll ${U.periodLabel(r.period)} (${r.id})`, html: dl([['Pay date', fdate(r.date)], ['Employees', r.slips.length], ['Gross', `<span class="num">${fmt(r.gross)}</span>`], ['Withholding', `<span class="num">${fmt(r.tax)}</span>`], ['Employer taxes', `<span class="num">${fmt(r.employerTax)}</span>`], ['Net pay', `<span class="num">${fmt(r.net)}</span>`], ['Journal', App.link('je', r.journal)]])
      + App.table([{ h: 'Employee', f: (s) => App.link('emp', s.empId, s.name) }, { h: 'Department', f: (s) => esc(s.dept) }, { h: 'Gross', num: true, f: (s) => fmt(s.gross) }, { h: 'Withheld', num: true, f: (s) => fmt(s.tax) }, { h: 'Net', num: true, f: (s) => fmt(s.net) }, { h: 'Employer tax', num: true, f: (s) => fmt(s.employerTax) }], r.slips, { foot: ['Total', '', fmt(r.gross), fmt(r.tax), fmt(r.net), fmt(r.employerTax)] }) };
  });
  App.detail('abs', (id) => { const a = E.S.absences.find((x) => x.id === id); if (!a) return null; const e = E.emp(a.empId);
    return { title: `Absence ${a.id}`, html: dl([['Employee', App.link('emp', e.id, e.name)], ['Type', esc(a.type)], ['From', fdate(a.start)], ['To', fdate(a.end)], ['Working days', a.days], ['Status', pill(a.status)], ['Approver', esc(E.emp(a.approverId)?.name || 'HR')], ['Vacation balance', `${e.ptoBalance} days`]]) + (a.note ? `<p>${esc(a.note)}</p>` : ''),
      buttons: a.status === 'Pending' ? App.btn('Reject', 'abs-reject', { id }, 'hr.absence.approve', 'danger') + App.btn('Approve', 'abs-approve', { id }, 'hr.absence.approve', 'primary') : '' };
  });
  App.act('abs-approve', (ds) => App.try(() => E.approveAbsence(ds.id), `${ds.id} approved.`));
  App.act('abs-reject', (ds) => App.try(() => E.rejectAbsence(ds.id, 'Not approved'), `${ds.id} rejected.`));

  // ---------- shared transaction forms (used from details, approvals and module pages) ----------
  const today = () => E.S.today;
  App.act('po-receive', (ds) => { const p = E.po(ds.id);
    App.drawer(`Receive goods on ${p.id}`, App.field('Receipt date', App.input('rcvDate', today(), 'date')) + App.table([{ h: 'Item', f: (l) => esc(l.sku) }, { h: 'Ordered', num: true, f: (l) => num(l.qty) }, { h: 'Already received', num: true, f: (l) => num(l.received) }, { h: 'Receive now', num: true, f: (l) => `<input class="cell-in num" style="max-width:110px" type="number" min="0" step="1" data-rcv="${p.lines.indexOf(l)}" id="rcv-${p.lines.indexOf(l)}" value="${l.qty - l.received}">` }], p.lines)
      + '<div class="callout">Receiving posts Dr 1200 Inventory and Cr 2100 Received not invoiced at the PO price, and updates each item\'s weighted average cost.</div>',
      { submitLabel: 'Post receipt', onSubmit: (f) => E.receivePO(p.id, App.val(f, 'rcvDate'), App.$$('[data-rcv]', f).map((x) => +x.value || 0)), success: `Goods received on ${p.id}.` });
  });
  App.act('ap-enter', (ds) => {
    const billable = E.S.pos.filter((p) => p.lines.some((l) => l.received > l.invoiced));
    if (!billable.length) { toast('No purchase orders have received goods waiting to be billed.', 'bad'); return; }
    const poId = ds.po && E.po(ds.po) ? ds.po : billable[0].id;
    const body = (pid) => { const p = E.po(pid); return App.table([{ h: 'Item', f: (l) => esc(l.sku) }, { h: 'Received, unbilled', num: true, f: (l) => num(l.received - l.invoiced) }, { h: 'PO price', num: true, f: (l) => fmt(l.price) }, { h: 'Bill qty', num: true, f: (l) => `<input class="cell-in num" style="max-width:100px" type="number" min="0" step="1" data-bq="${p.lines.indexOf(l)}" id="bq-${p.lines.indexOf(l)}" value="${l.received - l.invoiced}">` }, { h: 'Invoice price', num: true, f: (l) => `<input class="cell-in num" style="max-width:110px" type="number" min="0" step="0.01" data-bp="${p.lines.indexOf(l)}" id="bp-${p.lines.indexOf(l)}" value="${l.price}">` }], p.lines); };
    App.drawer('Enter supplier invoice', `<div class="row">${App.field('Purchase order', App.select('apPo', billable.map((p) => [p.id, `${p.id} ${E.sup(p.supplierId).name}`]), poId))}${App.field('Supplier invoice no.', App.input('apNum', '', 'text', 'placeholder="e.g. ARD-55120"'))}${App.field('Invoice date', App.input('apDate', today(), 'date'))}</div>
      <div id="apLines">${body(poId)}</div><div class="callout">Lines are matched to the PO and receipt. A quantity above what was received, or a price more than ${E.PRICE_TOLERANCE * 100}% off the PO price, puts the invoice on hold for a Controller.</div><div id="apTotal" class="num" style="text-align:left"></div>`,
      { submitLabel: 'Submit invoice', oninput: (f) => { const sel = App.val(f, 'apPo'); if (f.dataset.po !== sel) { f.dataset.po = sel; App.$('#apLines', f).innerHTML = body(sel); } const t = App.$$('[data-bq]', f).reduce((a, x) => a + (+x.value || 0) * (+App.$(`[data-bp="${x.dataset.bq}"]`, f).value || 0), 0); App.$('#apTotal', f).textContent = 'Invoice total ' + fmt(t); },
        onSubmit: (f) => E.enterAPInvoice({ poId: App.val(f, 'apPo'), number: App.val(f, 'apNum'), date: App.val(f, 'apDate'), lines: App.$$('[data-bq]', f).map((x) => ({ line: x.dataset.bq, qty: x.value, price: App.$(`[data-bp="${x.dataset.bq}"]`, f).value })) }),
        success: (inv) => inv.status === 'On Hold' ? `${inv.id} is on hold: ${inv.holds[0]}` : `${inv.id} matched, validated and posted to AP.` });
  });
  App.act('ap-release', (ds) => App.confirm('Release invoice hold', `Override the match hold on ${esc(ds.id)} and post it to Accounts payable? Any price difference goes to 5100 Purchase price variance.`, 'Release and validate', () => E.releaseHold(ds.id, App.openPeriods().includes(U.periodOf(E.apinv(ds.id).date)) ? null : today()), `${ds.id} released and validated.`));
  App.act('ap-cancel', (ds) => App.try(() => E.cancelAPInvoice(ds.id), `${ds.id} cancelled.`));
  App.act('ap-pay', (ds) => { const ids = ds.id ? [ds.id] : E.S.apInvoices.filter((i) => i.status === 'Validated').map((i) => i.id);
    if (!ids.length) { toast('There are no validated invoices to pay.', 'bad'); return; }
    App.drawer(ids.length > 1 ? 'Pay supplier invoices' : `Pay ${ids[0]}`, `<div class="row">${App.field('Payment date', App.input('payDate', today(), 'date'))}${App.field('Method', App.select('payMethod', ['ACH', 'Wire', 'Check']))}</div>`
      + App.table([{ h: 'Pay', f: (id) => `<input type="checkbox" data-pay="${id}" id="pay-${id}" checked>` }, { h: 'Invoice', f: (id) => esc(id) }, { h: 'Supplier', f: (id) => esc(E.sup(E.apinv(id).supplierId).name) }, { h: 'Due', f: (id) => fdate(E.apinv(id).due) }, { h: 'Amount', num: true, f: (id) => fmt(E.apinv(id).total) }], ids)
      + `<div class="callout">Posts Dr 2000 Accounts payable and Cr 1000 Cash, one payment per supplier. Operating cash available: <b class="num">${fmt(E.balance('1000'))}</b>.</div>`,
      { submitLabel: 'Release payment', onSubmit: (f) => { const sel = App.$$('[data-pay]', f).filter((x) => x.checked).map((x) => x.dataset.pay); if (!sel.length) throw new Error('Select at least one invoice.'); return E.payInvoices(sel, App.val(f, 'payDate'), App.val(f, 'payMethod')); }, success: (p) => `${p.length} payment(s) released, ${fmt(U.sum(p, (x) => x.amount))}.` });
  });
  App.act('so-release', (ds) => App.try(() => E.releaseCreditHold(ds.id), `${ds.id} released from credit hold.`));
  App.act('so-cancel', (ds) => App.confirm('Cancel sales order', `Cancel ${esc(ds.id)}? It will not ship or invoice.`, 'Cancel order', () => E.cancelSO(ds.id), `${ds.id} cancelled.`));
  App.act('so-ship', (ds) => { const o = E.so(ds.id);
    App.drawer(`Ship ${o.id}`, App.field('Ship date', App.input('shipDate', today(), 'date')) + App.table([{ h: 'Item', f: (l) => esc(l.sku) }, { h: 'Qty', num: true, f: (l) => num(l.qty) }, { h: 'On hand', num: true, f: (l) => num(E.item(l.sku).onHand) }, { h: 'Avg cost', num: true, f: (l) => fmt(E.item(l.sku).avgCost) }, { h: 'Status', f: (l) => E.item(l.sku).onHand >= l.qty ? pill('Available', 'good') : pill('Short', 'bad') }], o.lines)
      + '<div class="callout">Shipping relieves inventory at average cost (Dr 5000 COGS, Cr 1200 Inventory) and raises the customer invoice (Dr 1100 Receivables, Cr 4000 Revenue).</div>',
      { submitLabel: 'Ship and invoice', onSubmit: (f) => E.shipSO(o.id, App.val(f, 'shipDate')), success: (inv) => `${o.id} shipped. Invoice ${inv.id} raised for ${fmt(inv.total)}.` });
  });
  App.act('ar-receipt', (ds) => { const i = E.arinv(ds.id);
    App.drawer(`Record receipt on ${i.id}`, `<p>${esc(E.cust(i.customerId).name)} owes <b class="num">${fmt(i.total - i.paid)}</b> on this invoice.</p><div class="row">${App.field('Receipt date', App.input('rcDate', today(), 'date'))}${App.field('Amount', App.input('rcAmt', U.r2(i.total - i.paid), 'number', 'step="0.01" min="0"'))}${App.field('Bank reference', App.input('rcRef', '', 'text', 'placeholder="e.g. WIRE 448120"'))}</div>`,
      { submitLabel: 'Apply receipt', onSubmit: (f) => E.applyReceipt({ invoiceId: i.id, date: App.val(f, 'rcDate'), amount: App.val(f, 'rcAmt'), reference: App.val(f, 'rcRef') }), success: (r) => `Receipt ${r.id} applied, ${fmt(r.amount)}.` });
  });
  App.act('inv-adjust', (ds) => { const it = ds.sku ? E.item(ds.sku) : E.S.items[0];
    App.drawer('Adjust inventory', `<div class="row">${App.field('Item', App.select('adjSku', App.itemOptions(), it.sku))}${App.field('Quantity change', App.input('adjQty', '-1', 'number', 'step="1"'), 'Negative for shrinkage, positive for a count gain')}${App.field('Date', App.input('adjDate', today(), 'date'))}</div>${App.field('Reason', App.input('adjReason', 'Cycle count variance'))}<div class="callout">Adjustments are valued at average cost against 5000 Cost of goods sold.</div>`,
      { submitLabel: 'Post adjustment', onSubmit: (f) => E.adjustInventory({ sku: App.val(f, 'adjSku'), qty: App.val(f, 'adjQty'), date: App.val(f, 'adjDate'), reason: App.val(f, 'adjReason') }), success: 'Inventory adjusted.' });
  });
  App.act('emp-terminate', (ds) => { const e = E.emp(ds.id);
    App.drawer(`Terminate ${e.name}`, `${App.field('Termination date', App.input('termDate', today(), 'date'))}<div class="callout warn">${esc(e.name)}'s direct reports move to their manager. They stay on payroll for any period they worked in.</div>`, { submitLabel: 'Terminate', onSubmit: (f) => E.terminateEmployee(e.id, App.val(f, 'termDate')), success: `${e.name} terminated.` });
  });
  App.act('abs-new', (ds) => { const active = E.S.employees.filter((e) => e.status === 'Active');
    App.drawer('Request absence', `<div class="row">${App.field('Employee', App.select('absEmp', active.map((e) => [e.id, e.name]), ds.emp || active[0].id))}${App.field('Type', App.select('absType', ['Vacation', 'Sick', 'Parental', 'Unpaid']))}</div><div class="row">${App.field('From', App.input('absStart', today(), 'date'))}${App.field('To', App.input('absEnd', today(), 'date'))}</div>${App.field('Note', App.input('absNote'))}<div class="hint" id="absInfo"></div>`,
      { submitLabel: 'Submit request', oninput: (f) => { const e = E.emp(App.val(f, 'absEmp')); const s = App.val(f, 'absStart'), en = App.val(f, 'absEnd'); const d = U.isDate(s) && U.isDate(en) && en >= s ? U.businessDays(s, en) : 0; App.$('#absInfo', f).textContent = `${d} working day(s). ${e.name} has ${e.ptoBalance} vacation day(s) left.`; },
        onSubmit: (f) => E.requestAbsence({ empId: App.val(f, 'absEmp'), type: App.val(f, 'absType'), start: App.val(f, 'absStart'), end: App.val(f, 'absEnd'), note: App.val(f, 'absNote') }), success: (a) => `${a.id} submitted to ${E.emp(a.approverId)?.name || 'HR'} for approval.` });
  });

  // ---------- nav + router ----------
  function navCounts() {
    const inbox = E.approvalsInbox().length;
    return { approvals: inbox };
  }
  function renderNav() {
    const counts = navCounts();
    $('#rail').innerHTML = `<div class="brand"><div class="brand-mark"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 19h16M4 14h10M4 9h16M4 4h7"/></svg></div><div><b>Ledgerline</b><span>${esc(E.S.company)}</span></div></div>`
      + NAV.map(([g, names]) => { const items = names.filter((n) => views[n]); if (!items.length) return ''; return `<div class="nav-group"><h4>${g}</h4><div class="nav">${items.map((n) => `<a href="#${n}" class="${App.current === n ? 'on' : ''}" ${App.current === n ? 'aria-current="page"' : ''}><span>${esc(views[n].title)}</span>${counts[n] ? `<span class="count">${counts[n]}</span>` : ''}</a>`).join('')}</div></div>`; }).join('');
  }
  function render() {
    const v = views[App.current] || views.home;
    renderNav();
    $('#todayChip').textContent = `Today ${fdate(E.S.today)} · Open: ${App.openPeriods().map(U.periodLabel).join(', ') || 'none'}`;
    const sel = $('#roleSel'); if (sel.value !== E.S.role) sel.value = E.S.role;
    const scroll = window.scrollY;
    try { $('#content').innerHTML = v.render(); v.after && v.after($('#content')); }
    catch (err) { console.error(err); $('#content').innerHTML = `<div class="callout bad">This page failed to render: ${esc(err.message)}</div>`; }
    window.scrollTo(0, scroll);
    document.title = `${v.title} · Ledgerline Suite`;
  }
  App.render = render;
  function route() {
    const h = location.hash.replace('#', '');
    const next = views[h] ? h : 'home';
    if (next !== App.current) window.scrollTo(0, 0);
    App.current = next; $('#rail').classList.remove('open'); render();
  }
  App.go = (name) => { if (location.hash === '#' + name) route(); else location.hash = name; };

  // ---------- global events ----------
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]'); if (!el || el.disabled) return;
    const fn = acts[el.dataset.act]; if (!fn) return;
    ev.preventDefault(); fn(el.dataset, el, ev);
  });
  App.act('tab', (ds) => { ui.tab[ds.view] = ds.tab; render(); });
  App.act('go', (ds) => App.go(ds.view));
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { if ($('#drawer')) closeDrawer(); else $('#searchResults').hidden = true; } });

  function setupSearch() {
    const inp = $('#globalSearch'), box = $('#searchResults');
    const draw = () => { const res = E.search(inp.value); if (!inp.value.trim()) { box.hidden = true; return; }
      box.innerHTML = res.length ? res.map((r) => `<button type="button" data-act="search-pick" data-kind="${r.kind}" data-id="${esc(r.id)}">${esc(r.label)}<small>${esc(r.sub)}</small></button>`).join('') : '<div class="empty">No matches.</div>'; box.hidden = false; };
    inp.addEventListener('input', draw); inp.addEventListener('focus', draw);
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { const b = box.querySelector('button'); if (b) b.click(); } if (ev.key === 'ArrowDown') { ev.preventDefault(); box.querySelector('button')?.focus(); } });
    document.addEventListener('click', (ev) => { if (!ev.target.closest('.search')) box.hidden = true; });
  }
  App.act('search-pick', (ds) => { $('#searchResults').hidden = true; $('#globalSearch').value = ''; App.open(ds.kind, ds.id); });

  App.start = function () {
    loadOrSeed();
    const sel = $('#roleSel'); sel.innerHTML = Object.keys(E.ROLES).map((r) => `<option>${esc(r)}</option>`).join('');
    sel.addEventListener('change', () => { E.S.role = sel.value; E.S.user = E.ROLE_USERS[sel.value] || E.S.user; E.log('Switched role', sel.value); save(); render(); toast(`You are now ${E.S.user}, acting as ${sel.value}.`); });
    $('#resetBtn').addEventListener('click', () => App.confirm('Reset demo data', 'Replace everything in this browser with the original demo company? Your changes will be lost.', 'Reset', () => window.seedDemo(), 'Demo data restored.'));
    $('#menuBtn').addEventListener('click', () => $('#rail').classList.toggle('open'));
    setupSearch();
    window.addEventListener('hashchange', route);
    route();
  };
  window.App = App;
})();
