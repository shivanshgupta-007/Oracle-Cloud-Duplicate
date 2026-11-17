/* Revenue recognition and year-end close tests. */
const test = require('node:test');
const assert = require('node:assert');
const { E, seed } = require('../js/load-node.js');
const { r2, sum } = E.util;

const NOV = '2026-11';
const recRow = (acct) => E.reconcile().find((r) => r.acct === acct);
const allOk = () => E.reconcile().filter((r) => !r.ok);
const tbOk = () => { const tb = E.trialBalance(); assert.ok(Math.abs(tb.dr - tb.cr) < 0.005, 'TB balanced'); };
const C = () => E.S.customers[0].id;

test.describe('revenue recognition', () => {
  test.beforeEach(() => seed());

  test('seed: contracts exist, Jul-Oct run, Nov due, deferred revenue reconciles', () => {
    assert.ok(E.S.rcontracts.length >= 6);
    ['2026-07', '2026-08', '2026-09', '2026-10'].forEach((p) => assert.ok(E.S.revrecRuns[p], p));
    assert.ok(!E.S.revrecRuns[NOV]);
    assert.deepStrictEqual(E.recognitionDuePeriods(), [NOV]);
    assert.ok(recRow('2450').ok && recRow('2450').gl > 0);
    assert.deepStrictEqual(allOk(), []); tbOk();
    assert.ok(!E.S.journals.some((j) => j.status === 'Pending Approval' && j.period < '2026-10'));
    assert.ok(E.S.arInvoices.some((i) => String(i.ref || '').startsWith('RC-') && i.status === 'Paid'));
  });

  test('schedule sums exactly to the contract total; rounding goes to the last month', () => {
    const c = E.createContract({ customerId: C(), start: '2026-11-05', term: 7, billing: 'annual', lines: [{ service: 'SV-300', qty: 1, price: 1000 }] });
    assert.strictEqual(c.total, 1000);
    assert.strictEqual(sum(c.schedule, (s) => s.amount), 1000);
    assert.strictEqual(c.schedule[0].amount, 142.86);
    assert.strictEqual(c.schedule[6].amount, r2(1000 - 142.86 * 6));
    assert.strictEqual(c.installments.length, 1); assert.ok(c.installments[0].invoiceId);
    const m = E.contractPreview({ customerId: C(), start: '2026-11-05', term: 24, billing: 'monthly', lines: [{ service: 'SV-100', qty: 3 }] });
    assert.strictEqual(m.total, 10800); assert.strictEqual(m.installments.length, 24);
    assert.strictEqual(sum(m.installments, (i) => i.amount), 10800);
  });

  test('recognition posts once per period, Dr 2450 / Cr 4200, and reconciles', () => {
    const pv = E.recognitionPreview(NOV); assert.ok(pv.total > 0);
    const before = E.balance('4200');
    const j = E.runRecognition(NOV);
    assert.strictEqual(j.date, '2026-11-30');
    assert.strictEqual(j.lines.find((l) => l.acct === '2450').dr, pv.total);
    assert.strictEqual(r2(before - E.balance('4200')), pv.service);
    assert.throws(() => E.runRecognition(NOV), /already run/);
    assert.throws(() => E.runRecognition('2026-12'), /Future/);
    assert.strictEqual(E.recognitionPreview(NOV).total, 0);
    assert.deepStrictEqual(allOk(), []); tbOk();
    const c = E.createContract({ customerId: C(), start: '2026-10-10', term: 12, lines: [{ service: 'SV-100', qty: 1 }] });
    assert.strictEqual(c.schedule[0].status, 'Scheduled'); // Oct already run: caught up by a later run
    const chk = E.closeChecklist(NOV).find((t) => t.task === 'Revenue recognition run');
    assert.strictEqual(chk.done, true);
    assert.strictEqual(E.closeChecklist('2026-12').find((t) => t.task === 'Revenue recognition run').done, false);
  });

  test('relative SSP allocation by hand; instruments at start to 4000', () => {
    // 2 loggers at 900 (SSP 980) + 2 x SV-100 at 1500 (SSP 1800): price 4800, SSP weights 1960 / 3600
    const c = E.createContract({ customerId: C(), start: '2026-11-02', term: 12, lines: [{ sku: 'PL-500', qty: 2, price: 900, ssp: 980 }, { service: 'SV-100', qty: 2, price: 1500, ssp: 1800 }] });
    assert.strictEqual(c.total, 4800);
    const prod = r2(4800 * 1960 / 5560);
    assert.strictEqual(c.lines[0].allocated, prod); // 1692.09
    assert.strictEqual(c.lines[1].allocated, r2(4800 - prod));
    assert.strictEqual(c.schedule[0].product, prod);
    assert.strictEqual(c.schedule[0].service, r2(c.lines[1].allocated / 12));
    assert.strictEqual(sum(c.schedule, (s) => s.amount), 4800);
    const b4000 = E.balance('4000'); E.runRecognition(NOV);
    const j = E.je(E.S.revrecRuns[NOV]); const cr4000 = j.lines.find((l) => l.acct === '4000').cr;
    assert.ok(cr4000 >= prod); assert.strictEqual(r2(b4000 - E.balance('4000')), cr4000);
  });

  test('cancellation: unpaid invoice credited, paid portion to refund liability, reconciles', () => {
    // unpaid: annual contract started in Nov
    const a = E.createContract({ customerId: C(), start: '2026-11-01', term: 12, lines: [{ service: 'SV-100', qty: 2 }] }); // 3600, 300/month
    const invA = E.arinv(a.installments[0].invoiceId); const ar = E.balance('1100');
    const x = E.cancelPreview(a.id, '2026-11-17');
    assert.strictEqual(x.months, 11); assert.strictEqual(x.dropped, 3300); assert.strictEqual(x.credit, 3300); assert.strictEqual(x.refund, 0);
    E.cancelContract(a.id, '2026-11-17', 'Test');
    assert.strictEqual(E.openAmt(invA), 300); assert.strictEqual(r2(ar - E.balance('1100')), 3300);
    assert.strictEqual(E.contractDeferred(a), 300);
    // paid: seeded Jul contract invoice was collected
    const b = E.S.rcontracts.find((c) => c.start === '2026-07-06');
    assert.strictEqual(E.arinv(b.installments[0].invoiceId).status, 'Paid');
    const def = E.contractDeferred(b); // Nov and later = 8 months x 1500
    assert.strictEqual(def, 12000);
    E.cancelContract(b.id, '2026-11-10');
    assert.strictEqual(b.refundOpen, 10500); assert.strictEqual(E.contractDeferred(b), 1500);
    assert.strictEqual(recRow('2410').gl, 10500);
    // monthly contract: unbilled months simply drop
    const m = E.S.rcontracts.find((c) => c.billing === 'monthly');
    const pm = E.cancelPreview(m.id, '2026-11-17'); assert.strictEqual(pm.credit + pm.refund, 0); assert.ok(pm.unbilled > 0);
    E.cancelContract(m.id, '2026-11-17');
    assert.throws(() => E.cancelContract(m.id, '2026-11-17'), /Cancelled/);
    assert.deepStrictEqual(allOk(), []); tbOk();
    E.runRecognition(NOV); assert.deepStrictEqual(allOk(), []);
  });

  test('waterfall (billed only) totals equal the deferred revenue balance; roll-forward ties to GL', () => {
    const w = E.revenueWaterfall(null, { billedOnly: true });
    assert.strictEqual(w.total, r2(-E.balance('2450')));
    assert.strictEqual(r2(sum(w.totals) + w.later), w.total);
    E.runRecognition(NOV);
    const w2 = E.revenueWaterfall('2026-12', { billedOnly: true });
    assert.strictEqual(w2.total, r2(-E.balance('2450')));
    const rf = E.deferredRollForward('2026-07', NOV);
    assert.strictEqual(rf.closing, rf.gl);
    assert.strictEqual(rf.opening, 0);
    const rf2 = E.deferredRollForward('2026-09', NOV);
    assert.strictEqual(rf2.opening, r2(-E.balance('2450', { toPeriod: '2026-08' })));
    assert.strictEqual(rf2.closing, rf2.gl);
  });

  test('search finds contracts', () => {
    const hits = E.search('RC-100'); assert.ok(hits.some((h) => h.kind === 'rcontract'));
  });
});

