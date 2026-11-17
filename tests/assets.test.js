/* Fixed assets module tests. Run: node --test tests/ */
'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E, seed } = require('../js/load-node.js');

const r2 = (n) => Math.round((+n + Number.EPSILON) * 100) / 100;
const NOV = '2026-11-17';
const S = () => E.S;
const byName = (n) => S().assets.find((a) => a.name === n);
const asRole = (role, user, fn) => { const r = S().role, u = S().user; S().role = role; S().user = user; try { return fn(); } finally { S().role = r; S().user = u; } };

function assertAllOk(label = '') {
  for (const r of E.reconcile()) assert.ok(r.ok, `${label} reconcile ${r.name}: sub ${r.sub} gl ${r.gl}`);
  const tb = E.trialBalance(); assert.ok(Math.abs(tb.dr - tb.cr) < 0.005, `${label} TB ${tb.dr} != ${tb.cr}`);
  assert.equal(E.balanceSheet().balanced, true, `${label} balance sheet`);
  for (const a of S().assets) {
    assert.ok(r2(a.cost - a.accumulated) >= 0, `${label} ${a.id} NBV negative`);
    assert.ok(a.accumulated <= r2(a.cost - a.salvage) + 0.001, `${label} ${a.id} depreciated below salvage`);
  }
}
const add = (o) => E.addAsset({ name: 'Test asset', category: 'LAB', cost: 6000, salvage: 0, date: NOV, dept: 'Engineering', method: 'cash', ...o });

beforeEach(() => { seed(); });

describe('opening register', () => {
  test('cost sums to 240,000 and accumulated to 48,000 before July depreciation', () => {
    const open = S().assets.filter((a) => a.opening);
    assert.ok(open.length >= 8 && open.length <= 12);
    assert.equal(r2(open.reduce((s, a) => s + a.cost, 0)), 240000);
    assert.equal(r2(open.reduce((s, a) => s + a.openingAccum, 0)), 48000);
    // July's run is the first depreciation; opening register + July lines reconstructs the GL at Jul end
    const julLines = S().depreciationLines.filter((l) => l.period === '2026-07');
    assert.equal(r2(julLines.reduce((s, l) => s + l.amount, 0)), E.je(S().depreciationRuns['2026-07']).total);
    assert.equal(-E.balance('1510', { toPeriod: '2026-07' }), r2(48000 + E.je(S().depreciationRuns['2026-07']).total));
    assert.ok(!S().journals.some((j) => j.source === 'Assets' && j.period === '2026-07' && j.id !== S().depreciationRuns['2026-07']), 'no journals for opening register');
  });
  test('reconcile rows present and ok after seed', () => {
    const rows = E.reconcile();
    const cost = rows.find((r) => r.name === 'Fixed assets cost'), acc = rows.find((r) => r.name === 'Accumulated depreciation');
    assert.ok(cost && acc); assert.ok(cost.ok && acc.ok);
    assertAllOk('seed');
  });
  test('seed history: additions, approval, disposal with gain, pending demo item', () => {
    const osc = byName('Mixed-signal oscilloscope, 8-channel');
    assert.equal(osc.status, 'Active'); assert.ok(E.apinv(osc.invoiceId)); assert.equal(E.apinv(osc.invoiceId).lines[0].acct, '1500');
    const ev = byName('Delivery van, electric'); assert.equal(ev.status, 'Active'); assert.equal(ev.approvedBy, 'Avery Lin');
    const van = byName('Delivery van, diesel'); assert.equal(van.status, 'Retired'); assert.ok(van.retired.gainLoss > 0);
    const cc = byName('Climatic chamber, 1,000 L'); assert.equal(cc.status, 'Pending Approval'); assert.equal(cc.date, '2026-11-16');
    assert.ok(E.approvalsInbox().some((i) => i.kind === 'asset' && i.id === cc.id && i.perm === 'fa.approve'));
    assert.equal(E.search('climatic').filter((h) => h.kind === 'asset').length, 1);
    assert.ok(E.search(cc.tag.toLowerCase()).some((h) => h.id === cc.id));
    for (const p of ['2026-07', '2026-08', '2026-09', '2026-10']) assert.ok(S().depreciationRuns[p]);
  });
});

