/* Ledgerline Suite: talent management tests (recruiting, performance, compensation). */
'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E, seed } = require('../js/load-node.js');

const r2 = (n) => Math.round((+n + Number.EPSILON) * 100) / 100;
const empByName = (n) => E.S.employees.find((e) => e.name === n);
const asRole = (role, user, fn) => { const r = E.S.role, u = E.S.user; E.S.role = role; E.S.user = user; try { return fn(); } finally { E.S.role = r; E.S.user = u; } };
function assertLedgerOk() {
  const tb = E.trialBalance();
  assert.ok(Math.abs(tb.dr - tb.cr) < 0.005, `TB dr ${tb.dr} != cr ${tb.cr}`);
  assert.equal(E.balanceSheet().balanced, true);
  for (const r of E.reconcile()) assert.ok(r.ok, `reconcile ${r.name}: sub ${r.sub} gl ${r.gl}`);
}
const newReq = (over = {}) => E.createJobReq({ title: 'Test Engineer', dept: 'Engineering', hiringManagerId: empByName('Lena Park').id, salaryMin: 90000, salaryMax: 110000, headcount: 1, reason: 'New', ...over });
const toInterview = (c) => { E.advanceCandidate(c.id); E.advanceCandidate(c.id); assert.equal(E.candidate(c.id).stage, 'Interview'); return c; };

beforeEach(() => { seed(); });

describe('talent seed', () => {
  test('seeded talent data is present and the ledger is intact', () => {
    const T = E.S.talent;
    assert.ok(T.jobReqs.length >= 3);
    assert.ok(T.jobReqs.some((r) => r.status === 'Pending Approval' && r.date === '2026-11-15'));
    assert.ok(T.candidates.length >= 10);
    assert.ok(T.candidates.some((c) => c.offer && c.offer.status === 'Pending Approval' && c.offer.aboveRange));
    for (const e of E.S.employees.filter((x) => x.status === 'Active')) {
      const gs = E.goalsOf(e.id);
      assert.ok(gs.length >= 3 && gs.length <= 4, `${e.name} has ${gs.length} goals`);
      assert.equal(E.goalWeight(e.id), 100, `${e.name} goal weights`);
    }
    const states = new Set(T.reviews.map((r) => r.state));
    assert.ok(states.has('Completed') && states.has('Manager review'));
    assert.ok(T.salaryHistory.some((h) => h.reason === 'Merit' && h.date === '2026-07-01'));
    const kinds = new Set(E.approvalsInbox().map((a) => a.kind));
    ['jobreq', 'candidate', 'comp'].forEach((k) => assert.ok(kinds.has(k), `inbox has ${k}`));
    assert.ok(E.search('firmware').some((h) => h.kind === 'jobreq'));
    assert.ok(E.search('mei').some((h) => h.kind === 'candidate'));
    assert.ok(E.can('HR Specialist', 'hr.recruit.approve') && E.can('Buyer', 'hr.goals') && !E.can('Buyer', 'hr.comp.approve'));
    assertLedgerOk();
  });
});

