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
  const STATE_VERSION = 2;
  const FUNCTIONAL = 'USD';
  const TAX_CODES = [
    { code: 'MA', name: 'Massachusetts 6.25%', rate: 0.0625 },
    { code: 'NY', name: 'New York 8.875%', rate: 0.08875 },
    { code: 'NJ', name: 'New Jersey 6.625%', rate: 0.06625 },
    { code: 'EXEMPT', name: 'Exempt (public body or resale)', rate: 0 },
    { code: 'EU-EXPORT', name: 'Export, zero-rated', rate: 0 },
  ];
  const CURRENCIES = [{ code: 'USD', name: 'US dollar', symbol: '$' }, { code: 'EUR', name: 'Euro', symbol: '\u20ac' }, { code: 'GBP', name: 'Pound sterling', symbol: '\u00a3' }];
  // Month-average rates, USD per 1 unit of foreign currency, Jul-26..Jun-27.
  const FX_SERIES = {
    EUR: [1.0842, 1.0915, 1.1023, 1.1087, 1.1164, 1.1121, 1.1058, 1.0996, 1.1040, 1.1102, 1.1175, 1.1203],
    GBP: [1.2718, 1.2795, 1.2862, 1.2804, 1.2741, 1.2829, 1.2903, 1.2876, 1.2950, 1.3012, 1.2968, 1.3044],
  };

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
    'Controller': ['gl.post', 'gl.approve', 'gl.close', 'gl.depr', 'gl.coa', 'gl.recurring', 'ap.release', 'so.release', 'req.approve'],
    'AP Specialist': ['ap.enter', 'ap.pay', 'supplier.edit'],
    'Buyer': ['po.create', 'po.receive', 'supplier.edit', 'item.edit', 'inv.adjust'],
    'Order Manager': ['so.create', 'so.ship', 'ar.receipt', 'customer.edit'],
    'HR Specialist': ['hr.edit', 'hr.absence.approve', 'hr.payroll'],
  };
  const ROLE_USERS = { 'Administrator': 'System Administrator', 'Controller': 'Avery Lin', 'AP Specialist': 'Sam Achebe', 'Buyer': 'Dana Whitfield', 'Order Manager': 'Ines Duarte', 'HR Specialist': 'Nadia Petrova' };
  const can = (role, perm) => { const p = ROLES[role] || []; return p.includes('*') || p.includes(perm) || COMMON.includes(perm); };

  // ---------- extension points (see PLAN.md "Extending the engine") ----------
  const hooks = { state: [], reconcile: [], approvals: [], checklist: [], search: [], seedSetup: [], seedMonthly: [], seedFinal: [] };
  /** Register a hook: on('reconcile', fn). State hooks MUST be idempotent (only fill missing keys). */
  const on = (name, fn) => { if (!hooks[name]) throw new Error('Unknown hook ' + name); hooks[name].push(fn); };
  const addPerms = (role, perms) => { ROLES[role] = Array.from(new Set([...(ROLES[role] || []), ...perms])); };

  // ---------- state ----------
  let S;
  function blankState() {
    const periods = {};
    for (let i = 0; i < 12; i++) { const y = 2026 + Math.floor((6 + i) / 12); const m = ((6 + i) % 12) + 1; periods[`${y}-${String(m).padStart(2, '0')}`] = 'Future'; }
    return {
      version: STATE_VERSION, company: 'Halden Instruments Ltd.', currency: 'USD', today: TODAY, role: 'Administrator', user: 'System Administrator',
      seq: {}, periods, accounts: [], journals: [], depreciationRuns: {},
      suppliers: [], customers: [], items: [], invTxns: [],
      reqs: [], pos: [], apInvoices: [], payments: [],
      sos: [], arInvoices: [], receipts: [],
      departments: [], employees: [], absences: [], payruns: [],
      audit: [],
    };
  }
  /** Core keys added after v1; fills only what is missing so older saved states still load. */
  function fillCore(st) {
    const order = Object.keys(st.periods || {}).sort();
    st.taxCodes = st.taxCodes || TAX_CODES.map((x) => ({ ...x }));
    st.currencies = st.currencies || CURRENCIES.map((x) => ({ ...x }));
    if (!st.fxRates) { st.fxRates = {}; order.forEach((p, i) => { st.fxRates[p] = {}; for (const c in FX_SERIES) st.fxRates[p][c] = FX_SERIES[c][i % 12]; }); }
    st.recurring = st.recurring || []; st.creditMemos = st.creditMemos || []; st.taxRemits = st.taxRemits || [];
    (st.suppliers || []).forEach((x) => { if (!x.currency) x.currency = FUNCTIONAL; });
    (st.customers || []).forEach((x) => { if (!x.currency) x.currency = FUNCTIONAL; if (x.taxCode == null) x.taxCode = ''; });
    if ((st.accounts || []).length) CORE_ACCOUNTS.forEach(([code, name, type]) => { if (!st.accounts.some((a) => a.code === code)) { st.accounts.push({ code, name, type, active: true }); st.accounts.sort((a, b) => a.code.localeCompare(b.code)); } });
    return st;
  }
  const CORE_ACCOUNTS = [['2300', 'Sales tax payable', 'Liability'], ['7100', 'Realized FX gain/loss', 'Expense']];
  function applyStateHooks(st) { fillCore(st); hooks.state.forEach((f) => f(st)); return st; }
  function reset() { S = blankState(); Engine.S = S; applyStateHooks(S); return S; }
  function load(obj) { S = obj; Engine.S = S; applyStateHooks(S); return S; }
  /** Bump the ledger revision. Call after ANY change to a journal's lines or status. */
  const touch = () => { S._rev = (S._rev || 0) + 1; };
  /** Add a GL account if missing (no audit entry). For extension setup/state hooks. */
  function ensureAccount(code, name, type) {
    if (!S.accounts.some((a) => a.code === code)) { S.accounts.push({ code, name, type, active: true }); S.accounts.sort((a, b) => a.code.localeCompare(b.code)); touch(); }
  }

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
    S.accounts.sort((a, b) => a.code.localeCompare(b.code)); touch();
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
  /** Normalizes and validates journal lines (balanced, known accounts). Returns {lines, dr}. */
  function checkLines(lines) {
    lines = (lines || []).map((l) => ({ acct: String(l.acct), dr: r2(+l.dr || 0), cr: r2(+l.cr || 0), memo: l.memo || '' }))
      .filter((l) => l.dr || l.cr);
    if (!lines.length) fail('A journal needs at least one line with an amount.');
    for (const l of lines) {
      if (!acct(l.acct)) fail(`Account ${l.acct} does not exist.`);
      if (!Number.isFinite(l.dr) || !Number.isFinite(l.cr)) fail('Amounts must be valid numbers.');
      if (l.dr < 0 || l.cr < 0) fail('Amounts cannot be negative. Use the opposite column instead.');
      if (l.dr && l.cr) fail('A line can have a debit or a credit, not both.');
    }
    const dr = sum(lines, (l) => l.dr), cr = sum(lines, (l) => l.cr);
    if (Math.abs(dr - cr) > 0.004) fail(`Journal is out of balance by ${money(r2(dr - cr))}. Debits must equal credits.`);
    return { lines, dr };
  }
  function createJournal({ date, source = 'Manual', desc = '', lines = [], ref = '', needsApproval = false }) {
    const chk = checkLines(lines); lines = chk.lines; const dr = chk.dr;
    const p = assertOpen(date);
    const j = { id: nextId('JE'), date, period: p, source, desc, lines, ref, total: dr, status: needsApproval ? 'Pending Approval' : 'Posted', createdBy: S.user, role: S.role };
    S.journals.push(j); touch();
    log(needsApproval ? 'Submitted journal for approval' : 'Posted journal', j.id, `${source}: ${desc} (${money(dr)})`);
    return j;
  }
  /** Manual journal entered by a person: applies the approval threshold.
   *  autoReverse: true makes it an accrual that reverses on the first day of the next period
   *  (as soon as that period is open: immediately, or when it is opened). */
  function createManualJournal({ date, desc, lines, autoReverse = false }) {
    if (!String(desc || '').trim()) fail('Describe the journal so reviewers know what it is for.');
    if (autoReverse && isDate(date) && !nextPeriod(periodOf(date))) fail('An auto-reversing accrual needs a following period in the calendar.');
    const total = sum(lines || [], (l) => +l.dr || 0);
    const j = createJournal({ date, desc, lines, source: 'Manual', needsApproval: total > JE_APPROVAL_LIMIT });
    if (autoReverse) { j.autoReverse = true; processAutoReversals(); }
    return j;
  }
  function approveJournal(id) {
    const j = need(je(id), 'Journal'); if (j.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`);
    assertOpen(j.date); if (j.createdBy === S.user && S.role !== 'Administrator') fail('You cannot approve a journal you created (segregation of duties).');
    j.status = 'Posted'; j.approvedBy = S.user; touch(); log('Approved journal', id);
    if (j.autoReverse) processAutoReversals();
    return j;
  }
  const nextPeriod = (p) => { const ks = Object.keys(S.periods).sort(); const i = ks.indexOf(p); return i >= 0 && i < ks.length - 1 ? ks[i + 1] : null; };
  /** GL accounts that a subledger reconciles to (core + extension reconcile rows). */
  const controlAccounts = () => new Set(reconcile().map((r) => r.acct).filter(Boolean));
  /** reverseJournal(id, date): posts the mirror image of a posted journal into an open period. */
  function reverseJournal(id, date, opts = {}) {
    const j = need(je(id), 'Journal');
    if (j.status !== 'Posted') fail(`${id} is ${j.status}. Only posted journals can be reversed.`);
    if (j.reversedBy) fail(`${id} was already reversed by ${j.reversedBy}.`);
    if (j.reversalOf) fail(`${id} is itself the reversal of ${j.reversalOf}. Post a new journal instead.`);
    if (!isDate(date)) fail('Enter a valid reversal date (YYYY-MM-DD).');
    if (date < j.date) fail(`A reversal cannot be dated before the original journal (${j.date}).`);
    if (j.source !== 'Manual') {
      const ctrl = controlAccounts(); const hit = j.lines.find((l) => ctrl.has(l.acct));
      if (hit) fail(`${id} posts to control account ${hit.acct} ${acct(hit.acct)?.name || ''}. Reverse it through its subledger (for example a credit memo) so the subledger and GL stay in agreement.`);
    }
    const r = createJournal({ date, source: j.source, desc: `Reversal of ${j.id}: ${j.desc}`, ref: j.id, lines: j.lines.map((l) => ({ acct: l.acct, dr: l.cr, cr: l.dr, memo: l.memo })) });
    r.reversalOf = j.id; if (opts.auto) r.autoReversal = true; j.reversedBy = r.id;
    log(opts.auto ? 'Auto-reversed accrual' : 'Reversed journal', j.id, `${r.id} dated ${date}`);
    return r;
  }
  /** Reverses every posted auto-reversing accrual whose next period is open. Returns the reversals. */
  function processAutoReversals() {
    const out = [];
    S.journals.filter((j) => j.autoReverse && j.status === 'Posted' && !j.reversedBy).forEach((j) => {
      const np = nextPeriod(j.period); if (np && S.periods[np] === 'Open') out.push(reverseJournal(j.id, np + '-01', { auto: true }));
    });
    return out;
  }

  // ---------- recurring journals ----------
  const recurring = (id) => S.recurring.find((t) => t.id === id);
  const recurringNext = (t) => Object.keys(S.periods).sort().find((p) => p >= t.startPeriod && !t.generated[p]) || null;
  /** createRecurring({name, desc, lines:[{acct, dr, cr, memo}], startPeriod, day, source}) — monthly template. desc may contain {period}. */
  function createRecurring({ name, desc = '', lines, startPeriod, day = 1, source = 'Recurring', generated = {} }) {
    name = String(name || '').trim(); if (!name) fail('Give the recurring journal a name.');
    if (S.recurring.some((t) => t.name.toLowerCase() === name.toLowerCase())) fail(`A recurring journal named ${name} already exists.`);
    const chk = checkLines(lines);
    if (!S.periods[startPeriod]) fail('Choose a first period inside the FY2027 calendar.');
    day = +day; if (!Number.isInteger(day) || day < 1 || day > 31) fail('Day of month must be a whole number from 1 to 31.');
    const t = { id: nextId('RJ'), name, desc: String(desc || name), lines: chk.lines, total: chk.dr, frequency: 'Monthly', startPeriod, day, source, active: true, generated: { ...generated }, createdBy: S.user };
    t.nextPeriod = recurringNext(t);
    S.recurring.push(t); log('Created recurring journal', t.id, `${name} ${money(chk.dr)} monthly from ${periodLabel(startPeriod)}`); return t;
  }
  /** Template from an existing posted journal; starts the period after it unless startPeriod is given. */
  function recurringFromJournal(jeId, { name, startPeriod, day } = {}) {
    const j = need(je(jeId), 'Journal'); if (j.status !== 'Posted') fail(`${jeId} is ${j.status}. Only posted journals can be made recurring.`);
    if (j.reversalOf) fail('A reversal cannot be made recurring.');
    const sp = startPeriod || nextPeriod(j.period) || fail('There is no later period to start from.');
    return createRecurring({ name: name || j.desc, desc: j.desc, lines: j.lines, startPeriod: sp, day: day || +j.date.slice(8), source: 'Recurring', generated: sp <= j.period ? { [j.period]: j.id } : {} });
  }
  /** generateRecurring(id, period?) — posts the template into the given (or earliest open, not yet generated) period. Once per period. */
  function generateRecurring(id, period) {
    const t = need(recurring(id), 'Recurring journal'); if (!t.active) fail(`${t.name} is inactive.`);
    let p = period;
    if (!p) {
      p = Object.keys(S.periods).sort().find((x) => x >= t.startPeriod && S.periods[x] === 'Open' && !t.generated[x]);
      if (!p) fail(`${t.name} is already generated for every open period from ${periodLabel(t.startPeriod)}. Open the next period first.`);
    } else {
      if (!S.periods[p]) fail('Choose a period inside the FY2027 calendar.');
      if (t.generated[p]) fail(`${t.name} was already generated for ${periodLabel(p)} (${t.generated[p]}).`);
      if (p < t.startPeriod) fail(`${t.name} starts in ${periodLabel(t.startPeriod)}.`);
    }
    const dd = Math.min(t.day, +periodEnd(p).slice(8));
    const j = createJournal({ date: `${p}-${String(dd).padStart(2, '0')}`, source: t.source || 'Recurring', desc: t.desc.replace('{period}', periodLabel(p)), ref: t.id, lines: t.lines });
    t.generated[p] = j.id; t.nextPeriod = recurringNext(t); t.lastJournal = j.id;
    log('Generated recurring journal', t.id, `${j.id} for ${periodLabel(p)}`); return j;
  }
  function setRecurringActive(id, active) { const t = need(recurring(id), 'Recurring journal'); t.active = !!active; log(active ? 'Activated recurring journal' : 'Paused recurring journal', id); return t; }
  function rejectJournal(id, reason) {
    const j = need(je(id), 'Journal'); if (j.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`);
    j.status = 'Rejected'; j.rejectReason = reason || ''; touch(); log('Rejected journal', id, reason); return j;
  }

  /** Sum of (dr - cr) for posted journals, optionally limited to a period range. */
  // Memoized per (state object, ledger revision, period range): reports and dashboards call this many times per render.
  let balCache = { S: null, rev: -1, m: new Map() };
  function balances(opts = {}) {
    if (balCache.S !== S || balCache.rev !== (S._rev || 0)) balCache = { S, rev: S._rev || 0, m: new Map() };
    const key = (opts.fromPeriod || '') + '|' + (opts.toPeriod || '');
    let hit = balCache.m.get(key);
    if (!hit) { hit = computeBalances(opts); balCache.m.set(key, hit); }
    return { ...hit };
  }
  function computeBalances({ fromPeriod, toPeriod } = {}) {
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
    S.periods[p] = 'Open'; log('Reopened period', periodLabel(p)); processAutoReversals(); return true;
  }
  function openPeriod(p) {
    if (S.periods[p] !== 'Future') fail(`${periodLabel(p)} is not a future period.`);
    const earlierFuture = Object.keys(S.periods).filter((x) => x < p && S.periods[x] === 'Future');
    if (earlierFuture.length) fail(`Open ${earlierFuture.map(periodLabel).join(', ')} first. Periods open in order.`);
    S.periods[p] = 'Open'; log('Opened period', periodLabel(p)); processAutoReversals(); return true;
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
  // ---------- tax and currency ----------
  const taxCode = (code) => S.taxCodes.find((t) => t.code === code);
  /** Rate for a tax code; '' or missing code means untaxed (0). */
  const taxRate = (code) => (code ? need(taxCode(code), `Tax code ${code}`).rate : 0);
  const currency = (code) => S.currencies.find((c) => c.code === code);
  /** fxRate(ccy, date) — USD per 1 unit of ccy for the date's period (month-average). */
  function fxRate(ccy, date) {
    if (!ccy || ccy === FUNCTIONAL) return 1;
    if (!currency(ccy)) fail(`Currency ${ccy} is not set up.`);
    const p = periodOf(date); const r = S.fxRates[p] && S.fxRates[p][ccy];
    if (!(r > 0)) fail(`No ${ccy} exchange rate is loaded for ${periodLabel(p)}.`);
    return r;
  }
  function setFxRate(period, ccy, rate) {
    if (!S.periods[period]) fail('Choose a period inside the FY2027 calendar.'); if (!currency(ccy) || ccy === FUNCTIONAL) fail('Choose a foreign currency.');
    rate = +rate; if (!(rate > 0) || !Number.isFinite(rate)) fail('Exchange rate must be greater than zero.');
    S.fxRates[period] = S.fxRates[period] || {}; S.fxRates[period][ccy] = Math.round(rate * 1e6) / 1e6; log('Set exchange rate', `${ccy} ${periodLabel(period)}`, String(rate)); return rate;
  }
  const isFx = (i) => !!i.currency && i.currency !== FUNCTIONAL;
  /** Functional (USD) open balance of an AP or AR invoice: total - paid - credited. */
  const openAmt = (i) => r2(i.total - (i.paid || 0) - (i.credited || 0));
  /** Open balance in the invoice currency (equals openAmt for USD invoices). */
  const fxOpen = (i) => (isFx(i) ? r2(i.fxTotal - (i.fxPaid || 0) - (i.fxCredited || 0)) : openAmt(i));
  const ccyAmt = (n, ccy) => (!ccy || ccy === FUNCTIONAL ? money(n) : `${ccy} ${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  /** Functional amount relieved when `amt` (invoice currency) of the open balance is settled; exact on the final settlement. */
  const relieveFor = (i, amt) => { const o = fxOpen(i); return amt >= o - 0.001 ? openAmt(i) : r2(openAmt(i) * amt / o); };
  /** Allocates total across weights, rounding remainder onto the last share (sum is exact). */
  function alloc(total, weights) {
    const W = weights.reduce((a, b) => a + b, 0); let acc = 0;
    return weights.map((w, i) => { if (i === weights.length - 1) return r2(total - acc); const v = W ? r2(total * w / W) : 0; acc = r2(acc + v); return v; });
  }
  /** After an avg-cost change, true up GL 1200 to the item subledger (rounding only). */
  function inventoryTrueUp(date, ref, offset) {
    const diff = r2(sum(S.items, (x) => x.onHand * x.avgCost) - balance('1200'));
    if (Math.abs(diff) >= 0.01) createJournal({ date, source: 'Inventory', desc: `Average cost rounding ${ref}`, ref, lines: diff > 0 ? [{ acct: '1200', dr: diff }, { acct: offset, cr: diff }] : [{ acct: offset, dr: -diff }, { acct: '1200', cr: -diff }] });
  }
  const ensureCoreAccounts = () => CORE_ACCOUNTS.forEach(([c, n, t]) => ensureAccount(c, n, t));
  const settleStatus = (i, side) => {
    if (openAmt(i) <= 0.004) { i.status = (i.paid || 0) > 0.004 ? 'Paid' : 'Credited'; return; }
    if (side === 'AR') i.status = (i.paid || 0) > 0 ? 'Partially Paid' : 'Open';
  };

  function addSupplier({ name, terms = 30, site = '', email = '', currency: ccy = FUNCTIONAL }) {
    if (!String(name || '').trim()) fail('Supplier name is required.');
    if (S.suppliers.some((s) => s.name.toLowerCase() === name.trim().toLowerCase())) fail(`A supplier named ${name} already exists.`);
    if (!currency(ccy)) fail(`Currency ${ccy} is not set up.`);
    const s = { id: nextId('SUP'), name: name.trim(), terms: +terms || 30, site, email, currency: ccy, active: true };
    S.suppliers.push(s); log('Created supplier', s.id, s.name); return s;
  }
  function addCustomer({ name, terms = 30, creditLimit = 50000, segment = '', currency: ccy = FUNCTIONAL, taxCode: tc = '' }) {
    if (!String(name || '').trim()) fail('Customer name is required.');
    if (S.customers.some((c) => c.name.toLowerCase() === name.trim().toLowerCase())) fail(`A customer named ${name} already exists.`);
    if (!(+creditLimit >= 0)) fail('Credit limit must be zero or more.');
    if (!currency(ccy)) fail(`Currency ${ccy} is not set up.`);
    if (tc && !taxCode(tc)) fail(`Tax code ${tc} is not set up.`);
    const c = { id: nextId('CUS'), name: name.trim(), terms: +terms || 30, creditLimit: r2(+creditLimit), segment, currency: ccy, taxCode: tc, active: true };
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
    lines.forEach((l) => { need(item(l.sku), `Item ${l.sku}`); if (!Number.isFinite(l.qty) || !Number.isFinite(l.price) || l.price < 0) fail('Quantities and prices must be valid numbers.'); });
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
    lines.forEach((l) => { need(item(l.sku), `Item ${l.sku}`); if (!(l.price > 0) || !Number.isFinite(l.price)) fail(`Enter a valid price for ${l.sku}.`); if (!Number.isInteger(l.qty)) fail('Quantities must be whole numbers.'); });
    if (r) {
      const reqQty = {}; r.lines.forEach((l) => (reqQty[l.sku] = (reqQty[l.sku] || 0) + l.qty));
      const poQty = {}; lines.forEach((l) => (poQty[l.sku] = (poQty[l.sku] || 0) + l.qty));
      for (const k in poQty) { if (!reqQty[k]) fail(`${k} is not on requisition ${r.id}.`); if (poQty[k] > reqQty[k]) fail(`${k}: ordering ${poQty[k]} but ${r.id} approved ${reqQty[k]}.`); }
      const t = sum(lines, (l) => l.qty * l.price); if (t > r2(r.total * 1.1)) fail(`PO total ${money(t)} is more than 10% above the approved requisition (${money(r.total)}). Raise a new requisition.`);
    }
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
      it.avgCost = it.onHand > 0 ? r2((it.onHand * it.avgCost + q * l.price) / (it.onHand + q)) : l.price;
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
    assertOpen(date);
    (lines || []).forEach((l) => { if (+l.qty > 0 && !p.lines[+l.line]) fail(`${poId} has no line ${+l.line + 1}.`); if (+l.qty > 0 && (!Number.isInteger(+l.qty) || !(+l.price > 0) || !Number.isFinite(+l.price))) fail('Billed quantities must be whole numbers and prices greater than zero.'); });
    lines = (lines || []).filter((l) => +l.qty > 0).map((l) => ({ line: +l.line, sku: p.lines[+l.line].sku, qty: +l.qty, price: r2(+l.price), poPrice: p.lines[+l.line].price }));
    if (!lines.length) fail('Bill at least one line.');
    const dupLine = lines.find((l, i) => lines.findIndex((x) => x.line === l.line) !== i);
    if (dupLine) fail(`PO line ${dupLine.line + 1} (${dupLine.sku}) appears twice. Bill each PO line once.`);
    const holds = [];
    for (const l of lines) {
      const pl = p.lines[l.line];
      const pendingQty = S.apInvoices.filter((i) => i.poId === poId && i.status === 'On Hold').flatMap((i) => i.lines).filter((x) => x.line === l.line).reduce((a, x) => a + x.qty, 0);
      if (l.qty + pl.invoiced + pendingQty > pl.received) holds.push(`${l.sku}: billed ${l.qty}, only ${pl.received - pl.invoiced - pendingQty} received and not yet billed`);
      if (Math.abs(l.price - pl.price) / pl.price > PRICE_TOLERANCE) holds.push(`${l.sku}: price ${money(l.price)} is more than ${PRICE_TOLERANCE * 100}% off PO price ${money(pl.price)}`);
    }
    const s = sup(p.supplierId);
    const inv = { id: nextId('APINV'), number, supplierId: s.id, poId, date, due: addDays(date, s.terms), lines, total: sum(lines, (l) => l.qty * l.price), paid: 0, credited: 0, currency: FUNCTIONAL, rate: 1, holds, status: holds.length ? 'On Hold' : 'Entered' };
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
  /** payInvoices(ids[], date, method) — one payment per supplier. Pays each invoice's full open balance.
   *  Foreign-currency invoices are paid at the payment date's rate; the difference to the carrying
   *  amount posts to 7100 Realized FX gain/loss. Payment.amount is the USD cash paid. */
  function payInvoices(ids, date, method = 'ACH') {
    ids = [...new Set(ids)]; if (!ids.length) fail('Select at least one invoice.');
    assertOpen(date);
    const invs = ids.map((id) => need(apinv(id), `Invoice ${id}`));
    invs.forEach((i) => { if (i.status !== 'Validated') fail(`${i.id} is ${i.status} and cannot be paid.`); });
    const plan = invs.map((i) => { const fx = isFx(i); const rate = fx ? fxRate(i.currency, date) : 1; const carry = openAmt(i); const fxAmt = fxOpen(i); return { i, fx, rate, carry, fxAmt, cash: fx ? r2(fxAmt * rate) : carry }; });
    if (plan.some((x) => x.fx)) ensureCoreAccounts();
    const total = sum(plan, (x) => x.cash);
    const cash = balance('1000');
    if (total > cash) fail(`Payment of ${money(total)} exceeds operating cash of ${money(cash)}.`);
    const bySup = {}; plan.forEach((x) => (bySup[x.i.supplierId] = bySup[x.i.supplierId] || []).push(x));
    const out = [];
    for (const sid in bySup) {
      const list = bySup[sid]; const carry = sum(list, (x) => x.carry), amt = sum(list, (x) => x.cash), fxd = r2(amt - carry);
      const lines = [{ acct: '2000', dr: carry }, { acct: '1000', cr: amt }];
      if (fxd > 0) lines.push({ acct: '7100', dr: fxd, memo: 'Realized FX loss' }); if (fxd < 0) lines.push({ acct: '7100', cr: -fxd, memo: 'Realized FX gain' });
      const j = createJournal({ date, source: 'Payables', desc: `Payment to ${sup(sid).name} (${method})`, lines });
      const pay = { id: nextId('PAY'), supplierId: sid, date, method, amount: amt, invoices: list.map((x) => x.i.id), journal: j.id };
      const fxl = list.filter((x) => x.fx); if (fxl.length) { pay.fx = fxl.map((x) => ({ invoiceId: x.i.id, currency: x.i.currency, fxAmount: x.fxAmt, rate: x.rate, carrying: x.carry, cash: x.cash, gainLoss: r2(x.carry - x.cash) })); pay.fxGainLoss = r2(-fxd); }
      list.forEach((x) => { const i = x.i; i.paid = r2((i.paid || 0) + x.carry); if (x.fx) i.fxPaid = r2((i.fxPaid || 0) + x.fxAmt); i.status = 'Paid'; i.paymentId = pay.id; });
      S.payments.push(pay); j.ref = pay.id; log('Paid supplier', pay.id, `${sup(sid).name} ${money(amt)}`); out.push(pay);
    }
    return out;
  }

  /** Validates the currency/rate pair for a new invoice. Invoices are USD unless `currency` is passed. */
  function invoiceRate(ccy, rate, date) {
    ccy = ccy || FUNCTIONAL; if (!currency(ccy)) fail(`Currency ${ccy} is not set up.`);
    if (ccy === FUNCTIONAL) return { ccy, rate: 1, fx: false };
    const rt = rate != null && rate !== '' ? +rate : fxRate(ccy, date);
    if (!(rt > 0) || !Number.isFinite(rt)) fail('Exchange rate must be greater than zero.');
    return { ccy, rate: rt, fx: true };
  }
  /** Non-PO supplier invoice (services, utilities, expenses):
   *  createAPInvoice({supplierId, number, date, lines:[{acct, desc, amount, project?}], source, ref, currency?, rate?}) -> Validated invoice.
   *  currency defaults to USD (NOT the supplier's currency). With a foreign currency, line amounts are in that currency;
   *  the invoice books at rate (default: the period's rate). total / line.amount are USD; fxTotal / line.fxAmount are foreign. */
  function createAPInvoice({ supplierId, number, date, lines, source = 'Payables', ref = '', currency: ccy, rate }) {
    const s = need(sup(supplierId), 'Supplier'); assertOpen(date);
    number = String(number || '').trim(); if (!number) fail("Enter the supplier's invoice number.");
    if (S.apInvoices.some((i) => i.supplierId === s.id && i.number === number && i.status !== 'Cancelled')) fail(`Invoice ${number} from this supplier is already entered (duplicate check).`);
    const fx = invoiceRate(ccy, rate, date);
    lines = (lines || []).filter((l) => +l.amount).map((l) => ({ acct: String(l.acct), desc: l.desc || '', amount: r2(+l.amount), project: l.project || '' }));
    if (!lines.length) fail('Add at least one line with an amount.');
    lines.forEach((l) => { if (!acct(l.acct)) fail(`Account ${l.acct} does not exist.`); if (!Number.isFinite(l.amount)) fail('Amounts must be valid numbers.'); });
    const fxTotal = sum(lines, (l) => l.amount); if (!(fxTotal > 0)) fail('The invoice total must be greater than zero.');
    if (fx.fx) lines.forEach((l) => { l.fxAmount = l.amount; l.amount = r2(l.amount * fx.rate); });
    const total = sum(lines, (l) => l.amount); if (!(total > 0)) fail('The invoice total must be greater than zero.');
    const inv = { id: nextId('APINV'), number, supplierId: s.id, poId: '', date, due: addDays(date, s.terms), lines, total, paid: 0, credited: 0, currency: fx.ccy, rate: fx.rate, holds: [], status: 'Validated', ref };
    if (fx.fx) { inv.fxTotal = fxTotal; inv.fxPaid = 0; inv.fxCredited = 0; }
    const j = createJournal({ date, source, desc: `Invoice ${number} (${s.name})${fx.fx ? ` ${ccyAmt(fxTotal, fx.ccy)} @ ${fx.rate}` : ''}`, ref: inv.id, lines: [...lines.map((l) => (l.amount > 0 ? { acct: l.acct, dr: l.amount, memo: l.desc } : { acct: l.acct, cr: -l.amount, memo: l.desc })), { acct: '2000', cr: total, memo: s.name }] });
    inv.journal = j.id; S.apInvoices.push(inv); log('Entered invoice', inv.id, `${s.name} ${fx.fx ? ccyAmt(fxTotal, fx.ccy) + ' = ' : ''}${money(total)}`); return inv;
  }
  /** Receivables invoice not created by shipping (services, projects, fees):
   *  createARInvoice({customerId, date, lines:[{acct, desc, amount}], source, ref, taxCode?, currency?, rate?}) -> Open invoice.
   *  taxCode omitted = no tax. currency omitted = USD. Fields: net, tax, total (USD, total incl. tax); fxNet/fxTax/fxTotal when foreign. */
  function createARInvoice({ customerId, date, lines, source = 'Receivables', ref = '', taxCode: tc = '', currency: ccy, rate }) {
    const c = need(cust(customerId), 'Customer'); assertOpen(date);
    const fx = invoiceRate(ccy, rate, date); const tRate = taxRate(tc);
    lines = (lines || []).filter((l) => +l.amount).map((l) => ({ acct: String(l.acct), desc: l.desc || '', amount: r2(+l.amount) }));
    if (!lines.length) fail('Add at least one line with an amount.');
    lines.forEach((l) => { if (!acct(l.acct)) fail(`Account ${l.acct} does not exist.`); if (!Number.isFinite(l.amount)) fail('Amounts must be valid numbers.'); });
    const fxNet = sum(lines, (l) => l.amount); if (!(fxNet > 0)) fail('The invoice total must be greater than zero.');
    const fxTax = r2(fxNet * tRate);
    if (fx.fx) lines.forEach((l) => { l.fxAmount = l.amount; l.amount = r2(l.amount * fx.rate); });
    const net = sum(lines, (l) => l.amount), tax = fx.fx ? r2(fxTax * fx.rate) : fxTax, total = r2(net + tax);
    if (!(net > 0)) fail('The invoice total must be greater than zero.');
    if (tax) ensureCoreAccounts();
    const inv = { id: nextId('ARINV'), customerId: c.id, soId: '', date, due: addDays(date, c.terms), net, tax, taxCode: tc || '', taxRate: tRate, total, paid: 0, credited: 0, currency: fx.ccy, rate: fx.rate, status: 'Open', lines, ref };
    if (fx.fx) Object.assign(inv, { fxNet, fxTax, fxTotal: r2(fxNet + fxTax), fxPaid: 0, fxCredited: 0 });
    const jl = [{ acct: '1100', dr: total }, ...lines.map((l) => (l.amount > 0 ? { acct: l.acct, cr: l.amount, memo: l.desc } : { acct: l.acct, dr: -l.amount, memo: l.desc }))];
    if (tax) jl.push({ acct: '2300', cr: tax, memo: `Sales tax ${tc}` });
    const j = createJournal({ date, source, desc: `Invoice ${inv.id} (${c.name})${ref ? ' for ' + ref : ''}${fx.fx ? ` ${ccyAmt(inv.fxTotal, fx.ccy)} @ ${fx.rate}` : ''}`, ref: inv.id, lines: jl });
    inv.journal = j.id; S.arInvoices.push(inv); log('Raised invoice', inv.id, `${c.name} ${money(total)}`); return inv;
  }

  // ---------- credit memos ----------
  const creditMemo = (id) => S.creditMemos.find((m) => m.id === id);
  /** createARCreditMemo({invoiceId, date, amount, reason, returns:[{line, qty}]}) — amount in the invoice currency (incl. tax),
   *  <= open balance. returns (shipped-order invoices only) put stock back at the line's original unit cost
   *  (Dr 1200 / Cr 5000). With returns and no amount, the credit defaults to the returned lines at order price plus tax. */
  function createARCreditMemo({ invoiceId, date, amount, reason, returns }) {
    const inv = need(arinv(invoiceId), 'Invoice'); const c = cust(inv.customerId);
    if (!(openAmt(inv) > 0.004)) fail(`${invoiceId} has no open balance to credit.`);
    if (!String(reason || '').trim()) fail('Give a reason for the credit memo.');
    assertOpen(date); if (date < inv.date) fail('A credit memo cannot be dated before its invoice.');
    let ret = [];
    const rq = (returns || []).filter((r) => +r.qty);
    if (rq.length) {
      if (!inv.soId) fail('Return to stock applies only to invoices raised by shipping a sales order.');
      const o = need(so(inv.soId), 'Sales order');
      ret = rq.map((r) => {
        const li = +r.line, q = +r.qty, l = o.lines[li]; if (!l) fail(`${o.id} has no line ${li + 1}.`);
        if (!Number.isInteger(q) || q < 0) fail('Return quantities must be whole numbers, zero or more.');
        const left = l.qty - (l.returned || 0); if (q > left) fail(`${l.sku}: only ${left} shipped and not yet returned, not ${q}.`);
        return { line: li, sku: l.sku, qty: q, price: l.price, unitCost: l.unitCost ?? item(l.sku).avgCost };
      });
      const dup = ret.find((r, i) => ret.findIndex((x) => x.line === r.line) !== i); if (dup) fail(`Line ${dup.line + 1} (${dup.sku}) appears twice.`);
    }
    const fx = isFx(inv), openF = fxOpen(inv);
    if (amount === '' || amount == null) { if (!ret.length) fail('Enter the credit amount.'); amount = r2(sum(ret, (r) => r.qty * r.price) * (1 + (inv.taxRate || 0))); }
    amount = r2(+amount);
    if (!(amount > 0) || !Number.isFinite(amount)) fail('Enter a credit amount greater than zero.');
    if (amount > openF + 0.001) fail(`Credit ${ccyAmt(amount, inv.currency)} is more than the open balance ${ccyAmt(openF, inv.currency)}.`);
    const func = relieveFor(inv, amount);
    const tax = inv.tax && inv.total > 0 ? r2(func * inv.tax / inv.total) : 0, net = r2(func - tax);
    if (tax) ensureCoreAccounts();
    const rev = inv.lines && inv.lines.length ? alloc(net, inv.lines.map((l) => l.amount)).map((v, k) => ({ acct: inv.lines[k].acct, v })) : [{ acct: '4000', v: net }];
    const lines = [...rev.map((x) => (x.v >= 0 ? { acct: x.acct, dr: x.v, memo: 'Credit memo' } : { acct: x.acct, cr: -x.v, memo: 'Credit memo' }))];
    if (tax) lines.push({ acct: '2300', dr: tax, memo: `Sales tax ${inv.taxCode}` });
    lines.push({ acct: '1100', cr: func, memo: c.name });
    const m = { id: nextId('ARCM'), side: 'AR', invoiceId, customerId: c.id, date, amount: func, net, tax, reason: String(reason).trim(), currency: inv.currency || FUNCTIONAL, returns: ret, createdBy: S.user };
    if (fx) m.fxAmount = amount;
    const j = createJournal({ date, source: 'Receivables', desc: `Credit memo ${m.id} on ${invoiceId} (${c.name}): ${m.reason}`, ref: m.id, lines });
    m.journal = j.id;
    if (ret.length) {
      const value = r2(sum(ret, (r) => r.qty * r.unitCost));
      const jr = createJournal({ date, source: 'Inventory', desc: `Customer return ${m.id} to stock (${inv.soId})`, ref: m.id, lines: [{ acct: '1200', dr: value }, { acct: '5000', cr: value }] });
      m.returnJournal = jr.id; m.returnValue = value;
      const o = so(inv.soId);
      ret.forEach((r) => {
        const it = item(r.sku);
        it.avgCost = it.onHand > 0 ? r2((it.onHand * it.avgCost + r.qty * r.unitCost) / (it.onHand + r.qty)) : r.unitCost;
        it.onHand += r.qty; o.lines[r.line].returned = (o.lines[r.line].returned || 0) + r.qty;
        invTxn(date, r.sku, 'Customer return', r.qty, r.unitCost, m.id);
      });
      inventoryTrueUp(date, m.id, '5000');
    }
    inv.credited = r2((inv.credited || 0) + func); if (fx) inv.fxCredited = r2((inv.fxCredited || 0) + amount);
    (inv.memos = inv.memos || []).push(m.id); settleStatus(inv, 'AR');
    S.creditMemos.push(m); log('Issued credit memo', m.id, `${c.name} ${money(func)} on ${invoiceId}`); return m;
  }
  /** createAPCreditMemo({invoiceId, date, amount, reason}) — supplier credit (price adjustment) on a validated, unpaid invoice.
   *  amount in the invoice currency, <= open. Dr 2000; Cr 5100 for PO invoices, or the original line accounts (pro rata) for direct invoices. */
  function createAPCreditMemo({ invoiceId, date, amount, reason }) {
    const inv = need(apinv(invoiceId), 'Invoice'); const s = sup(inv.supplierId);
    if (inv.status !== 'Validated') fail(`Only validated, unpaid invoices can be credited. ${invoiceId} is ${inv.status}.`);
    if (!String(reason || '').trim()) fail('Give a reason for the credit memo.');
    assertOpen(date); if (date < inv.date) fail('A credit memo cannot be dated before its invoice.');
    amount = r2(+amount); const openF = fxOpen(inv);
    if (!(amount > 0) || !Number.isFinite(amount)) fail('Enter a credit amount greater than zero.');
    if (amount > openF + 0.001) fail(`Credit ${ccyAmt(amount, inv.currency)} is more than the open balance ${ccyAmt(openF, inv.currency)}.`);
    const func = relieveFor(inv, amount);
    const cr = inv.poId ? [{ acct: '5100', v: func }] : alloc(func, inv.lines.map((l) => l.amount)).map((v, k) => ({ acct: inv.lines[k].acct, v }));
    const lines = [{ acct: '2000', dr: func, memo: s.name }, ...cr.map((x) => (x.v >= 0 ? { acct: x.acct, cr: x.v, memo: 'Supplier credit' } : { acct: x.acct, dr: -x.v, memo: 'Supplier credit' }))];
    const m = { id: nextId('APCM'), side: 'AP', invoiceId, supplierId: s.id, date, amount: func, reason: String(reason).trim(), currency: inv.currency || FUNCTIONAL, createdBy: S.user };
    if (isFx(inv)) m.fxAmount = amount;
    const j = createJournal({ date, source: 'Payables', desc: `Supplier credit memo ${m.id} on ${inv.number} (${s.name}): ${m.reason}`, ref: m.id, lines });
    m.journal = j.id;
    inv.credited = r2((inv.credited || 0) + func); if (isFx(inv)) inv.fxCredited = r2((inv.fxCredited || 0) + amount);
    (inv.memos = inv.memos || []).push(m.id); settleStatus(inv, 'AP');
    S.creditMemos.push(m); log('Recorded supplier credit memo', m.id, `${s.name} ${money(func)} on ${invoiceId}`); return m;
  }

  // ---------- order to cash ----------
  const openAR = (custId) => sum(S.arInvoices.filter((i) => i.customerId === custId && i.status !== 'Paid'), (i) => openAmt(i));
  /** Order value including the customer's sales tax (what credit exposure counts). */
  const soGross = (o) => r2(o.total * (1 + taxRate(cust(o.customerId)?.taxCode)));
  const openOrders = (custId) => sum(S.sos.filter((o) => o.customerId === custId && (o.status === 'Booked')), (o) => soGross(o));
  /** createSO({customerId, date, lines:[{sku, qty, price}], poNumber}) — credit check */
  function createSO({ customerId, date, lines, poNumber = '' }) {
    const c = need(cust(customerId), 'Customer'); if (!isDate(date)) fail('Enter a valid order date.');
    lines = (lines || []).filter((l) => l.sku && +l.qty > 0).map((l) => ({ sku: l.sku, qty: +l.qty, price: (l.price === '' || l.price == null) ? r2(item(l.sku)?.price) : r2(+l.price) }));
    if (!lines.length) fail('Add at least one item with a quantity.');
    lines.forEach((l) => { need(item(l.sku), `Item ${l.sku}`); if (!Number.isInteger(l.qty)) fail('Quantities must be whole numbers.'); if (!(l.price > 0) || !Number.isFinite(l.price)) fail(`Enter a price greater than zero for ${l.sku}.`); });
    const seen = new Set(); for (const l of lines) { if (seen.has(l.sku)) fail(`${l.sku} is on the order twice. Combine it into one line.`); seen.add(l.sku); }
    const total = sum(lines, (l) => l.qty * l.price);
    const exposure = r2(openAR(c.id) + openOrders(c.id) + total * (1 + taxRate(c.taxCode)));
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
    assertOpen(date);
    const need2 = {}; o.lines.forEach((l) => (need2[l.sku] = (need2[l.sku] || 0) + l.qty));
    const short = o.lines.filter((l) => item(l.sku).onHand < need2[l.sku]);
    if (short.length) fail('Not enough stock: ' + short.map((l) => `${l.sku} needs ${l.qty}, ${item(l.sku).onHand} on hand`).join('; ') + '. Receive a purchase order first.');
    let cogs = 0;
    o.lines.forEach((l) => { l.unitCost = item(l.sku).avgCost; cogs += l.qty * l.unitCost; });
    cogs = r2(cogs);
    const c = cust(o.customerId);
    const j1 = createJournal({ date, source: 'Shipping', desc: `Cost of goods shipped ${id} (${c.name})`, ref: id, lines: [{ acct: '5000', dr: cogs }, { acct: '1200', cr: cogs }] });
    o.lines.forEach((l) => { const it = item(l.sku); it.onHand -= l.qty; invTxn(date, l.sku, 'Shipment', -l.qty, l.unitCost, id); });
    const tRate = taxRate(c.taxCode), tax = r2(o.total * tRate), gross = r2(o.total + tax);
    if (tax) ensureCoreAccounts();
    const inv = { id: nextId('ARINV'), customerId: c.id, soId: id, date, due: addDays(date, c.terms), net: o.total, tax, taxCode: c.taxCode || '', taxRate: tRate, total: gross, paid: 0, credited: 0, currency: FUNCTIONAL, rate: 1, status: 'Open' };
    const l2 = [{ acct: '1100', dr: gross }, { acct: '4000', cr: o.total }]; if (tax) l2.push({ acct: '2300', cr: tax, memo: `Sales tax ${c.taxCode}` });
    const j2 = createJournal({ date, source: 'Receivables', desc: `Invoice ${inv.id} for ${id} (${c.name})`, ref: inv.id, lines: l2 });
    inv.journal = j2.id; S.arInvoices.push(inv);
    o.status = 'Invoiced'; o.shipDate = date; o.invoiceId = inv.id; o.cogsJournal = j1.id; o.margin = r2(o.total - cogs); o.tax = tax;
    log('Shipped and invoiced', id, `${inv.id} ${money(gross)}`); return inv;
  }
  /** applyReceipt({invoiceId, date, amount, reference}) — amount is in the invoice currency.
   *  Foreign invoices: cash = amount x the receipt date's rate; the difference to the carrying amount
   *  relieved posts to 7100 Realized FX gain/loss. receipt.amount is the USD cash received. */
  function applyReceipt({ invoiceId, date, amount, reference = '' }) {
    const inv = need(arinv(invoiceId), 'Invoice'); amount = r2(+amount);
    if (inv.status === 'Paid') fail(`${invoiceId} is already paid.`);
    if (inv.status === 'Credited') fail(`${invoiceId} was fully credited and has nothing to collect.`);
    const open = fxOpen(inv);
    if (!(amount > 0) || !Number.isFinite(amount)) fail('Enter a receipt amount greater than zero.');
    if (amount > open + 0.001) fail(`Receipt ${ccyAmt(amount, inv.currency)} is more than the open balance ${ccyAmt(open, inv.currency)}.`);
    assertOpen(date);
    const fx = isFx(inv), rate = fx ? fxRate(inv.currency, date) : 1;
    const relieved = fx ? relieveFor(inv, amount) : amount, cash = fx ? r2(amount * rate) : amount, gain = r2(cash - relieved);
    const c = cust(inv.customerId);
    const lines = [{ acct: '1000', dr: cash }, { acct: '1100', cr: relieved }];
    if (gain) { ensureCoreAccounts(); lines.push(gain > 0 ? { acct: '7100', cr: gain, memo: 'Realized FX gain' } : { acct: '7100', dr: -gain, memo: 'Realized FX loss' }); }
    const j = createJournal({ date, source: 'Receivables', desc: `Receipt from ${c.name} on ${invoiceId}${fx ? ` ${ccyAmt(amount, inv.currency)} @ ${rate}` : ''}${reference ? ' ref ' + reference : ''}`, ref: invoiceId, lines });
    const rc = { id: nextId('RCPT'), customerId: c.id, invoiceId, date, amount: cash, reference, journal: j.id };
    if (fx) Object.assign(rc, { currency: inv.currency, fxAmount: amount, rate, carrying: relieved, fxGainLoss: gain });
    S.receipts.push(rc); inv.paid = r2(inv.paid + relieved); if (fx) inv.fxPaid = r2((inv.fxPaid || 0) + amount);
    settleStatus(inv, 'AR');
    log('Applied customer receipt', rc.id, `${c.name} ${money(cash)}`); return rc;
  }
  function arAging(asOf = S.today) {
    const buckets = ['Current', '1-30', '31-60', '61-90', '90+'];
    const rows = S.customers.map((c) => {
      const r = { customerId: c.id, name: c.name, total: 0 }; buckets.forEach((b) => (r[b] = 0));
      S.arInvoices.filter((i) => i.customerId === c.id && i.status !== 'Paid').forEach((i) => {
        const late = daysBetween(i.due, asOf), open = openAmt(i);
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
    S.absences.filter((a) => a.status === 'Pending' && a.approverId === id).forEach((a) => (a.approverId = e.managerId));
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
    hooks.approvals.forEach((f) => out.push(...f()));
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
  function closeChecklist(p) {
    const pend = S.journals.filter((j) => j.period === p && j.status === 'Pending Approval').length;
    const holds = S.apInvoices.filter((i) => i.status === 'On Hold' && periodOf(i.date) <= p).length;
    const rec = reconcile().every((r) => r.ok);
    const unreceived = S.pos.filter((x) => ['Open', 'Partially Received'].includes(x.status) && periodOf(x.date) <= p).length;
    return [
      { task: 'Payroll run', done: S.payruns.some((r) => r.period === p), detail: S.payruns.find((r) => r.period === p)?.id || 'Not run yet' },
      { task: 'Depreciation posted', done: !!S.depreciationRuns[p], detail: S.depreciationRuns[p] || 'Not posted yet' },
      { task: 'Journals approved', done: !pend, detail: pend ? `${pend} awaiting approval` : 'None pending' },
      { task: 'Invoice holds resolved', done: !holds, detail: holds ? `${holds} on hold` : 'No holds' },
      { task: 'Open receipts reviewed', done: !unreceived, detail: unreceived ? `${unreceived} PO(s) not fully received` : 'All received', advisory: true },
      { task: 'Subledgers reconcile to GL', done: rec, detail: rec ? 'AP, AR, inventory, accrual tie out' : 'Differences found' },
      recurringCheck(p),
      { task: 'Foreign-currency open items reviewed', done: !fxOpenItems().length, advisory: true, detail: fxOpenItems().length ? `${fxOpenItems().length} open EUR/GBP invoice(s) carried at booking rates; unrealized revaluation is not posted` : 'No open foreign-currency items' },
      salesTaxCheck(p),
      ...hooks.checklist.flatMap((f) => f(p)),
      { task: 'Period closed', done: S.periods[p] === 'Closed', detail: S.periods[p] },
    ];
  }
  function recurringCheck(p) {
    const due = S.recurring.filter((t) => t.active && t.startPeriod <= p && !t.generated[p]);
    return { task: 'Recurring journals generated', done: !due.length, advisory: true, detail: due.length ? `${due.map((t) => t.name).join(', ')} not generated` : 'All templates generated' };
  }
  const fxOpenItems = () => [...S.apInvoices.filter((i) => i.status === 'Validated'), ...S.arInvoices.filter((i) => i.status !== 'Paid' && i.status !== 'Credited')].filter((i) => isFx(i) && openAmt(i) > 0);
  function salesTaxCheck(p) {
    const prev = Object.keys(S.periods).sort().filter((x) => x < p).pop();
    if (!prev) return { task: 'Prior month sales tax remitted', done: true, advisory: true, detail: 'No prior period' };
    const due = salesTaxDue(prev), rem = S.taxRemits.find((r) => r.period === prev);
    return { task: 'Prior month sales tax remitted', done: !!rem || due <= 0, advisory: true, detail: rem ? `${periodLabel(prev)} remitted (${rem.journal})` : due > 0 ? `${periodLabel(prev)}: ${money(due)} due` : `Nothing due for ${periodLabel(prev)}` };
  }

  // ---------- sales tax ----------
  /** salesTaxReport() -> rows [{period, code, name, rate, taxable, tax, creditTaxable, creditTax, netTax}] for periods with activity. */
  function salesTaxReport() {
    const m = new Map();
    const row = (p, code) => { const k = p + '|' + code; if (!m.has(k)) { const t = taxCode(code); m.set(k, { period: p, code, name: t ? t.name : 'No tax code', rate: t ? t.rate : 0, taxable: 0, tax: 0, creditTaxable: 0, creditTax: 0, netTax: 0, invoices: 0 }); } return m.get(k); };
    S.arInvoices.forEach((i) => { if (i.net == null) return; const r = row(periodOf(i.date), i.taxCode || ''); r.taxable = r2(r.taxable + i.net); r.tax = r2(r.tax + (i.tax || 0)); r.invoices++; });
    S.creditMemos.filter((x) => x.side === 'AR').forEach((x) => { const i = arinv(x.invoiceId); const r = row(periodOf(x.date), i.taxCode || ''); r.creditTaxable = r2(r.creditTaxable + x.net); r.creditTax = r2(r.creditTax + x.tax); });
    return [...m.values()].map((r) => ({ ...r, netTax: r2(r.tax - r.creditTax) })).sort((a, b) => a.period.localeCompare(b.period) || a.code.localeCompare(b.code));
  }
  const salesTaxDue = (p) => sum(salesTaxReport().filter((r) => r.period === p), (r) => r.netTax);
  /** remitSalesTax({period, date, reference}) — pays the period's net sales tax: Dr 2300 / Cr 1000. Once per period, after it ends. */
  function remitSalesTax({ period, date, reference = '' }) {
    if (!S.periods[period]) fail('Choose a period inside the FY2027 calendar.');
    const done = S.taxRemits.find((r) => r.period === period); if (done) fail(`Sales tax for ${periodLabel(period)} was already remitted (${done.journal}).`);
    if (!isDate(date)) fail('Enter a valid remittance date.');
    if (date <= periodEnd(period)) fail(`Remit ${periodLabel(period)} sales tax after the period ends (on or after ${addDays(periodEnd(period), 1)}).`);
    assertOpen(date);
    const amt = salesTaxDue(period); if (!(amt > 0)) fail(`No sales tax is due for ${periodLabel(period)}.`);
    const cash = balance('1000'); if (amt > cash) fail(`Remittance of ${money(amt)} exceeds operating cash of ${money(cash)}.`);
    ensureCoreAccounts();
    const id = nextId('STX');
    const j = createJournal({ date, source: 'Tax', desc: `Sales tax remittance ${periodLabel(period)}${reference ? ' ref ' + reference : ''}`, ref: id, lines: [{ acct: '2300', dr: amt }, { acct: '1000', cr: amt }] });
    const r = { id, period, date, amount: amt, reference, journal: j.id }; S.taxRemits.push(r);
    log('Remitted sales tax', id, `${periodLabel(period)} ${money(amt)}`); return r;
  }

  /** Subledger-to-GL reconciliation for the four control accounts. */
  function reconcile() {
    const b = balances();
    const rows = [
      { name: 'Accounts payable', acct: '2000', sub: sum(S.apInvoices.filter((i) => i.status === 'Validated'), (i) => openAmt(i)), gl: -b['2000'] },
      { name: 'Accounts receivable', acct: '1100', sub: sum(S.arInvoices.filter((i) => i.status !== 'Paid'), (i) => openAmt(i)), gl: b['1100'] },
      { name: 'Inventory', acct: '1200', sub: sum(S.items, (i) => i.onHand * i.avgCost), gl: b['1200'] },
      { name: 'Received not invoiced', acct: '2100', sub: sum(S.pos.flatMap((p) => p.lines), (l) => (l.received - l.invoiced) * l.price), gl: -b['2100'] },
    ];
    hooks.reconcile.forEach((f) => rows.push(...f(b)));
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
    S.creditMemos.forEach((m) => hit(m.id, m.reason) && out.push({ kind: 'cm', id: m.id, label: m.id, sub: `${m.side === 'AR' ? cust(m.customerId)?.name : sup(m.supplierId)?.name} credit memo, ${m.reason}` }));
    S.recurring.forEach((t) => hit(t.id, t.name) && out.push({ kind: 'rj', id: t.id, label: t.name, sub: `Recurring journal ${t.id}` }));
    S.reqs.forEach((r) => hit(r.id, r.requester) && out.push({ kind: 'req', id: r.id, label: r.id, sub: `${r.requester}, ${r.status}` }));
    hooks.search.forEach((f) => out.push(...f(q, hit)));
    return out.slice(0, 30);
  }

  const Engine = {
    TODAY, FY_START, STATE_VERSION, FUNCTIONAL, ROLE_USERS, REQ_APPROVAL_LIMIT, JE_APPROVAL_LIMIT, PRICE_TOLERANCE, WITHHOLDING_RATE, EMPLOYER_TAX_RATE, DEPRECIATION_MONTHS, ROLES,
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
    createAPInvoice, createARInvoice,
    taxCode, taxRate, currency, fxRate, setFxRate, isFx, openAmt, fxOpen, ccyAmt, soGross,
    creditMemo, createARCreditMemo, createAPCreditMemo, salesTaxReport, salesTaxDue, remitSalesTax,
    reverseJournal, processAutoReversals, nextPeriod, recurring, createRecurring, recurringFromJournal, generateRecurring, setRecurringActive,
    hooks, on, addPerms, touch, ensureAccount, need, fail,
    /** Add or replace engine functions from an extension module. */
    extend(obj) { Object.keys(obj).forEach((k) => { Engine[k] = obj[k]; }); return Engine; },
  };
  // getter/setter on S don't survive object literal spread; define explicitly
  Object.defineProperty(Engine, 'S', { get: () => S, set: (v) => { S = v; }, enumerable: true });
  reset();
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine; else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
