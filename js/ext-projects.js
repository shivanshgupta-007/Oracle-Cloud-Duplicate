/* Ledgerline Suite — ext-projects.js
 * Project financials: projects, weekly timesheets, expense reports, reimbursement,
 * project billing (time and materials, fixed price), budget vs actual. No DOM.
 *
 * GL effects (all via E.createJournal / E.createARInvoice):
 *   Timesheet approved   Dr 5200 Cost of services (customer projects) / Dr 6700 R&D labor (internal)
 *                        Cr 6000 Salaries and wages (reclass: payroll already expensed the wages)
 *   Expense approved     Dr 6500/6510/6520/6530/6400 per line / Cr 2150 Employee reimbursements payable
 *   Reimbursement batch  Dr 2150 / Cr 1000
 *   Project invoice      Dr 1100 / Cr 4100 Service revenue (E.createARInvoice, source 'Projects', ref project id)
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { r2, sum, money, periodOf, periodEnd, periodLabel, addDays, isDate } = E.util;
  const fail = E.fail;
  const S = () => E.S;

  const STANDARD_HOURS = 2080;
  const EXPENSE_MARKUP = 0.10;
  const MEALS_DAILY_LIMIT = 75;
  const RECEIPT_THRESHOLD = 25;
  const PROJECT_TYPES = ['Time and materials', 'Fixed price', 'Internal'];
  const COST_TYPES = ['Labor', 'Expenses', 'Materials'];
  const EXPENSE_CATEGORIES = { Travel: '6500', Meals: '6510', Lodging: '6520', Supplies: '6400', Mileage: '6530' };
  const DEFAULT_RATES = { Engineering: 210, Operations: 140, default: 175 };
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const ACCOUNTS = [['2150', 'Employee reimbursements payable', 'Liability'], ['4100', 'Service revenue', 'Revenue'],
    ['5200', 'Cost of services', 'Expense'], ['6510', 'Meals and entertainment', 'Expense'], ['6520', 'Lodging', 'Expense'],
    ['6530', 'Mileage', 'Expense'], ['6700', 'R&D labor', 'Expense']];
  const ROLE_PERMS = { 'Controller': ['prj.approve', 'prj.bill', 'prj.edit', 'exp.reimburse'] };
  const EVERYONE = ['prj.time', 'exp.submit'];

  function grantPerms() {
    Object.keys(E.ROLES).forEach((r) => E.addPerms(r, EVERYONE));
    Object.keys(ROLE_PERMS).forEach((r) => E.addPerms(r, ROLE_PERMS[r]));
  }
  grantPerms();

  // ---------- state ----------
  E.on('state', (st) => {
    st.projects = st.projects || []; st.timesheets = st.timesheets || []; st.expenseReports = st.expenseReports || []; st.reimbursements = st.reimbursements || [];
    // loaded state from before this module existed: add its accounts directly (ensureAccount works on the live state only)
    if (st.accounts && st.accounts.length) {
      let added = false;
      ACCOUNTS.forEach(([code, name, type]) => { if (!st.accounts.some((a) => a.code === code)) { st.accounts.push({ code, name, type, active: true }); added = true; } });
      if (added) st.accounts.sort((a, b) => a.code.localeCompare(b.code));
    }
    grantPerms(); // roles added by modules that load after this one
  });
  function ensureAccounts() { ACCOUNTS.forEach(([c, n, t]) => E.ensureAccount(c, n, t)); }

  // ---------- lookups and helpers ----------
  const project = (id) => S().projects.find((p) => p.id === id);
  const timesheet = (id) => S().timesheets.find((t) => t.id === id);
  const expenseReport = (id) => S().expenseReports.find((x) => x.id === id);
  const reimbursement = (id) => S().reimbursements.find((x) => x.id === id);
  const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
  const mondayOf = (d) => addDays(d, -((dow(d) + 6) % 7));
  const weekEnd = (ws) => addDays(ws, 4);
  const today = () => S()._date || S().today;
  const isBillableProject = (p) => p.type !== 'Internal';
  /** Fully loaded hourly cost: salary / 2080 x (1 + employer tax). */
  const costRate = (e) => r2(e.salary / STANDARD_HOURS * (1 + E.EMPLOYER_TAX_RATE));
  const billRate = (p, e) => { const r = p.rates || DEFAULT_RATES; return +(r[e.dept] ?? r.default ?? DEFAULT_RATES.default); };
  const lineHours = (l) => r2(l.hours.reduce((a, h) => a + (+h || 0), 0));
  const tsHours = (t) => sum(t.lines, lineHours);
  /** Accounting date for a document: its own date when that period is open, else the action date. */
  function postDate(docDate) { return S().periods[periodOf(docDate)] === 'Open' ? docDate : today(); }
  const empName = (id) => E.emp(id)?.name || id;

  // ---------- projects ----------
  /** createProject({name, customerId, type, managerId, start, end, contractValue, budget:{Labor,Expenses,Materials}, tasks:[{name, billable}], rates:{Engineering, Operations, default}, milestones:[{name, pct}]}) */
  function createProject({ name, customerId = '', type, managerId, start, end, contractValue = 0, budget = {}, tasks = [], rates, milestones = [] }) {
    ensureAccounts();
    name = String(name || '').trim(); if (!name) fail('Project name is required.');
    if (!PROJECT_TYPES.includes(type)) fail('Choose a project type: Time and materials, Fixed price or Internal.');
    if (type !== 'Internal') E.need(E.cust(customerId), 'Customer'); else customerId = '';
    const mgr = E.need(E.emp(managerId), 'Project manager'); if (mgr.status !== 'Active') fail(`${mgr.name} is not active.`);
    if (!isDate(start) || !isDate(end) || end < start) fail('Enter valid start and end dates (end on or after start).');
    if (S().projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail(`A project named "${name}" already exists.`);
    contractValue = r2(+contractValue || 0);
    if (type === 'Fixed price' && !(contractValue > 0)) fail('A fixed price project needs a contract value greater than zero.');
    const b = {}; COST_TYPES.forEach((k) => { b[k] = r2(+budget[k] || 0); if (b[k] < 0 || !Number.isFinite(b[k])) fail(`${k} budget cannot be negative.`); });
    if (!(sum(COST_TYPES, (k) => b[k]) > 0)) fail('Enter a budget for at least one cost type.');
    tasks = (tasks || []).filter((t) => String(t.name || '').trim());
    if (!tasks.length) fail('Add at least one task.');
    const rt = { ...DEFAULT_RATES, ...(rates || {}) }; Object.keys(rt).forEach((k) => { rt[k] = r2(+rt[k] || 0); if (!(rt[k] >= 0)) fail('Bill rates cannot be negative.'); });
    const ms = (milestones || []).filter((m) => String(m.name || '').trim() && +m.pct > 0).map((m, i) => ({ id: `M${i + 1}`, name: String(m.name).trim(), pct: r2(+m.pct), invoiceId: '' }));
    if (sum(ms, (m) => m.pct) > 100.001) fail('Milestone percentages cannot add up to more than 100%.');
    const id = E.nextId('PRJ');
    const p = { id, name, customerId, type, managerId, start, end, status: 'Active', contractValue: type === 'Fixed price' ? contractValue : 0, budget: b,
      tasks: tasks.map((t, i) => ({ id: `T${i + 1}`, name: String(t.name).trim(), billable: type === 'Internal' ? false : (t.billable === undefined ? true : t.billable === true || t.billable === 'Yes' || t.billable === 'true') })),
      rates: rt, milestones: ms, created: today() };
    S().projects.push(p); E.log('Created project', id, `${name} (${type})`); return p;
  }
  function closeProject(id) {
    const p = E.need(project(id), 'Project'); if (p.status !== 'Active') fail(`${id} is already closed.`);
    if (S().timesheets.some((t) => t.status === 'Submitted' && t.lines.some((l) => l.projectId === id))) fail(`${id} has timesheets awaiting approval.`);
    p.status = 'Closed'; p.closed = today(); E.log('Closed project', id); return p;
  }

  // ---------- timesheets ----------
  /** createTimesheet({empId, weekStart (a Monday), lines:[{projectId, taskId, hours:[Mon..Fri]}], submit=true}) */
  function createTimesheet({ empId, weekStart, lines, submit = true, note = '' }) {
    const e = E.need(E.emp(empId), 'Employee'); if (e.status !== 'Active') fail(`${e.name} is not active.`);
    if (!isDate(weekStart)) fail('Choose the week (its Monday).');
    if (dow(weekStart) !== 1) fail('A timesheet week starts on a Monday.');
    if (weekStart > S().today) fail('You cannot enter time for a future week.');
    const dup = S().timesheets.find((t) => t.empId === empId && t.weekStart === weekStart && t.status !== 'Rejected');
    if (dup) fail(`${e.name} already has timesheet ${dup.id} for the week of ${weekStart}.`);
    const out = [];
    for (const l of lines || []) {
      const hours = DAYS.map((_, i) => { const v = l.hours?.[i]; return v === '' || v == null ? 0 : +v; });
      if (hours.some((h) => !Number.isFinite(h) || h < 0 || h > 24)) fail('Hours per day must be between 0 and 24.');
      if (!hours.some((h) => h > 0)) continue;
      const p = E.need(project(l.projectId), `Project ${l.projectId || ''}`.trim());
      if (p.status !== 'Active') fail(`${p.id} is closed to new time.`);
      const t = p.tasks.find((x) => x.id === l.taskId); if (!t) fail(`Choose a task on ${p.id}.`);
      if (weekEnd(weekStart) < p.start || weekStart > p.end) fail(`${p.id} runs ${p.start} to ${p.end}; this week is outside it.`);
      if (out.some((x) => x.projectId === p.id && x.taskId === t.id)) fail(`${p.id} ${t.name} is on the timesheet twice. Combine the rows.`);
      out.push({ projectId: p.id, taskId: t.id, hours: hours.map(r2), billable: p.type === 'Time and materials' && t.billable, costRate: 0, cost: 0, billRate: billRate(p, e), invoiceId: '' });
    }
    if (!out.length) fail('Enter hours on at least one project task.');
    const daily = DAYS.map((_, i) => sum(out, (l) => l.hours[i]));
    if (daily.some((h) => h > 24)) fail('More than 24 hours entered on one day.');
    const ts = { id: E.nextId('TS'), empId, weekStart, lines: out, hours: sum(out, lineHours), status: submit ? 'Submitted' : 'Draft', approverId: e.managerId, note, created: today(), submitted: submit ? today() : '' };
    S().timesheets.push(ts); E.log(submit ? 'Submitted timesheet' : 'Saved timesheet', ts.id, `${e.name}, week of ${weekStart}, ${ts.hours} h`); return ts;
  }
  function submitTimesheet(id) {
    const t = E.need(timesheet(id), 'Timesheet'); if (t.status !== 'Draft') fail(`${id} is ${t.status}, not a draft.`);
    t.status = 'Submitted'; t.submitted = today(); E.log('Submitted timesheet', id); return t;
  }
  /** Approve: freezes cost on each line and posts the labor reclass. */
  function approveTimesheet(id) {
    const t = E.need(timesheet(id), 'Timesheet'); if (t.status !== 'Submitted') fail(`${id} is not awaiting approval.`);
    const e = E.need(E.emp(t.empId), 'Employee');
    if (e.name === S().user && S().role !== 'Administrator') fail('You cannot approve your own timesheet.');
    ensureAccounts();
    const rate = costRate(e);
    const costs = t.lines.map((l) => r2(lineHours(l) * rate));
    const toServices = sum(t.lines.filter((l) => isBillableProject(project(l.projectId))), (l) => costs[t.lines.indexOf(l)]);
    const toRnd = sum(t.lines.filter((l) => !isBillableProject(project(l.projectId))), (l) => costs[t.lines.indexOf(l)]);
    const total = r2(toServices + toRnd);
    const date = postDate(weekEnd(t.weekStart) <= periodEnd(periodOf(t.weekStart)) ? weekEnd(t.weekStart) : periodEnd(periodOf(t.weekStart)));
    const j = E.createJournal({ date, source: 'Projects', ref: t.id, desc: `Labor cost reclass ${t.id}: ${e.name}, week of ${t.weekStart} (${tsHours(t)} h @ ${money(rate)})`, lines: [
      { acct: '5200', dr: toServices, memo: 'Customer project labor' }, { acct: '6700', dr: toRnd, memo: 'Internal project labor' },
      { acct: '6000', cr: total, memo: `Reallocate ${e.name} wages to projects` }] });
    t.lines.forEach((l, i) => { l.costRate = rate; l.cost = costs[i]; });
    t.cost = total; t.status = 'Approved'; t.approvedBy = S().user; t.approved = today(); t.journal = j.id;
    E.log('Approved timesheet', id, `${e.name} ${tsHours(t)} h, cost ${money(total)}`); return t;
  }
  function rejectTimesheet(id, reason) {
    const t = E.need(timesheet(id), 'Timesheet'); if (t.status !== 'Submitted') fail(`${id} is not awaiting approval.`);
    t.status = 'Rejected'; t.rejectReason = reason || ''; t.decidedBy = S().user; E.log('Rejected timesheet', id, reason); return t;
  }

  // ---------- expense reports ----------
  /** Policy flags for a set of lines of one employee: meals over the daily limit, missing receipts. Returns per-line arrays of messages. */
  function policyCheck(lines) {
    const meals = {}; lines.forEach((l) => { if (l.category === 'Meals') meals[l.date] = r2((meals[l.date] || 0) + (+l.amount || 0)); });
    return lines.map((l) => {
      const f = [];
      if (l.category === 'Meals' && meals[l.date] > MEALS_DAILY_LIMIT) f.push(`Meals ${money(meals[l.date])} on ${l.date} exceed the ${money(MEALS_DAILY_LIMIT)} daily limit`);
      if ((+l.amount || 0) > RECEIPT_THRESHOLD && !l.receipt) f.push(`Receipt required over ${money(RECEIPT_THRESHOLD)}`);
      return f;
    });
  }
  const truthy = (v) => v === true || v === 'Yes' || v === 'yes' || v === 'true' || v === 1 || v === '1';
  /** createExpenseReport({empId, purpose, date, lines:[{date, category, amount, projectId, billable, receipt}], submit=true}) */
  function createExpenseReport({ empId, purpose = '', date, lines, submit = true }) {
    const e = E.need(E.emp(empId), 'Employee'); if (e.status !== 'Active') fail(`${e.name} is not active.`);
    purpose = String(purpose || '').trim(); if (!purpose) fail('Describe the business purpose of the report.');
    date = date || today(); if (!isDate(date)) fail('Enter a valid report date.');
    const out = [];
    for (const l of lines || []) {
      if (!l.category && !(+l.amount)) continue;
      const acct = EXPENSE_CATEGORIES[l.category]; if (!acct) fail('Choose a category for every line: ' + Object.keys(EXPENSE_CATEGORIES).join(', ') + '.');
      if (!isDate(l.date)) fail('Enter a valid date (YYYY-MM-DD) on every line.');
      if (l.date > date) fail(`Line dated ${l.date} is after the report date.`);
      const amount = r2(+l.amount); if (!(amount > 0) || !Number.isFinite(amount)) fail('Every line needs an amount greater than zero.');
      let projectId = l.projectId || '';
      if (projectId) { const p = E.need(project(projectId), 'Project'); if (p.status !== 'Active') fail(`${p.id} is closed.`); }
      const billable = !!projectId && truthy(l.billable) && project(projectId).type === 'Time and materials';
      out.push({ date: l.date, category: l.category, acct, amount, projectId, billable, receipt: truthy(l.receipt), desc: String(l.desc || '').trim(), invoiceId: '' });
    }
    if (!out.length) fail('Add at least one expense line.');
    const flags = policyCheck(out); out.forEach((l, i) => (l.flags = flags[i]));
    const x = { id: E.nextId('EXP'), empId, purpose, date, lines: out, total: sum(out, (l) => l.amount), status: submit ? 'Submitted' : 'Draft', approverId: e.managerId,
      violations: flags.flat().length, created: today(), submitted: submit ? today() : '' };
    S().expenseReports.push(x); E.log(submit ? 'Submitted expense report' : 'Saved expense report', x.id, `${e.name} ${money(x.total)}${x.violations ? `, ${x.violations} policy flag(s)` : ''}`); return x;
  }
  function submitExpenseReport(id) { const x = E.need(expenseReport(id), 'Expense report'); if (x.status !== 'Draft') fail(`${id} is ${x.status}, not a draft.`); x.status = 'Submitted'; x.submitted = today(); E.log('Submitted expense report', id); return x; }
  function approveExpenseReport(id) {
    const x = E.need(expenseReport(id), 'Expense report'); if (x.status !== 'Submitted') fail(`${id} is not awaiting approval.`);
    const e = E.emp(x.empId); if (e && e.name === S().user && S().role !== 'Administrator') fail('You cannot approve your own expense report.');
    ensureAccounts();
    const by = {}; x.lines.forEach((l) => (by[l.acct] = r2((by[l.acct] || 0) + l.amount)));
    const j = E.createJournal({ date: postDate(x.date), source: 'Expenses', ref: x.id, desc: `Expense report ${x.id}: ${empName(x.empId)}, ${x.purpose}`, lines: [
      ...Object.keys(by).sort().map((a) => ({ acct: a, dr: by[a] })), { acct: '2150', cr: x.total, memo: `Owed to ${empName(x.empId)}` }] });
    x.status = 'Approved'; x.approvedBy = S().user; x.approved = today(); x.journal = j.id;
    E.log('Approved expense report', id, `${empName(x.empId)} ${money(x.total)}`); return x;
  }
  function rejectExpenseReport(id, reason) {
    const x = E.need(expenseReport(id), 'Expense report'); if (x.status !== 'Submitted') fail(`${id} is not awaiting approval.`);
    x.status = 'Rejected'; x.rejectReason = reason || ''; x.decidedBy = S().user; E.log('Rejected expense report', id, reason); return x;
  }
  /** reimburseExpenses(ids | null for all approved, date) -> batch. Dr 2150 / Cr 1000. */
  function reimburseExpenses(ids, date) {
    date = date || today(); E.assertOpen(date);
    const list = (ids && ids.length ? [...new Set(ids)].map((id) => E.need(expenseReport(id), `Expense report ${id}`)) : S().expenseReports.filter((x) => x.status === 'Approved'));
    if (!list.length) fail('There are no approved expense reports waiting for reimbursement.');
    list.forEach((x) => { if (x.status !== 'Approved') fail(`${x.id} is ${x.status} and cannot be reimbursed.`); });
    const total = sum(list, (x) => x.total);
    const cash = E.balance('1000'); if (total > cash) fail(`Reimbursement of ${money(total)} exceeds operating cash of ${money(cash)}.`);
    const id = E.nextId('REIMB');
    const j = E.createJournal({ date, source: 'Expenses', ref: id, desc: `Employee expense reimbursement ${id} (${list.length} report${list.length === 1 ? '' : 's'})`, lines: [
      { acct: '2150', dr: total }, { acct: '1000', cr: total, memo: 'ACH to employees' }] });
    const b = { id, date, reports: list.map((x) => x.id), total, journal: j.id, by: S().user };
    list.forEach((x) => { x.status = 'Reimbursed'; x.reimbursement = id; x.reimbursed = date; });
    S().reimbursements.push(b); E.log('Reimbursed employee expenses', id, `${list.length} report(s), ${money(total)}`); return b;
  }

  // ---------- billing ----------
  /** Approved, billable, not yet invoiced work on a T&M project, optionally up to a cut-off date. */
  function unbilled(projectId, through) {
    const p = E.need(project(projectId), 'Project');
    const labor = [], expenses = [];
    if (p.type !== 'Time and materials') return { labor, expenses, laborAmount: 0, expenseAmount: 0, total: 0 };
    S().timesheets.filter((t) => t.status === 'Approved' && (!through || t.weekStart <= through)).forEach((t) => t.lines.forEach((l, i) => {
      if (l.projectId === projectId && l.billable && !l.invoiceId) labor.push({ ts: t, line: l, idx: i, emp: E.emp(t.empId), hours: lineHours(l), rate: l.billRate, amount: r2(lineHours(l) * l.billRate) });
    }));
    S().expenseReports.filter((x) => ['Approved', 'Reimbursed'].includes(x.status)).forEach((x) => x.lines.forEach((l, i) => {
      if (l.projectId === projectId && l.billable && !l.invoiceId && (!through || l.date <= through)) expenses.push({ rep: x, line: l, idx: i, cost: l.amount, amount: r2(l.amount * (1 + EXPENSE_MARKUP)) });
    }));
    const laborAmount = sum(labor, (x) => x.amount), expenseAmount = sum(expenses, (x) => x.amount);
    return { labor, expenses, laborAmount, expenseAmount, total: r2(laborAmount + expenseAmount) };
  }
  /** T&M: invoice all unbilled approved hours (hours x bill rate) and billable expenses (cost + 10%). */
  function generateProjectInvoice(projectId, { date, through } = {}) {
    const p = E.need(project(projectId), 'Project');
    if (p.type !== 'Time and materials') fail(`${p.id} is ${p.type}. Use milestone or percent-complete billing.`);
    date = date || today(); E.assertOpen(date);
    const u = unbilled(projectId, through || date);
    if (!(u.total > 0)) fail(`${p.id} has no unbilled approved time or billable expenses${through ? ' up to ' + through : ''}.`);
    ensureAccounts();
    const groups = new Map();
    u.labor.forEach((x) => { const k = x.emp.id + '|' + x.rate; const g = groups.get(k) || { emp: x.emp, rate: x.rate, hours: 0, amount: 0 }; g.hours = r2(g.hours + x.hours); g.amount = r2(g.amount + x.amount); groups.set(k, g); });
    const cats = new Map(); u.expenses.forEach((x) => cats.set(x.line.category, r2((cats.get(x.line.category) || 0) + x.amount)));
    const lines = [...[...groups.values()].map((g) => ({ acct: '4100', desc: `Labor: ${g.emp.name} (${g.emp.dept}), ${g.hours} h @ ${money(g.rate)}`, amount: g.amount })),
      ...[...cats.entries()].map(([c, a]) => ({ acct: '4100', desc: `Expenses: ${c} at cost + ${EXPENSE_MARKUP * 100}%`, amount: a }))];
    const inv = E.createARInvoice({ customerId: p.customerId, date, lines, source: 'Projects', ref: p.id });
    u.labor.forEach((x) => (x.line.invoiceId = inv.id)); u.expenses.forEach((x) => (x.line.invoiceId = inv.id));
    inv.projectId = p.id; inv.hours = sum(u.labor, (x) => x.hours);
    E.log('Billed project', p.id, `${inv.id} ${money(inv.total)}`); return inv;
  }
  /** Fixed price: bill by percent complete (cost to date / budget) or by an explicit milestone. Never exceeds the contract value. */
  function billFixedPrice(projectId, { date, method = 'percent', milestoneId } = {}) {
    const p = E.need(project(projectId), 'Project');
    if (p.type !== 'Fixed price') fail(`${p.id} is ${p.type}, not fixed price.`);
    date = date || today(); E.assertOpen(date);
    const f = financials(projectId); const remaining = r2(p.contractValue - f.billed);
    if (!(remaining > 0.004)) fail(`${p.id} is fully billed (${money(p.contractValue)}).`);
    let amount, desc, ms;
    if (method === 'milestone') {
      ms = p.milestones.find((m) => m.id === milestoneId); if (!ms) fail('Choose a milestone to bill.');
      if (ms.invoiceId) fail(`Milestone "${ms.name}" was billed on ${ms.invoiceId}.`);
      amount = Math.min(r2(p.contractValue * ms.pct / 100), remaining); desc = `Milestone: ${ms.name} (${ms.pct}% of ${money(p.contractValue)})`;
    } else {
      amount = Math.min(r2(p.contractValue * f.pctComplete - f.billed), remaining);
      desc = `Progress billing: ${(f.pctComplete * 100).toFixed(1)}% complete of ${money(p.contractValue)}, less ${money(f.billed)} billed`;
    }
    amount = r2(amount);
    if (!(amount > 0)) fail(`Nothing to bill: ${money(f.billed)} already billed covers ${(f.pctComplete * 100).toFixed(1)}% complete.`);
    ensureAccounts();
    const inv = E.createARInvoice({ customerId: p.customerId, date, lines: [{ acct: '4100', desc, amount }], source: 'Projects', ref: p.id });
    inv.projectId = p.id; if (ms) ms.invoiceId = inv.id;
    E.log('Billed project', p.id, `${inv.id} ${money(amount)}`); return inv;
  }

  // ---------- project financials ----------
  function financials(projectId) {
    const p = E.need(project(projectId), 'Project');
    const actual = { Labor: 0, Expenses: 0, Materials: 0 };
    let hours = 0, billableHours = 0, pendingHours = 0;
    S().timesheets.forEach((t) => t.lines.forEach((l) => {
      if (l.projectId !== projectId) return;
      if (t.status === 'Approved') { actual.Labor += l.cost; hours += lineHours(l); if (l.billable) billableHours += lineHours(l); }
      else if (t.status === 'Submitted') pendingHours += lineHours(l);
    }));
    S().expenseReports.filter((x) => ['Approved', 'Reimbursed'].includes(x.status)).forEach((x) => x.lines.forEach((l) => { if (l.projectId === projectId) actual.Expenses += l.amount; }));
    S().apInvoices.filter((i) => !['Cancelled', 'On Hold'].includes(i.status)).forEach((i) => (i.lines || []).forEach((l) => { if (l.project === projectId) actual.Materials += +l.amount || 0; }));
    COST_TYPES.forEach((k) => (actual[k] = r2(actual[k])));
    const budgetTotal = sum(COST_TYPES, (k) => p.budget[k] || 0), cost = sum(COST_TYPES, (k) => actual[k]);
    const invoices = S().arInvoices.filter((i) => i.ref === projectId);
    const billed = sum(invoices, (i) => i.total);
    const pctComplete = budgetTotal > 0 ? Math.min(1, cost / budgetTotal) : 0;
    const eac = sum(COST_TYPES, (k) => Math.max(p.budget[k] || 0, actual[k]));
    let unbilledWip = 0;
    if (p.type === 'Time and materials') unbilledWip = unbilled(projectId).total;
    else if (p.type === 'Fixed price') unbilledWip = Math.max(0, r2(Math.min(p.contractValue, p.contractValue * pctComplete) - billed));
    const revenueBasis = p.type === 'Fixed price' ? p.contractValue : 0;
    const margin = p.type === 'Internal' ? r2(-cost) : r2(billed - cost);
    return { budget: { ...p.budget, total: budgetTotal }, actual, cost, billed, invoices, margin, marginPct: billed ? margin / billed : 0, pctComplete, eac,
      variance: r2(budgetTotal - eac), unbilledWip: r2(unbilledWip), hours: r2(hours), billableHours: r2(billableHours), pendingHours: r2(pendingHours),
      remainingContract: p.type === 'Fixed price' ? r2(p.contractValue - billed) : 0, revenueBasis };
  }
  function portfolio() {
    const ps = S().projects.map((p) => ({ p, f: financials(p.id) }));
    const active = ps.filter((x) => x.p.status === 'Active');
    return { count: ps.length, active: active.length, billed: sum(ps, (x) => x.f.billed), cost: sum(ps, (x) => x.f.cost), wip: sum(ps, (x) => x.f.unbilledWip),
      budget: sum(active, (x) => x.f.budget.total), margin: sum(ps.filter((x) => x.p.type !== 'Internal'), (x) => x.f.margin), customerBilled: sum(ps.filter((x) => x.p.type !== 'Internal'), (x) => x.f.billed) };
  }
  const pendingTimesheets = () => S().timesheets.filter((t) => t.status === 'Submitted');
  const pendingExpenses = () => S().expenseReports.filter((x) => x.status === 'Submitted');
  const reimbursable = () => S().expenseReports.filter((x) => x.status === 'Approved');

  // ---------- hooks ----------
  E.on('reconcile', (b) => [{ name: 'Employee reimbursements', acct: '2150', sub: sum(reimbursable(), (x) => x.total), gl: -(b['2150'] || 0) }]);
  E.on('approvals', () => [
    ...pendingTimesheets().map((t) => ({ kind: 'timesheet', id: t.id, title: `Timesheet ${tsHours(t)} h: ${empName(t.empId)}, week of ${t.weekStart}`, who: empName(t.empId), date: t.submitted || t.weekStart, perm: 'prj.approve',
      why: `Project time for manager approval (${[...new Set(t.lines.map((l) => l.projectId))].join(', ')})` })),
    ...pendingExpenses().map((x) => ({ kind: 'expense', id: x.id, title: `Expense report ${money(x.total)}: ${empName(x.empId)}`, who: empName(x.empId), date: x.submitted || x.date, perm: 'prj.approve',
      why: x.violations ? `${x.violations} policy flag(s): ${[...new Set(x.lines.flatMap((l) => l.flags))].join('; ')}` : `${x.purpose}` })),
  ]);
  E.on('checklist', (p) => {
    const pend = S().timesheets.filter((t) => t.status === 'Submitted' && periodOf(t.weekStart) <= p).length;
    const end = periodEnd(p);
    const unb = S().projects.filter((x) => x.type === 'Time and materials').filter((x) => unbilled(x.id, end).total > 0);
    return [
      { task: 'Timesheets approved for period', done: !pend, detail: pend ? `${pend} timesheet(s) awaiting approval` : 'None pending', advisory: true },
      { task: 'Project billing run', done: !unb.length, detail: unb.length ? `Unbilled work on ${unb.map((x) => x.id).join(', ')}` : 'All approved T&M work billed', advisory: true },
    ];
  });
  E.on('search', (q, hit) => [
    ...S().projects.filter((p) => hit(p.id, p.name, E.cust(p.customerId)?.name, p.type)).map((p) => ({ kind: 'project', id: p.id, label: `${p.id} ${p.name}`, sub: `Project, ${p.type}, ${p.status}` })),
    ...S().expenseReports.filter((x) => hit(x.id, x.purpose, empName(x.empId))).map((x) => ({ kind: 'expense', id: x.id, label: x.id, sub: `Expense report, ${empName(x.empId)}, ${money(x.total)}, ${x.status}` })),
    ...S().timesheets.filter((t) => hit(t.id)).map((t) => ({ kind: 'timesheet', id: t.id, label: t.id, sub: `Timesheet, ${empName(t.empId)}, ${t.status}` })),
  ]);

  // ---------- seed ----------
  function prng(seed) { return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  let rnd = prng(4242); // own generator: never consume the core seed's random stream
  const spread = (h) => { const d = [0, 0, 0, 0, 0]; let left = Math.round(h * 2); let i = 0; while (left > 0) { d[i % 5] += 0.5; left--; i++; } return d.map((x) => r2(x)); };
  const byName = (n) => S().employees.find((e) => e.name === n);
  const P = {}; // seed project ids by key
  // [employee, project key, task id, base weekly hours, first month]
  const ALLOC = [
    ['Hana Sato', 'fw', 'T1', 16, '2026-07'], ['Hana Sato', 'mer', 'T3', 6, '2026-08'],
    ['Oliver Brandt', 'pin', 'T2', 18, '2026-08'], ['Oliver Brandt', 'mer', 'T2', 6, '2026-07'],
    ['Lena Park', 'fw', 'T2', 6, '2026-07'], ['Lena Park', 'pin', 'T1', 4, '2026-08'],
    ['Marco Bellini', 'mer', 'T2', 18, '2026-07'], ['Marco Bellini', 'sol', 'T1', 6, '2026-09'],
    ['Priya Raman', 'mer', 'T4', 3, '2026-07'], ['Dana Whitfield', 'sol', 'T2', 10, '2026-09'],
  ];
  function seedWeek(ws, ctx, approve) {
    const groups = {};
    ALLOC.forEach(([n, k, task, base, from]) => {
      const p = project(P[k]); if (!p || periodOf(ws) < from || weekEnd(ws) < p.start) return;
      const h = Math.max(2, base + Math.round((rnd() - 0.5) * 8));
      (groups[n] = groups[n] || []).push({ projectId: p.id, taskId: task, hours: spread(h) });
    });
    const made = [];
    Object.keys(groups).forEach((n) => {
      const e = byName(n); if (!e || e.status !== 'Active') return;
      ctx.at(weekEnd(ws)); const t = createTimesheet({ empId: e.id, weekStart: ws, lines: groups[n] });
      if (approve(n)) ctx.asRole('Controller', 'Avery Lin', () => approveTimesheet(t.id));
      made.push(t);
    });
    return made;
  }
  function seedExpenses(p, ctx, D, opts = {}) {
    const mk = (n, purpose, day, lines) => { const e = byName(n); if (!e) return null; ctx.at(D(p, day)); return createExpenseReport({ empId: e.id, purpose, date: D(p, day), lines }); };
    const reps = [];
    const v = () => r2(rnd() * 40);
    if (P.mer) reps.push(mk('Marco Bellini', `Meridian pump station installs (${periodLabel(p)})`, 12, [
      { date: D(p, 6), category: 'Mileage', amount: r2(96 + v()), projectId: P.mer, billable: true, receipt: true },
      { date: D(p, 7), category: 'Lodging', amount: 189, projectId: P.mer, billable: true, receipt: true },
      { date: D(p, 7), category: 'Meals', amount: r2(38 + v() / 2), projectId: P.mer, billable: true, receipt: true },
      { date: D(p, 8), category: 'Lodging', amount: 189, projectId: P.mer, billable: true, receipt: true },
      { date: D(p, 8), category: 'Meals', amount: r2(44 + v() / 2), projectId: P.mer, billable: true, receipt: true },
      { date: D(p, 9), category: 'Supplies', amount: r2(60 + v() * 2), projectId: P.mer, billable: true, receipt: true }]));
    if (P.pin && p >= '2026-08') reps.push(mk('Oliver Brandt', `Pinecrest site visit (${periodLabel(p)})`, 15, [
      { date: D(p, 13), category: 'Travel', amount: r2(318 + v() * 3), projectId: P.pin, receipt: true },
      { date: D(p, 13), category: 'Lodging', amount: 214, projectId: P.pin, receipt: true },
      { date: D(p, 14), category: 'Meals', amount: r2(52 + v() / 2), projectId: P.pin, receipt: true }]));
    if (!opts.short) reps.push(mk('Kwame Asante', `Customer visits (${periodLabel(p)})`, 19, [
      { date: D(p, 16), category: 'Travel', amount: r2(240 + v() * 4), receipt: true }, { date: D(p, 17), category: 'Meals', amount: r2(48 + v()), receipt: true },
      { date: D(p, 18), category: 'Mileage', amount: r2(42 + v()), receipt: true }]));
    return reps.filter(Boolean);
  }
  E.on('seedSetup', (ctx) => {
    rnd = prng(4242); Object.keys(P).forEach((k) => delete P[k]); ensureAccounts();
    const c = (n) => S().customers.find((x) => x.name === n)?.id;
    ctx.at('2026-07-01');
    const priya = byName('Priya Raman'), lena = byName('Lena Park');
    if (!priya || !lena) return;
    P.mer = createProject({ name: 'Meridian telemetry network rollout', type: 'Time and materials', customerId: c('Meridian Water Authority'), managerId: priya.id, start: '2026-07-01', end: '2027-03-31',
      budget: { Labor: 160000, Expenses: 18000, Materials: 30000 }, tasks: [{ name: 'Site surveys', billable: true }, { name: 'Field installation', billable: true }, { name: 'Network commissioning', billable: true }, { name: 'Project administration', billable: false }] }).id;
    P.fw = createProject({ name: 'Firmware platform v4', type: 'Internal', managerId: lena.id, start: '2026-07-01', end: '2027-06-30',
      budget: { Labor: 140000, Expenses: 5000, Materials: 8000 }, tasks: [{ name: 'Core firmware' }, { name: 'Architecture and review' }, { name: 'Validation' }] }).id;
    ctx.at('2026-08-01');
    P.pin = createProject({ name: 'Pinecrest lab commissioning', type: 'Fixed price', customerId: c('Pinecrest University'), managerId: lena.id, start: '2026-08-01', end: '2027-01-29', contractValue: 180000,
      budget: { Labor: 95000, Expenses: 9000, Materials: 26000 }, tasks: [{ name: 'Lab design', billable: true }, { name: 'Sensor installation', billable: true }, { name: 'Acceptance testing', billable: true }],
      milestones: [{ name: 'Design sign-off', pct: 20 }, { name: 'Installation complete', pct: 50 }, { name: 'Final acceptance', pct: 30 }] }).id;
    ctx.at('2026-09-01');
    P.sol = createProject({ name: 'Solace cleanroom monitoring', type: 'Time and materials', customerId: c('Solace Pharma'), managerId: priya.id, start: '2026-09-01', end: '2027-02-26',
      budget: { Labor: 60000, Expenses: 6000, Materials: 12000 }, tasks: [{ name: 'Cleanroom sensor design', billable: true }, { name: 'Installation and validation', billable: true }],
      rates: { Engineering: 225, Operations: 150, default: 185 } }).id;
  });
  E.on('seedMonthly', (p, ctx) => {
    if (!P.mer) return;
    const D = (pp, d) => `${pp}-${String(d).padStart(2, '0')}`;
    const last = p === '2026-11';
    // weekly timesheets: every week whose Monday falls in p and before today's week
    const weeks = []; for (let d = mondayOf(p + '-01'); periodOf(d) <= p; d = addDays(d, 7)) if (periodOf(d) === p && addDays(d, 7) <= S().today) weeks.push(d);
    weeks.forEach((ws, wi) => seedWeek(ws, ctx, (n) => !(last && wi === weeks.length - 1 && (n === 'Hana Sato' || n === 'Oliver Brandt'))));
    // project materials (supplier invoices tagged to projects), paid inside the month
    const sup = ctx.sups && ctx.sups[0];
    const mat = { '2026-07': [['mer', 7400]], '2026-08': [['pin', 9800]], '2026-09': [['pin', 8600], ['sol', 4200]], '2026-10': [['mer', 6100], ['pin', 3900]], '2026-11': [] }[p] || [];
    mat.forEach(([k, amt], i) => {
      if (!sup) return; ctx.at(D(p, 10 + i));
      const inv = E.createAPInvoice({ supplierId: sup.id, number: `PRJ-MAT-${p.replace('-', '')}-${i + 1}`, date: D(p, 10 + i), source: 'Projects', ref: P[k],
        lines: [{ acct: '5200', desc: `Installation materials for ${P[k]}`, amount: amt, project: P[k] }] });
      if (!last) { ctx.at(D(p, 26)); E.payInvoices([inv.id], D(p, 26), 'ACH'); }
    });
    // expense reports: submitted mid-month, approved two days later, reimbursed on the 28th
    const reps = seedExpenses(p, ctx, D, { short: last });
    reps.forEach((x) => { ctx.at(addDays(x.date, 2)); ctx.asRole('Controller', 'Avery Lin', () => approveExpenseReport(x.id)); });
    if (!last) { ctx.at(D(p, 28)); ctx.asRole('Controller', 'Avery Lin', () => reimburseExpenses(null, D(p, 28))); }
    // collections on earlier project invoices that fall due this month
    S().arInvoices.filter((i) => i.projectId && i.status !== 'Paid' && periodOf(i.due) === p && i.due <= S().today).forEach((i) => { ctx.at(i.due); E.applyReceipt({ invoiceId: i.id, date: i.due, amount: r2(i.total - i.paid), reference: `WIRE${i.id.slice(-4)}${p.slice(5)}` }); });
    // month-end billing run
    if (!last) {
      const end = periodEnd(p); ctx.at(end);
      ctx.asRole('Controller', 'Avery Lin', () => {
        [P.mer, P.sol].forEach((id) => { if (unbilled(id, end).total > 0) generateProjectInvoice(id, { date: end, through: end }); });
        if (p >= '2026-08') { try { billFixedPrice(P.pin, { date: end, method: 'percent' }); } catch (e) { /* nothing new to bill */ } }
      });
    }
  });
  E.on('seedFinal', (ctx) => {
    if (!P.mer) return;
    // the demo's pending expense report, with a meals policy violation and a missing receipt
    const marco = byName('Marco Bellini'); if (!marco) return;
    ctx.at('2026-11-16');
    createExpenseReport({ empId: marco.id, purpose: 'Meridian north district commissioning trip', date: '2026-11-16', lines: [
      { date: '2026-11-11', category: 'Lodging', amount: 189, projectId: P.mer, billable: true, receipt: true },
      { date: '2026-11-11', category: 'Meals', amount: 54.2, projectId: P.mer, billable: true, receipt: true },
      { date: '2026-11-12', category: 'Meals', amount: 38.6, projectId: P.mer, billable: true, receipt: true },
      { date: '2026-11-12', category: 'Meals', amount: 46.9, projectId: P.mer, billable: true, receipt: false, desc: 'Team dinner, north district crew' },
      { date: '2026-11-12', category: 'Mileage', amount: 112.4, projectId: P.mer, billable: true, receipt: true },
      { date: '2026-11-13', category: 'Supplies', amount: 18.75, projectId: P.mer, billable: true, receipt: false }] });
  });

  E.extend({
    PROJECT_TYPES, COST_TYPES, EXPENSE_CATEGORIES, EXPENSE_MARKUP, MEALS_DAILY_LIMIT, RECEIPT_THRESHOLD, STANDARD_HOURS, PROJECT_DEFAULT_RATES: DEFAULT_RATES, TS_DAYS: DAYS,
    project, timesheet, expenseReport, reimbursement, laborCostRate: costRate, projectBillRate: billRate, timesheetHours: tsHours, mondayOf,
    createProject, closeProject, createTimesheet, submitTimesheet, approveTimesheet, rejectTimesheet,
    expensePolicyCheck: policyCheck, createExpenseReport, submitExpenseReport, approveExpenseReport, rejectExpenseReport, reimburseExpenses,
    projectUnbilled: unbilled, generateProjectInvoice, billFixedPrice, projectFinancials: financials, projectPortfolio: portfolio,
    pendingTimesheets, pendingExpenses, reimbursableExpenses: reimbursable,
  });
})(typeof window !== 'undefined' ? window : globalThis);
