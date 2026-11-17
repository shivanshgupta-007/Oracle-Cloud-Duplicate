/* Ledgerline Suite: independent, adversarial engine tests.
 * Run: node --test tests/
 * Uses only node:test and node:assert/strict.
 */
'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');
const seed = require('../js/seed.js');

const r2 = (n) => Math.round((+n + Number.EPSILON) * 100) / 100;
const NOV = '2026-11-17';

// ---------- invariant helpers ----------
function journalBalanced(j) {
  const dr = j.lines.reduce((a, l) => a + l.dr, 0), cr = j.lines.reduce((a, l) => a + l.cr, 0);
  return Number.isFinite(dr) && Number.isFinite(cr) && Math.abs(dr - cr) < 0.005;
}
function assertInvariants(label = '') {
  const S = E.S;
  for (const j of S.journals) assert.ok(journalBalanced(j), `${label} journal ${j.id} unbalanced`);
  const tb = E.trialBalance();
  assert.ok(Number.isFinite(tb.dr) && Number.isFinite(tb.cr), `${label} TB not finite`);
  assert.ok(Math.abs(tb.dr - tb.cr) < 0.005, `${label} TB dr ${tb.dr} != cr ${tb.cr}`);
  const bs = E.balanceSheet();
  assert.equal(bs.balanced, true, `${label} balance sheet not balanced`);
  for (const r of E.reconcile()) assert.ok(r.ok, `${label} reconcile ${r.name}: sub ${r.sub} gl ${r.gl}`);
  for (const it of S.items) {
    assert.ok(it.onHand >= 0, `${label} ${it.sku} onHand ${it.onHand} < 0`);
    assert.ok(Number.isFinite(it.avgCost), `${label} ${it.sku} avgCost ${it.avgCost}`);
  }
}
const snap = () => JSON.stringify(E.S);
const restore = (s) => E.load(JSON.parse(s));
const asUser = (role, user, fn) => { const r = E.S.role, u = E.S.user; E.S.role = role; E.S.user = user; try { return fn(); } finally { E.S.role = r; E.S.user = u; } };
const supId = () => E.S.suppliers[0].id;
const custByName = (n) => E.S.customers.find((c) => c.name === n);
const empByName = (n) => E.S.employees.find((e) => e.name === n);
function makeReceivedPO(sku = 'HX-100', qty = 100, price = 40, receive = qty) {
  const p = E.createPO({ supplierId: supId(), date: NOV, lines: [{ sku, qty, price }] });
  if (receive) E.receivePO(p.id, NOV, [receive]);
  return p;
}

beforeEach(() => { seed(); });

// =====================================================================
describe('seed invariants', () => {
  test('every journal balanced', () => {
    assert.ok(E.S.journals.length > 50);
    for (const j of E.S.journals) assert.ok(journalBalanced(j), j.id);
  });
  test('journals only in Jul..Nov (periods that were open when posted)', () => {
    for (const j of E.S.journals) {
      assert.ok(j.period >= '2026-07' && j.period <= '2026-11', `${j.id} in ${j.period}`);
      assert.equal(j.period, j.date.slice(0, 7));
    }
  });
  test('period statuses', () => {
    const P = E.S.periods;
    for (const p of ['2026-07', '2026-08', '2026-09']) assert.equal(P[p], 'Closed');
    for (const p of ['2026-10', '2026-11']) assert.equal(P[p], 'Open');
    for (const p of ['2026-12', '2027-01', '2027-06']) assert.equal(P[p], 'Future');
    assert.equal(E.S.role, 'Administrator');
    assert.equal(E.TODAY, '2026-11-17');
  });
  test('TB nets to zero, BS balanced, all reconciled, no negative stock', () => {
    assertInvariants('seed');
    assert.equal(E.reconcile().length, 4);
    assert.ok(E.reconcile().every((r) => r.ok));
  });
  test('BS identity A = L + E (+ earnings) computed independently', () => {
    const b = E.balances();
    let a = 0, l = 0, eq = 0, rev = 0, exp = 0;
    for (const ac of E.S.accounts) {
      const v = b[ac.code] || 0;
      if (ac.type === 'Asset') a += v; else if (ac.type === 'Liability') l -= v; else if (ac.type === 'Equity') eq -= v;
      else if (ac.type === 'Revenue') rev -= v; else exp += v;
    }
    assert.ok(Math.abs(a - (l + eq + rev - exp)) < 0.01);
  });
  test('approvals inbox: one each of req, je, apinv, so + 2 absences', () => {
    const k = {}; E.approvalsInbox().forEach((x) => (k[x.kind] = (k[x.kind] || 0) + 1));
    assert.deepEqual(k, { req: 1, je: 1, apinv: 1, so: 1, abs: 2 });
  });
});