describe('depreciation math', () => {
  test('monthly straight-line per asset, full-month proration from capitalization month', () => {
    const a = add({ cost: 7200, salvage: 0, category: 'IT' });                // 36 months -> 200/mo
    assert.equal(E.assetMonthly(a.id), 200);
    assert.equal(E.assetCharge(a.id, '2026-11').amount, 200);                 // Nov 17 capitalization: full Nov
    const before = E.balance('6300');
    const j = E.runDepreciation('2026-11');
    const line = S().depreciationLines.find((l) => l.assetId === a.id && l.journal === j.id);
    assert.equal(line.amount, 200);
    assert.equal(a.accumulated, 200);
    assert.equal(r2(E.balance('6300') - before), j.total);
    assert.equal(j.source, 'Assets'); assert.equal(j.date, '2026-11-30');
    assert.equal(S().depreciationRuns['2026-11'], j.id);
    // run total = sum of every in-service asset's monthly charge
    const exp = r2(S().assets.filter((x) => x.status === 'Active').reduce((s, x) => s + (S().depreciationLines.find((l) => l.assetId === x.id && l.journal === j.id)?.amount || 0), 0));
    assert.equal(exp, j.total);
    assertAllOk('nov run');
  });
  test('asset capitalized after its month was run is caught up in the next run', () => {
    // electric van: Oct-20 capitalization after the Oct run -> Nov run charges Oct + Nov
    const ev = byName('Delivery van, electric');
    assert.equal(ev.accumulated, 0);
    const m = r2((41500 - 7500) / 60);
    const c = E.assetCharge(ev.id, '2026-11');
    assert.equal(c.months, 2); assert.equal(c.amount, r2(m * 2));
    // oscilloscope (Aug-18, after Aug run) got 2 months in Sep
    const osc = byName('Mixed-signal oscilloscope, 8-channel');
    const sep = S().depreciationLines.find((l) => l.assetId === osc.id && l.period === '2026-09');
    assert.equal(sep.months, 2); assert.equal(sep.amount, r2(((18400 - 400) / 60) * 2));
  });
  test('stops at cost minus salvage; last month takes the remainder; NBV never below salvage', () => {
    const a = add({ cost: 1000, salvage: 100, category: 'IT', life: 3 });   // 300/mo, 3 months
    E.runDepreciation('2026-11');
    assert.equal(a.accumulated, 300);
    for (const p of ['2026-12', '2027-01', '2027-02']) { E.openPeriod(p); E.runDepreciation(p); }
    assert.equal(a.accumulated, 900); assert.equal(E.assetNBV(a.id), 100);
    assert.equal(E.assetCharge(a.id, '2027-03').amount, 0);
    const b = add({ cost: 100, category: 'IT', life: 3, date: '2026-12-05', name: 'Odd amount' });   // 33.33/mo; last month 33.34
    E.openPeriod('2027-03'); E.runDepreciation('2027-03');                  // Dec-Mar = 4 months but life 3: capped at 100
    assert.equal(b.accumulated, 100); assert.equal(E.assetNBV(b.id), 0);
    assertAllOk('salvage');
  });
  test('projection matches register and the next run', () => {
    const pr = E.depreciationProjection();
    assert.equal(pr.periods[0], '2026-11'); assert.equal(pr.periods.length, 12);
    const pv = E.depreciationPreview('2026-11');
    assert.equal(pr.totals[0], pv.total);
    assert.equal(E.runDepreciation('2026-11').total, pv.total);
  });
  test('no double run; runs in period order; closed/future periods refused', () => {
    assert.throws(() => E.runDepreciation('2026-10'), /already posted/);
    E.openPeriod('2026-12');
    assert.throws(() => E.runDepreciation('2026-12'), /Nov-26 first/);
    E.runDepreciation('2026-11');
    assert.throws(() => E.runDepreciation('2026-11'), /already posted/);
    assert.throws(() => E.runDepreciation('2027-01'), /Future/);
    assertAllOk('runs');
  });
  test('checklist row: advisory, ties for a run period', () => {
    const row = E.closeChecklist('2026-10').find((r) => r.task === 'Depreciation matches asset register');
    assert.ok(row && row.advisory);
    assert.equal(row.done, false);                     // electric van added after Oct run
    E.runDepreciation('2026-11');
    assert.equal(E.closeChecklist('2026-10').find((r) => r.task === 'Depreciation matches asset register').done, true);
    assert.equal(E.closeChecklist('2026-11').find((r) => r.task === 'Depreciation matches asset register').done, true);
  });
});

