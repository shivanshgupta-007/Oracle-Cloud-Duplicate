/* Ledgerline Suite: ext-wms.js
 * Warehouse management: stock by location, inter-location transfers, lot and serial control.
 * Rules only, no DOM. See PLAN.md "Extending the engine".
 *
 * The core item.onHand stays the company total and valuation stays company-level average cost,
 * so nothing here posts to the GL (a transfer between locations moves units, not value).
 * Location subledger: S.stock[sku][loc] = units. Invariant, for every item at all times:
 *     Σ S.stock[sku][*]  +  units on Shipped (in-transit) transfers  =  item.onHand
 * Serial-controlled items: count of serials 'In stock' at a location = S.stock[sku][loc]
 * (serials on a shipped transfer are 'In transit'). Lot-controlled: Σ lot.qty[loc] = S.stock[sku][loc].
 *
 * Core movements are wrapped with E.extend (location validated BEFORE calling the original so a
 * throw leaves state untouched; location stock updated after): receivePO, shipSO, adjustInventory,
 * createARCreditMemo (returns land in BOS-QA), issueComponents and reportCompletion (ext-mfg).
 * Every location movement is logged in S.lotTrace (txn id, location, serials, lots). Any txn created
 * outside the wrappers (ext-mfg's seed calls its own functions directly) is picked up by wmsSync()
 * using default locations; the 'Inventory by location' reconcile row exposes any drift.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { r2, addDays } = E.util;
  const fail = E.fail, need = E.need;
  const S = () => E.S;

  const LOCATIONS = [
    { code: 'BOS-MAIN', name: 'Boston main warehouse', site: 'Boston, MA', type: 'Warehouse', pickable: true },
    { code: 'BOS-QA', name: 'Quality inspection', site: 'Boston, MA', type: 'Inspection', pickable: false },
    { code: 'DAY-FIELD', name: 'Dayton field depot', site: 'Dayton, OH', type: 'Depot', pickable: true },
  ];
  const RECEIVE_LOC = 'BOS-MAIN', RETURN_LOC = 'BOS-QA';
  const PICK_ORDER = ['BOS-MAIN', 'DAY-FIELD'];            // auto-pick for shipments and WO issues
  const ADJUST_ORDER = ['BOS-MAIN', 'DAY-FIELD', 'BOS-QA']; // negative adjustments without a location
  const TR_STEPS = ['Requested', 'Shipped', 'Received'];
  const SHELF_MONTHS = 18;

  const loc = (code) => S().locations.find((l) => l.code === code);
  const transfer = (id) => S().transfers.find((t) => t.id === id);
  const serial = (sn) => S().serials[sn];
  const lotRec = (id) => S().lots[id];
  const itNum = (id) => +String(id).split('-').pop() || 0;
  const qtyAt = (sku, l) => (S().stock[sku] && S().stock[sku][l]) || 0;
  const bump = (sku, l, q) => { const m = S().stock[sku] = S().stock[sku] || {}; m[l] = (m[l] || 0) + q; if (!m[l]) delete m[l]; };
  const inTransit = (sku) => S().transfers.filter((t) => t.status === 'Shipped').reduce((a, t) => a + t.lines.filter((l) => l.sku === sku).reduce((b, l) => b + l.qty, 0), 0);
  const locTotal = (sku) => Object.values(S().stock[sku] || {}).reduce((a, b) => a + b, 0);
  const addMonths = (d, n) => { const [y, m, dd] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(dd, last)); return t.toISOString().slice(0, 10); };
  const today = () => S()._date || S().today || E.TODAY;
  const needLoc = (code) => { const l = loc(code); if (!l) fail(`Location ${code} does not exist.`); return l; };

  // ---------- state ----------
  E.on('state', (st) => {
    st.locations = st.locations || LOCATIONS.map((x) => ({ ...x }));
    st.transfers = st.transfers || []; st.lotTrace = st.lotTrace || [];
    st.serials = st.serials || {}; st.lots = st.lots || {};
    st.wms = st.wms || { serialSeq: {}, lotSeq: {} };
    if (!st.stock) { st.stock = {}; st.wms.cursor = (st.seq && st.seq.IT) || 1000; }
    if (st.wms.cursor == null) st.wms.cursor = (st.seq && st.seq.IT) || 1000;
    // Older saved states: any on-hand not assigned to a location goes to the main warehouse.
    if (E.S !== st) return; // only when st is the live state (load/reset)
    wmsSync(); absorbUnassigned('Unassigned on-hand at upgrade');
  });
  function absorbUnassigned(why) {
    (S().items || []).forEach((it) => {
      const gap = it.onHand - locTotal(it.sku) - inTransit(it.sku);
      if (gap > 0) moveIn(it.sku, RECEIVE_LOC, gap, { date: today(), ref: 'OPENING', type: 'Opening', why });
    });
  }

  // ---------- serials and lots ----------
  function newSerials(sku, n, date) {
    const seq = S().wms.serialSeq; const base = sku.replace(/-/g, '') + '-' + date.slice(2, 4) + '-';
    const out = [];
    for (let i = 0; i < n; i++) { seq[sku] = (seq[sku] || 0) + 1; out.push(base + String(seq[sku]).padStart(5, '0')); }
    return out;
  }
  function newLot(sku, date, ref) {
    const ym = date.slice(2, 4) + date.slice(5, 7); const key = ym; const seq = S().wms.lotSeq;
    seq[key] = (seq[key] || 0) + 1; let n = seq[key], letters = '';
    while (n > 0) { n--; letters = String.fromCharCode(65 + (n % 26)) + letters; n = Math.floor(n / 26); }
    const id = `LOT-${ym}-${letters}`;
    const it = E.item(sku);
    S().lots[id] = { lot: id, sku, received: date, ref, expiry: addMonths(date, it.shelfLifeMonths || SHELF_MONTHS), qty: {} };
    return id;
  }
  const fifoSerials = (sku, l) => Object.values(S().serials).filter((s) => s.sku === sku && s.status === 'In stock' && s.loc === l).sort((a, b) => (a.received < b.received ? -1 : a.received > b.received ? 1 : a.sn < b.sn ? -1 : 1));
  const fifoLots = (sku, l, only) => Object.values(S().lots).filter((x) => x.sku === sku && (x.qty[l] || 0) > 0 && (!only || only.includes(x.lot))).sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.lot < b.lot ? -1 : 1));
  const trace = (e) => { const t = { id: E.nextId('LT'), ...e }; S().lotTrace.unshift(t); return t; };

  /** Add units at a location. serials / lots given = existing ones coming back (transfer receipt, return); else new. */
  function moveIn(sku, l, qty, { date, ref, type, serials, lots, why, txn, auto } = {}) {
    const it = E.item(sku); date = date || today();
    bump(sku, l, qty);
    const res = { loc: l };
    if (it && it.serialControlled) {
      const sns = (serials && serials.length) ? serials.slice(0, qty) : [];
      if (sns.length < qty) sns.push(...newSerials(sku, qty - sns.length, date).map((sn) => { S().serials[sn] = { sn, sku, received: date, receiptRef: ref, receiptType: type }; return sn; }));
      sns.forEach((sn) => { const s = S().serials[sn]; s.status = 'In stock'; s.loc = l; delete s.out; delete s.transfer; });
      res.serials = sns;
    }
    if (it && it.lotControlled) {
      let use = (lots || []).filter((x) => x.qty > 0 && lotRec(x.lot));
      const given = use.reduce((a, x) => a + x.qty, 0);
      if (given < qty) use = [...use, { lot: newLot(sku, date, ref), qty: qty - given }];
      use.forEach((x) => { const r = lotRec(x.lot); r.qty[l] = (r.qty[l] || 0) + x.qty; });
      res.lots = use.map((x) => ({ lot: x.lot, qty: x.qty }));
    }
    trace({ date, type, ref, sku, loc: l, qty, serials: res.serials, lots: res.lots, note: why || '', txn: txn || '', auto: auto || undefined });
    return res;
  }
  /** Plan an outbound pick without mutating. Throws a readable message if the locations cannot cover it. */
  function planOut(sku, qty, { location, order = PICK_ORDER, serials, lots, lenient = false, purpose = 'pick' } = {}) {
    const it = need(E.item(sku), `Item ${sku}`);
    if (location) { const L = needLoc(location); if (!L.pickable && purpose !== 'adjust' && purpose !== 'transfer') fail(`${location} is a ${L.type.toLowerCase()} location. Transfer the stock to a warehouse before you ${purpose} from it.`); }
    const locs = location ? [location] : order;
    const chosenSn = it.serialControlled && serials && serials.length ? serials : null;
    const chosenLots = it.lotControlled && lots && lots.length ? lots : null;
    if (chosenSn) {
      if (new Set(chosenSn).size !== chosenSn.length) fail(`${sku}: a serial number is chosen twice.`);
      if (chosenSn.length !== qty) fail(`${sku}: choose exactly ${qty} serial number(s), not ${chosenSn.length}.`);
      for (const sn of chosenSn) { const s = serial(sn); if (!s || s.sku !== sku) fail(`${sn} is not a serial number of ${sku}.`); if (s.status !== 'In stock') fail(`${sn} is ${s.status}, not in stock.`); if (!locs.includes(s.loc)) fail(`${sn} is at ${s.loc}, not ${locs.join(' or ')}.`); }
    }
    if (chosenLots) for (const id of chosenLots) { const r = lotRec(id); if (!r || r.sku !== sku) fail(`${id} is not a lot of ${sku}.`); }
    const avail = (l) => chosenSn ? chosenSn.filter((sn) => serial(sn).loc === l).length : chosenLots ? fifoLots(sku, l, chosenLots).reduce((a, x) => a + x.qty[l], 0) : Math.max(0, qtyAt(sku, l));
    const allocs = []; let left = qty;
    for (const l of locs) { if (left <= 0) break; const take = Math.min(avail(l), left); if (take > 0) { allocs.push({ loc: l, qty: take }); left -= take; } }
    if (left > 0) {
      if (!lenient) {
        const parts = locs.map((l) => `${avail(l)} at ${l}`); const tr = inTransit(sku); if (tr) parts.push(`${tr} in transit`);
        if (!location) S().locations.filter((L) => !locs.includes(L.code) && qtyAt(sku, L.code) > 0).forEach((L) => parts.push(`${qtyAt(sku, L.code)} at ${L.code}`));
        fail(`${sku}: need ${qty}${chosenLots ? ' from ' + chosenLots.join(', ') : ''}, ${parts.join(', ')}. Transfer stock or pick another location.`);
      }
      for (const L of S().locations) { if (left <= 0) break; if (locs.includes(L.code)) continue; const take = Math.min(qtyAt(sku, L.code), left); if (take > 0) { allocs.push({ loc: L.code, qty: take }); left -= take; } }
      if (left > 0) { const a = allocs.find((x) => x.loc === RECEIVE_LOC); if (a) a.qty += left; else allocs.push({ loc: RECEIVE_LOC, qty: left }); }
    }
    for (const a of allocs) {
      if (it.serialControlled) a.serials = (chosenSn ? chosenSn.filter((sn) => serial(sn).loc === a.loc) : fifoSerials(sku, a.loc).slice(0, a.qty).map((s) => s.sn));
      if (it.lotControlled) { let need2 = a.qty; a.lots = []; for (const x of fifoLots(sku, a.loc, chosenLots)) { if (need2 <= 0) break; const t = Math.min(x.qty[a.loc], need2); a.lots.push({ lot: x.lot, qty: t }); need2 -= t; } }
    }
    return { sku, qty, allocs };
  }
  /** Apply a planned pick. status: what happens to serials (Shipped, Consumed, Adjusted out, In transit). */
  function applyOut(plan, { date, ref, type, status, customerId, transferId, txn, auto }) {
    date = date || today();
    const it = E.item(plan.sku); const res = { serials: [], lots: [] };
    for (const a of plan.allocs) {
      bump(plan.sku, a.loc, -a.qty);
      (a.serials || []).forEach((sn) => { const s = serial(sn); s.status = status; s.loc = status === 'In transit' ? 'IN-TRANSIT' : null; if (transferId) s.transfer = transferId; else s.out = { type, ref, date, customerId: customerId || '' }; res.serials.push(sn); });
      (a.lots || []).forEach((x) => { const r = lotRec(x.lot); r.qty[a.loc] -= x.qty; if (!r.qty[a.loc]) delete r.qty[a.loc]; res.lots.push({ lot: x.lot, qty: x.qty, loc: a.loc }); });
      trace({ date, type, ref, sku: plan.sku, loc: a.loc, qty: -a.qty, serials: a.serials && a.serials.length ? a.serials : undefined, lots: a.lots && a.lots.length ? a.lots : undefined, customerId: customerId || '', txn: txn || '', auto: auto || undefined });
    }
    res.loc = plan.allocs.map((a) => a.loc).join(', ');
    return res;
  }

  // ---------- txn cursor: every invTxn is assigned to a location exactly once ----------
  function newTxns() {
    const c = S().wms.cursor, out = [];
    for (const t of S().invTxns) { if (itNum(t.id) <= c) break; out.push(t); }
    return out.reverse();
  }
  const advance = () => { S().wms.cursor = (S().seq && S().seq.IT) || S().wms.cursor; };
  const SERIAL_STATUS = { 'Shipment': 'Shipped', 'WO Issue': 'Consumed', 'Adjustment': 'Adjusted out' };
  /** Assign inventory txns created outside the wrappers to default locations. Returns the count. */
  function wmsSync() {
    const list = newTxns();
    for (const t of list) {
      if (t.qty > 0) moveIn(t.sku, t.type === 'Customer return' ? RETURN_LOC : RECEIVE_LOC, t.qty, { date: t.date, ref: t.ref, type: t.type, txn: t.id, auto: true });
      else if (t.qty < 0) { const o = t.type === 'Shipment' ? E.so(t.ref) : null; applyOut(planOut(t.sku, -t.qty, { order: ADJUST_ORDER, lenient: true }), { date: t.date, ref: t.ref, type: t.type, status: SERIAL_STATUS[t.type] || 'Issued', customerId: o ? o.customerId : '', txn: t.id, auto: true }); }
    }
    advance(); return list.length;
  }
  /** After an original call: route each new txn: outbound via plans[sku] (or lenient), inbound to inLoc. */
  function settle({ plans = {}, inLoc = RECEIVE_LOC, status, customerId, inFor }) {
    for (const t of newTxns()) {
      if (t.qty < 0) {
        let p = plans[t.sku]; if (!p || p.qty !== -t.qty || p.used) p = planOut(t.sku, -t.qty, { order: ADJUST_ORDER, lenient: true });
        p.used = true; applyOut(p, { date: t.date, ref: t.ref, type: t.type, status: status || SERIAL_STATUS[t.type] || 'Issued', customerId, txn: t.id });
      } else if (t.qty > 0) moveIn(t.sku, inLoc, t.qty, { date: t.date, ref: t.ref, type: t.type, txn: t.id, ...(inFor ? inFor(t) : {}) });
    }
    advance();
  }

  // ---------- wrappers ----------
  const orig = {};
  ['receivePO', 'shipSO', 'adjustInventory', 'createARCreditMemo', 'issueComponents', 'reportCompletion'].forEach((k) => { if (typeof E[k] === 'function') orig[k] = E[k]; });

  /** receivePO(poId, date, qtys, {location}) — receives into opts.location or BOS-MAIN; serials/lots generated. */
  function receivePO(poId, date, qtys, opts = {}) {
    wmsSync(); const l = opts.location || RECEIVE_LOC; needLoc(l);
    const j = orig.receivePO(poId, date, qtys); settle({ inLoc: l }); return j;
  }
  /** shipSO(id, date, {location, serials:{sku:[sn]}, lots:{sku:[lot]}}) — picks from one location or auto-picks BOS-MAIN then DAY-FIELD (may split). */
  function shipSO(id, date, opts = {}) {
    wmsSync();
    const o = E.so(id); const plans = {};
    if (o && o.status === 'Booked') {
      const q = {}; o.lines.forEach((l) => (q[l.sku] = (q[l.sku] || 0) + l.qty));
      if (Object.keys(q).every((s) => E.item(s) && E.item(s).onHand >= q[s])) {
        const errs = [];
        for (const s in q) { try { plans[s] = planOut(s, q[s], { location: opts.location || undefined, serials: opts.serials && opts.serials[s], lots: opts.lots && opts.lots[s], purpose: 'ship' }); } catch (e) { errs.push(e.message); } }
        if (errs.length) fail(`Cannot pick ${id}${opts.location ? ' from ' + opts.location : ''}: ` + errs.join(' '));
      }
    }
    const inv = orig.shipSO(id, date);
    settle({ plans, status: 'Shipped', customerId: o.customerId });
    o.picks = S().lotTrace.filter((e) => e.ref === id && e.type === 'Shipment').reverse().map((e) => ({ sku: e.sku, qty: -e.qty, loc: e.loc, serials: e.serials, lots: e.lots }));
    return inv;
  }
  /** adjustInventory({sku, qty, date, reason, location}) — + into location (default BOS-MAIN); − from location or BOS-MAIN, DAY-FIELD, BOS-QA. */
  function adjustInventory(args = {}) {
    wmsSync();
    const { sku, location } = args; const q = +args.qty; const plans = {};
    if (location) needLoc(location);
    const it = E.item(sku);
    if (it && Number.isInteger(q) && q < 0 && it.onHand + q >= 0) plans[sku] = planOut(sku, -q, { location, order: ADJUST_ORDER, serials: args.serials, lots: args.lots, purpose: 'adjust' });
    const j = orig.adjustInventory(args);
    settle({ plans, inLoc: location || RECEIVE_LOC, status: 'Adjusted out' }); return j;
  }
  /** createARCreditMemo(...) — returned units go to BOS-QA, with the serials / lots that shipped on that order. */
  function createARCreditMemo(args = {}) {
    wmsSync();
    const inv = E.arinv(args.invoiceId); const soId = inv && inv.soId;
    const pool = {}; // serials/lots shipped on the order, by sku, still out
    const inFor = (t) => {
      const it = E.item(t.sku); if (!soId) return {};
      if (it.serialControlled) { pool[t.sku] = pool[t.sku] || Object.values(S().serials).filter((s) => s.sku === t.sku && s.status === 'Shipped' && s.out && s.out.ref === soId).map((s) => s.sn); return { serials: pool[t.sku].splice(0, t.qty) }; }
      if (it.lotControlled) {
        const o = E.so(soId); const shipped = ((o && o.picks) || []).filter((p) => p.sku === t.sku).flatMap((p) => p.lots || []);
        let left = t.qty; const lots = []; for (const x of shipped) { if (left <= 0) break; const k = Math.min(x.qty, left); lots.push({ lot: x.lot, qty: k }); left -= k; } return { lots };
      }
      return {};
    };
    const m = orig.createARCreditMemo(args); settle({ inLoc: RETURN_LOC, inFor }); return m;
  }
  /** issueComponents(id, {date, lines, location}) — components picked from location or BOS-MAIN then DAY-FIELD. */
  function issueComponents(id, opts = {}) {
    wmsSync();
    const w = E.wo && E.wo(id); const plans = {};
    if (opts.location) needLoc(opts.location);
    if (w && ['Released', 'In progress'].includes(w.status)) {
      const req = opts.lines ? opts.lines.filter((l) => l && l.sku && String(l.qty).trim() !== '' && +l.qty > 0).map((l) => ({ sku: l.sku, qty: +l.qty })) : w.components.map((c) => ({ sku: c.sku, qty: r2(c.required - c.issued) })).filter((l) => l.qty > 0);
      const errs = [];
      for (const l of req) { const it = E.item(l.sku); if (it && Number.isInteger(l.qty) && l.qty <= it.onHand && !plans[l.sku]) { try { plans[l.sku] = planOut(l.sku, l.qty, { location: opts.location, purpose: 'issue' }); } catch (e) { errs.push(e.message); } } }
      if (errs.length) fail(`Cannot issue to ${id}: ` + errs.join(' '));
    }
    const j = orig.issueComponents(id, opts); settle({ plans, status: 'Consumed' }); return j;
  }
  /** reportCompletion(id, {date, qty, location}) — finished goods into location (default BOS-MAIN). */
  function reportCompletion(id, opts = {}) {
    wmsSync(); const l = opts.location || RECEIVE_LOC; needLoc(l);
    const j = orig.reportCompletion(id, opts); settle({ inLoc: l }); return j;
  }

  // ---------- transfers ----------
  /** createTransfer({date, from, to, lines:[{sku, qty}], note}) — status Requested (no stock moves yet). */
  function createTransfer({ date, from, to, lines, note = '' } = {}) {
    wmsSync();
    if (!E.util.isDate(date)) fail('Enter a valid transfer date.');
    needLoc(from); needLoc(to); if (from === to) fail('Choose two different locations.');
    lines = (lines || []).filter((l) => l && l.sku && String(l.qty).trim() !== '' && +l.qty !== 0).map((l) => ({ sku: l.sku, qty: +l.qty, serials: l.serials, lots: l.lots }));
    if (!lines.length) fail('Add at least one item with a quantity.');
    const seen = new Set();
    for (const l of lines) {
      need(E.item(l.sku), `Item ${l.sku}`);
      if (!Number.isInteger(l.qty) || l.qty <= 0) fail(`${l.sku}: transfer a whole quantity greater than zero.`);
      if (seen.has(l.sku)) fail(`${l.sku} is on the transfer twice. Combine it into one line.`); seen.add(l.sku);
    }
    const t = { id: E.nextId('TR'), date, from, to, note, status: 'Requested', requestedBy: S().user,
      lines: lines.map((l) => ({ sku: l.sku, qty: l.qty, ...(l.serials && l.serials.length ? { pickSerials: l.serials } : {}), ...(l.lots && l.lots.length ? { pickLots: l.lots } : {}) })) };
    S().transfers.push(t); E.log('Requested transfer', t.id, `${from} to ${to}, ${lines.length} line(s)`); return t;
  }
  /** shipTransfer(id, date, {serials:{sku:[sn]}, lots:{sku:[lot]}}) — deducts from the source; units are in transit. */
  function shipTransfer(id, date, opts = {}) {
    wmsSync();
    const t = need(transfer(id), 'Transfer'); if (t.status !== 'Requested') fail(`${id} is ${t.status}; only requested transfers can ship.`);
    if (!E.util.isDate(date)) fail('Enter a valid ship date.'); if (date < t.date) fail('A transfer cannot ship before it was requested.');
    const errs = []; const plans = t.lines.map((l) => { try { return planOut(l.sku, l.qty, { location: t.from, serials: (opts.serials && opts.serials[l.sku]) || l.pickSerials, lots: (opts.lots && opts.lots[l.sku]) || l.pickLots, purpose: 'transfer' }); } catch (e) { errs.push(e.message); return null; } });
    if (errs.length) fail(`Cannot ship ${id}: ` + errs.join(' '));
    t.lines.forEach((l, i) => { const r = applyOut(plans[i], { date, ref: id, type: 'Transfer out', status: 'In transit', transferId: id }); l.serials = r.serials; l.lots = r.lots.map((x) => ({ lot: x.lot, qty: x.qty })); });
    t.status = 'Shipped'; t.shipDate = date; t.shippedBy = S().user;
    E.log('Shipped transfer', id, `${t.from} to ${t.to}, in transit`); return t;
  }
  /** receiveTransfer(id, date) — adds the in-transit units (same serials / lots) at the destination. */
  function receiveTransfer(id, date) {
    wmsSync();
    const t = need(transfer(id), 'Transfer'); if (t.status !== 'Shipped') fail(`${id} is ${t.status}; only shipped transfers can be received.`);
    if (!E.util.isDate(date)) fail('Enter a valid receipt date.'); if (date < t.shipDate) fail('A transfer cannot be received before it shipped.');
    t.lines.forEach((l) => moveIn(l.sku, t.to, l.qty, { date, ref: id, type: 'Transfer in', serials: l.serials, lots: l.lots }));
    t.status = 'Received'; t.receiveDate = date; t.receivedBy = S().user;
    E.log('Received transfer', id, `${t.to}`); return t;
  }
  function cancelTransfer(id) {
    const t = need(transfer(id), 'Transfer'); if (t.status !== 'Requested') fail(`${id} is ${t.status}; only requested transfers can be cancelled.`);
    t.status = 'Cancelled'; E.log('Cancelled transfer', id); return t;
  }

  // ---------- reporting ----------
  /** Matrix rows: one per item with qty per location, in transit, total, onHand and ok flag. */
  function stockByLocation() {
    return S().items.map((it) => {
      const by = {}; S().locations.forEach((L) => (by[L.code] = qtyAt(it.sku, L.code)));
      const transit = inTransit(it.sku), total = locTotal(it.sku) + transit;
      return { sku: it.sku, name: it.name, by, transit, total, onHand: it.onHand, ok: total === it.onHand, serialControlled: !!it.serialControlled, lotControlled: !!it.lotControlled };
    });
  }
  const serialsAt = (sku, l) => fifoSerials(sku, l).map((s) => s.sn);
  const lotsAt = (sku, l) => fifoLots(sku, l).map((x) => ({ lot: x.lot, qty: x.qty[l], expiry: x.expiry }));
  /** traceSerial(sn) — receipt (PO or other source), current location or where it went, full movement history. */
  function traceSerial(sn) {
    const s = serial(sn); if (!s) return null;
    const po = E.po(s.receiptRef); const out = s.out || null; const o = out && out.type === 'Shipment' ? E.so(out.ref) : null;
    return { ...s, supplier: po ? E.sup(po.supplierId)?.name : '', poId: po ? po.id : '', so: o ? o.id : '', customer: o ? E.cust(o.customerId)?.name : '', invoiceId: o ? o.invoiceId : '',
      history: S().lotTrace.filter((e) => e.serials && e.serials.includes(sn)).slice().reverse() };
  }
  /** traceLot(lot) — on hand by location, in transit, and every movement (receipts, shipments to customers, WO consumption, transfers). */
  function traceLot(id) {
    const r = lotRec(id); if (!r) return null;
    const transit = S().transfers.filter((t) => t.status === 'Shipped').reduce((a, t) => a + t.lines.flatMap((l) => l.lots || []).filter((x) => x.lot === id).reduce((b, x) => b + x.qty, 0), 0);
    const uses = S().lotTrace.filter((e) => e.lots && e.lots.some((x) => x.lot === id)).map((e) => ({ ...e, lotQty: e.lots.filter((x) => x.lot === id).reduce((a, x) => a + x.qty, 0) * Math.sign(e.qty), customer: e.customerId ? E.cust(e.customerId)?.name : '' })).reverse();
    return { ...r, onHand: Object.values(r.qty).reduce((a, b) => a + b, 0), transit, uses };
  }
  function wmsCheck() {
    const rows = stockByLocation(); const bad = rows.filter((r) => !r.ok);
    const serialBad = S().items.filter((it) => it.serialControlled && S().locations.some((L) => fifoSerials(it.sku, L.code).length !== qtyAt(it.sku, L.code)));
    const lotBad = S().items.filter((it) => it.lotControlled && S().locations.some((L) => fifoLots(it.sku, L.code).reduce((a, x) => a + x.qty[L.code], 0) !== qtyAt(it.sku, L.code)));
    return { ok: !bad.length && !serialBad.length && !lotBad.length, bad, serialBad: serialBad.map((i) => i.sku), lotBad: lotBad.map((i) => i.sku) };
  }

  E.on('reconcile', () => {
    const items = S().items;
    const ctl = (f) => items.filter(f);
    const serialSub = ctl((i) => i.serialControlled).reduce((a, it) => a + Object.values(S().serials).filter((s) => s.sku === it.sku && (s.status === 'In stock' || s.status === 'In transit')).length, 0);
    const lotSub = ctl((i) => i.lotControlled).reduce((a, it) => a + Object.values(S().lots).filter((x) => x.sku === it.sku).reduce((b, x) => b + Object.values(x.qty).reduce((c, d) => c + d, 0), 0) + S().transfers.filter((t) => t.status === 'Shipped').reduce((b, t) => b + t.lines.filter((l) => l.sku === it.sku).flatMap((l) => l.lots || []).reduce((c, x) => c + x.qty, 0), 0), 0);
    const onH = (f) => ctl(f).reduce((a, i) => a + i.onHand, 0);
    return [
      { name: 'Inventory by location (units: locations + in transit vs on hand)', acct: '1200', sub: items.reduce((a, i) => a + locTotal(i.sku) + inTransit(i.sku), 0), gl: items.reduce((a, i) => a + i.onHand, 0), units: true },
      { name: 'Serial numbers in stock (units)', acct: '1200', sub: serialSub, gl: onH((i) => i.serialControlled), units: true },
      { name: 'Lot quantities (units)', acct: '1200', sub: lotSub, gl: onH((i) => i.lotControlled), units: true },
    ];
  });
  E.on('approvals', () => []);
  E.on('checklist', (p) => {
    const open = S().transfers.filter((t) => t.status === 'Shipped' && String(t.shipDate).slice(0, 7) <= p);
    return [{ task: 'Transfers in transit reviewed', done: !open.length, advisory: true, detail: open.length ? `${open.map((t) => t.id).join(', ')} in transit (counted in on hand, not at a location)` : 'Nothing in transit' }];
  });
  E.on('search', (q, hit) => {
    const out = S().transfers.filter((t) => hit(t.id, t.from, t.to, t.note)).map((t) => ({ kind: 'transfer', id: t.id, label: `${t.id} ${t.from} to ${t.to}`, sub: `Transfer, ${t.status}` }));
    if (q.length >= 4) {
      Object.keys(S().serials).filter((sn) => sn.toLowerCase().includes(q)).slice(0, 8).forEach((sn) => out.push({ kind: 'serial', id: sn, label: sn, sub: `Serial ${S().serials[sn].sku}, ${S().serials[sn].status}` }));
      Object.keys(S().lots).filter((id) => id.toLowerCase().includes(q)).slice(0, 8).forEach((id) => out.push({ kind: 'lot', id, label: id, sub: `Lot ${S().lots[id].sku}, expires ${S().lots[id].expiry}` }));
    }
    return out;
  });
  E.addPerms('Buyer', ['wms.transfer']);
  E.addPerms('Order Manager', ['wms.transfer']);

  // ---------- seed ----------
  E.on('seedSetup', () => {
    const hx = E.item('HX-310'); if (hx) hx.serialControlled = true;
    const kt = E.item('KT-900'); if (kt) { kt.lotControlled = true; kt.shelfLifeMonths = SHELF_MONTHS; }
    // Opening balances: everything sits in the main warehouse (serials and an opening lot generated for it)
    S().items.forEach((it) => { const gap = it.onHand - locTotal(it.sku); if (gap > 0) moveIn(it.sku, RECEIVE_LOC, gap, { date: it.sku === 'KT-900' ? '2026-06-15' : '2026-07-01', ref: 'OPENING', type: 'Opening balance' }); });
    advance();
  });
  E.on('seedMonthly', (p, ctx) => {
    wmsSync();
    if (p === '2026-10') {
      const lines = [{ sku: 'HX-310', qty: 24 }, { sku: 'HX-100', qty: 60 }, { sku: 'CB-010', qty: 400 }, { sku: 'KT-900', qty: 18 }, { sku: 'HX-220', qty: 12 }]
        .map((l) => ({ ...l, qty: Math.min(l.qty, Math.floor(qtyAt(l.sku, RECEIVE_LOC) / 3)) })).filter((l) => l.qty > 0);
      ctx.at('2026-10-05'); const t = createTransfer({ date: '2026-10-05', from: 'BOS-MAIN', to: 'DAY-FIELD', lines, note: 'Stock the Dayton depot for Midwest field service' });
      ctx.at('2026-10-06'); shipTransfer(t.id, '2026-10-06');
      ctx.at('2026-10-09'); receiveTransfer(t.id, '2026-10-09');
    }
  });
  E.on('seedFinal', (ctx) => {
    wmsSync();
    const lines = [{ sku: 'HX-310', qty: 10 }, { sku: 'PL-500', qty: 8 }, { sku: 'HX-220', qty: 15 }].map((l) => ({ ...l, qty: Math.min(l.qty, Math.floor(qtyAt(l.sku, RECEIVE_LOC) / 3)) })).filter((l) => l.qty > 0);
    ctx.at('2026-11-14'); const t = createTransfer({ date: '2026-11-14', from: 'BOS-MAIN', to: 'DAY-FIELD', lines, note: 'Replenish Dayton depot, Q4 service calls' });
    ctx.at('2026-11-16'); shipTransfer(t.id, '2026-11-16');
    // Returned units that passed inspection, waiting to go back to the main warehouse
    const qa = S().items.filter((it) => qtyAt(it.sku, RETURN_LOC) > 0).map((it) => ({ sku: it.sku, qty: qtyAt(it.sku, RETURN_LOC) }));
    if (qa.length) { ctx.at('2026-11-17'); createTransfer({ date: '2026-11-17', from: RETURN_LOC, to: RECEIVE_LOC, lines: qa, note: 'Returns passed inspection, put away' }); }
  });

  E.extend({
    WMS: { LOCATIONS, RECEIVE_LOC, RETURN_LOC, PICK_ORDER, ADJUST_ORDER, TR_STEPS },
    receivePO, shipSO, adjustInventory, ...(orig.createARCreditMemo ? { createARCreditMemo } : {}),
    ...(orig.issueComponents ? { issueComponents } : {}), ...(orig.reportCompletion ? { reportCompletion } : {}),
    location: loc, transfer, serial, lot: lotRec, stockAt: qtyAt, inTransit, locTotal, planOut,
    createTransfer, shipTransfer, receiveTransfer, cancelTransfer,
    stockByLocation, serialsAt, lotsAt, traceSerial, traceLot, wmsCheck, wmsSync,
  });
})(typeof window !== 'undefined' ? window : globalThis);