describe('recruiting', () => {
  test('requisition approval gate: no candidates until approved; approver needs permission', () => {
    const r = newReq();
    assert.equal(r.status, 'Draft');
    assert.throws(() => E.addCandidate({ reqId: r.id, name: 'Early Bird' }), /open requisition/);
    assert.throws(() => E.approveJobReq(r.id), /not awaiting approval/);
    E.submitJobReq(r.id);
    assert.equal(r.status, 'Pending Approval');
    assert.ok(E.approvalsInbox().some((a) => a.kind === 'jobreq' && a.id === r.id));
    assert.throws(() => E.addCandidate({ reqId: r.id, name: 'Early Bird' }), /open requisition/);
    assert.throws(() => asRole('Buyer', 'Dana Whitfield', () => E.approveJobReq(r.id)), /cannot approve/);
    assert.equal(r.status, 'Pending Approval');
    asRole('HR Specialist', 'Nadia Petrova', () => E.approveJobReq(r.id));
    assert.equal(r.status, 'Open');
    assert.ok(!E.approvalsInbox().some((a) => a.id === r.id));
    const c = E.addCandidate({ reqId: r.id, name: 'On Time', source: 'Referral' });
    assert.equal(c.stage, 'Applied');
  });

  test('offer above range max needs approval before it can be accepted', () => {
    const r = newReq({ submit: true }); E.approveJobReq(r.id);
    const c = toInterview(E.addCandidate({ reqId: r.id, name: 'Pricey Pat' }));
    assert.throws(() => E.makeOffer(c.id, { salary: 80000, startDate: '2027-01-04' }), /below the range minimum/);
    const o = E.makeOffer(c.id, { salary: 118000, startDate: '2027-01-04' });
    assert.equal(o.status, 'Pending Approval');
    assert.ok(E.approvalsInbox().some((a) => a.kind === 'candidate' && a.id === c.id));
    const n = E.S.employees.length;
    assert.throws(() => E.acceptOffer(c.id), /awaits approval/);
    assert.equal(E.S.employees.length, n);
    E.approveOffer(c.id);
    assert.equal(E.candidate(c.id).offer.status, 'Approved');
    // within range: approved straight away
    const c2 = toInterview(E.addCandidate({ reqId: r.id, name: 'Fair Fran' }));
    assert.equal(E.makeOffer(c2.id, { salary: 105000, startDate: '2027-01-04' }).status, 'Approved');
  });

  test('accepting an offer hires exactly once and fills the requisition at headcount', () => {
    const r = newReq({ headcount: 2, submit: true }); E.approveJobReq(r.id);
    const a = toInterview(E.addCandidate({ reqId: r.id, name: 'Alex Hire' }));
    const b = toInterview(E.addCandidate({ reqId: r.id, name: 'Blair Hire' }));
    const spare = E.addCandidate({ reqId: r.id, name: 'Casey Spare' });
    const n = E.S.employees.length, j = E.S.journals.length;
    E.makeOffer(a.id, { salary: 100000, startDate: '2026-12-07' });
    const e = E.acceptOffer(a.id);
    assert.equal(E.S.employees.length, n + 1);
    assert.equal(e.name, 'Alex Hire'); assert.equal(e.title, 'Test Engineer'); assert.equal(e.dept, 'Engineering');
    assert.equal(e.managerId, empByName('Lena Park').id); assert.equal(e.salary, 100000); assert.equal(e.hireDate, '2026-12-07');
    assert.equal(E.candidate(a.id).stage, 'Hired'); assert.equal(E.candidate(a.id).empId, e.id);
    assert.equal(r.filled, 1); assert.equal(r.status, 'Open'); assert.equal(E.openHeadcount(r), 1);
    assert.throws(() => E.acceptOffer(a.id), /already been hired/);
    assert.equal(E.S.employees.length, n + 1);
    assert.ok(E.salaryHistory(e.id).some((h) => h.reason === 'Hire' && h.salary === 100000));
    E.makeOffer(b.id, { salary: 95000, startDate: '2027-01-04' });
    E.acceptOffer(b.id);
    assert.equal(E.S.employees.length, n + 2);
    assert.equal(r.status, 'Filled');
    assert.equal(E.candidate(spare.id).stage, 'Rejected');
    assert.throws(() => E.addCandidate({ reqId: r.id, name: 'Too Late' }), /Filled/);
    assert.equal(E.S.journals.length, j, 'talent posts no journals');
    assertLedgerOk();
  });

  test('pipeline: advance, reject, and time in stage', () => {
    const c = E.S.talent.candidates.find((x) => x.stage === 'Applied');
    assert.ok(E.timeInStage(c) >= 0);
    E.advanceCandidate(c.id); assert.equal(c.stage, 'Screen'); assert.equal(E.timeInStage(c), 0);
    E.advanceCandidate(c.id); assert.equal(c.stage, 'Interview');
    assert.throws(() => E.advanceCandidate(c.id), /Make an offer/);
    E.addFeedback(c.id, { interviewer: 'Lena Park', rating: 4, comment: 'Good' });
    assert.equal(c.rating, 4);
    assert.throws(() => E.addFeedback(c.id, { interviewer: 'X', rating: 7 }), /1 to 5/);
    E.rejectCandidate(c.id, 'Chose another');
    assert.equal(c.stage, 'Rejected');
    assert.throws(() => E.advanceCandidate(c.id), /no next stage/);
  });
});