// =====================================================================
describe('GL rules', () => {
  test('unbalanced journal throws', () => {
    assert.throws(() => E.createJournal({ date: NOV, lines: [{ acct: '6100', dr: 100 }, { acct: '1000', cr: 99.99 }] }), /out of balance/);
  });
  test('posting into closed Sep or future Dec throws; no journal added', () => {
    const n = E.S.journals.length;
    const lines = [{ acct: '6100', dr: 10 }, { acct: '1000', cr: 10 }];
    assert.throws(() => E.createJournal({ date: '2026-09-15', lines }), /Closed/);
    assert.throws(() => E.createJournal({ date: '2026-12-01', lines }), /Future/);
    assert.throws(() => E.createJournal({ date: '2027-07-01', lines }), /No accounting period/);
    assert.throws(() => E.createJournal({ date: '2026-11-xx', lines }), /valid date/);
    assert.equal(E.S.journals.length, n);
  });
  test('line with both dr and cr throws', () => {
    assert.throws(() => E.createJournal({ date: NOV, lines: [{ acct: '6100', dr: 10, cr: 10 }, { acct: '1000', dr: 10 }, { acct: '1000', cr: 10 }] }), /not both/);
  });
  test('unknown account throws; negative amount throws; empty throws', () => {
    assert.throws(() => E.createJournal({ date: NOV, lines: [{ acct: '9999', dr: 10 }, { acct: '1000', cr: 10 }] }), /does not exist/);
    assert.throws(() => E.createJournal({ date: NOV, lines: [{ acct: '6100', dr: -10 }, { acct: '1000', cr: -10 }] }), /negative/);
    assert.throws(() => E.createJournal({ date: NOV, lines: [] }), /at least one line/);
  });
  test('non-finite amounts are rejected (Infinity must not bypass balance check)', { todo: 'engine bug: engine.js:115-116 Infinity-Infinity=NaN passes the balance check' }, () => {
    assert.throws(() => E.createJournal({ date: NOV, lines: [{ acct: '6100', dr: Infinity }, { acct: '1000', cr: Infinity }] }));
    assertInvariants('after infinity');
  });
  test('manual journal > limit is Pending and does not affect balances until approved', () => {
    const before = E.balances();
    const amt = E.JE_APPROVAL_LIMIT + 0.01;
    const j = E.createManualJournal({ date: NOV, desc: 'Big accrual', lines: [{ acct: '6100', dr: amt }, { acct: '2200', cr: amt }] });
    assert.equal(j.status, 'Pending Approval');
    assert.deepEqual(E.balances(), before);
    assert.ok(E.approvalsInbox().some((x) => x.kind === 'je' && x.id === j.id));
    asUser('Controller', 'Someone Else', () => E.approveJournal(j.id));
    assert.equal(j.status, 'Posted');
    assert.equal(E.balance('6100'), r2(before['6100'] + amt));
    assertInvariants();
  });
  test('manual journal exactly at limit posts directly', () => {
    const j = E.createManualJournal({ date: NOV, desc: 'At limit', lines: [{ acct: '6100', dr: E.JE_APPROVAL_LIMIT }, { acct: '1000', cr: E.JE_APPROVAL_LIMIT }] });
    assert.equal(j.status, 'Posted');
  });
  test('manual journal needs description', () => {
    assert.throws(() => E.createManualJournal({ date: NOV, desc: '  ', lines: [{ acct: '6100', dr: 1 }, { acct: '1000', cr: 1 }] }), /Describe/);
  });
  test('segregation of duties on journal approval', () => {
    E.S.role = 'Controller'; E.S.user = 'X';
    const j = E.createManualJournal({ date: NOV, desc: 'SoD', lines: [{ acct: '6100', dr: 60000 }, { acct: '2200', cr: 60000 }] });
    assert.throws(() => E.approveJournal(j.id), /segregation/);
    assert.equal(j.status, 'Pending Approval');
    E.S.user = 'Y';
    E.approveJournal(j.id);
    assert.equal(j.status, 'Posted');
    assert.equal(j.approvedBy, 'Y');
    assert.throws(() => E.approveJournal(j.id), /not awaiting/);
  });
  test('rejected journal never affects balances and cannot be approved', () => {
    const before = E.balances();
    const j = E.createManualJournal({ date: NOV, desc: 'Rej', lines: [{ acct: '6100', dr: 70000 }, { acct: '2200', cr: 70000 }] });
    E.rejectJournal(j.id, 'no');
    assert.throws(() => asUser('Controller', 'Z', () => E.approveJournal(j.id)));
    assert.deepEqual(E.balances(), before);
  });
  test('closePeriod blocked by a pending journal in that period', () => {
    const j = E.createManualJournal({ date: '2026-10-20', desc: 'Oct pending', lines: [{ acct: '6100', dr: 60000 }, { acct: '2200', cr: 60000 }] });
    assert.throws(() => E.closePeriod('2026-10'), /awaiting approval/);
    assert.equal(E.S.periods['2026-10'], 'Open');
    E.rejectJournal(j.id);
    E.closePeriod('2026-10');
    assert.equal(E.S.periods['2026-10'], 'Closed');
    // seed's Nov pending journal blocks Nov close
    assert.throws(() => E.closePeriod('2026-11'), /awaiting approval/);
  });
  test('approving a pending journal whose period has since closed throws', () => {
    const j = E.createManualJournal({ date: '2026-10-20', desc: 'Oct pending', lines: [{ acct: '6100', dr: 60000 }, { acct: '2200', cr: 60000 }] });
    E.rejectJournal(j.id); // must be resolved to close; verify a stale closed-period approve path by forcing state
    const k = E.createManualJournal({ date: NOV, desc: 'x', lines: [{ acct: '6100', dr: 60000 }, { acct: '2200', cr: 60000 }] });
    E.S.periods['2026-11'] = 'Closed';
    assert.throws(() => asUser('Controller', 'Q', () => E.approveJournal(k.id)), /Closed/);
  });
  test('periods close and open in order', () => {
    // Nov can't close while Oct open (reject Nov pending first so the order rule is what fires)
    const pend = E.approvalsInbox().find((x) => x.kind === 'je');
    E.rejectJournal(pend.id);
    assert.throws(() => E.closePeriod('2026-11'), /in order/);
    assert.throws(() => E.closePeriod('2026-12'), /not open/);
    assert.throws(() => E.closePeriod('2026-09'), /not open/);
    assert.throws(() => E.openPeriod('2027-01'), /in order/);
    assert.throws(() => E.openPeriod('2026-11'), /not a future/);
    E.openPeriod('2026-12'); E.openPeriod('2027-01');
    assert.equal(E.S.periods['2027-01'], 'Open');
    E.closePeriod('2026-10'); E.closePeriod('2026-11');
    assert.equal(E.S.periods['2026-11'], 'Closed');
  });
  test('reopen a closed period then posting is allowed', () => {
    const lines = [{ acct: '6100', dr: 10 }, { acct: '1000', cr: 10 }];
    assert.throws(() => E.createJournal({ date: '2026-09-30', lines }));
    assert.throws(() => E.reopenPeriod('2026-10'), /not closed/);
    E.reopenPeriod('2026-09');
    const j = E.createJournal({ date: '2026-09-30', lines });
    assert.equal(j.period, '2026-09');
    assertInvariants();
  });
  test('trial balance by period excludes later periods', () => {
    const before = E.trialBalance('2026-10');
    E.createJournal({ date: NOV, lines: [{ acct: '6100', dr: 123 }, { acct: '1000', cr: 123 }] });
    assert.deepEqual(E.trialBalance('2026-10'), before);
  });
});

