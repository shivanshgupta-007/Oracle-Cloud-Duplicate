/* Ledgerline Suite: cash management tests (ext-cash.js). Run: node --test tests/ */
'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E, seed } = require('../js/load-node.js');

const r2 = (n) => Math.round((+n + Number.EPSILON) * 100) / 100;
const stmts = () => E.S.bankStatements.slice().sort((a, b) => a.endDate.localeCompare(b.endDate));
const nov = () => stmts().find((s) => s.period === '2026-11');
const balanced = (j) => Math.abs(j.lines.reduce((a, l) => a + l.dr - l.cr, 0)) < 0.005;
function invariants() {
  E.S.journals.forEach((j) => assert.ok(balanced(j), `${j.id} unbalanced`));
  const tb = E.trialBalance(); assert.ok(Math.abs(tb.dr - tb.cr) < 0.005, 'trial balance');
  E.reconcile().forEach((r) => assert.ok(r.ok, `reconcile ${r.name}: ${r.sub} vs ${r.gl}`));
}
function noDoubleMatch() {
  const seen = new Set();
  E.S.bankStatements.forEach((s) => s.lines.forEach((l) => { if (l.matched) { assert.ok(!seen.has(l.matched), `${l.matched} matched twice`); seen.add(l.matched); } }));
}