describe('performance', () => {
  test('goal weights must total 100 to submit', () => {
    const e = E.hireEmployee({ name: 'Goal Setter', title: 'Analyst', dept: 'Finance', salary: 70000, hireDate: '2026-11-02' });
    assert.throws(() => E.submitGoals(e.id), /no goals/);
    const g1 = E.addGoal({ empId: e.id, title: 'Close faster', weight: 60, targetDate: '2027-06-30' });
    E.addGoal({ empId: e.id, title: 'Automate recs', weight: 30, targetDate: '2027-03-31' });
    assert.throws(() => E.submitGoals(e.id), /total 90%/);
    assert.throws(() => E.addGoal({ empId: e.id, title: 'Bad', weight: 0, targetDate: '2027-03-31' }), /Weight/);
    E.addGoal({ empId: e.id, title: 'Learn the ERP', weight: 20, targetDate: '2027-03-31' });
    assert.throws(() => E.submitGoals(e.id), /total 110%/);
    E.updateGoal(g1.id, { weight: 50 });
    E.submitGoals(e.id);
    assert.equal(E.goalPlan(e.id).status, 'Submitted');
    E.updateGoal(g1.id, { progress: 40 });
    assert.equal(E.goal(g1.id).status, 'In progress');
    assert.equal(E.goalPlan(e.id).status, 'Submitted', 'progress update keeps plan submitted');
    E.updateGoal(g1.id, { weight: 45 });
    assert.equal(E.goalPlan(e.id).status, 'Draft', 'weight change reopens plan');
  });

  test('review states and calibration distribution', () => {
    const r = E.S.talent.reviews.find((x) => x.state === 'Not started');
    assert.throws(() => E.saveManagerReview(r.id, { rating: 3, comments: 'x', submit: true }), /not submitted a self review/);
    E.saveSelfReview(r.id, { rating: 4, comments: '' }); assert.equal(r.state, 'Self review');
    E.saveSelfReview(r.id, { rating: 4, comments: 'Done well', submit: true }); assert.equal(r.state, 'Manager review');
    const dept = E.emp(r.empId).dept; const before = E.calibration()[dept];
    E.saveManagerReview(r.id, { rating: 5, comments: 'Excellent', submit: true }); assert.equal(r.state, 'Completed');
    const after = E.calibration()[dept];
    assert.equal(after[5], before[5] + 1); assert.equal(after.n, before.n + 1);
    const all = Object.values(E.calibration()).reduce((a, o) => a + o.n, 0);
    assert.equal(all, E.S.talent.reviews.filter((x) => x.state === 'Completed').length);
  });
});