// =====================================================================
describe('procure to pay', () => {
  test('req <= limit auto-approved, > limit pending', () => {
    const a = E.createReq({ date: NOV, lines: [{ sku: 'HX-100', qty: 100, price: 100 }] }); // exactly 10,000
    assert.equal(a.status, 'Approved');
    const b = E.createReq({ date: NOV, lines: [{ sku: 'HX-100', qty: 100, price: 100.01 }] });
    assert.equal(b.status, 'Pending Approval');
  });
  test('PO from unapproved req throws; approve then PO ok and req Ordered', () => {
    const r = E.createReq({ date: NOV, lines: [{ sku: 'HX-100', qty: 1000, price: 40 }] });
    assert.throws(() => E.createPO({ reqId: r.id, supplierId: supId(), date: NOV }), /must be approved/);
    E.approveReq(r.id);
    const p = E.createPO({ reqId: r.id, supplierId: supId(), date: NOV });
    assert.equal(r.status, 'Ordered');
    assert.equal(p.total, 40000);
    assert.throws(() => E.createPO({ reqId: r.id, supplierId: supId(), date: NOV }), /must be approved/);
  });
  test('rejected req cannot become a PO', () => {
    const r = E.createReq({ date: NOV, lines: [{ sku: 'HX-100', qty: 1000, price: 40 }] });
    E.rejectReq(r.id, 'no');
    assert.throws(() => E.createPO({ reqId: r.id, supplierId: supId(), date: NOV }));
  });
  test('PO from an approved req cannot exceed the approved requisition', { todo: 'engine bug: engine.js:267 createPO({reqId, lines}) ignores the approved req lines/total, so a <=$10k auto-approved req can become a PO of any size' }, () => {
    const r = E.createReq({ date: NOV, lines: [{ sku: 'HX-100', qty: 10, price: 40 }] });
    assert.equal(r.status, 'Approved');
    assert.throws(() => E.createPO({ reqId: r.id, supplierId: supId(), date: NOV, lines: [{ sku: 'HX-100', qty: 100000, price: 40 }] }));
  });
  test('receive more than ordered throws; fractional throws; receive into closed period throws', () => {
    const p = E.createPO({ supplierId: supId(), date: NOV, lines: [{ sku: 'HX-100', qty: 10, price: 40 }] });
    const s = snap();
    assert.throws(() => E.receivePO(p.id, NOV, [11]), /left to receive/);
    assert.throws(() => E.receivePO(p.id, NOV, [1.5]), /whole/);
    assert.throws(() => E.receivePO(p.id, '2026-09-10', [5]), /Closed/);
    assert.throws(() => E.receivePO(p.id, NOV, [0]), /at least one/);
    assert.equal(snap(), s, 'failed receipts must not mutate state');
    E.receivePO(p.id, NOV, [6]);
    assert.equal(p.status, 'Partially Received');
    assert.throws(() => E.receivePO(p.id, NOV, [5]), /left to receive/);
    E.receivePO(p.id, NOV, [4]);
    assert.equal(p.status, 'Received');
    assert.throws(() => E.receivePO(p.id, NOV, [1]), /fully received/);
    assertInvariants();
  });
  test('receipt updates weighted average cost', () => {
    const it = E.item('HX-310');
    const n0 = it.onHand, a0 = it.avgCost, inv0 = E.balance('1200'), rni0 = E.balance('2100');
    const p = E.createPO({ supplierId: supId(), date: NOV, lines: [{ sku: 'HX-310', qty: 37, price: 333.33 }] });
    E.receivePO(p.id, NOV, [37]);
    assert.equal(it.avgCost, r2((n0 * a0 + 37 * 333.33) / (n0 + 37)));
    assert.equal(it.onHand, n0 + 37);
    assert.equal(it.lastCost, 333.33);
    assert.equal(r2(E.balance('2100') - rni0), -r2(37 * 333.33));
    // GL 1200 change = 37 * 333.33 plus any rounding true-up against 5100
    assert.ok(Math.abs(E.balance('1200') - inv0 - 37 * 333.33) < 1);
    assertInvariants();
  });
  test('AP invoice qty > received -> On Hold, no GL effect; releaseHold cannot override', () => {
    const p = makeReceivedPO('HX-100', 100, 40, 60);
    const before = E.balances(); const nj = E.S.journals.length;
    const inv = E.enterAPInvoice({ poId: p.id, number: 'Q-1', date: NOV, lines: [{ line: 0, qty: 61, price: 40 }] });
    assert.equal(inv.status, 'On Hold');
    assert.ok(inv.holds.length >= 1);
    assert.deepEqual(E.balances(), before); assert.equal(E.S.journals.length, nj);
    assert.throws(() => E.releaseHold(inv.id), /received/);
    assertInvariants();
  });
  test('AP invoice price > 5% off -> On Hold; release posts', () => {
    const p = makeReceivedPO('HX-100', 100, 40);
    const before = E.balances();
    const inv = E.enterAPInvoice({ poId: p.id, number: 'P-1', date: NOV, lines: [{ line: 0, qty: 100, price: 42.01 }] });
    assert.equal(inv.status, 'On Hold');
    assert.deepEqual(E.balances(), before);
    assertInvariants();
    E.releaseHold(inv.id);
    assert.equal(inv.status, 'Validated');
    assert.equal(r2(E.balance('5100') - before['5100']), r2((42.01 - 40) * 100));
    assert.equal(r2(before['2000'] - E.balance('2000')), r2(42.01 * 100));
    assert.equal(p.status, 'Closed');
    assertInvariants();
  });
  test('AP invoice below price by > 5% also holds', () => {
    const p = makeReceivedPO('HX-100', 100, 40);
    const inv = E.enterAPInvoice({ poId: p.id, number: 'P-2', date: NOV, lines: [{ line: 0, qty: 10, price: 37.99 }] });
    assert.equal(inv.status, 'On Hold');
  });
  test('within tolerance -> Validated with PPV = (inv - PO) * qty', () => {
    for (const [price, q] of [[41.99, 73], [38.01, 50], [40, 10]]) {
      seed();
      const p = makeReceivedPO('HX-100', 100, 40);
      const b5100 = E.balance('5100'), b2100 = E.balance('2100'), b2000 = E.balance('2000');
      const inv = E.enterAPInvoice({ poId: p.id, number: 'T-' + price, date: NOV, lines: [{ line: 0, qty: q, price }] });
      assert.equal(inv.status, 'Validated');
      assert.equal(r2(E.balance('5100') - b5100), r2((price - 40) * q));
      assert.equal(r2(E.balance('2100') - b2100), r2(40 * q));
      assert.equal(r2(b2000 - E.balance('2000')), r2(price * q));
      assertInvariants();
    }
  });
  test('duplicate invoice number from same supplier throws; cancelled frees the number', () => {
    const p = makeReceivedPO('HX-100', 100, 40);
    E.enterAPInvoice({ poId: p.id, number: 'D-1', date: NOV, lines: [{ line: 0, qty: 10, price: 40 }] });
    assert.throws(() => E.enterAPInvoice({ poId: p.id, number: 'D-1', date: NOV, lines: [{ line: 0, qty: 10, price: 40 }] }), /duplicate/);
    const h = E.enterAPInvoice({ poId: p.id, number: 'D-2', date: NOV, lines: [{ line: 0, qty: 10, price: 99 }] });
    E.cancelAPInvoice(h.id);
    E.enterAPInvoice({ poId: p.id, number: 'D-2', date: NOV, lines: [{ line: 0, qty: 10, price: 40 }] });
    assertInvariants();
  });
  test('a pending (On Hold) invoice reserves received qty for later invoices', () => {
    const p = makeReceivedPO('HX-100', 100, 40);
    E.enterAPInvoice({ poId: p.id, number: 'H-1', date: NOV, lines: [{ line: 0, qty: 80, price: 50 }] }); // price hold
    const b = E.enterAPInvoice({ poId: p.id, number: 'H-2', date: NOV, lines: [{ line: 0, qty: 30, price: 40 }] });
    assert.equal(b.status, 'On Hold');
  });
  test('splitting the same PO line across invoice lines cannot bill more than received', { todo: 'engine bug: engine.js:315-318 and 330 check each invoice line separately against pl.invoiced, so duplicate {line:0} entries bypass the 3-way qty match' }, () => {
    const p = makeReceivedPO('HX-100', 100, 40, 60);
    const inv = E.enterAPInvoice({ poId: p.id, number: 'S-1', date: NOV, lines: [{ line: 0, qty: 50, price: 40 }, { line: 0, qty: 50, price: 40 }] });
    assert.equal(inv.status, 'On Hold');
    assert.ok(p.lines[0].invoiced <= p.lines[0].received);
  });
  test('invoice against a non-existent PO line throws a user-readable error', { todo: 'engine bug: engine.js:312 p.lines[+l.line] undefined -> TypeError instead of a user-readable Error' }, () => {
    const p = makeReceivedPO('HX-100', 10, 40);
    assert.throws(() => E.enterAPInvoice({ poId: p.id, number: 'X', date: NOV, lines: [{ line: 5, qty: 1, price: 40 }] }), (e) => !(e instanceof TypeError));
  });
  test('payInvoices reduces 2000 and 1000 by same amount; paid invoice cannot be repaid', () => {
    const p = makeReceivedPO('HX-100', 100, 40);
    const inv = E.enterAPInvoice({ poId: p.id, number: 'Pay-1', date: NOV, lines: [{ line: 0, qty: 100, price: 40.5 }] });
    const seedInv = E.S.apInvoices.find((i) => i.status === 'Validated' && i.id !== inv.id);
    const c0 = E.balance('1000'), a0 = E.balance('2000');
    const expect = r2(inv.total + seedInv.total);
    const pays = E.payInvoices([inv.id, seedInv.id], NOV, 'ACH');
    assert.equal(pays.length, 2); // different suppliers -> one payment each
    assert.equal(r2(c0 - E.balance('1000')), expect);
    assert.equal(r2(E.balance('2000') - a0), expect);
    assert.equal(inv.status, 'Paid');
    assert.throws(() => E.payInvoices([inv.id], NOV), /Paid/);
    assertInvariants();
  });
  test('payInvoices refuses On Hold invoices', () => {
    const hold = E.S.apInvoices.find((i) => i.status === 'On Hold');
    assert.throws(() => E.payInvoices([hold.id], NOV), /On Hold/);
  });
  test('payment exceeding cash throws and changes nothing', () => {
    E.createJournal({ date: NOV, lines: [{ acct: '6100', dr: E.balance('1000') - 100 }, { acct: '1000', cr: E.balance('1000') - 100 }] });
    const p = makeReceivedPO('HX-100', 100, 40);
    const inv = E.enterAPInvoice({ poId: p.id, number: 'Big', date: NOV, lines: [{ line: 0, qty: 100, price: 40 }] });
    const s = snap();
    assert.throws(() => E.payInvoices([inv.id], NOV), /exceeds operating cash/);
    assert.equal(snap(), s);
  });
  test('the same invoice listed twice in one payment is not paid twice', { todo: 'engine bug: engine.js:353-366 payInvoices does not de-duplicate ids; [id,id] debits 2000 by 2x the invoice and breaks the AP reconciliation' }, () => {
    const inv = E.S.apInvoices.find((i) => i.status === 'Validated');
    const c0 = E.balance('1000');
    try { E.payInvoices([inv.id, inv.id], NOV); } catch (e) { /* throwing is also acceptable */ }
    assert.ok(r2(c0 - E.balance('1000')) <= inv.total);
    assertInvariants();
  });
  test('reconcile ok after each step of a full P2P cycle', () => {
    const r = E.createReq({ date: NOV, lines: [{ sku: 'KT-900', qty: 300, price: 75 }] }); assertInvariants('req');
    E.approveReq(r.id);
    const p = E.createPO({ reqId: r.id, supplierId: supId(), date: NOV }); assertInvariants('po');
    E.receivePO(p.id, NOV, [120]); assertInvariants('rcv1');
    const i1 = E.enterAPInvoice({ poId: p.id, number: 'C-1', date: NOV, lines: [{ line: 0, qty: 120, price: 76.1 }] }); assertInvariants('inv1');
    E.receivePO(p.id, NOV, [180]); assertInvariants('rcv2');
    const i2 = E.enterAPInvoice({ poId: p.id, number: 'C-2', date: NOV, lines: [{ line: 0, qty: 180, price: 90 }] }); assertInvariants('inv2 hold');
    E.releaseHold(i2.id, '2026-11-18'); assertInvariants('release');
    assert.equal(i2.date, '2026-11-18');
    E.payInvoices([i1.id, i2.id], NOV); assertInvariants('pay');
    assert.equal(p.status, 'Closed');
  });
  test('releaseHold with a closed-period date throws', () => {
    const hold = E.S.apInvoices.find((i) => i.status === 'On Hold');
    assert.throws(() => E.releaseHold(hold.id, '2026-09-30'), /Closed/);
  });
});