describe('cash management', () => {
  beforeEach(() => { seed(); });

  test('bank account and statements exist; Jul-Oct full months, Nov partial to 14 Nov', () => {
    assert.ok(E.S.bankAccounts.length >= 1);
    assert.equal(E.S.bankAccounts[0].gl, '1000');
    assert.deepEqual(stmts().map((s) => s.period), ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    assert.equal(nov().endDate, '2026-11-14');
    stmts().forEach((s) => s.lines.forEach((l) => { assert.ok(l.date >= s.startDate && l.date <= s.endDate, `${l.id} outside statement`); assert.match(s.id, /^BST-/); }));
  });

  test('statements tie: opening + lines = closing, and sequential statements chain', () => {
    const list = stmts();
    const opening = E.S.journals.filter((j) => j.source === 'Opening').reduce((a, j) => a + E.cashOf(j, '1000'), 0);
    assert.equal(list[0].opening, r2(opening));
    list.forEach((s, i) => {
      assert.equal(r2(s.opening + s.lines.reduce((a, l) => a + l.amount, 0)), s.closing, `${s.id} does not tie`);
      if (i) assert.equal(s.opening, list[i - 1].closing, `${s.id} does not chain`);
    });
  });

  test('statements contain bank-only fees and interest, and a returned payment in Nov', () => {
    stmts().filter((s) => s.period < '2026-11').forEach((s) => {
      const fee = s.lines.find((l) => l.kind === 'fee'), int = s.lines.find((l) => l.kind === 'interest');
      assert.ok(fee && fee.amount <= -45 && fee.amount >= -120, `${s.id} fee`);
      assert.ok(int && int.amount >= 300 && int.amount <= 900, `${s.id} interest`);
    });
    assert.ok(nov().lines.some((l) => l.kind === 'returned' && l.amount < 0));
    // at least one GL item clears on the following month's statement
    const r = E.bankReconReport(stmts()[0].id);
    assert.ok(r.depositsInTransit.length + r.outstandingPayments.length > 0);
  });

  test('Jul-Oct reconciled with zero difference; Nov open with unmatched lines', () => {
    stmts().filter((s) => s.period <= '2026-10').forEach((s) => {
      const r = E.bankReconReport(s.id);
      assert.equal(s.status, 'Reconciled');
      assert.equal(r.difference, 0, `${s.id} difference ${r.difference}`);
      assert.equal(r.linesUnmatched, 0);
      assert.ok(s.lines.every((l) => l.status === 'Reconciled'));
    });
    assert.equal(nov().status, 'Open');
    assert.ok(nov().lines.filter((l) => !l.matched).length >= 3);
    ['2026-07', '2026-08', '2026-09'].forEach((p) => assert.equal(E.S.periods[p], 'Closed'));
    // fee and interest journals landed in the right months
    stmts().filter((s) => s.period <= '2026-10').forEach((s) => {
      const js = E.S.journals.filter((j) => j.ref === s.id);
      assert.equal(js.length, 2, `${s.id} accounting`);
      js.forEach((j) => assert.equal(j.period, s.period));
    });
    assert.ok(E.closeChecklist('2026-09').find((c) => c.task === 'Bank statement reconciled').done);
    assert.equal(E.closeChecklist('2026-11').find((c) => c.task === 'Bank statement reconciled').done, false);
    invariants();
  });

  test('reconciliation difference equals the bank items not in the books', () => {
    const s = nov(); const r = E.bankReconReport(s.id);
    const un = r2(s.lines.filter((l) => !l.matched).reduce((a, l) => a + l.amount, 0));
    assert.equal(r.difference, un);
    assert.equal(r.adjustedBank, r2(r.closing + r.ditTotal + r.opTotal - r.bookedLaterTotal));
    assert.equal(r.book, E.bookBalanceAt('1000', s.endDate));
    assert.equal(r.complete, false);
    assert.throws(() => E.markStatementReconciled(s.id), /not matched/);
  });

  test('auto-match never double-matches and is idempotent', () => {
    const s = nov();
    // add a duplicate-amount GL entry so two lines compete
    const rentLine = s.lines.find((l) => l.desc.includes('RENT'));
    E.createJournal({ date: '2026-11-02', source: 'Payables', desc: 'Duplicate rent test', lines: [{ acct: '6100', dr: -rentLine.amount }, { acct: '1000', cr: -rentLine.amount }] });
    const n = E.autoMatchStatement(s.id);
    assert.ok(n >= 4, `matched ${n}`);
    noDoubleMatch();
    s.lines.filter((l) => l.matched).forEach((l) => {
      const j = E.je(l.matched);
      assert.equal(E.cashOf(j, '1000'), l.amount);
      assert.ok(Math.abs(E.util.daysBetween(j.date, l.date)) <= 5);
    });
    // reference beats date: the receipt line matches its own receipt journal
    const wire = s.lines.find((l) => l.type === 'WIRE');
    assert.ok(E.je(wire.matched).desc.includes(wire.ref));
    assert.equal(E.autoMatchStatement(s.id), 0);
    noDoubleMatch();
    assert.ok(E.unreconciledCash().some((x) => x.desc === 'Duplicate rent test'));
  });

  test('unmatch and rematch, with one-to-one and amount guards', () => {
    const s = nov(); E.autoMatchStatement(s.id);
    const l = s.lines.find((x) => x.matched); const jid = l.matched;
    E.unmatchBankLine(s.id, l.id);
    assert.equal(l.matched, null); assert.equal(l.status, 'Unmatched');
    assert.ok(E.unreconciledCash().some((x) => x.id === jid));
    const other = s.lines.find((x) => x.matched);
    assert.throws(() => E.matchBankLine(s.id, l.id, other.matched), /already matched|differ/);
    const wrong = E.unreconciledCash().find((x) => x.amount !== l.amount);
    if (wrong) assert.throws(() => E.matchBankLine(s.id, l.id, wrong.id), /differ/);
    E.matchBankLine(s.id, l.id, jid);
    assert.equal(l.matched, jid); assert.equal(l.status, 'Matched');
    assert.throws(() => E.matchBankLine(s.id, l.id, jid), /already matched/);
    // reconciled statements are locked
    const jul = stmts()[0];
    assert.throws(() => E.unmatchBankLine(jul.id, jul.lines[0].id), /reconciled/);
    noDoubleMatch();
  });

  test('create accounting for a fee posts balanced and reconciles; returned payment reopens AR', () => {
    const s = nov(); E.autoMatchStatement(s.id);
    const fee = s.lines.find((l) => l.kind === 'fee');
    const cash0 = E.balance('1000'), chg0 = E.balance('6600');
    const j = E.createBankAccounting(s.id, fee.id);
    assert.ok(balanced(j)); assert.equal(j.status, 'Posted'); assert.equal(j.ref, s.id);
    assert.equal(r2(E.balance('1000') - cash0), fee.amount);
    assert.equal(r2(E.balance('6600') - chg0), -fee.amount);
    assert.equal(fee.matched, j.id);
    assert.throws(() => E.createBankAccounting(s.id, fee.id), /already matched/);

    const ret = s.lines.find((l) => l.kind === 'returned');
    const rc = E.S.receipts.find((r) => r.id === ret.receiptId); const inv = E.arinv(rc.invoiceId);
    const paid0 = inv.paid, ar0 = E.balance('1100');
    const jr = E.createBankAccounting(s.id, ret.id);
    assert.ok(balanced(jr));
    assert.equal(r2(paid0 - inv.paid), rc.amount);
    assert.notEqual(inv.status, 'Paid');
    assert.equal(r2(E.balance('1100') - ar0), rc.amount);
    invariants();

    // everything else on the statement should now be matched; reconcile it
    s.lines.filter((l) => !l.matched).forEach((l) => E.createBankAccounting(s.id, l.id));
    const r = E.bankReconReport(s.id);
    assert.equal(r.difference, 0); assert.equal(r.complete, true);
    E.markStatementReconciled(s.id);
    assert.equal(s.status, 'Reconciled');
    assert.ok(E.closeChecklist('2026-11').find((c) => c.task === 'Bank statement reconciled').done);
    invariants();
    E.reopenBankStatement(s.id); assert.equal(s.status, 'Open');
    assert.throws(() => E.reopenBankStatement(stmts()[0].id), /Reopen/);
  });

  test('a throwing action leaves state unchanged', () => {
    const s = nov(); const before = JSON.stringify(E.S);
    assert.throws(() => E.matchBankLine(s.id, s.lines[0].id, 'JE-1001'), /opening/i);
    assert.throws(() => E.createBankAccounting(s.id, s.lines.find((l) => l.kind === 'fee').id, { date: '2026-08-15' }), /Closed/);
    assert.throws(() => E.createBankAccounting(s.id, s.lines.find((l) => l.kind === 'fee').id, { acct: '1100' }), /control/);
    assert.equal(JSON.stringify(E.S), before);
  });

  test('forecast: receipts and payments equal open AR / validated AP due within the horizon', () => {
    const f = E.cashForecast();
    assert.equal(f.weeks.length, 13);
    assert.equal(f.horizon, E.util.addDays(E.TODAY, 90));
    const ar = r2(E.S.arInvoices.filter((i) => i.status !== 'Paid' && i.due <= f.horizon).reduce((a, i) => a + i.total - i.paid, 0));
    const ap = r2(E.S.apInvoices.filter((i) => i.status === 'Validated' && i.due <= f.horizon).reduce((a, i) => a + i.total - i.paid, 0));
    assert.equal(f.totals.receipts, ar);
    assert.equal(f.totals.payments, -ap);
    const netPay = r2(E.S.employees.filter((e) => e.status === 'Active').reduce((a, e) => a + r2(e.salary / 12), 0) * (1 - E.WITHHOLDING_RATE));
    assert.equal(f.netPayEstimate, netPay);
    const payrolls = f.items.filter((x) => x.kind === 'payroll');
    assert.ok(payrolls.length >= 3 && payrolls.every((x) => x.date === E.util.periodEnd(x.date.slice(0, 7))));
    assert.ok(f.items.filter((x) => x.kind === 'rent').length >= 3);
    assert.equal(f.opening, E.balance('1000'));
    let bal = f.opening; f.weeks.forEach((w) => { assert.equal(w.opening, bal); bal = r2(bal + w.net); assert.equal(w.closing, bal); });
    assert.equal(r2(f.totals.receipts + f.totals.payments + f.totals.payroll + f.totals.rent), f.totals.net);
  });

  test('hooks: search, permissions, reconcile row', () => {
    assert.ok(E.search('BST-').some((h) => h.kind === 'bankstmt'));
    assert.ok(E.can('Controller', 'cash.reconcile'));
    assert.ok(E.can('AP Specialist', 'cash.reconcile'));
    assert.ok(!E.can('Buyer', 'cash.reconcile'));
    const row = E.reconcile().find((r) => /Bank statement vs book/.test(r.name));
    assert.ok(row && row.ok);
  });
});
