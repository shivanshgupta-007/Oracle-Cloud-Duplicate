/* Manufacturing, supply planning and cycle counting (js/ext-mfg.js). Run: node --test tests/ */
'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E, seed } = require('../js/load-node.js');

const r2 = (n) => Math.round((+n + Number.EPSILON) * 100) / 100;
const NOV = '2026-11-17';
const recRow = (name) => E.reconcile().find((r) => r.name === name);
function assertBooks(label) {
  for (const r of E.reconcile()) assert.ok(r.ok, `${label}: ${r.name} sub ${r.sub} gl ${r.gl}`);
  const tb = E.trialBalance(); assert.ok(Math.abs(tb.dr - tb.cr) < 0.005, `${label}: TB ${tb.dr} vs ${tb.cr}`);
  assert.ok(recRow('Work in process'), 'WIP reconcile row present');
  assert.ok(recRow('Inventory').ok && recRow('Work in process').ok, label);
}
const snapshot = () => JSON.stringify(E.S);
/** fresh planned HX-900 WO that will not run short */
function newWO(qty = 7) { return E.createWO({ sku: 'HX-900', qty, start: NOV, due: '2026-11-30' }); }

describe('manufacturing', () => {
  beforeEach(() => seed());

  test('seed: accounts, assembled items, BOMs, work orders, all books reconcile', () => {
    for (const c of ['1300', '5300', '5310']) assert.ok(E.acct(c), c);
    assert.equal(E.acct('5300').type, 'Expense'); assert.ok(E.acct('5300').code >= '5000' && E.acct('5300').code < '6000');
    assert.equal(E.item('HX-900').make, true); assert.ok(E.item('HX-900').onHand > 0); assert.ok(E.item('HX-900').avgCost > 900);
    assert.ok(E.S.wos.some((w) => w.status === 'In progress' && w.start >= '2026-11-01'));
    assert.ok(E.S.wos.filter((w) => w.status === 'Closed').length >= 2);
    assert.ok(E.S.counts.some((c) => c.status === 'Counted' && c.date >= '2026-11-01'));
    assert.ok(E.S.sos.some((o) => o.lines.some((l) => l.sku === 'HX-900') && o.status === 'Invoiced'));
    for (const p of ['2026-07', '2026-08', '2026-09']) assert.equal(E.S.periods[p], 'Closed');
    assert.ok(E.balance('1000') > 0);
    assertBooks('seed');
    assert.ok(Math.abs(recRow('Work in process').gl) > 0, 'demo WO holds WIP');
  });

  test('BOM cost roll-up = components at avg cost + labor + overhead', () => {
    const c = E.bomCost('HX-900');
    const i = (s) => E.item(s).avgCost;
    const mat = r2(i('PL-500') + 4 * i('HX-100') + 2 * i('HX-220') + i('HX-310') + 8 * i('CB-010'));
    assert.equal(c.material, mat);
    assert.equal(c.labor, 155); assert.equal(c.overhead, 40);
    assert.equal(c.total, r2(mat + 195));
    const b = E.bom('HX-900');
    assert.deepEqual(b.components.map((x) => [x.sku, x.qty]), [['PL-500', 1], ['HX-100', 4], ['HX-220', 2], ['HX-310', 1], ['CB-010', 8]]);
    assert.equal(b.laborRate, 62); assert.equal(b.laborHours, 2.5);
  });

  test('BOM validation: no self reference, no duplicates, positive qty', () => {
    assert.throws(() => E.saveBOM({ sku: 'HX-900', components: [{ sku: 'HX-900', qty: 1 }] }), /itself/);
    assert.throws(() => E.saveBOM({ sku: 'HX-900', components: [{ sku: 'HX-100', qty: 1 }, { sku: 'HX-100', qty: 2 }] }), /twice/);
    assert.throws(() => E.saveBOM({ sku: 'HX-900', components: [{ sku: 'HX-100', qty: -1 }] }), /greater than zero/);
    assert.throws(() => E.saveBOM({ sku: 'HX-900', components: [] }), /at least one/);
  });

  test('issue reduces components, posts WIP Dr 1300 / Cr 1200 at avg cost, txn shape like core', () => {
    const w = newWO(7); E.releaseWO(w.id, { date: NOV });
    const before = Object.fromEntries(w.components.map((c) => [c.sku, { oh: E.item(c.sku).onHand, avg: E.item(c.sku).avgCost }]));
    const gl1300 = E.balance('1300'), gl1200 = E.balance('1200');
    const j = E.issueComponents(w.id, { date: NOV });
    const expect = r2(w.components.reduce((a, c) => a + r2(c.required * before[c.sku].avg), 0));
    assert.equal(j.total, expect);
    assert.deepEqual(j.lines.map((l) => [l.acct, l.dr, l.cr]), [['1300', expect, 0], ['1200', 0, expect]]);
    for (const c of w.components) assert.equal(E.item(c.sku).onHand, before[c.sku].oh - c.required);
    assert.equal(E.balance('1300'), r2(gl1300 + expect)); assert.equal(E.balance('1200'), r2(gl1200 - expect));
    const t = E.S.invTxns[0];
    assert.deepEqual(Object.keys(t).sort(), ['date', 'id', 'onHandAfter', 'qty', 'ref', 'sku', 'type', 'unitCost', 'value'].sort());
    assert.equal(t.type, 'WO Issue'); assert.equal(t.ref, w.id); assert.ok(t.qty < 0); assert.equal(t.onHandAfter, E.item(t.sku).onHand); assert.match(t.id, /^IT-/);
    assert.equal(E.wo(w.id).status, 'In progress');
    assertBooks('after issue');
  });

  test('completion absorbs conversion and moves cost to FG at hand-computed cost; partial 3 of 7', () => {
    const w = newWO(7); E.releaseWO(w.id, { date: NOV });
    const issued = E.issueComponents(w.id, { date: NOV }).total;
    const fg = E.item('HX-900'); const oh0 = fg.onHand, avg0 = fg.avgCost;
    const gl5300 = E.balance('5300');
    E.reportCompletion(w.id, { date: NOV, qty: 3 });
    const conv = r2(3 * (2.5 * 62 + 40)); // 585
    const transfer = r2(r2(issued * 3 / 7) + conv);
    assert.equal(E.balance('5300'), r2(gl5300 - conv), 'Cr 5300 applied labor and overhead');
    const fj = E.S.journals.filter((j) => j.ref === w.id && j.desc.startsWith('Completion'));
    assert.equal(fj.length, 1); assert.equal(fj[0].total, transfer);
    assert.deepEqual(fj[0].lines.map((l) => l.acct), ['1200', '1300']);
    assert.equal(fg.onHand, oh0 + 3);
    assert.equal(fg.avgCost, r2((oh0 * avg0 + transfer) / (oh0 + 3)));
    assert.equal(E.woWip(E.wo(w.id)), r2(issued + conv - transfer));
    assert.equal(E.S.invTxns[0].type, 'WO Completion'); assert.equal(E.S.invTxns[0].qty, 3);
    assertBooks('after 3 of 7');
    E.reportCompletion(w.id, { date: NOV, qty: 2 }); assertBooks('after 5 of 7');
    E.reportCompletion(w.id, { date: NOV, qty: 2 }); assertBooks('after 7 of 7');
    const done = E.wo(w.id);
    assert.equal(done.status, 'Completed');
    assert.equal(done.relieved, r2(issued + 7 * 195), 'everything issued plus conversion reached finished goods');
    assert.ok(Math.abs(E.woWip(done)) < 0.01);
    E.closeWO(w.id, NOV); assert.equal(E.wo(w.id).status, 'Closed'); assertBooks('after close');
  });

  test('awkward quantities: 13 units completed 3 + 4 + 6 keep inventory and WIP reconciled to the cent', () => {
    const w = newWO(13); E.releaseWO(w.id, { date: NOV, allowShortages: true });
    E.issueComponents(w.id, { date: NOV });
    for (const q of [3, 4, 6]) { E.reportCompletion(w.id, { date: NOV, qty: q }); assertBooks(`after +${q}`); assert.ok(Math.abs(recRow('Inventory').diff) < 0.01); }
    E.closeWO(w.id, NOV); assertBooks('closed');
  });

  test('cannot complete more than released remaining; nothing changes', () => {
    const w = newWO(7); E.releaseWO(w.id, { date: NOV }); E.issueComponents(w.id, { date: NOV });
    E.reportCompletion(w.id, { date: NOV, qty: 5 });
    const snap = snapshot();
    assert.throws(() => E.reportCompletion(w.id, { date: NOV, qty: 3 }), /Only 2 of 7/);
    assert.throws(() => E.reportCompletion(w.id, { date: NOV, qty: 1.5 }), /whole/);
    assert.equal(snapshot(), snap);
  });

  test('cannot complete before components are issued; cannot complete a planned WO', () => {
    const w = newWO(4);
    assert.throws(() => E.reportCompletion(w.id, { date: NOV, qty: 1 }), /Planned/);
    E.releaseWO(w.id, { date: NOV });
    const snap = snapshot();
    assert.throws(() => E.reportCompletion(w.id, { date: NOV, qty: 1 }), /Issue components first/);
    assert.equal(snapshot(), snap);
  });

  test('cannot issue without stock: state unchanged; release reports shortages', () => {
    const w = E.createWO({ sku: 'HX-900', qty: 5000, start: NOV });
    assert.throws(() => E.releaseWO(w.id, { date: NOV }), /shortages/i);
    const res = E.releaseWO(w.id, { date: NOV, allowShortages: true });
    assert.ok(res.shortages.length >= 1);
    const snap = snapshot();
    assert.throws(() => E.issueComponents(w.id, { date: NOV }), /on hand/);
    assert.throws(() => E.issueComponents(w.id, { date: NOV, lines: [{ sku: 'HX-310', qty: E.item('HX-310').onHand + 1 }] }), /on hand/);
    assert.throws(() => E.issueComponents(w.id, { date: '2026-08-15' }), /Closed/);
    assert.equal(snapshot(), snap);
    // partial issue by line is fine
    E.issueComponents(w.id, { date: NOV, lines: [{ sku: 'PL-500', qty: 3 }] });
    assert.equal(E.wo(w.id).components.find((c) => c.sku === 'PL-500').issued, 3);
    assertBooks('partial issue');
  });

  test('short close writes residual WIP to 5310 production variance', () => {
    const w = newWO(6); E.releaseWO(w.id, { date: NOV }); E.issueComponents(w.id, { date: NOV });
    E.reportCompletion(w.id, { date: NOV, qty: 2 });
    const wip = E.woWip(E.wo(w.id)); assert.ok(wip > 0);
    const v0 = E.balance('5310');
    E.closeWO(w.id, NOV);
    assert.equal(E.balance('5310'), r2(v0 + wip));
    assert.equal(E.woWip(E.wo(w.id)), 0);
    assertBooks('short close');
  });

  test('MRP arithmetic: projected = on hand − SO − WO demand + PO + reqs; suggestion to 2x reorder in lots', () => {
    const plan = () => E.supplyPlan().find((r) => r.sku === 'HX-310');
    const p0 = plan();
    assert.equal(p0.projected, r2(p0.onHand - p0.soDemand - p0.woDemand + p0.poSupply + p0.reqSupply));
    // add 300 of WO demand for HX-310 via a planned WO, and an open SO for 20
    E.createWO({ sku: 'HX-900', qty: 300, start: NOV });
    const c = E.S.customers.find((x) => x.name === 'Solace Pharma');
    E.createSO({ customerId: c.id, date: NOV, lines: [{ sku: 'HX-310', qty: 20 }] });
    const p1 = plan();
    assert.equal(p1.woDemand, p0.woDemand + 300); assert.equal(p1.soDemand, p0.soDemand + 20);
    assert.equal(p1.projected, r2(p0.projected - 320));
    assert.equal(p1.needed, p1.projected <= p1.reorder);
    assert.equal(p1.lot, 10);
    assert.equal(p1.suggest, Math.ceil((2 * p1.reorder - p1.projected) / 10) * 10);
    assert.equal(p1.action, 'Buy');
    // cable lots of 500
    const cb = E.supplyPlan().find((r) => r.sku === 'CB-010'); assert.equal(cb.lot, 500);
    if (cb.suggest) assert.equal(cb.suggest % 500, 0);
    // requisitions count as supply afterwards and big ones need approval
    const reqs = E.createPlannedReqs({ skus: ['HX-310'], date: NOV });
    assert.equal(reqs.length, 1); assert.equal(reqs[0].lines[0].qty, p1.suggest);
    assert.equal(reqs[0].status, reqs[0].total > E.REQ_APPROVAL_LIMIT ? 'Pending Approval' : 'Approved');
    assert.equal(plan().reqSupply, p1.reqSupply + p1.suggest);
    assert.equal(plan().needed, false);
  });

  test('MRP make suggestion creates planned work orders', () => {
    const c = E.S.customers.find((x) => x.name === 'Meridian Water Authority');
    const fg = E.supplyPlan().find((r) => r.sku === 'HX-900');
    E.createSO({ customerId: c.id, date: NOV, lines: [{ sku: 'HX-900', qty: Math.max(1, Math.ceil(fg.projected)) }] });
    const r = E.supplyPlan().find((x) => x.sku === 'HX-900');
    assert.equal(r.action, 'Make'); assert.equal(r.suggest % 5, 0);
    const n0 = E.S.wos.length;
    const wos = E.createPlannedWOs({ skus: ['HX-900'], date: NOV });
    assert.equal(E.S.wos.length, n0 + 1); assert.equal(wos[0].status, 'Planned'); assert.equal(wos[0].qty, r.suggest);
    assert.equal(E.supplyPlan().find((x) => x.sku === 'HX-900').needed, false);
  });

  test('cycle count: variance qty/value, post adjustments via adjustInventory, books reconcile', () => {
    const busy = new Set(E.S.counts.filter((c) => ['Open', 'Counted'].includes(c.status)).flatMap((c) => c.lines.map((l) => l.sku)));
    const [A, B, C] = ['HX-100', 'HX-220', 'CB-010', 'KT-900', 'PL-500', 'HX-310', 'KT-950'].filter((s) => !busy.has(s) && E.item(s).onHand >= 3);
    const cc = E.createCount({ date: NOV, skus: [A, B, C] });
    assert.equal(cc.status, 'Open'); assert.match(cc.id, /^CC-/);
    const sys = Object.fromEntries(cc.lines.map((l) => [l.sku, l.systemQty]));
    assert.throws(() => E.postCount(cc.id, NOV), /every item/);
    assert.throws(() => E.enterCounts(cc.id, { [A]: -1 }), /zero or more/);
    E.enterCounts(cc.id, { [A]: sys[A] - 3, [B]: sys[B] + 40 });
    assert.equal(E.count(cc.id).status, 'Open');
    E.enterCounts(cc.id, { [C]: sys[C] });
    assert.equal(E.count(cc.id).status, 'Counted');
    const v = E.countVariance(E.count(cc.id).lines.find((l) => l.sku === A));
    assert.equal(v.qty, -3); assert.equal(v.value, r2(-3 * E.item(A).avgCost));
    const cogs0 = E.balance('5000'), j0 = E.S.journals.length;
    const exp = r2(-3 * E.item(A).avgCost) + r2(40 * E.item(B).avgCost);
    E.postCount(cc.id, NOV);
    const c = E.count(cc.id);
    assert.equal(c.status, 'Posted'); assert.equal(E.S.journals.length, j0 + 2, 'only non-zero deltas post');
    assert.equal(E.item(A).onHand, sys[A] - 3); assert.equal(E.item(B).onHand, sys[B] + 40);
    assert.equal(c.netValue, r2(exp));
    assert.equal(r2(E.balance('5000') - cogs0), r2(-exp));
    assert.ok(E.S.journals.slice(-2).every((j) => /Cycle count CC-/.test(j.desc)));
    assert.throws(() => E.postCount(cc.id, NOV), /already posted/);
    assertBooks('after count');
  });

  test('ABC classes and count picks most due items, not items on an open count', () => {
    const cls = E.abcClasses();
    assert.ok(Object.values(cls).includes('A'));
    const busy = new Set(E.S.counts.filter((c) => ['Open', 'Counted'].includes(c.status)).flatMap((c) => c.lines.map((l) => l.sku)));
    const cc = E.createCount({ date: NOV, n: 3 });
    assert.equal(cc.lines.length, 3);
    cc.lines.forEach((l) => assert.ok(!busy.has(l.sku)));
  });

  test('hooks: checklist advisory, search finds WOs and BOMs, Buyer permissions', () => {
    const items = E.closeChecklist('2026-11');
    const row = items.find((x) => x.task === 'Open work orders reviewed');
    assert.ok(row && row.advisory === true && row.done === false);
    const hits = E.search('HX-900');
    assert.ok(hits.some((h) => h.kind === 'wo')); assert.ok(hits.some((h) => h.kind === 'bom'));
    assert.ok(E.search('WO-1').some((h) => h.kind === 'wo'));
    assert.ok(E.can('Buyer', 'mfg.edit') && E.can('Buyer', 'mfg.plan') && E.can('Administrator', 'mfg.edit'));
    assert.ok(!E.can('AP Specialist', 'mfg.edit'));
  });
});