// =====================================================================
describe('order to cash', () => {
  test('order over credit -> Credit Hold; ship throws until released', () => {
    const c = custByName('Pinecrest University');
    const o = E.createSO({ customerId: c.id, date: NOV, lines: [{ sku: 'HX-100', qty: 1, price: c.creditLimit }] });
    assert.equal(o.status, 'Credit Hold');
    assert.ok(E.approvalsInbox().some((x) => x.kind === 'so' && x.id === o.id));
    assert.throws(() => E.shipSO(o.id, NOV), /credit hold/);
    E.releaseCreditHold(o.id);
    assert.equal(o.status, 'Booked');
    E.shipSO(o.id, NOV);
    assert.equal(o.status, 'Invoiced');
    assertInvariants();
  });
  test('booked orders count toward exposure', () => {
    const c = custByName('Pinecrest University');
    const room = r2(c.creditLimit - E.openAR(c.id));
    const a = E.createSO({ customerId: c.id, date: NOV, lines: [{ sku: 'HX-100', qty: 1, price: room }] });
    assert.equal(a.status, 'Booked');
    const b = E.createSO({ customerId: c.id, date: NOV, lines: [{ sku: 'HX-100', qty: 1, price: 1 }] });
    assert.equal(b.status, 'Credit Hold');
  });
  test('ship with insufficient stock throws and leaves state unchanged', () => {
    const it = E.item('PL-500');
    const o = E.createSO({ customerId: custByName('Corran Biolabs').id, date: NOV, lines: [{ sku: 'HX-100', qty: 1 }, { sku: 'PL-500', qty: it.onHand + 1 }] });
    const s = snap();
    assert.throws(() => E.shipSO(o.id, NOV), /Not enough stock/);
    assert.equal(snap(), s);
  });
  test('two lines of the same SKU cannot together ship more than on hand', { todo: 'engine bug: engine.js:393 stock check is per line, so duplicate-SKU lines drive onHand negative (and a later receipt can divide by zero in avgCost, engine.js:294)' }, () => {
    const it = E.item('KT-900'); const n = it.onHand;
    const o = E.createSO({ customerId: custByName('Corran Biolabs').id, date: NOV, lines: [{ sku: 'KT-900', qty: n }, { sku: 'KT-900', qty: n }] });
    try { E.shipSO(o.id, NOV); } catch (e) { /* expected */ }
    assert.ok(it.onHand >= 0, `onHand ${it.onHand}`);
  });
  test('ship posts COGS at avg cost and AR invoice at order total', () => {
    const c = custByName('Solace Pharma');
    const o = E.createSO({ customerId: c.id, date: NOV, lines: [{ sku: 'HX-220', qty: 7 }, { sku: 'CB-010', qty: 113, price: 27.5 }] });
    const h = E.item('HX-220'), cb = E.item('CB-010');
    const expCogs = r2(7 * h.avgCost + 113 * cb.avgCost), expTotal = r2(7 * h.price + 113 * 27.5);
    assert.equal(o.total, expTotal);
    const b = E.balances(); const n1 = h.onHand, n2 = cb.onHand;
    const inv = E.shipSO(o.id, NOV);
    assert.equal(r2(E.balance('5000') - b['5000']), expCogs);
    assert.equal(r2(b['1200'] - E.balance('1200')), expCogs);
    assert.equal(r2(E.balance('1100') - b['1100']), expTotal);
    assert.equal(r2(b['4000'] - E.balance('4000')), expTotal);
    assert.equal(inv.total, expTotal);
    assert.equal(inv.due, E.util.addDays(NOV, c.terms));
    assert.equal(h.onHand, n1 - 7); assert.equal(cb.onHand, n2 - 113);
    assert.equal(o.margin, r2(expTotal - expCogs));
    assert.throws(() => E.shipSO(o.id, NOV), /Invoiced/);
    assert.throws(() => E.cancelSO(o.id), /shipped/);
    assertInvariants();
  });
  test('cancelled SO cannot ship', () => {
    const o = E.createSO({ customerId: custByName('Solace Pharma').id, date: NOV, lines: [{ sku: 'HX-220', qty: 1 }] });
    E.cancelSO(o.id);
    assert.throws(() => E.shipSO(o.id, NOV));
  });
  test('ship into closed period throws; snapshot restore round-trips', () => {
    const o = E.createSO({ customerId: custByName('Solace Pharma').id, date: NOV, lines: [{ sku: 'HX-220', qty: 1 }] });
    const s = snap();
    assert.throws(() => E.shipSO(o.id, '2026-09-30'), /Closed/);
    restore(s);
    assert.deepEqual(E.S, JSON.parse(s));
    assertInvariants();
  });
  test('over-receipt throws; partial -> Partially Paid; full -> Paid', () => {
    const o = E.createSO({ customerId: custByName('Solace Pharma').id, date: NOV, lines: [{ sku: 'HX-220', qty: 3 }] });
    const inv = E.shipSO(o.id, NOV);
    assert.throws(() => E.applyReceipt({ invoiceId: inv.id, date: NOV, amount: inv.total + 0.01 }), /more than the open balance/);
    assert.throws(() => E.applyReceipt({ invoiceId: inv.id, date: NOV, amount: 0 }), /greater than zero/);
    assert.throws(() => E.applyReceipt({ invoiceId: inv.id, date: NOV, amount: -5 }), /greater than zero/);
    const c0 = E.balance('1000');
    E.applyReceipt({ invoiceId: inv.id, date: NOV, amount: 100 });
    assert.equal(inv.status, 'Partially Paid');
    assert.equal(r2(E.balance('1000') - c0), 100);
    assertInvariants();
    assert.throws(() => E.applyReceipt({ invoiceId: inv.id, date: NOV, amount: r2(inv.total - 100 + 0.01) }));
    E.applyReceipt({ invoiceId: inv.id, date: NOV, amount: r2(inv.total - 100) });
    assert.equal(inv.status, 'Paid');
    assert.throws(() => E.applyReceipt({ invoiceId: inv.id, date: NOV, amount: 1 }), /already paid/);
    assertInvariants();
  });
  test('aging buckets sum to open AR', () => {
    const ag = E.arAging();
    let total = 0;
    for (const row of ag.rows) {
      const s = r2(ag.buckets.reduce((a, b) => a + row[b], 0));
      assert.equal(s, row.total, row.name);
      assert.equal(row.total, E.openAR(row.customerId));
      total += row.total;
    }
    assert.equal(r2(total), E.balance('1100'));
    // Ostrava's Sep invoice is overdue
    const ost = ag.rows.find((r) => r.name === 'Ostrava Foods');
    assert.ok(ost['Current'] < ost.total);
  });
  test('SO with negative or zero price is rejected', { todo: 'engine bug: engine.js:377 createSO accepts negative unit prices (price:-100 books negative revenue); zero silently falls back to list price' }, () => {
    assert.throws(() => E.createSO({ customerId: custByName('Solace Pharma').id, date: NOV, lines: [{ sku: 'HX-220', qty: 1, price: -100 }] }));
  });
});