test.describe('year-end close', () => {
  test.beforeEach(() => seed());

  const months = ['2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06'];
  function driveToJune() {
    E.S.journals.filter((j) => j.status === 'Pending Approval').forEach((j) => E.approveJournal(j.id));
    E.closePeriod('2026-10'); E.closePeriod('2026-11');
    months.forEach((p) => { E.openPeriod(p); if (p !== '2027-06') E.closePeriod(p); });
  }

  test('preconditions enforced', () => {
    const pv = E.yearEndPreview('FY2027');
    assert.strictEqual(pv.ready, false);
    assert.throws(() => E.yearEndClose('FY2027'), /blocked/);
    assert.ok(pv.lines.length > 0);
    assert.strictEqual(sum(pv.lines, (l) => l.dr), sum(pv.lines, (l) => l.cr));
    // pending journal in June blocks
    E.S.journals.filter((j) => j.status === 'Pending Approval').forEach((j) => E.rejectJournal(j.id, 'test'));
    E.closePeriod('2026-10'); E.closePeriod('2026-11');
    months.forEach((p) => { E.openPeriod(p); if (p !== '2027-06') E.closePeriod(p); });
    E.createManualJournal({ date: '2027-06-15', desc: 'Big pending', lines: [{ acct: '6800', dr: 60000 }, { acct: '1000', cr: 60000 }] });
    assert.throws(() => E.yearEndClose('FY2027'), /awaiting approval|pending/i);
  });

  test('closing zeroes P&L accounts and moves net income to retained earnings', () => {
    driveToJune();
    const ni = E.incomeStatement('2026-07', '2027-06').netIncome;
    const pv = E.yearEndPreview('FY2027'); assert.ok(pv.ready); assert.strictEqual(pv.netIncome, ni);
    const re = E.balance('3100');
    const j = E.yearEndClose('FY2027');
    assert.strictEqual(j.date, '2027-06-30'); assert.strictEqual(E.S.yearEnd.FY2027, j.id);
    const b = E.balances({ fromPeriod: '2026-07', toPeriod: '2027-06' });
    E.S.accounts.filter((a) => a.type === 'Revenue' || a.type === 'Expense').forEach((a) => assert.strictEqual(b[a.code] || 0, 0, a.code));
    assert.strictEqual(r2(re - E.balance('3100')), ni);
    assert.strictEqual(E.incomeStatement('2026-07', '2027-06').netIncome, 0);
    assert.ok(j.lines.every((l) => (l.entity || 'US01') === 'US01' || l.entity));
    assert.ok(E.balanceSheet('2027-06').balanced); tbOk();
    assert.throws(() => E.yearEndClose('FY2027'), /already closed|blocked/);
  });
});
