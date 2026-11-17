/* Warehouses, transfers, lots and serials (js/ext-wms.js). Run: node --test tests/ */
'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E, seed } = require('../js/load-node.js');

const NOV = '2026-11-17';
const snapshot = () => JSON.stringify(E.S);
/** Σ locations + in transit = onHand for every item; serial/lot records agree; reconcile ok; TB balanced. */
function assertInvariant(label) {
  for (const it of E.S.items) {
    const locs = E.S.locations.reduce((a, L) => a + E.stockAt(it.sku, L.code), 0);
    assert.equal(locs + E.inTransit(it.sku), it.onHand, `${label}: ${it.sku} locations ${locs} + transit ${E.inTransit(it.sku)} vs onHand ${it.onHand}`);
    for (const L of E.S.locations) assert.ok(E.stockAt(it.sku, L.code) >= 0, `${label}: ${it.sku} negative at ${L.code}`);
  }
  const chk = E.wmsCheck(); assert.ok(chk.ok, `${label}: ${JSON.stringify(chk)}`);
  for (const r of E.reconcile()) assert.ok(r.ok, `${label}: ${r.name} sub ${r.sub} gl ${r.gl}`);
  const tb = E.trialBalance(); assert.ok(Math.abs(tb.dr - tb.cr) < 0.005, `${label}: TB ${tb.dr} vs ${tb.cr}`);
}
const cust = (name) => E.S.customers.find((c) => c.name === name);
function bookSO(lines, who = 'Meridian Water Authority') {
  const o = E.createSO({ customerId: cust(who).id, date: NOV, lines });
  if (o.status === 'Credit Hold') E.releaseCreditHold(o.id);
  return o;
}
function newPO(lines) { return E.createPO({ supplierId: E.S.suppliers[0].id, date: NOV, lines }); }