// =====================================================================
describe('HCM and payroll', () => {
  test('payroll for Nov posts gross/net/taxes with correct per-slip rounding', () => {
    const end = '2026-11-30';
    const elig = E.S.employees.filter((e) => e.hireDate <= end && e.status === 'Active');
    let gross = 0, tax = 0, net = 0, er = 0;
    for (const e of elig) { const g = r2(e.salary / 12), t = r2(g * 0.22), x = r2(g * 0.0765); gross += g; tax += t; net += r2(g - t); er += x; }
    [gross, tax, net, er] = [gross, tax, net, er].map(r2);
    const b = E.balances();
    const run = E.runPayroll('2026-11');
    assert.equal(run.slips.length, elig.length);
    assert.equal(run.gross, gross); assert.equal(run.tax, tax); assert.equal(run.net, net); assert.equal(run.employerTax, er);
    assert.equal(r2(gross - tax), net);
    assert.equal(r2(E.balance('6000') - b['6000']), gross);
    assert.equal(r2(E.balance('6050') - b['6050']), er);
    assert.equal(r2(b['1000'] - E.balance('1000')), net);
    assert.equal(r2(b['2200'] - E.balance('2200')), r2(tax + er));
    assert.equal(E.je(run.journal).date, end);
    assertInvariants();
    assert.throws(() => E.runPayroll('2026-11'), /already been run/);
    assert.throws(() => E.runPayroll('2026-10'), /already been run/);
    assert.throws(() => E.runPayroll('2026-12'), /Future/);
    assert.equal(E.S.payruns.filter((r) => r.period === '2026-12').length, 0);
  });
  test('employee terminated in Nov is paid in Nov; hired after Nov is not', () => {
    const t = empByName('Oliver Brandt');
    E.terminateEmployee(t.id, '2026-11-05');
    const late = E.hireEmployee({ name: 'New Hire', title: 'Tech', dept: 'Engineering', salary: 50000, hireDate: '2026-12-01' });
    const run = E.runPayroll('2026-11');
    assert.ok(run.slips.some((s) => s.empId === t.id));
    assert.ok(!run.slips.some((s) => s.empId === late.id));
  });
  test('terminated employee reports move to their manager', () => {
    const cto = empByName('Lena Park'), ceo = empByName('Margit Halden');
    E.terminateEmployee(cto.id, NOV);
    assert.equal(empByName('Hana Sato').managerId, ceo.id);
    assert.equal(empByName('Oliver Brandt').managerId, ceo.id);
    assert.equal(cto.status, 'Terminated');
    assert.throws(() => E.terminateEmployee(cto.id, NOV), /not active/);
    assert.ok(!E.S.employees.some((e) => e.status === 'Active' && e.managerId === cto.id));
  });
  test('pending absence approver follows the reassignment when the manager is terminated', { todo: 'engine bug: engine.js:444-446 terminateEmployee moves reports but leaves pending absences with approverId = the terminated manager' }, () => {
    const cto = empByName('Lena Park'); const hana = empByName('Hana Sato');
    E.terminateEmployee(cto.id, NOV);
    const a = E.S.absences.find((x) => x.empId === hana.id && x.status === 'Pending');
    assert.notEqual(a.approverId, cto.id);
  });
  test('vacation request over balance throws', () => {
    const e = empByName('Ines Duarte');
    assert.throws(() => E.requestAbsence({ empId: e.id, type: 'Vacation', start: '2027-01-04', end: '2027-01-29' }), /vacation day/);
    assert.throws(() => E.requestAbsence({ empId: e.id, type: 'Vacation', start: '2027-01-09', end: '2027-01-10' }), /no working days/);
    assert.throws(() => E.requestAbsence({ empId: e.id, type: 'Vacation', start: '2027-01-10', end: '2027-01-09' }), /valid date range/);
  });
  test('overlapping request throws', () => {
    const hana = empByName('Hana Sato');
    assert.throws(() => E.requestAbsence({ empId: hana.id, type: 'Sick', start: '2026-12-28', end: '2026-12-29' }), /Overlaps/);
    assert.throws(() => E.requestAbsence({ empId: hana.id, type: 'Sick', start: '2026-12-31', end: '2027-01-04' }), /Overlaps/);
    E.requestAbsence({ empId: hana.id, type: 'Sick', start: '2027-01-01', end: '2027-01-04' });
  });
  test('approval deducts balance; second request then exceeds remaining', () => {
    const hana = empByName('Hana Sato');
    const a = E.S.absences.find((x) => x.empId === hana.id);
    E.approveAbsence(a.id);
    assert.equal(a.days, 9);
    assert.equal(hana.ptoBalance, 6);
    assert.throws(() => E.approveAbsence(a.id), /not pending/);
    assert.throws(() => E.requestAbsence({ empId: hana.id, type: 'Vacation', start: '2027-01-04', end: '2027-01-12' }), /vacation day/); // 7 days > 6
    const sick = E.S.absences.find((x) => x.type === 'Sick');
    const k = E.emp(sick.empId).ptoBalance; E.approveAbsence(sick.id);
    assert.equal(E.emp(sick.empId).ptoBalance, k);
  });
  test('two pending vacation requests cannot both be approved beyond balance', () => {
    const e = empByName('Ines Duarte');
    const a = E.requestAbsence({ empId: e.id, type: 'Vacation', start: '2027-01-04', end: '2027-01-15' }); // 10
    const b = E.requestAbsence({ empId: e.id, type: 'Vacation', start: '2027-02-01', end: '2027-02-12' }); // 10
    E.approveAbsence(a.id);
    assert.throws(() => E.approveAbsence(b.id), /no longer has enough/);
    assert.equal(e.ptoBalance, 5);
  });
});

