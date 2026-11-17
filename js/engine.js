/* Ledgerline Suite — engine.js
 * All state and business rules. No DOM access, so it runs in Node for tests.
 * Every write function throws Error(userReadableMessage) on a rule violation.
 * Callers that need atomicity snapshot Engine.S before calling (see App.run).
 */
(function (root) {
  'use strict';

  const TODAY = '2026-11-17';
  const FY_START = '2026-07';
  const REQ_APPROVAL_LIMIT = 10000;
  const JE_APPROVAL_LIMIT = 50000;
  const PRICE_TOLERANCE = 0.05;          // AP 3-way match price tolerance
  const WITHHOLDING_RATE = 0.22;         // employee tax withheld
  const EMPLOYER_TAX_RATE = 0.0765;      // employer payroll tax
  const DEPRECIATION_MONTHS = 60;

  // ---------- small utils ----------
  const r2 = (n) => Math.round((+n + Number.EPSILON) * 100) / 100;
  const sum = (arr, f) => r2(arr.reduce((a, x) => a + (f ? f(x) : x), 0));
  const periodOf = (d) => String(d).slice(0, 7);
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  const periodEnd = (p) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
  const periodLabel = (p) => { const [y, m] = p.split('-').map(Number); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] + '-' + String(y).slice(2); };
  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fail = (msg) => { throw new Error(msg); };
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const businessDays = (start, end) => {
    let n = 0; for (let d = start; d <= end; d = addDays(d, 1)) { const w = new Date(d + 'T00:00:00Z').getUTCDay(); if (w !== 0 && w !== 6) n++; } return n;
  };

  // ---------- security ----------
  const COMMON = ['req.create', 'hr.absence.create'];
  const ROLES = {
    'Administrator': ['*'],
    'Controller': ['gl.post', 'gl.approve', 'gl.close', 'gl.depr', 'gl.coa', 'ap.release', 'so.release', 'req.approve'],
    'AP Specialist': ['ap.enter', 'ap.pay', 'supplier.edit'],
    'Buyer': ['po.create', 'po.receive', 'supplier.edit', 'item.edit', 'inv.adjust'],
    'Order Manager': ['so.create', 'so.ship', 'ar.receipt', 'customer.edit'],
    'HR Specialist': ['hr.edit', 'hr.absence.approve', 'hr.payroll'],
  };
  const ROLE_USERS = { 'Administrator': 'System Administrator', 'Controller': 'Avery Lin', 'AP Specialist': 'Sam Achebe', 'Buyer': 'Dana Whitfield', 'Order Manager': 'Ines Duarte', 'HR Specialist': 'Nadia Petrova' };
  const can = (role, perm) => { const p = ROLES[role] || []; return p.includes('*') || p.includes(perm) || COMMON.includes(perm); };

  // ---------- state ----------
  let S;
  function blankState() {
    const periods = {};
    for (let i = 0; i < 12; i++) { const y = 2026 + Math.floor((6 + i) / 12); const m = ((6 + i) % 12) + 1; periods[`${y}-${String(m).padStart(2, '0')}`] = 'Future'; }
    return {
      version: 1, company: 'Halden Instruments Ltd.', currency: 'USD', today: TODAY, role: 'Administrator', user: 'System Administrator',
      seq: {}, periods, accounts: [], journals: [], depreciationRuns: {},
      suppliers: [], customers: [], items: [], invTxns: [],
      reqs: [], pos: [], apInvoices: [], payments: [],
      sos: [], arInvoices: [], receipts: [],
      departments: [], employees: [], absences: [], payruns: [],
      audit: [],
    };
  }
  function reset() { S = blankState(); Engine.S = S; return S; }
  function load(obj) { S = obj; Engine.S = S; return S; }

  const nextId = (prefix) => { S.seq[prefix] = (S.seq[prefix] || 1000) + 1; return `${prefix}-${S.seq[prefix]}`; };
  const log = (action, ref, detail) => { S.audit.unshift({ ts: S._clock || new Date().toISOString(), date: S._date || TODAY, user: S.user, role: S.role, action, ref: ref || '', detail: detail || '' }); if (S.audit.length > 2000) S.audit.length = 2000; };

  // ---------- lookups ----------
  const item = (sku) => S.items.find((x) => x.sku === sku);
  const sup = (id) => S.suppliers.find((x) => x.id === id);
  const cust = (id) => S.customers.find((x) => x.id === id);
  const emp = (id) => S.employees.find((x) => x.id === id);
  const acct = (code) => S.accounts.find((x) => x.code === code);
  const je = (id) => S.journals.find((x) => x.id === id);
  const po = (id) => S.pos.find((x) => x.id === id);
  const so = (id) => S.sos.find((x) => x.id === id);
  const apinv = (id) => S.apInvoices.find((x) => x.id === id);
  const arinv = (id) => S.arInvoices.find((x) => x.id === id);
  const req = (id) => S.reqs.find((x) => x.id === id);
  const payrun = (id) => S.payruns.find((x) => x.id === id);
  const need = (x, what) => x || fail(`${what} was not found.`);

  // ---------- general ledger ----------
  const DEBIT_NORMAL = { Asset: true, Expense: true, Liability: false, Equity: false, Revenue: false };

  function addAccount({ code, name, type }) {
    code = String(code || '').trim(); name = String(name || '').trim();
    if (!/^\d{4}$/.test(code)) fail('Account code must be 4 digits.');
    if (acct(code)) fail(`Account ${code} already exists.`);
    if (!name) fail('Account name is required.');
    if (!(type in DEBIT_NORMAL)) fail('Choose an account type.');
    S.accounts.push({ code, name, type, active: true });
    S.accounts.sort((a, b) => a.code.localeCompare(b.code));
    log('Created account', code, name);
    return acct(code);
  }

  function assertOpen(date) {
    if (!isDate(date)) fail('Enter a valid date (YYYY-MM-DD).');
    const p = periodOf(date); const st = S.periods[p];
    if (!st) fail(`No accounting period exists for ${date}. The calendar covers FY2027 (Jul-26 to Jun-27).`);
    if (st !== 'Open') fail(`Period ${periodLabel(p)} is ${st}. Post to an open period, or ask a Controller to open it.`);
    return p;
  }

  /** createJournal({date, source, desc, lines:[{acct, dr, cr, memo}], ref, needsApproval}) */
  function createJournal({ date, source = 'Manual', desc = '', lines = [], ref = '', needsApproval = false }) {
    lines = lines.map((l) => ({ acct: String(l.acct), dr: r2(+l.dr || 0), cr: r2(+l.cr || 0), memo: l.memo || '' }))
      .filter((l) => l.dr || l.cr);
    if (!lines.length) fail('A journal needs at least one line with an amount.');
    for (const l of lines) {
      if (!acct(l.acct)) fail(`Account ${l.acct} does not exist.`);
      if (l.dr < 0 || l.cr < 0) fail('Amounts cannot be negative. Use the opposite column instead.');
      if (l.dr && l.cr) fail('A line can have a debit or a credit, not both.');
    }
    const dr = sum(lines, (l) => l.dr), cr = sum(lines, (l) => l.cr);
    if (Math.abs(dr - cr) > 0.004) fail(`Journal is out of balance by ${money(r2(dr - cr))}. Debits must equal credits.`);
    const p = assertOpen(date);
    const j = { id: nextId('JE'), date, period: p, source, desc, lines, ref, total: dr, status: needsApproval ? 'Pending Approval' : 'Posted', createdBy: S.user, role: S.role };
    S.journals.push(j);
    log(needsApproval ? 'Submitted journal for approval' : 'Posted journal', j.id, `${source}: ${desc} (${money(dr)})`);
    return j;
  }
  /** Manual journal entered by a person: applies the approval threshold. */
  function createManualJournal({ date, desc, lines }) {
    if (!String(desc || '').trim()) fail('Describe the journal so reviewers know what it is for.');
    const total = sum(lines, (l) => +l.dr || 0);
    return createJournal({ date, desc, lines, source: 'Manual', needsApproval: total > JE_APPROVAL_LIMIT });
  }
  function approveJournal(id) {
    const j = need(je(id), 'Journal'); if (j.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`);
    assertOpen(j.date); if (j.createdBy === S.user && S.role !== 'Administrator') fail('You cannot approve a journal you created (segregation of duties).');
    j.status = 'Posted'; j.approvedBy = S.user; log('Approved journal', id); return j;
  }
  function rejectJournal(id, reason) {
    const j = need(je(id), 'Journal'); if (j.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`);
    j.status = 'Rejected'; j.rejectReason = reason || ''; log('Rejected journal', id, reason); return j;
  }

  /** Sum of (dr - cr) for posted journals, optionally limited to a period range. */
  function balances({ fromPeriod, toPeriod } = {}) {
    const out = {}; S.accounts.forEach((a) => (out[a.code] = 0));
    for (const j of S.journals) {
      if (j.status !== 'Posted') continue;
      if (fromPeriod && j.period < fromPeriod) continue;
      if (toPeriod && j.period > toPeriod) continue;
      for (const l of j.lines) out[l.acct] = (out[l.acct] || 0) + l.dr - l.cr;
    }
    for (const k in out) out[k] = r2(out[k]);
    return out;
  }
  const balance = (code, opts) => balances(opts)[code] || 0;
  /** Converts a dr-cr figure into the account's natural sign. */
  const natural = (code, v) => (DEBIT_NORMAL[acct(code).type] ? v : -v);

  function trialBalance(toPeriod) {
    const b = balances({ toPeriod });
    const rows = S.accounts.map((a) => ({ ...a, dr: b[a.code] > 0 ? b[a.code] : 0, cr: b[a.code] < 0 ? -b[a.code] : 0 })).filter((r) => r.dr || r.cr);
    return { rows, dr: sum(rows, (r) => r.dr), cr: sum(rows, (r) => r.cr) };
  }
  function incomeStatement(fromPeriod, toPeriod) {
    const b = balances({ fromPeriod, toPeriod });
    const pick = (pred) => S.accounts.filter(pred).map((a) => ({ code: a.code, name: a.name, amount: natural(a.code, b[a.code]) })).filter((r) => r.amount);
    const revenue = pick((a) => a.type === 'Revenue');
    const cogs = pick((a) => a.type === 'Expense' && a.code < '6000');
    const opex = pick((a) => a.type === 'Expense' && a.code >= '6000');
    const tRev = sum(revenue, (r) => r.amount), tCogs = sum(cogs, (r) => r.amount), tOpex = sum(opex, (r) => r.amount);
    return { revenue, cogs, opex, totalRevenue: tRev, totalCogs: tCogs, grossMargin: r2(tRev - tCogs), totalOpex: tOpex, netIncome: r2(tRev - tCogs - tOpex) };
  }
  function balanceSheet(toPeriod) {
    const b = balances({ toPeriod });
    const pick = (t) => S.accounts.filter((a) => a.type === t).map((a) => ({ code: a.code, name: a.name, amount: natural(a.code, b[a.code]) })).filter((r) => r.amount);
    const assets = pick('Asset'), liabilities = pick('Liability'), equity = pick('Equity');
    const earnings = incomeStatement(FY_START, toPeriod).netIncome;
    const tA = sum(assets, (r) => r.amount), tL = sum(liabilities, (r) => r.amount), tE = r2(sum(equity, (r) => r.amount) + earnings);
    return { assets, liabilities, equity, currentEarnings: earnings, totalAssets: tA, totalLiabilities: tL, totalEquity: tE, balanced: Math.abs(tA - tL - tE) < 0.01 };
  }

  function periods() {
    return Object.keys(S.periods).sort().map((p) => ({
      period: p, label: periodLabel(p), status: S.periods[p],
      posted: S.journals.filter((j) => j.period === p && j.status === 'Posted').length,
      pending: S.journals.filter((j) => j.period === p && j.status === 'Pending Approval').length,
    }));
  }
  function closePeriod(p) {
    if (S.periods[p] !== 'Open') fail(`${periodLabel(p)} is not open.`);
    const pend = S.journals.filter((j) => j.period === p && j.status === 'Pending Approval');
    if (pend.length) fail(`${periodLabel(p)} has ${pend.length} journal(s) awaiting approval (${pend.map((j) => j.id).join(', ')}). Approve or reject them first.`);
    const earlierOpen = Object.keys(S.periods).filter((x) => x < p && S.periods[x] === 'Open');
    if (earlierOpen.length) fail(`Close ${earlierOpen.map(periodLabel).join(', ')} first. Periods close in order.`);
    S.periods[p] = 'Closed'; log('Closed period', periodLabel(p)); return true;
  }
  function reopenPeriod(p) {
    if (S.periods[p] !== 'Closed') fail(`${periodLabel(p)} is not closed.`);
    S.periods[p] = 'Open'; log('Reopened period', periodLabel(p)); return true;
  }
  function openPeriod(p) {
    if (S.periods[p] !== 'Future') fail(`${periodLabel(p)} is not a future period.`);
    const earlierFuture = Object.keys(S.periods).filter((x) => x < p && S.periods[x] === 'Future');
    if (earlierFuture.length) fail(`Open ${earlierFuture.map(periodLabel).join(', ')} first. Periods open in order.`);
    S.periods[p] = 'Open'; log('Opened period', periodLabel(p)); return true;
  }
  function runDepreciation(p) {
    if (S.depreciationRuns[p]) fail(`Depreciation for ${periodLabel(p)} already posted (${S.depreciationRuns[p]}).`);
    const cost = balance('1500', { toPeriod: p });
    const amt = r2(cost / DEPRECIATION_MONTHS);
    if (amt <= 0) fail('There is no equipment to depreciate.');
    const j = createJournal({ date: periodEnd(p), source: 'Assets', desc: `Straight-line depreciation ${periodLabel(p)} (${DEPRECIATION_MONTHS} months)`, lines: [{ acct: '6300', dr: amt }, { acct: '1510', cr: amt }] });
    S.depreciationRuns[p] = j.id; return j;
  }

  // ---------- suppliers / customers / items ----------
  function addSupplier({ name, terms = 30, site = '', email = '' }) {
    if (!String(name || '').trim()) fail('Supplier name is required.');
    if (S.suppliers.some((s) => s.name.toLowerCase() === name.trim().toLowerCase())) fail(`A supplier named ${name} already exists.`);
    const s = { id: nextId('SUP'), name: name.trim(), terms: +terms || 30, site, email, active: true };
    S.suppliers.push(s); log('Created supplier', s.id, s.name); return s;
  }
  function addCustomer({ name, terms = 30, creditLimit = 50000, segment = '' }) {
    if (!String(name || '').trim()) fail('Customer name is required.');
    if (S.customers.some((c) => c.name.toLowerCase() === name.trim().toLowerCase())) fail(`A customer named ${name} already exists.`);
    if (!(+creditLimit >= 0)) fail('Credit limit must be zero or more.');
    const c = { id: nextId('CUS'), name: name.trim(), terms: +terms || 30, creditLimit: r2(+creditLimit), segment, active: true };
    S.customers.push(c); log('Created customer', c.id, c.name); return c;
  }
  function addItem({ sku, name, uom = 'Each', price, reorder = 0, cost = 0 }) {
    sku = String(sku || '').trim().toUpperCase();
    if (!sku) fail('SKU is required.'); if (item(sku)) fail(`Item ${sku} already exists.`);
    if (!String(name || '').trim()) fail('Item name is required.');
    if (!(+price > 0)) fail('List price must be greater than zero.');
    const it = { sku, name: name.trim(), uom, price: r2(+price), reorder: +reorder || 0, onHand: 0, avgCost: r2(+cost || 0), lastCost: r2(+cost || 0) };
    S.items.push(it); log('Created item', sku, it.name); return it;
  }
  function invTxn(date, sku, type, qty, unitCost, ref) {
    S.invTxns.unshift({ id: nextId('IT'), date, sku, type, qty, unitCost: r2(unitCost), value: r2(qty * unitCost), ref, onHandAfter: item(sku).onHand });
  }
  /** Cycle count / adjustment: qty delta (+/-), posts to 5000 COGS (shrinkage). */
  function adjustInventory({ sku, qty, date, reason }) {
    const it = need(item(sku), 'Item'); qty = +qty; if (!qty || !Number.isInteger(qty)) fail('Enter a whole, non-zero quantity.');
    if (it.onHand + qty < 0) fail(`Only ${it.onHand} ${sku} on hand. You cannot adjust below zero.`);
    if (!String(reason || '').trim()) fail('Give a reason for the adjustment.');
    const value = r2(Math.abs(qty) * it.avgCost);
    const lines = qty > 0 ? [{ acct: '1200', dr: value }, { acct: '5000', cr: value }] : [{ acct: '5000', dr: value }, { acct: '1200', cr: value }];
    const j = createJournal({ date, source: 'Inventory', desc: `Adjustment ${sku} ${qty > 0 ? '+' : ''}${qty}: ${reason}`, lines, ref: sku });
    it.onHand += qty; invTxn(date, sku, 'Adjustment', qty, it.avgCost, j.id);
    return j;
  }

  // ---------- procurement ----------
  /** createReq({date, requester, justification, lines:[{sku, qty, price}]}) */
  function createReq({ date, requester, justification = '', lines }) {
    if (!isDate(date)) fail('Enter a valid date.');
    lines = (lines || []).filter((l) => l.sku && +l.qty > 0).map((l) => ({ sku: l.sku, qty: +l.qty, price: r2(+l.price || item(l.sku)?.lastCost || 0) }));
    if (!lines.length) fail('Add at least one item with a quantity.');
    lines.forEach((l) => need(item(l.sku), `Item ${l.sku}`));
    const total = sum(lines, (l) => l.qty * l.price);
    const r = { id: nextId('REQ'), date, requester: requester || S.user, justification, lines, total, status: total > REQ_APPROVAL_LIMIT ? 'Pending Approval' : 'Approved' };
    S.reqs.push(r); log(r.status === 'Approved' ? 'Created requisition (auto-approved)' : 'Submitted requisition for approval', r.id, money(total)); return r;
  }
  function approveReq(id) { const r = need(req(id), 'Requisition'); if (r.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`); r.status = 'Approved'; r.approvedBy = S.user; log('Approved requisition', id); return r; }
  function rejectReq(id, reason) { const r = need(req(id), 'Requisition'); if (r.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`); r.status = 'Rejected'; r.rejectReason = reason || ''; log('Rejected requisition', id, reason); return r; }

  /** createPO({reqId?, supplierId, date, lines:[{sku, qty, price}]}) */
  function createPO({ reqId, supplierId, date, lines }) {
    const s = need(sup(supplierId), 'Supplier'); if (!isDate(date)) fail('Enter a valid date.');
    let r = null;
    if (reqId) { r = need(req(reqId), 'Requisition'); if (r.status !== 'Approved') fail(`${reqId} must be approved before it becomes a purchase order (it is ${r.status}).`); if (!lines) lines = r.lines; }
    lines = (lines || []).filter((l) => l.sku && +l.qty > 0).map((l) => ({ sku: l.sku, qty: +l.qty, price: r2(+l.price), received: 0, invoiced: 0 }));
    if (!lines.length) fail('A purchase order needs at least one line.');
    lines.forEach((l) => { need(item(l.sku), `Item ${l.sku}`); if (!(l.price > 0)) fail(`Enter a price for ${l.sku}.`); });
    const p = { id: nextId('PO'), reqId: reqId || '', supplierId: s.id, date, lines, total: sum(lines, (l) => l.qty * l.price), status: 'Open', buyer: S.user };
    S.pos.push(p); if (r) { r.status = 'Ordered'; r.poId = p.id; }
    log('Created purchase order', p.id, `${s.name} ${money(p.total)}`); return p;
  }
  function poStatus(p) {
    const rec = p.lines.every((l) => l.received >= l.qty), any = p.lines.some((l) => l.received > 0);
    const inv = p.lines.every((l) => l.invoiced >= l.qty);
    p.status = inv && rec ? 'Closed' : rec ? 'Received' : any ? 'Partially Received' : 'Open';
  }
  /** receivePO(poId, date, qtys[]) — qtys aligned to PO lines */
  function receivePO(poId, date, qtys) {
    const p = need(po(poId), 'Purchase order');
    if (p.status === 'Closed' || p.status === 'Received') fail(`${poId} is fully received.`);
    const recs = p.lines.map((l, i) => ({ l, q: +(qtys?.[i] ?? 0) })).filter((x) => x.q > 0);
    if (!recs.length) fail('Enter a quantity to receive on at least one line.');
    for (const { l, q } of recs) {
      if (!Number.isInteger(q)) fail('Quantities must be whole numbers.');
      if (q > l.qty - l.received) fail(`Line ${l.sku}: only ${l.qty - l.received} left to receive, not ${q}.`);
    }
    const value = sum(recs, (x) => x.q * x.l.price);
    const j = createJournal({ date, source: 'Receiving', desc: `Receipt against ${poId} (${sup(p.supplierId).name})`, ref: poId, lines: [{ acct: '1200', dr: value }, { acct: '2100', cr: value }] });
    for (const { l, q } of recs) {
      const it = item(l.sku);
      it.avgCost = r2((it.onHand * it.avgCost + q * l.price) / (it.onHand + q));
      it.onHand += q; it.lastCost = l.price; l.received += q;
      invTxn(date, l.sku, 'PO Receipt', q, l.price, poId);
    }
    // keep GL inventory exactly equal to subledger after avg-cost rounding
    const sub = sum(S.items, (x) => x.onHand * x.avgCost), gl = balance('1200');
    const diff = r2(sub - gl);
    if (Math.abs(diff) >= 0.01) createJournal({ date, source: 'Receiving', desc: `Average cost rounding ${poId}`, ref: poId, lines: diff > 0 ? [{ acct: '1200', dr: diff }, { acct: '5100', cr: diff }] : [{ acct: '5100', dr: -diff }, { acct: '1200', cr: -diff }] });
    (p.receipts = p.receipts || []).push({ date, journal: j.id, qtys: p.lines.map((l, i) => +(qtys?.[i] || 0)) });
    poStatus(p); log('Received goods', poId, money(value)); return j;
  }

  // ---------- payables ----------
  /** enterAPInvoice({poId, number, date, lines:[{line, qty, price}]}) — 3-way match */
  function enterAPInvoice({ poId, number, date, lines }) {
    const p = need(po(poId), 'Purchase order'); if (!isDate(date)) fail('Enter a valid invoice date.');
    number = String(number || '').trim(); if (!number) fail("Enter the supplier's invoice number.");
    if (S.apInvoices.some((i) => i.supplierId === p.supplierId && i.number === number && i.status !== 'Cancelled')) fail(`Invoice ${number} from this supplier is already entered (duplicate check).`);
    lines = (lines || []).filter((l) => +l.qty > 0).map((l) => ({ line: +l.line, sku: p.lines[+l.line].sku, qty: +l.qty, price: r2(+l.price), poPrice: p.lines[+l.line].price }));
    if (!lines.length) fail('Bill at least one line.');
    const holds = [];
    for (const l of lines) {
      const pl = p.lines[l.line];
      const pendingQty = S.apInvoices.filter((i) => i.poId === poId && i.status === 'On Hold').flatMap((i) => i.lines).filter((x) => x.line === l.line).reduce((a, x) => a + x.qty, 0);
      if (l.qty + pl.invoiced + pendingQty > pl.received) holds.push(`${l.sku}: billed ${l.qty}, only ${pl.received - pl.invoiced - pendingQty} received and not yet billed`);
      if (Math.abs(l.price - pl.price) / pl.price > PRICE_TOLERANCE) holds.push(`${l.sku}: price ${money(l.price)} is more than ${PRICE_TOLERANCE * 100}% off PO price ${money(pl.price)}`);
    }
    const s = sup(p.supplierId);
    const inv = { id: nextId('APINV'), number, supplierId: s.id, poId, date, due: addDays(date, s.terms), lines, total: sum(lines, (l) => l.qty * l.price), paid: 0, holds, status: holds.length ? 'On Hold' : 'Entered' };
    S.apInvoices.push(inv);
    log(holds.length ? 'Invoice placed on hold' : 'Entered invoice', inv.id, holds.join('; ') || money(inv.total));
    if (!holds.length) validateAP(inv);
    return inv;
  }
  function validateAP(inv) {
    const p = po(inv.poId);
    for (const l of inv.lines) { const pl = p.lines[l.line]; if (l.qty + pl.invoiced > pl.received) fail(`${l.sku}: cannot bill more than received. Receive the goods first.`); }
    const accrual = sum(inv.lines, (l) => l.qty * l.poPrice);
    const ppv = r2(inv.total - accrual);
    const lines = [{ acct: '2100', dr: accrual, memo: 'Clear received-not-invoiced' }];
    if (ppv > 0) lines.push({ acct: '5100', dr: ppv, memo: 'Purchase price variance' });
    if (ppv < 0) lines.push({ acct: '5100', cr: -ppv, memo: 'Purchase price variance' });
    lines.push({ acct: '2000', cr: inv.total, memo: `${sup(inv.supplierId).name} inv ${inv.number}` });
    const j = createJournal({ date: inv.date, source: 'Payables', desc: `Invoice ${inv.number} (${sup(inv.supplierId).name}) on ${inv.poId}`, ref: inv.id, lines });
    inv.lines.forEach((l) => (p.lines[l.line].invoiced += l.qty));
    inv.status = 'Validated'; inv.journal = j.id; poStatus(p); return j;
  }
  /** Controller override of match holds. Received-qty holds cannot be overridden. */
  function releaseHold(id, date) {
    const inv = need(apinv(id), 'Invoice'); if (inv.status !== 'On Hold') fail(`${id} is not on hold.`);
    if (date) { assertOpen(date); inv.date = date; }
    const j = validateAP(inv); inv.releasedBy = S.user; inv.holdsReleased = inv.holds; inv.holds = [];
    log('Released invoice hold', id); return j;
  }
  function cancelAPInvoice(id) {
    const inv = need(apinv(id), 'Invoice'); if (inv.status !== 'On Hold') fail('Only invoices on hold can be cancelled. Validated invoices are reversed by a credit memo.');
    inv.status = 'Cancelled'; log('Cancelled invoice', id); return inv;
  }
  /** payInvoices(ids[], date, method) — one payment per supplier */
  function payInvoices(ids, date, method = 'ACH') {
    const invs = ids.map((id) => need(apinv(id), `Invoice ${id}`));
    invs.forEach((i) => { if (i.status !== 'Validated') fail(`${i.id} is ${i.status} and cannot be paid.`); });
    const total = sum(invs, (i) => i.total - i.paid);
    const cash = balance('1000');
    if (total > cash) fail(`Payment of ${money(total)} exceeds operating cash of ${money(cash)}.`);
    const bySup = {}; invs.forEach((i) => (bySup[i.supplierId] = bySup[i.supplierId] || []).push(i));
    const out = [];
    for (const sid in bySup) {
      const list = bySup[sid]; const amt = sum(list, (i) => i.total - i.paid);
      const j = createJournal({ date, source: 'Payables', desc: `Payment to ${sup(sid).name} (${method})`, lines: [{ acct: '2000', dr: amt }, { acct: '1000', cr: amt }] });
      const pay = { id: nextId('PAY'), supplierId: sid, date, method, amount: amt, invoices: list.map((i) => i.id), journal: j.id };
      list.forEach((i) => { i.paid = i.total; i.status = 'Paid'; i.paymentId = pay.id; });
      S.payments.push(pay); j.ref = pay.id; log('Paid supplier', pay.id, `${sup(sid).name} ${money(amt)}`); out.push(pay);
    }
    return out;
  }

  // ---------- order to cash ----------
  const openAR = (custId) => sum(S.arInvoices.filter((i) => i.customerId === custId && i.status !== 'Paid'), (i) => i.total - i.paid);
  const openOrders = (custId) => sum(S.sos.filter((o) => o.customerId === custId && (o.status === 'Booked')), (o) => o.total);
  /** createSO({customerId, date, lines:[{sku, qty, price}], poNumber}) — credit check */
  function createSO({ customerId, date, lines, poNumber = '' }) {
    const c = need(cust(customerId), 'Customer'); if (!isDate(date)) fail('Enter a valid order date.');
    lines = (lines || []).filter((l) => l.sku && +l.qty > 0).map((l) => ({ sku: l.sku, qty: +l.qty, price: r2(+l.price || item(l.sku)?.price) }));
    if (!lines.length) fail('Add at least one item with a quantity.');
    lines.forEach((l) => { need(item(l.sku), `Item ${l.sku}`); if (!Number.isInteger(l.qty)) fail('Quantities must be whole numbers.'); });
    const total = sum(lines, (l) => l.qty * l.price);
    const exposure = r2(openAR(c.id) + openOrders(c.id) + total);
    const o = { id: nextId('SO'), customerId: c.id, date, poNumber, lines, total, status: exposure > c.creditLimit ? 'Credit Hold' : 'Booked', exposure };
    if (o.status === 'Credit Hold') o.hold = `Exposure ${money(exposure)} exceeds credit limit ${money(c.creditLimit)}`;
    S.sos.push(o); log(o.status === 'Booked' ? 'Booked sales order' : 'Sales order on credit hold', o.id, o.hold || `${c.name} ${money(total)}`); return o;
  }
  function releaseCreditHold(id) { const o = need(so(id), 'Sales order'); if (o.status !== 'Credit Hold') fail(`${id} is not on credit hold.`); o.status = 'Booked'; o.releasedBy = S.user; log('Released credit hold', id); return o; }
  function cancelSO(id) { const o = need(so(id), 'Sales order'); if (!['Booked', 'Credit Hold'].includes(o.status)) fail(`${id} has shipped and cannot be cancelled.`); o.status = 'Cancelled'; log('Cancelled sales order', id); return o; }
  /** shipSO(id, date) — relieves inventory at avg cost and auto-invoices */
  function shipSO(id, date) {
    const o = need(so(id), 'Sales order');
    if (o.status === 'Credit Hold') fail(`${id} is on credit hold. A Controller must release it before shipping.`);
    if (o.status !== 'Booked') fail(`${id} is ${o.status} and cannot be shipped.`);
    const short = o.lines.filter((l) => item(l.sku).onHand < l.qty);
    if (short.length) fail('Not enough stock: ' + short.map((l) => `${l.sku} needs ${l.qty}, ${item(l.sku).onHand} on hand`).join('; ') + '. Receive a purchase order first.');
    let cogs = 0;
    o.lines.forEach((l) => { l.unitCost = item(l.sku).avgCost; cogs += l.qty * l.unitCost; });
    cogs = r2(cogs);
    const c = cust(o.customerId);
    const j1 = createJournal({ date, source: 'Shipping', desc: `Cost of goods shipped ${id} (${c.name})`, ref: id, lines: [{ acct: '5000', dr: cogs }, { acct: '1200', cr: cogs }] });
    o.lines.forEach((l) => { const it = item(l.sku); it.onHand -= l.qty; invTxn(date, l.sku, 'Shipment', -l.qty, l.unitCost, id); });
    const inv = { id: nextId('ARINV'), customerId: c.id, soId: id, date, due: addDays(date, c.terms), total: o.total, paid: 0, status: 'Open' };
    const j2 = createJournal({ date, source: 'Receivables', desc: `Invoice ${inv.id} for ${id} (${c.name})`, ref: inv.id, lines: [{ acct: '1100', dr: o.total }, { acct: '4000', cr: o.total }] });
    inv.journal = j2.id; S.arInvoices.push(inv);
    o.status = 'Invoiced'; o.shipDate = date; o.invoiceId = inv.id; o.cogsJournal = j1.id; o.margin = r2(o.total - cogs);
    log('Shipped and invoiced', id, `${inv.id} ${money(o.total)}`); return inv;
  }
  function applyReceipt({ invoiceId, date, amount, reference = '' }) {
    const inv = need(arinv(invoiceId), 'Invoice'); amount = r2(+amount);
    if (inv.status === 'Paid') fail(`${invoiceId} is already paid.`);
    const open = r2(inv.total - inv.paid);
    if (!(amount > 0)) fail('Enter a receipt amount greater than zero.');
    if (amount > open + 0.001) fail(`Receipt ${money(amount)} is more than the open balance ${money(open)}.`);
    const c = cust(inv.customerId);
    const j = createJournal({ date, source: 'Receivables', desc: `Receipt from ${c.name} on ${invoiceId}${reference ? ' ref ' + reference : ''}`, ref: invoiceId, lines: [{ acct: '1000', dr: amount }, { acct: '1100', cr: amount }] });
    const rc = { id: nextId('RCPT'), customerId: c.id, invoiceId, date, amount, reference, journal: j.id };
    S.receipts.push(rc); inv.paid = r2(inv.paid + amount); inv.status = inv.paid >= inv.total ? 'Paid' : 'Partially Paid';
    log('Applied customer receipt', rc.id, `${c.name} ${money(amount)}`); return rc;
  }
  function arAging(asOf = S.today) {
    const buckets = ['Current', '1-30', '31-60', '61-90', '90+'];
    const rows = S.customers.map((c) => {
      const r = { customerId: c.id, name: c.name, total: 0 }; buckets.forEach((b) => (r[b] = 0));
      S.arInvoices.filter((i) => i.customerId === c.id && i.status !== 'Paid').forEach((i) => {
        const late = daysBetween(i.due, asOf), open = r2(i.total - i.paid);
        const b = late <= 0 ? 'Current' : late <= 30 ? '1-30' : late <= 60 ? '31-60' : late <= 90 ? '61-90' : '90+';
        r[b] = r2(r[b] + open); r.total = r2(r.total + open);
      });
      return r;
    }).filter((r) => r.total);
    return { buckets, rows };
  }

  // ---------- HCM ----------
  function hireEmployee({ name, title, dept, managerId = '', salary, hireDate, location = 'Boston, MA' }) {
    if (!String(name || '').trim()) fail('Name is required.'); if (!String(title || '').trim()) fail('Job title is required.');
    if (!S.departments.includes(dept)) fail('Choose a department.');
    if (!(+salary > 0)) fail('Annual salary must be greater than zero.'); if (!isDate(hireDate)) fail('Enter a valid hire date.');
    if (managerId && !emp(managerId)) fail('Manager not found.');
    const e = { id: nextId('E'), name: name.trim(), title: title.trim(), dept, managerId, salary: r2(+salary), hireDate, location, status: 'Active', ptoBalance: 15 };
    S.employees.push(e); log('Hired employee', e.id, `${e.name}, ${e.title}`); return e;
  }
  function terminateEmployee(id, date) {
    const e = need(emp(id), 'Employee'); if (e.status !== 'Active') fail(`${e.name} is not active.`); if (!isDate(date)) fail('Enter a valid termination date.');
    const reports = S.employees.filter((x) => x.managerId === id && x.status === 'Active');
    reports.forEach((r) => (r.managerId = e.managerId)); // reassign reports upward
    e.status = 'Terminated'; e.termDate = date; log('Terminated employee', id, `${e.name}; ${reports.length} report(s) moved to ${emp(e.managerId)?.name || 'no manager'}`); return e;
  }
  function requestAbsence({ empId, type, start, end, note = '' }) {
    const e = need(emp(empId), 'Employee'); if (e.status !== 'Active') fail(`${e.name} is not active.`);
    if (!isDate(start) || !isDate(end) || end < start) fail('Enter a valid date range (end on or after start).');
    const days = businessDays(start, end); if (!days) fail('The range has no working days.');
    if (type === 'Vacation' && days > e.ptoBalance) fail(`${e.name} has ${e.ptoBalance} vacation day(s) left; this request needs ${days}.`);
    const overlap = S.absences.find((a) => a.empId === empId && ['Pending', 'Approved'].includes(a.status) && !(a.end < start || a.start > end));
    if (overlap) fail(`Overlaps ${overlap.id} (${overlap.start} to ${overlap.end}).`);
    const a = { id: nextId('ABS'), empId, type, start, end, days, note, status: 'Pending', approverId: e.managerId };
    S.absences.push(a); log('Requested absence', a.id, `${e.name} ${type} ${days}d`); return a;
  }
  function approveAbsence(id) {
    const a = need(S.absences.find((x) => x.id === id), 'Absence'); if (a.status !== 'Pending') fail(`${id} is not pending.`);
    const e = emp(a.empId); if (a.type === 'Vacation') { if (a.days > e.ptoBalance) fail(`${e.name} no longer has enough vacation balance.`); e.ptoBalance = r2(e.ptoBalance - a.days); }
    a.status = 'Approved'; a.decidedBy = S.user; log('Approved absence', id); return a;
  }
  function rejectAbsence(id, reason) { const a = need(S.absences.find((x) => x.id === id), 'Absence'); if (a.status !== 'Pending') fail(`${id} is not pending.`); a.status = 'Rejected'; a.reason = reason || ''; a.decidedBy = S.user; log('Rejected absence', id); return a; }
  function runPayroll(p) {
    if (S.payruns.some((r) => r.period === p)) fail(`Payroll for ${periodLabel(p)} has already been run.`);
    const end = periodEnd(p), start = p + '-01';
    const staff = S.employees.filter((e) => e.hireDate <= end && (e.status === 'Active' || (e.termDate && e.termDate >= start)));
    if (!staff.length) fail('No employees are eligible for this payroll.');
    const slips = staff.map((e) => { const gross = r2(e.salary / 12), tax = r2(gross * WITHHOLDING_RATE), er = r2(gross * EMPLOYER_TAX_RATE); return { empId: e.id, name: e.name, dept: e.dept, gross, tax, net: r2(gross - tax), employerTax: er }; });
    const gross = sum(slips, (s) => s.gross), tax = sum(slips, (s) => s.tax), net = sum(slips, (s) => s.net), er = sum(slips, (s) => s.employerTax);
    const cash = balance('1000'); if (net > cash) fail(`Net pay ${money(net)} exceeds operating cash ${money(cash)}.`);
    const j = createJournal({ date: end, source: 'Payroll', desc: `Payroll ${periodLabel(p)} (${slips.length} employees)`, lines: [
      { acct: '6000', dr: gross, memo: 'Gross wages' }, { acct: '6050', dr: er, memo: 'Employer taxes' },
      { acct: '1000', cr: net, memo: 'Net pay' }, { acct: '2200', cr: r2(tax + er), memo: 'Withholding + employer taxes' }] });
    const run = { id: nextId('PR'), period: p, date: end, slips, gross, tax, net, employerTax: er, journal: j.id };
    j.ref = run.id; S.payruns.push(run); log('Ran payroll', run.id, `${periodLabel(p)} net ${money(net)}`); return run;
  }

  // ---------- cross-module views ----------
  function approvalsInbox() {
    const out = [];
    S.reqs.filter((r) => r.status === 'Pending Approval').forEach((r) => out.push({ kind: 'req', id: r.id, title: `Requisition ${money(r.total)}`, who: r.requester, date: r.date, perm: 'req.approve', why: `Over ${money(REQ_APPROVAL_LIMIT)} approval limit` }));
    S.journals.filter((j) => j.status === 'Pending Approval').forEach((j) => out.push({ kind: 'je', id: j.id, title: `Journal ${money(j.total)}: ${j.desc}`, who: j.createdBy, date: j.date, perm: 'gl.approve', why: `Over ${money(JE_APPROVAL_LIMIT)} approval limit` }));
    S.apInvoices.filter((i) => i.status === 'On Hold').forEach((i) => out.push({ kind: 'apinv', id: i.id, title: `Invoice ${i.number} from ${sup(i.supplierId).name}, ${money(i.total)}`, who: 'Payables', date: i.date, perm: 'ap.release', why: i.holds.join('; ') }));
    S.sos.filter((o) => o.status === 'Credit Hold').forEach((o) => out.push({ kind: 'so', id: o.id, title: `Order ${money(o.total)} for ${cust(o.customerId).name}`, who: 'Order management', date: o.date, perm: 'so.release', why: o.hold }));
    S.absences.filter((a) => a.status === 'Pending').forEach((a) => out.push({ kind: 'abs', id: a.id, title: `${a.type}, ${a.days} day(s): ${emp(a.empId).name}`, who: emp(a.empId).name, date: a.start, perm: 'hr.absence.approve', why: `${a.start} to ${a.end}` }));
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
  function closeChecklist(p) {
    const pend = S.journals.filter((j) => j.period === p && j.status === 'Pending Approval').length;
    const holds = S.apInvoices.filter((i) => i.status === 'On Hold' && periodOf(i.date) <= p).length;
    const unreceived = S.pos.filter((x) => ['Open', 'Partially Received'].includes(x.status) && periodOf(x.date) <= p).length;
    return [
      { task: 'Payroll run', done: S.payruns.some((r) => r.period === p), detail: S.payruns.find((r) => r.period === p)?.id || 'Not run yet' },
      { task: 'Depreciation posted', done: !!S.depreciationRuns[p], detail: S.depreciationRuns[p] || 'Not posted yet' },
      { task: 'Journals approved', done: !pend, detail: pend ? `${pend} awaiting approval` : 'None pending' },
      { task: 'Invoice holds resolved', done: !holds, detail: holds ? `${holds} on hold` : 'No holds' },
      { task: 'Open receipts reviewed', done: !unreceived, detail: unreceived ? `${unreceived} PO(s) not fully received` : 'All received', advisory: true },
      { task: 'Subledgers reconcile to GL', done: reconcile().every((r) => r.ok), detail: reconcile().every((r) => r.ok) ? 'AP, AR, inventory, accrual tie out' : 'Differences found' },
      { task: 'Period closed', done: S.periods[p] === 'Closed', detail: S.periods[p] },
    ];
  }
  /** Subledger-to-GL reconciliation for the four control accounts. */
  function reconcile() {
    const b = balances();
    const rows = [
      { name: 'Accounts payable', acct: '2000', sub: sum(S.apInvoices.filter((i) => i.status === 'Validated'), (i) => i.total - i.paid), gl: -b['2000'] },
      { name: 'Accounts receivable', acct: '1100', sub: sum(S.arInvoices.filter((i) => i.status !== 'Paid'), (i) => i.total - i.paid), gl: b['1100'] },
      { name: 'Inventory', acct: '1200', sub: sum(S.items, (i) => i.onHand * i.avgCost), gl: b['1200'] },
      { name: 'Received not invoiced', acct: '2100', sub: sum(S.pos.flatMap((p) => p.lines), (l) => (l.received - l.invoiced) * l.price), gl: -b['2100'] },
    ];
    return rows.map((r) => ({ ...r, diff: r2(r.sub - r.gl), ok: Math.abs(r.sub - r.gl) < 0.05 }));
  }
  function search(q) {
    q = String(q || '').trim().toLowerCase(); if (q.length < 2) return [];
    const hit = (...xs) => xs.some((x) => String(x || '').toLowerCase().includes(q));
    const out = [];
    S.employees.forEach((e) => hit(e.id, e.name, e.title, e.dept) && out.push({ kind: 'emp', id: e.id, label: e.name, sub: `${e.title}, ${e.dept}` }));
    S.suppliers.forEach((s) => hit(s.id, s.name) && out.push({ kind: 'sup', id: s.id, label: s.name, sub: 'Supplier' }));
    S.customers.forEach((c) => hit(c.id, c.name) && out.push({ kind: 'cust', id: c.id, label: c.name, sub: 'Customer' }));
    S.items.forEach((i) => hit(i.sku, i.name) && out.push({ kind: 'item', id: i.sku, label: `${i.sku} ${i.name}`, sub: `Item, ${i.onHand} on hand` }));
    S.accounts.forEach((a) => hit(a.code, a.name) && out.push({ kind: 'acct', id: a.code, label: `${a.code} ${a.name}`, sub: `${a.type} account` }));
    S.pos.forEach((p) => hit(p.id) && out.push({ kind: 'po', id: p.id, label: p.id, sub: `${sup(p.supplierId).name}, ${p.status}` }));
    S.sos.forEach((o) => hit(o.id, o.poNumber) && out.push({ kind: 'so', id: o.id, label: o.id, sub: `${cust(o.customerId).name}, ${o.status}` }));
    S.journals.forEach((j) => hit(j.id, j.desc) && out.push({ kind: 'je', id: j.id, label: j.id, sub: j.desc }));
    S.apInvoices.forEach((i) => hit(i.id, i.number) && out.push({ kind: 'apinv', id: i.id, label: `${i.id} (${i.number})`, sub: `${sup(i.supplierId).name}, ${i.status}` }));
    S.arInvoices.forEach((i) => hit(i.id) && out.push({ kind: 'arinv', id: i.id, label: i.id, sub: `${cust(i.customerId).name}, ${i.status}` }));
    S.reqs.forEach((r) => hit(r.id, r.requester) && out.push({ kind: 'req', id: r.id, label: r.id, sub: `${r.requester}, ${r.status}` }));
    return out.slice(0, 25);
  }

  const Engine = {
    TODAY, FY_START, ROLE_USERS, REQ_APPROVAL_LIMIT, JE_APPROVAL_LIMIT, PRICE_TOLERANCE, WITHHOLDING_RATE, EMPLOYER_TAX_RATE, DEPRECIATION_MONTHS, ROLES,
    get S() { return S; }, set S(v) { S = v; },
    reset, load, can, log, nextId,
    util: { r2, sum, periodOf, addDays, daysBetween, periodEnd, periodLabel, money, businessDays, isDate },
    item, sup, cust, emp, acct, je, po, so, apinv, arinv, req, payrun,
    addAccount, createJournal, createManualJournal, approveJournal, rejectJournal, balances, balance, natural, trialBalance, incomeStatement, balanceSheet,
    periods, closePeriod, reopenPeriod, openPeriod, runDepreciation, assertOpen,
    addSupplier, addCustomer, addItem, adjustInventory,
    createReq, approveReq, rejectReq, createPO, receivePO,
    enterAPInvoice, releaseHold, cancelAPInvoice, payInvoices,
    createSO, releaseCreditHold, cancelSO, shipSO, applyReceipt, openAR, arAging,
    hireEmployee, terminateEmployee, requestAbsence, approveAbsence, rejectAbsence, runPayroll,
    approvalsInbox, closeChecklist, reconcile, search,
  };
  // getter/setter on S don't survive object literal spread; define explicitly
  Object.defineProperty(Engine, 'S', { get: () => S, set: (v) => { S = v; }, enumerable: true });
  reset();
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine; else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