describe('additions and approval', () => {
  test('cash addition posts Dr 1500 / Cr 1000; invoice addition creates a linked AP invoice', () => {
    const b = E.balances();
    const a = add({ cost: 5000 });
    assert.equal(a.status, 'Active');
    assert.equal(r2(E.balance('1500') - b['1500']), 5000); assert.equal(r2(E.balance('1000') - b['1000']), -5000);
    const i = add({ cost: 9000, method: 'invoice', supplierId: S().suppliers[0].id, invoiceNumber: 'ARD-T-1' });
    const inv = E.apinv(i.invoiceId); assert.equal(inv.status, 'Validated'); assert.equal(inv.total, 9000); assert.equal(inv.ref, i.id);
    assert.throws(() => add({ method: 'invoice', supplierId: S().suppliers[0].id, invoiceNumber: 'ARD-T-1' }), /duplicate/);
    assertAllOk('adds');
  });
  test('over $25k: Pending Approval, no GL until approved; SoD; reject leaves GL untouched', () => {
    const gl = E.balances(); const nj = S().journals.length;
    const a = add({ cost: 30000, name: 'Big rig' });
    assert.equal(a.status, 'Pending Approval');
    assert.equal(S().journals.length, nj); assert.deepEqual(E.balances(), gl);
    assertAllOk('pending');
    assert.ok(E.approvalsInbox().some((x) => x.id === a.id));
    asRole('Controller', 'System Administrator', () => assert.throws(() => E.approveAsset(a.id), /segregation/));
    asRole('Controller', 'Avery Lin', () => E.approveAsset(a.id));
    assert.equal(a.status, 'Active'); assert.equal(r2(E.balance('1500') - gl['1500']), 30000);
    assert.throws(() => E.approveAsset(a.id), /not awaiting/);
    assertAllOk('approved');
    const b = add({ cost: 40000, name: 'Rejected rig' }); const nj2 = S().journals.length;
    E.rejectAsset(b.id, 'Not budgeted'); assert.equal(b.status, 'Rejected'); assert.equal(S().journals.length, nj2);
    assert.ok(E.can('Controller', 'fa.approve') && E.can('Controller', 'fa.edit') && !E.can('Buyer', 'fa.approve'));
    // seeded climatic chamber via supplier invoice
    const cc = byName('Climatic chamber, 1,000 L');
    asRole('Controller', 'Avery Lin', () => E.approveAsset(cc.id));
    assert.equal(E.apinv(cc.invoiceId).lines[0].acct, '1500');
    assertAllOk('chamber');
  });
  test('validation errors leave state untouched', () => {
    const snap = JSON.stringify(S());
    assert.throws(() => add({ cost: -1 }), /greater than zero/);
    assert.throws(() => add({ salvage: 6000 }), /less than cost/);
    assert.throws(() => add({ date: '2026-09-10' }), /Closed/);
    assert.throws(() => add({ category: 'XX' }), /category/);
    assert.throws(() => add({ method: 'invoice', supplierId: 'nope' }), /supplier/);
    assert.equal(JSON.stringify(S()), snap);
  });
});