describe('compensation', () => {
  test('increase over 10% needs approval; approval applies salary when effective today or earlier', () => {
    const e = empByName('Marco Bellini'); const s0 = e.salary;
    const small = E.requestSalaryChange({ empId: e.id, newSalary: r2(s0 * 1.05), reason: 'Market', effectiveDate: '2026-11-01' });
    assert.equal(small.status, 'Applied'); assert.equal(e.salary, r2(s0 * 1.05));
    const s1 = e.salary;
    const big = E.requestSalaryChange({ empId: empByName('Sam Achebe').id, newSalary: 100000, reason: 'Promotion', effectiveDate: '2026-11-15' });
    assert.equal(big.status, 'Pending Approval');
    assert.ok(E.approvalsInbox().some((a) => a.kind === 'comp' && a.id === big.id));
    assert.throws(() => asRole('Order Manager', 'Ines Duarte', () => E.approveSalaryChange(big.id)), /cannot approve/);
    asRole('HR Specialist', 'Nadia Petrova', () => E.approveSalaryChange(big.id));
    assert.equal(big.status, 'Applied'); assert.equal(empByName('Sam Achebe').salary, 100000);
    assert.throws(() => E.requestSalaryChange({ empId: e.id, newSalary: s1 - 1000, reason: 'Merit', effectiveDate: '2026-12-01' }), /Correction/);
    const hist = E.salaryHistory(e.id).map((h) => h.reason);
    assert.equal(hist[0], 'Hire'); assert.ok(hist.includes('Market'));
  });

  test('merit cycle totals vs budget; submit creates 2027-01-01 changes', () => {
    const S = E.S; S.talent.merit.proposals = {};
    E.setMeritBudget(3.5);
    const act = S.employees.filter((e) => e.status === 'Active');
    const payroll = r2(act.reduce((a, e) => a + e.salary, 0));
    let sm = E.meritSummary();
    assert.equal(sm.payroll, payroll); assert.equal(sm.budget, r2(payroll * 0.035)); assert.equal(sm.proposed, 0);
    const free = act.filter((e) => !S.talent.compChanges.some((c) => c.empId === e.id && ['Pending Approval', 'Approved'].includes(c.status)));
    free.forEach((e) => E.setMeritProposal(e.id, 3));
    sm = E.meritSummary();
    const expect = r2(free.reduce((a, e) => a + r2(r2(e.salary * 1.03) - e.salary), 0));
    assert.equal(sm.proposed, expect); assert.equal(sm.remaining, r2(sm.budget - expect)); assert.equal(sm.overBudget, false);
    E.setMeritProposal(free[0].id, 30);
    assert.equal(E.meritSummary().overBudget, true);
    assert.throws(() => E.submitMeritCycle(), /over the/);
    E.setMeritProposal(free[0].id, 3);
    const n = S.talent.compChanges.length;
    const ids = E.submitMeritCycle();
    assert.equal(ids.length, free.length); assert.equal(S.talent.compChanges.length, n + free.length);
    ids.forEach((id) => { const c = E.compChange(id); assert.equal(c.effectiveDate, '2027-01-01'); assert.equal(c.reason, 'Merit'); assert.equal(c.status, 'Approved'); });
    assert.equal(free[0].salary, E.compChange(ids[0]).currentSalary, 'future-dated: salary unchanged today');
    assert.throws(() => E.submitMeritCycle(), /already been submitted/);
  });

  test('payroll wrapper applies future-dated change only from its effective period', () => {
    const e = empByName('Hana Sato'); const old = e.salary;
    const c = E.requestSalaryChange({ empId: e.id, newSalary: r2(old + 6000), reason: 'Market', effectiveDate: '2026-12-01' });
    assert.equal(c.status, 'Approved'); assert.equal(e.salary, old);
    const nov = E.runPayroll('2026-11');
    assert.equal(nov.slips.find((s) => s.empId === e.id).gross, r2(old / 12));
    assert.equal(c.status, 'Approved'); assert.equal(e.salary, old);
    // failed Dec run (period not open) leaves the change unapplied
    assert.throws(() => E.runPayroll('2026-12'), /Future/);
    assert.equal(c.status, 'Approved'); assert.equal(e.salary, old);
    E.openPeriod('2026-12');
    const dec = E.runPayroll('2026-12');
    assert.equal(c.status, 'Applied'); assert.equal(e.salary, r2(old + 6000));
    assert.equal(dec.slips.find((s) => s.empId === e.id).gross, r2((old + 6000) / 12));
    assert.ok(E.salaryHistory(e.id).some((h) => h.ref === c.id && h.date === '2026-12-01'));
    assertLedgerOk();
  });

  test('apply due changes action applies only approved changes on or before the date', () => {
    const k = empByName('Kwame Asante'); const sc = E.S.talent.compChanges.find((c) => c.empId === k.id && c.status === 'Approved');
    assert.ok(sc, 'seeded future-dated change');
    assert.equal(E.applyDueChanges().length, 0);
    const done = E.applyDueChanges('2027-01-01');
    assert.ok(done.some((c) => c.id === sc.id)); assert.equal(k.salary, sc.newSalary);
    const pend = E.S.talent.compChanges.find((c) => c.status === 'Pending Approval');
    assert.ok(pend && pend.status === 'Pending Approval', 'pending approvals are not applied');
    assertLedgerOk();
  });
});