// =====================================================================
describe('depreciation', () => {
  test('once per period; amount = GL 1500 / 60', () => {
    const exp = r2(E.balance('1500', { toPeriod: '2026-11' }) / 60);
    assert.equal(exp, 4000);
    const b = E.balances();
    const j = E.runDepreciation('2026-11');
    assert.equal(j.total, exp);
    assert.equal(r2(E.balance('6300') - b['6300']), exp);
    assert.equal(r2(b['1510'] - E.balance('1510')), exp);
    assert.equal(j.date, '2026-11-30');
    assert.throws(() => E.runDepreciation('2026-11'), /already posted/);
    assert.throws(() => E.runDepreciation('2026-10'), /already posted/);
    assert.throws(() => E.runDepreciation('2026-12'), /Future/);
    assert.equal(E.S.depreciationRuns['2026-12'], undefined);
    E.openPeriod('2026-12');
    E.runDepreciation('2026-12');
    assertInvariants();
  });
  test('depreciation base reflects equipment additions', () => {
    E.createJournal({ date: NOV, lines: [{ acct: '1500', dr: 6000 }, { acct: '1000', cr: 6000 }] });
    assert.equal(E.runDepreciation('2026-11').total, r2(246000 / 60));
  });
});

// =====================================================================
describe('atomicity contract (snapshot / restore)', () => {
  test('failing shipSO round-trips', () => {
    const o = E.createSO({ customerId: custByName('Corran Biolabs').id, date: NOV, lines: [{ sku: 'HX-310', qty: 1 }, { sku: 'PL-500', qty: 99999 }] });
    const s = snap(); const before = JSON.parse(s);
    assert.throws(() => E.shipSO(o.id, NOV));
    restore(s);
    assert.deepEqual(E.S, before);
    assertInvariants();
    // engine functions operate on restored state (no stale closure)
    E.cancelSO(o.id);
    assert.equal(E.so(o.id).status, 'Cancelled');
    assert.equal(E.S.sos.find((x) => x.id === o.id).status, 'Cancelled');
  });
  test('failing payInvoices round-trips', () => {
    const inv = E.S.apInvoices.find((i) => i.status === 'Validated');
    E.createJournal({ date: NOV, lines: [{ acct: '6100', dr: E.balance('1000') }, { acct: '1000', cr: E.balance('1000') }] });
    const s = snap(); const before = JSON.parse(s);
    assert.throws(() => E.payInvoices([inv.id], NOV), /exceeds/);
    restore(s);
    assert.deepEqual(E.S, before);
    assertInvariants();
  });
  test('failing multi-supplier payment midway (closed date) round-trips', () => {
    const p = makeReceivedPO('HX-100', 10, 40);
    const a = E.enterAPInvoice({ poId: p.id, number: 'MS', date: NOV, lines: [{ line: 0, qty: 10, price: 40 }] });
    const b = E.S.apInvoices.find((i) => i.status === 'Validated' && i.supplierId !== a.supplierId);
    const s = snap();
    assert.throws(() => E.payInvoices([a.id, b.id], '2026-09-30'));
    restore(s);
    assert.equal(snap(), s);
  });
  test('failed AP invoice in a closed period leaves no residue after restore', () => {
    const p = makeReceivedPO('HX-100', 10, 40);
    const s = snap();
    assert.throws(() => E.enterAPInvoice({ poId: p.id, number: 'CL', date: '2026-09-30', lines: [{ line: 0, qty: 10, price: 40 }] }));
    restore(s);
    assert.equal(snap(), s);
    E.enterAPInvoice({ poId: p.id, number: 'CL', date: NOV, lines: [{ line: 0, qty: 10, price: 40 }] }); // number not burned
    assertInvariants();
  });
});