describe('transfers and disposal', () => {
  test('transfer changes department/custodian with no GL', () => {
    const a = S().assets.find((x) => x.status === 'Active'); const nj = S().journals.length;
    const e = S().employees.find((x) => x.name === 'Ines Duarte');
    E.transferAsset({ id: a.id, date: NOV, dept: 'Sales', custodian: e.id });
    assert.equal(a.dept, 'Sales'); assert.equal(a.custodian, e.id); assert.equal(S().journals.length, nj);
    assert.equal(a.history[a.history.length - 1].type, 'Transferred');
  });
  test('seeded van sale: gain computed by hand', () => {
    const van = byName('Delivery van, diesel');
    // opening 27 months x 500 = 13,500; Jul-Oct 4 x 500 = 2,000 -> 15,500; NBV 20,500; proceeds 21,250 -> gain 750
    assert.equal(van.retired.accumulated, 15500); assert.equal(van.retired.nbv, 20500); assert.equal(van.retired.gainLoss, 750);
    const j = E.je(van.retired.journal);
    const ln = (acct, side) => r2(j.lines.filter((l) => l.acct === acct).reduce((s, l) => s + l[side], 0));
    assert.equal(ln('1000', 'dr'), 21250); assert.equal(ln('1510', 'dr'), 15500); assert.equal(ln('1500', 'cr'), 36000); assert.equal(ln('4910', 'cr'), 750);
  });
  test('loss on disposal with catch-up depreciation for the disposal month (Nov not run yet)', () => {
    const a = byName('Calibration bench, 6-channel');      // 500/mo, accumulated through Oct
    const acc = a.accumulated;
    const x = E.disposalPreview(a.id, NOV, 10000);
    assert.equal(x.catchUp, 500); assert.equal(x.accumulated, r2(acc + 500));
    const nbv = r2(32000 - acc - 500); assert.equal(x.nbv, nbv); assert.equal(x.gainLoss, r2(10000 - nbv));
    const b = E.balances();
    E.retireAsset({ id: a.id, date: NOV, proceeds: 10000, reason: 'Sold' });
    assert.equal(r2(E.balance('6910') - (b['6910'] || 0)), r2(nbv - 10000));
    assert.equal(r2(E.balance('6300') - b['6300']), 500);
    assert.equal(a.status, 'Retired');
    assertAllOk('after loss');
    const j = E.runDepreciation('2026-11');                 // retired asset is not charged again
    assert.ok(!S().depreciationLines.some((l) => l.journal === j.id && l.assetId === a.id));
    assertAllOk('after run');
    assert.throws(() => E.retireAsset({ id: a.id, date: NOV }), /Retired/);
  });
  test('cannot date a disposal before depreciation already posted; scrapping = full NBV loss', () => {
    const a = byName('Warehouse racking and pallet truck');
    E.runDepreciation('2026-11'); E.openPeriod('2026-12'); E.runDepreciation('2026-12');
    assert.throws(() => E.retireAsset({ id: a.id, date: NOV, proceeds: 0 }), /posted through Dec-26/);
    const nbv = E.assetNBV(a.id);
    E.retireAsset({ id: a.id, date: '2026-12-15', proceeds: 0 });
    assert.equal(a.retired.gainLoss, -nbv);
    assertAllOk('scrap');
  });
  test('roll-forward ties to the GL and rows add up', () => {
    const rf = E.rollForward('2026-07', '2026-11');
    assert.equal(rf.cost.opening, 240000); assert.equal(rf.accum.opening, 48000);
    assert.equal(rf.cost.closing, r2(rf.cost.opening + rf.cost.additions - rf.cost.disposals));
    assert.equal(rf.cost.closing, rf.gl.cost); assert.equal(rf.accum.closing, rf.gl.accum);
    const oct = E.rollForward('2026-10', '2026-10');
    assert.equal(oct.cost.disposals, 36000); assert.equal(oct.accum.disposals, 15500);
    assert.equal(oct.cost.closing, E.balance('1500', { toPeriod: '2026-10' }));
    assert.throws(() => E.rollForward('2026-10', '2026-08'), /start/);
    const reg = E.assetRegister();
    assert.equal(reg.totals.cost, E.balance('1500')); assert.equal(reg.totals.nbv, r2(E.balance('1500') + E.balance('1510')));
  });
});
