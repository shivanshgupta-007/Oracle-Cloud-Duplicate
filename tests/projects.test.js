// Projects, timesheets, expenses and project billing (ext-projects.js).
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E, seed } = require('../js/load-node.js');

const r2 = E.util.r2;
const empBy = (n) => E.S.employees.find((e) => e.name === n);
const prjBy = (n) => E.S.projects.find((p) => p.name === n);
const recOk = () => { const bad = E.reconcile().filter((r) => !r.ok); assert.deepEqual(bad.map((r) => `${r.name} ${r.diff}`), []); const tb = E.trialBalance(); assert.ok(Math.abs(tb.dr - tb.cr) < 0.005, 'trial balance nets to zero'); };
const balanced = (j) => assert.ok(Math.abs(E.util.sum(j.lines, (l) => l.dr) - E.util.sum(j.lines, (l) => l.cr)) < 0.005, `${j.id} balances`);
const WEEK = '2026-11-02'; // a Monday in the open period Nov-26
let ivy; // fresh engineer with no seeded timesheets
const asController = (fn) => { const r = E.S.role, u = E.S.user; E.S.role = 'Controller'; E.S.user = 'Avery Lin'; try { return fn(); } finally { E.S.role = r; E.S.user = u; } };

describe('projects, time and expenses', () => {
  beforeEach(() => {
    seed();
    ivy = E.hireEmployee({ name: 'Ivy Moreau', title: 'Test Engineer', dept: 'Engineering', managerId: empBy('Lena Park').id, salary: 104000, hireDate: '2026-07-01' });
  });

  it('seed: projects, timesheets, expenses present and everything reconciles', () => {
    assert.ok(E.S.projects.length >= 3);
    ['Meridian telemetry network rollout', 'Pinecrest lab commissioning', 'Firmware platform v4'].forEach((n) => assert.ok(prjBy(n), n));
    assert.equal(prjBy('Pinecrest lab commissioning').contractValue, 180000);
    assert.ok(E.S.timesheets.filter((t) => t.status === 'Approved').length > 50);
    assert.equal(E.pendingTimesheets().length, 2);
    const pe = E.pendingExpenses(); assert.equal(pe.length, 1); assert.ok(pe[0].violations > 0);
    assert.ok(E.approvalsInbox().some((i) => i.kind === 'timesheet' && i.perm === 'prj.approve'));
    assert.ok(E.approvalsInbox().some((i) => i.kind === 'expense'));
    assert.ok(E.reconcile().some((r) => r.acct === '2150'));
    // no pending journals in Jul-Sep and every journal balances
    E.S.journals.forEach(balanced);
    assert.ok(!E.S.journals.some((j) => j.status === 'Pending Approval' && j.period < '2026-10'));
    assert.ok(E.balance('1000') > 0, 'cash stays positive');
    recOk();
  });

  it('labor cost rate = salary / 2080 x (1 + employer tax)', () => {
    const rate = E.laborCostRate(ivy);
    assert.equal(rate, r2(104000 / 2080 * (1 + E.EMPLOYER_TAX_RATE)));
    assert.equal(rate, 53.83);
  });

  it('timesheet: reclass journal only on approval, balanced, cost stored on lines', () => {
    const mer = prjBy('Meridian telemetry network rollout'), fw = prjBy('Firmware platform v4');
    const before = E.S.journals.length, b6000 = E.balance('6000'), b5200 = E.balance('5200'), b6700 = E.balance('6700');
    const t = E.createTimesheet({ empId: ivy.id, weekStart: WEEK, lines: [{ projectId: mer.id, taskId: 'T2', hours: [8, 8, 4, 0, 0] }, { projectId: fw.id, taskId: 'T1', hours: [0, 0, 4, 8, 6] }] });
    assert.equal(t.status, 'Submitted'); assert.equal(t.hours, 38);
    assert.equal(E.S.journals.length, before, 'no journal on submit');
    assert.ok(E.projectFinancials(mer.id).pendingHours >= 20);
    asController(() => E.approveTimesheet(t.id));
    const rate = E.laborCostRate(ivy);
    assert.equal(t.status, 'Approved');
    assert.equal(t.lines[0].cost, r2(20 * rate)); assert.equal(t.lines[1].cost, r2(18 * rate)); assert.equal(t.lines[0].costRate, rate);
    const j = E.je(t.journal); balanced(j); assert.equal(j.status, 'Posted'); assert.equal(j.period, '2026-11');
    assert.equal(r2(E.balance('5200') - b5200), r2(20 * rate));
    assert.equal(r2(E.balance('6700') - b6700), r2(18 * rate));
    assert.equal(r2(b6000 - E.balance('6000')), r2(38 * rate), 'Cr 6000 by the full cost');
    assert.throws(() => asController(() => E.approveTimesheet(t.id)), /not awaiting approval/);
    recOk();
  });

  it('timesheet validation and rejection', () => {
    const mer = prjBy('Meridian telemetry network rollout');
    assert.throws(() => E.createTimesheet({ empId: ivy.id, weekStart: '2026-11-03', lines: [{ projectId: mer.id, taskId: 'T1', hours: [1] }] }), /Monday/);
    assert.throws(() => E.createTimesheet({ empId: ivy.id, weekStart: WEEK, lines: [{ projectId: mer.id, taskId: 'T1', hours: [25] }] }), /between 0 and 24/);
    assert.throws(() => E.createTimesheet({ empId: ivy.id, weekStart: WEEK, lines: [] }), /at least one/);
    const t = E.createTimesheet({ empId: ivy.id, weekStart: WEEK, lines: [{ projectId: mer.id, taskId: 'T1', hours: [4, 4, 4, 4, 4] }] });
    assert.throws(() => E.createTimesheet({ empId: ivy.id, weekStart: WEEK, lines: [{ projectId: mer.id, taskId: 'T1', hours: [1] }] }), /already has timesheet/);
    const n = E.S.journals.length;
    E.rejectTimesheet(t.id, 'Wrong task');
    assert.equal(t.status, 'Rejected'); assert.equal(E.S.journals.length, n);
    E.createTimesheet({ empId: ivy.id, weekStart: WEEK, lines: [{ projectId: mer.id, taskId: 'T2', hours: [4, 4, 4, 4, 4] }] }); // resubmit allowed after rejection
  });

  it('expense approval credits 2150; reimbursement clears it; reconcile holds at each step', () => {
    const mer = prjBy('Meridian telemetry network rollout');
    const g2150 = E.balance('2150'), cash = E.balance('1000');
    const x = E.createExpenseReport({ empId: ivy.id, purpose: 'Meridian install', date: '2026-11-10', lines: [
      { date: '2026-11-09', category: 'Travel', amount: 300, projectId: mer.id, billable: true, receipt: true },
      { date: '2026-11-09', category: 'Lodging', amount: 180, projectId: mer.id, billable: true, receipt: true },
      { date: '2026-11-10', category: 'Meals', amount: 40, receipt: true }] });
    assert.equal(x.total, 520); assert.equal(x.violations, 0);
    recOk();
    asController(() => E.approveExpenseReport(x.id));
    const j = E.je(x.journal); balanced(j);
    assert.deepEqual(j.lines.filter((l) => l.dr).map((l) => [l.acct, l.dr]), [['6500', 300], ['6510', 40], ['6520', 180]]);
    assert.equal(r2(E.balance('2150') - g2150), -520);
    recOk();
    const owed = E.util.sum(E.reimbursableExpenses(), (r) => r.total);
    const b = asController(() => E.reimburseExpenses(null, '2026-11-17'));
    assert.equal(b.total, owed); assert.equal(x.status, 'Reimbursed');
    assert.equal(E.balance('2150'), 0, '2150 fully cleared');
    assert.equal(r2(cash - E.balance('1000')), owed);
    assert.throws(() => E.reimburseExpenses(null, '2026-11-17'), /no approved/);
    recOk();
  });

  it('expense policy flags: meals over $75/day and missing receipts over $25', () => {
    const flags = E.expensePolicyCheck([
      { date: '2026-11-09', category: 'Meals', amount: 50, receipt: true }, { date: '2026-11-09', category: 'Meals', amount: 30, receipt: true },
      { date: '2026-11-10', category: 'Meals', amount: 75, receipt: true }, { date: '2026-11-10', category: 'Supplies', amount: 26, receipt: false },
      { date: '2026-11-10', category: 'Supplies', amount: 25, receipt: false }]);
    assert.equal(flags[0].length, 1); assert.match(flags[0][0], /daily limit/); assert.equal(flags[1].length, 1);
    assert.equal(flags[2].length, 0, 'exactly $75 is within policy');
    assert.match(flags[3][0], /Receipt required/); assert.equal(flags[4].length, 0);
    const x = E.createExpenseReport({ empId: ivy.id, purpose: 'Dinner', date: '2026-11-10', lines: [{ date: '2026-11-09', category: 'Meals', amount: 92, receipt: false }] });
    assert.equal(x.violations, 2); assert.equal(x.lines[0].flags.length, 2);
  });

  it('T&M invoice = hours x bill rate + billable expenses x 1.1; AR reconciles; same hours cannot be billed twice', () => {
    const mer = prjBy('Meridian telemetry network rollout');
    const pre = E.projectUnbilled(mer.id);
    const t = E.createTimesheet({ empId: ivy.id, weekStart: WEEK, lines: [{ projectId: mer.id, taskId: 'T2', hours: [8, 8, 8, 0, 0] }, { projectId: mer.id, taskId: 'T4', hours: [0, 0, 0, 4, 0] }] });
    asController(() => E.approveTimesheet(t.id));
    const x = E.createExpenseReport({ empId: ivy.id, purpose: 'Site', date: '2026-11-10', lines: [{ date: '2026-11-09', category: 'Lodging', amount: 200, projectId: mer.id, billable: true, receipt: true }, { date: '2026-11-09', category: 'Meals', amount: 30, projectId: mer.id, billable: false, receipt: true }] });
    asController(() => E.approveExpenseReport(x.id));
    const rate = mer.rates.Engineering; assert.equal(rate, 210);
    const u = E.projectUnbilled(mer.id);
    assert.equal(r2(u.laborAmount - pre.laborAmount), 24 * 210, 'non-billable task excluded');
    assert.equal(r2(u.expenseAmount - pre.expenseAmount), 220, 'billable expense at cost + 10%, non-billable excluded');
    const expected = r2(E.util.sum(u.labor, (l) => r2(l.hours * l.rate)) + E.util.sum(u.expenses, (e) => r2(e.cost * 1.1)));
    const ar = E.balance('1100'), rev = E.balance('4100');
    const inv = asController(() => E.generateProjectInvoice(mer.id, { date: '2026-11-17' }));
    assert.equal(inv.total, expected); assert.equal(inv.ref, mer.id);
    assert.ok(inv.lines.every((l) => l.acct === '4100'));
    assert.equal(r2(E.balance('1100') - ar), expected); assert.equal(r2(rev - E.balance('4100')), expected);
    assert.ok(t.lines[0].invoiceId === inv.id && x.lines[0].invoiceId === inv.id);
    assert.equal(t.lines[1].invoiceId, '', 'non-billable line never marked billed');
    recOk();
    assert.throws(() => E.generateProjectInvoice(mer.id, { date: '2026-11-17' }), /no unbilled/);
    assert.equal(E.projectUnbilled(mer.id).total, 0);
    assert.equal(E.projectFinancials(mer.id).unbilledWip, 0);
    // a receipt on the project invoice keeps AR in step
    E.applyReceipt({ invoiceId: inv.id, date: '2026-11-17', amount: inv.total });
    recOk();
  });

  it('fixed price: percent-complete billing never exceeds the contract value', () => {
    const pin = prjBy('Pinecrest lab commissioning');
    let f = E.projectFinancials(pin.id);
    assert.ok(f.billed > 0 && f.billed <= 180000);
    const inv = asController(() => E.billFixedPrice(pin.id, { date: '2026-11-17', method: 'percent' }));
    assert.equal(inv.total, r2(180000 * f.pctComplete - f.billed));
    assert.throws(() => E.billFixedPrice(pin.id, { date: '2026-11-17', method: 'percent' }), /Nothing to bill/);
    // blow through the budget: cost to date far above budget -> capped at 100%
    for (let w = 0; w < 6; w++) {
      const ws = E.util.addDays('2026-08-03', 7 * w);
      const t = E.createTimesheet({ empId: ivy.id, weekStart: ws, lines: [{ projectId: pin.id, taskId: 'T2', hours: [24, 24, 24, 24, 24] }] });
      asController(() => E.approveTimesheet(t.id));
    }
    E.createAPInvoice({ supplierId: E.S.suppliers[0].id, number: 'BIG-1', date: '2026-11-17', lines: [{ acct: '5200', amount: 90000, project: pin.id }] });
    f = E.projectFinancials(pin.id);
    assert.equal(f.pctComplete, 1); assert.ok(f.cost > f.budget.total);
    asController(() => E.billFixedPrice(pin.id, { date: '2026-11-17', method: 'percent' }));
    f = E.projectFinancials(pin.id);
    assert.equal(f.billed, 180000);
    assert.throws(() => E.billFixedPrice(pin.id, { date: '2026-11-17', method: 'milestone', milestoneId: 'M3' }), /fully billed/);
    assert.ok(f.margin < 0 && f.eac >= f.cost);
    recOk();
  });

  it('fixed price milestone billing is capped by what remains', () => {
    const p = asController(() => E.createProject({ name: 'Ostrava line audit', type: 'Fixed price', customerId: E.S.customers[2].id, managerId: empBy('Priya Raman').id, start: '2026-11-01', end: '2027-01-31', contractValue: 50000,
      budget: { Labor: 30000 }, tasks: [{ name: 'Audit' }], milestones: [{ name: 'Kickoff', pct: 40 }, { name: 'Report', pct: 60 }] }));
    const a = E.billFixedPrice(p.id, { date: '2026-11-17', method: 'milestone', milestoneId: 'M1' });
    assert.equal(a.total, 20000);
    assert.throws(() => E.billFixedPrice(p.id, { date: '2026-11-17', method: 'milestone', milestoneId: 'M1' }), /was billed/);
    const b = E.billFixedPrice(p.id, { date: '2026-11-17', method: 'milestone', milestoneId: 'M2' });
    assert.equal(b.total, 30000); assert.equal(E.projectFinancials(p.id).billed, 50000);
    assert.throws(() => E.createProject({ name: 'Bad', type: 'Fixed price', customerId: E.S.customers[0].id, managerId: ivy.id, start: '2026-11-01', end: '2026-12-01', budget: { Labor: 1 }, tasks: [{ name: 'x' }] }), /contract value/);
    recOk();
  });

  it('internal projects cannot be billed and post to R&D labor', () => {
    const fw = prjBy('Firmware platform v4');
    assert.throws(() => E.generateProjectInvoice(fw.id, { date: '2026-11-17' }), /Internal/);
    assert.throws(() => E.billFixedPrice(fw.id, { date: '2026-11-17' }), /not fixed price/);
    const t = E.createTimesheet({ empId: ivy.id, weekStart: WEEK, lines: [{ projectId: fw.id, taskId: 'T1', hours: [8, 8, 8, 8, 8] }] });
    asController(() => E.approveTimesheet(t.id));
    const j = E.je(t.journal);
    assert.deepEqual(j.lines.map((l) => l.acct).sort(), ['6000', '6700']);
    assert.ok(t.lines.every((l) => !l.billable));
  });

  it('permissions and hooks', () => {
    Object.keys(E.ROLES).forEach((r) => { assert.ok(E.can(r, 'prj.time'), r); assert.ok(E.can(r, 'exp.submit'), r); });
    ['prj.approve', 'prj.bill', 'exp.reimburse'].forEach((p) => { assert.ok(E.can('Controller', p)); assert.ok(!E.can('HR Specialist', p)); });
    const cl = E.closeChecklist('2026-11');
    assert.ok(cl.some((c) => c.task === 'Timesheets approved for period' && c.advisory && !c.done));
    assert.ok(cl.some((c) => c.task === 'Project billing run' && c.advisory));
    assert.ok(E.search('meridian telemetry').some((h) => h.kind === 'project'));
    const x = E.pendingExpenses()[0];
    assert.ok(E.search(x.id.toLowerCase()).some((h) => h.kind === 'expense' && h.id === x.id));
  });

  it('atomicity: failed approval leaves state untouched', () => {
    const mer = prjBy('Meridian telemetry network rollout');
    const t = E.createTimesheet({ empId: ivy.id, weekStart: WEEK, lines: [{ projectId: mer.id, taskId: 'T1', hours: [8] }] });
    E.S.periods['2026-11'] = 'Closed'; E.S.periods['2026-10'] = 'Closed';
    const snap = JSON.stringify(E.S);
    assert.throws(() => asController(() => E.approveTimesheet(t.id)), /Period/);
    assert.equal(JSON.stringify(E.S), snap);
  });
});