describe('warehouse management', () => {
  beforeEach(() => seed());

  test('seed: locations, flags, DAY-FIELD stock, one transfer in transit, serials and lots; invariant holds', () => {
    assert.deepEqual(E.S.locations.map((l) => l.code), ['BOS-MAIN', 'BOS-QA', 'DAY-FIELD']);
    assert.equal(E.item('HX-310').serialControlled, true); assert.equal(E.item('KT-900').lotControlled, true);
    const done = E.S.transfers.find((t) => t.status === 'Received' && t.date.startsWith('2026-10'));
    assert.ok(done && done.to === 'DAY-FIELD');
    assert.ok(E.S.transfers.some((t) => t.status === 'Shipped' && t.shipDate.startsWith('2026-11')));
    assert.ok(E.S.items.some((it) => E.stockAt(it.sku, 'DAY-FIELD') > 0));
    assert.ok(E.inTransit('HX-310') > 0);
    assert.equal(E.serialsAt('HX-310', 'BOS-MAIN').length, E.stockAt('HX-310', 'BOS-MAIN'));
    assert.ok(E.lotsAt('KT-900', 'BOS-MAIN').length > 0);
    const r = E.reconcile().find((x) => x.name.startsWith('Inventory by location')); assert.ok(r && r.ok);
    assertInvariant('seed');
  });

  test('state hook: older state without a stock subledger puts on-hand into BOS-MAIN', () => {
    const st = JSON.parse(snapshot()); delete st.stock; delete st.wms; delete st.transfers; delete st.serials; delete st.lots; delete st.lotTrace;
    E.load(st);
    for (const it of E.S.items) assert.equal(E.stockAt(it.sku, 'BOS-MAIN'), it.onHand, it.sku);
    assertInvariant('upgrade');
    const again = snapshot(); E.load(JSON.parse(again)); assert.equal(snapshot(), again, 'state hook is idempotent');
  });

  test('receive into a chosen location generates unique serials and a lot', () => {
    const po = newPO([{ sku: 'HX-310', qty: 5, price: 305 }, { sku: 'KT-900', qty: 30, price: 73 }]);
    const before = Object.keys(E.S.serials).length;
    E.receivePO(po.id, NOV, [5, 30], { location: 'DAY-FIELD' });
    assert.equal(Object.keys(E.S.serials).length, before + 5);
    const mine = Object.values(E.S.serials).filter((s) => s.receiptRef === po.id);
    assert.equal(mine.length, 5); mine.forEach((s) => { assert.match(s.sn, /^HX310-26-\d{5}$/); assert.equal(s.loc, 'DAY-FIELD'); });
    const lot = Object.values(E.S.lots).find((l) => l.ref === po.id);
    assert.match(lot.lot, /^LOT-2611-[A-Z]+$/); assert.equal(lot.expiry, '2028-05-17'); assert.equal(lot.qty['DAY-FIELD'], 30);
    const all = Object.keys(E.S.serials); assert.equal(new Set(all).size, all.length);
    assert.throws(() => E.receivePO(po.id, NOV, [0, 0], { location: 'NOWHERE' }), /does not exist/);
    assertInvariant('receive');
  });

  test('ship auto-picks BOS-MAIN then DAY-FIELD (split) and traces serials to the customer', () => {
    const main = E.stockAt('HX-310', 'BOS-MAIN'), field = E.stockAt('HX-310', 'DAY-FIELD');
    assert.ok(field > 0);
    const o = bookSO([{ sku: 'HX-310', qty: main + 1 }]);
    E.shipSO(o.id, NOV);
    assert.equal(E.stockAt('HX-310', 'BOS-MAIN'), 0); assert.equal(E.stockAt('HX-310', 'DAY-FIELD'), field - 1);
    assert.deepEqual(o.picks.map((p) => p.loc), ['BOS-MAIN', 'DAY-FIELD']);
    const sn = o.picks[1].serials[0]; const tr = E.traceSerial(sn);
    assert.equal(tr.status, 'Shipped'); assert.equal(tr.so, o.id); assert.equal(tr.customer, 'Meridian Water Authority');
    assert.ok(tr.history.some((h) => h.type === 'Transfer in' && h.loc === 'DAY-FIELD'), 'history shows the depot transfer');
    assert.ok(E.S.lotTrace.some((e) => e.ref === o.id && e.type === 'Shipment' && e.serials.includes(sn)));
    assertInvariant('ship split');
  });

  test('ship that no combination of locations covers throws and leaves state unchanged', () => {
    // in-transit units count toward onHand but cannot be picked
    const it = E.item('PL-500'); const avail = E.stockAt('PL-500', 'BOS-MAIN') + E.stockAt('PL-500', 'DAY-FIELD');
    assert.ok(E.inTransit('PL-500') > 0);
    const o = bookSO([{ sku: 'PL-500', qty: avail + 1 }]); assert.ok(it.onHand >= avail + 1);
    const snap = snapshot();
    assert.throws(() => E.shipSO(o.id, NOV), /PL-500: need .* in transit/);
    assert.equal(snapshot(), snap);
    const o2 = bookSO([{ sku: 'HX-100', qty: 5 }]); const s2 = snapshot();
    assert.throws(() => E.shipSO(o2.id, NOV, { location: 'BOS-QA' }), /inspection location/);
    assert.equal(snapshot(), s2);
    E.shipSO(o2.id, NOV, { location: 'DAY-FIELD' });
    assertInvariant('ship from location');
  });

  test('chosen serials ship; a serial cannot ship twice', () => {
    const pick = E.serialsAt('HX-310', 'DAY-FIELD').slice(-2);
    const o = bookSO([{ sku: 'HX-310', qty: 2 }]);
    E.shipSO(o.id, NOV, { serials: { 'HX-310': pick } });
    pick.forEach((sn) => assert.equal(E.serial(sn).status, 'Shipped'));
    const o2 = bookSO([{ sku: 'HX-310', qty: 1 }]); const snap = snapshot();
    assert.throws(() => E.shipSO(o2.id, NOV, { serials: { 'HX-310': [pick[0]] } }), /Shipped, not in stock/);
    assert.equal(snapshot(), snap);
    assertInvariant('chosen serials');
  });

  test('lots are consumed FIFO by expiry, and lot trace shows where used', () => {
    const po = newPO([{ sku: 'KT-900', qty: 20, price: 73 }]); E.receivePO(po.id, NOV, [20]);
    const lots = E.lotsAt('KT-900', 'BOS-MAIN'); assert.ok(lots.length >= 2);
    const oldest = lots[0]; assert.ok(oldest.expiry < lots[lots.length - 1].expiry);
    const o = bookSO([{ sku: 'KT-900', qty: oldest.qty + 3 }]);
    E.shipSO(o.id, NOV, { location: 'BOS-MAIN' });
    assert.equal(E.lot(oldest.lot).qty['BOS-MAIN'] || 0, 0, 'oldest lot used first');
    const p = o.picks[0]; assert.deepEqual(p.lots.map((x) => x.lot), [oldest.lot, lots[1].lot]); assert.equal(p.lots[1].qty, 3);
    const tr = E.traceLot(oldest.lot);
    assert.ok(tr.uses.some((u) => u.ref === o.id && u.customer === 'Meridian Water Authority'));
    assert.ok(tr.uses.some((u) => u.type === 'WO Issue'), 'KT-950 builds consumed this lot');
    assertInvariant('lots');
  });

  test('adjustments: + into a location, - from a location or auto order, never below zero there', () => {
    E.adjustInventory({ sku: 'CB-010', qty: 25, date: NOV, reason: 'Found stock', location: 'DAY-FIELD' });
    assert.equal(E.stockAt('CB-010', 'DAY-FIELD'), 425);
    E.adjustInventory({ sku: 'CB-010', qty: -10, date: NOV, reason: 'Damaged', location: 'DAY-FIELD' });
    assert.equal(E.stockAt('CB-010', 'DAY-FIELD'), 415);
    const snap = snapshot();
    assert.throws(() => E.adjustInventory({ sku: 'CB-010', qty: -500, date: NOV, reason: 'Lost', location: 'DAY-FIELD' }), /CB-010: need 500/);
    assert.equal(snapshot(), snap);
    const sn0 = E.serialsAt('HX-310', 'BOS-MAIN')[0];
    E.adjustInventory({ sku: 'HX-310', qty: -1, date: NOV, reason: 'Scrapped' });
    assert.equal(E.serial(sn0).status, 'Adjusted out');
    E.adjustInventory({ sku: 'KT-900', qty: 4, date: NOV, reason: 'Count gain', location: 'BOS-QA' });
    assertInvariant('adjust');
  });

  test('work order issue and completion move stock at locations', () => {
    const w = E.createWO({ sku: 'KT-950', qty: 3, start: NOV, due: '2026-11-30' });
    E.releaseWO(w.id, { date: NOV });
    const kt = E.stockAt('KT-900', 'DAY-FIELD');
    const snap = snapshot();
    assert.throws(() => E.issueComponents(w.id, { date: NOV, location: 'BOS-QA' }), /inspection location/);
    assert.equal(snapshot(), snap);
    E.issueComponents(w.id, { date: NOV, location: 'DAY-FIELD' });
    assert.equal(E.stockAt('KT-900', 'DAY-FIELD'), kt - 3);
    assert.ok(E.S.lotTrace.some((e) => e.ref === w.id && e.type === 'WO Issue' && e.lots));
    assertInvariant('WO issue');
    const fg = E.stockAt('KT-950', 'DAY-FIELD');
    E.reportCompletion(w.id, { date: NOV, qty: 3, location: 'DAY-FIELD' });
    assert.equal(E.stockAt('KT-950', 'DAY-FIELD'), fg + 3);
    assertInvariant('WO complete');
  });

  test('transfers: Requested -> Shipped (in transit) -> Received; serials and lots travel', () => {
    const sn = E.serialsAt('HX-310', 'BOS-MAIN').slice(0, 2);
    const t = E.createTransfer({ date: NOV, from: 'BOS-MAIN', to: 'DAY-FIELD', lines: [{ sku: 'HX-310', qty: 2, serials: sn }, { sku: 'KT-900', qty: 5 }] });
    assert.equal(t.id.startsWith('TR-'), true); assert.equal(t.status, 'Requested');
    const main = E.stockAt('KT-900', 'BOS-MAIN'), field = E.stockAt('KT-900', 'DAY-FIELD'), oh = E.item('KT-900').onHand;
    E.shipTransfer(t.id, NOV);
    assert.equal(E.stockAt('KT-900', 'BOS-MAIN'), main - 5); assert.equal(E.inTransit('KT-900'), 5); assert.equal(E.item('KT-900').onHand, oh, 'no onHand change');
    sn.forEach((s) => assert.equal(E.serial(s).status, 'In transit'));
    assertInvariant('transfer shipped');
    E.receiveTransfer(t.id, NOV);
    assert.equal(E.stockAt('KT-900', 'DAY-FIELD'), field + 5); assert.equal(E.inTransit('KT-900'), 0);
    sn.forEach((s) => { assert.equal(E.serial(s).loc, 'DAY-FIELD'); assert.equal(E.serial(s).status, 'In stock'); });
    assert.equal(E.traceSerial(sn[0]).loc, 'DAY-FIELD');
    assertInvariant('transfer received');
    const big = E.createTransfer({ date: NOV, from: 'DAY-FIELD', to: 'BOS-MAIN', lines: [{ sku: 'HX-100', qty: 999 }] });
    const snap = snapshot();
    assert.throws(() => E.shipTransfer(big.id, NOV), /HX-100: need 999/);
    assert.equal(snapshot(), snap);
    assert.throws(() => E.receiveTransfer(big.id, NOV), /only shipped/);
    assert.throws(() => E.createTransfer({ date: NOV, from: 'BOS-MAIN', to: 'BOS-MAIN', lines: [{ sku: 'HX-100', qty: 1 }] }), /different/);
    E.cancelTransfer(big.id); assert.equal(big.status, 'Cancelled');
  });

  test('customer returns land in BOS-QA with the shipped serials', () => {
    const o = bookSO([{ sku: 'HX-310', qty: 3 }]); const inv = E.shipSO(o.id, NOV);
    const shipped = o.picks.flatMap((p) => p.serials);
    const qa = E.stockAt('HX-310', 'BOS-QA');
    E.createARCreditMemo({ invoiceId: inv.id, date: NOV, reason: 'Wrong spec', returns: [{ line: 0, qty: 2 }] });
    assert.equal(E.stockAt('HX-310', 'BOS-QA'), qa + 2);
    const back = shipped.filter((sn) => E.serial(sn).status === 'In stock');
    assert.equal(back.length, 2); back.forEach((sn) => assert.equal(E.serial(sn).loc, 'BOS-QA'));
    assertInvariant('return');
  });
});