// =====================================================================
describe('fuzz', () => {
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function runFuzz(seedNum, steps) {
    seed();
    const rnd = mulberry32(seedNum);
    const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const pick = (arr) => (arr.length ? arr[Math.floor(rnd() * arr.length)] : undefined);
    const S = () => E.S;
    const dates = ['2026-09-30', '2026-10-15', '2026-10-31', '2026-11-03', '2026-11-17', '2026-11-28', '2026-12-10', '2027-01-05'];
    const date = () => (rnd() < 0.8 ? pick(dates.slice(1, 6)) : pick(dates));
    const skus = () => S().items.map((i) => i.sku);
    let invNo = 0;
    const users = ['Avery Lin', 'Theo Okafor', 'Sam Achebe'];

    const ops = {
      createPO: () => {
        const sku = pick(skus()); const it = E.item(sku);
        const lines = [{ sku, qty: ri(1, 300), price: r2(it.lastCost * (0.8 + rnd() * 0.4)) }];
        if (rnd() < 0.3) { const s2 = pick(skus().filter((x) => x !== sku)); lines.push({ sku: s2, qty: ri(1, 200), price: r2(E.item(s2).lastCost * (0.9 + rnd() * 0.2)) }); }
        E.createPO({ supplierId: pick(S().suppliers).id, date: date(), lines });
      },
      reqFlow: () => {
        const sku = pick(skus()); const it = E.item(sku);
        const r = E.createReq({ date: date(), lines: [{ sku, qty: ri(1, 400), price: it.lastCost }] });
        if (r.status === 'Pending Approval' && rnd() < 0.7) E.approveReq(r.id);
        E.createPO({ reqId: r.id, supplierId: pick(S().suppliers).id, date: date() });
      },
      receive: () => {
        const p = pick(S().pos.filter((x) => x.status === 'Open' || x.status === 'Partially Received')) || pick(S().pos);
        E.receivePO(p.id, date(), p.lines.map((l) => (rnd() < 0.8 ? ri(0, Math.max(0, l.qty - l.received) + (rnd() < 0.15 ? 3 : 0)) : 0)));
      },
      invoice: () => {
        const p = pick(S().pos.filter((x) => x.lines.some((l) => l.received > l.invoiced))) || pick(S().pos);
        const li = ri(0, p.lines.length - 1); const l = p.lines[li];
        const avail = l.received - l.invoiced;
        const qty = rnd() < 0.85 ? ri(1, Math.max(1, avail)) : avail + ri(1, 5);
        const price = r2(l.price * (0.92 + rnd() * 0.16));
        const number = rnd() < 0.1 && invNo ? `FZ-${invNo}` : `FZ-${++invNo}`;
        E.enterAPInvoice({ poId: p.id, number, date: date(), lines: [{ line: li, qty, price }] });
      },
      release: () => { const i = pick(S().apInvoices.filter((x) => x.status === 'On Hold')); E.releaseHold(i ? i.id : 'nope', rnd() < 0.5 ? date() : undefined); },
      cancelAP: () => { const i = pick(S().apInvoices.filter((x) => x.status === 'On Hold')); E.cancelAPInvoice(i ? i.id : 'nope'); },
      pay: () => {
        const v = S().apInvoices.filter((x) => x.status === 'Validated' || rnd() < 0.05);
        const chosen = [...new Set(v.filter(() => rnd() < 0.5).map((x) => x.id))];
        if (!chosen.length && v.length) chosen.push(v[0].id);
        E.payInvoices(chosen, date());
      },
      createSO: () => {
        const pool = skus().slice(); const lines = [];
        for (let k = ri(1, 3); k > 0 && pool.length; k--) {
          const sku = pool.splice(ri(0, pool.length - 1), 1)[0]; const it = E.item(sku);
          lines.push({ sku, qty: rnd() < 0.85 ? ri(1, Math.max(1, Math.floor(it.onHand * 0.3))) : it.onHand + ri(1, 50), ...(rnd() < 0.3 ? { price: r2(it.price * (0.8 + rnd() * 0.3)) } : {}) });
        }
        const o = E.createSO({ customerId: pick(S().customers).id, date: date(), lines });
        if (rnd() < 0.5) E.shipSO(o.id, date());
      },
      releaseCredit: () => { const o = pick(S().sos.filter((x) => x.status === 'Credit Hold')); E.releaseCreditHold(o ? o.id : 'nope'); },
      ship: () => { const o = pick(S().sos.filter((x) => x.status === 'Booked' || rnd() < 0.05)); E.shipSO(o ? o.id : 'nope', date()); },
      cancelSO: () => { const o = pick(S().sos); E.cancelSO(o.id); },
      receipt: () => {
        const i = pick(S().arInvoices.filter((x) => x.status !== 'Paid')) || pick(S().arInvoices);
        const open = r2(i.total - i.paid); const roll = rnd();
        const amount = roll < 0.4 ? open : roll < 0.8 ? r2(open * rnd()) : roll < 0.9 ? r2(open + 1) : -1;
        E.applyReceipt({ invoiceId: i.id, date: date(), amount });
      },
      adjust: () => {
        const it = pick(S().items); const q = rnd() < 0.5 ? ri(1, 30) : -ri(1, Math.max(1, it.onHand + (rnd() < 0.1 ? 10 : 0)));
        E.adjustInventory({ sku: it.sku, qty: q, date: date(), reason: 'cycle count' });
      },
      journal: () => {
        const amt = rnd() < 0.2 ? r2(50000 + rnd() * 30000) : r2(rnd() * 5000);
        const exp = pick(['6100', '6200', '6400', '6500', '4900']);
        const lines = rnd() < 0.1 ? [{ acct: exp, dr: amt }, { acct: '1000', cr: r2(amt + 0.5) }] : [{ acct: exp, dr: amt }, { acct: '1000', cr: amt }];
        E.S.user = pick(users);
        E.createManualJournal({ date: date(), desc: 'fuzz', lines });
      },
      approveJE: () => { const j = pick(S().journals.filter((x) => x.status === 'Pending Approval')); E.S.user = pick(users); E.approveJournal(j ? j.id : 'nope'); },
      rejectJE: () => { const j = pick(S().journals.filter((x) => x.status === 'Pending Approval')); E.rejectJournal(j ? j.id : 'nope'); },
      payroll: () => E.runPayroll(pick(['2026-10', '2026-11', '2026-11', '2026-12'])),
      depr: () => E.runDepreciation(pick(['2026-10', '2026-11', '2026-11', '2026-12'])),
      periods: () => { const r = rnd(); if (r < 0.4) E.openPeriod(pick(['2026-12', '2027-01'])); else if (r < 0.8) E.closePeriod(pick(['2026-10', '2026-11'])); else E.reopenPeriod(pick(['2026-09', '2026-10'])); },
      hcm: () => {
        const r = rnd(); const act = S().employees.filter((e) => e.status === 'Active');
        if (r < 0.3) E.hireEmployee({ name: 'Fuzz ' + ri(1, 1e6), title: 'Tech', dept: pick(S().departments), managerId: pick(act).id, salary: ri(40000, 200000), hireDate: date() });
        else if (r < 0.45 && act.length > 3) E.terminateEmployee(pick(act.slice(1)).id, date());
        else if (r < 0.8) { const st = pick(['2026-12-01', '2027-01-04', '2027-02-08', '2026-11-20']); E.requestAbsence({ empId: pick(act).id, type: pick(['Vacation', 'Sick']), start: st, end: E.util.addDays(st, ri(0, 25)) }); }
        else { const a = pick(S().absences.filter((x) => x.status === 'Pending')); E.approveAbsence(a ? a.id : 'nope'); }
      },
    };
    const weights = { createPO: 8, reqFlow: 4, receive: 10, invoice: 10, release: 4, cancelAP: 2, pay: 6, createSO: 10, releaseCredit: 3, ship: 6, cancelSO: 2, receipt: 8, adjust: 5, journal: 6, approveJE: 3, rejectJE: 1, payroll: 2, depr: 2, periods: 3, hcm: 5 };
    const bag = Object.entries(weights).flatMap(([k, w]) => Array(w).fill(k));
    const stats = { ok: 0, threw: 0 };

    for (let step = 0; step < steps; step++) {
      const op = pick(bag);
      const s = snap(); const pre = JSON.parse(s); const nj = E.S.journals.length;
      const label = `seed ${seedNum} step ${step} op ${op}`;
      try {
        ops[op]();
        E.S.role = 'Administrator'; E.S.user = 'System Administrator';
        stats.ok++;
        // new journals must be in periods that were Open before the op
        for (const j of E.S.journals.slice(nj)) assert.equal(pre.periods[j.period], 'Open', `${label}: ${j.id} posted into ${j.period} (${pre.periods[j.period]})`);
        // existing journals are immutable except Pending -> Posted/Rejected
        for (let k = 0; k < nj; k++) {
          const a = pre.journals[k], b = E.S.journals[k];
          assert.deepEqual(b.lines, a.lines, `${label}: ${a.id} lines changed`);
          if (a.status !== 'Pending Approval') assert.equal(b.status, a.status, `${label}: ${a.id} status changed`);
        }
      } catch (e) {
        if (e instanceof assert.AssertionError) throw e;
        if (!(e instanceof Error) || e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError) throw new Error(`${label}: non-user error ${e && e.stack}`);
        restore(s);
        stats.threw++;
        assert.equal(snap(), s, `${label}: restore did not round-trip`);
      }
      assertInvariants(label);
    }
    return stats;
  }

  test('300 random operations from seed keep TB balanced and reconcile() ok', () => {
    const st = runFuzz(1234567, 300);
    assert.ok(st.ok > 60, `too few successful ops ${JSON.stringify(st)}`);
    assert.ok(st.threw > 20, `too few failing ops ${JSON.stringify(st)}`);
  });
  for (const s of [7, 42, 99, 2026, 31337]) {
    test(`fuzz seed ${s} (200 ops)`, () => { runFuzz(s, 200); });
  }
});
