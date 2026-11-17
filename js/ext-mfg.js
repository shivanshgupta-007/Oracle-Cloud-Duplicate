/* Ledgerline Suite: ext-mfg.js
 * Manufacturing (bills of material, work orders with WIP costing), supply planning
 * (MRP-lite) and cycle counting. Rules only, no DOM. See PLAN.md "Extending the engine".
 *
 * Accounting:
 *   Issue components      Dr 1300 Work in process        / Cr 1200 Inventory (avg cost)
 *   Report completion     Dr 1300                        / Cr 5300 Applied labor and overhead
 *                         Dr 1200 (finished goods)       / Cr 1300 (material + conversion)
 *                         + average-cost rounding        1200 vs 5310 (keeps the item subledger = GL 1200)
 *   Close work order      residual WIP                   -> 5310 Production variance
 * Reconcile: Σ WIP of work orders that are not closed = GL 1300.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { r2, sum, money, periodOf, periodLabel, addDays, periodEnd, isDate, daysBetween } = E.util;
  const fail = E.fail, need = E.need;

  const OPEN_WO = ['Planned', 'Released', 'In progress'];
  const WO_STEPS = ['Planned', 'Released', 'In progress', 'Completed', 'Closed'];
  const COUNT_INTERVAL = { A: 30, B: 90, C: 180 }; // days between counts by ABC class
  const S = () => E.S;

  function ensureAccounts() {
    E.ensureAccount('1300', 'Work in process', 'Asset');
    E.ensureAccount('5300', 'Applied labor and overhead', 'Expense');
    E.ensureAccount('5310', 'Production variance', 'Expense');
  }

  E.on('state', (st) => {
    st.boms = st.boms || {};
    st.wos = st.wos || [];
    st.counts = st.counts || [];
    // states saved before this module existed: add its accounts (blank states get them in seedSetup)
    if (st.accounts && st.accounts.length && !st.accounts.some((a) => a.code === '1300')) {
      [['1300', 'Work in process', 'Asset'], ['5300', 'Applied labor and overhead', 'Expense'], ['5310', 'Production variance', 'Expense']]
        .forEach(([code, name, type]) => { if (!st.accounts.some((a) => a.code === code)) st.accounts.push({ code, name, type, active: true }); });
      st.accounts.sort((a, b) => a.code.localeCompare(b.code)); st._rev = (st._rev || 0) + 1;
    }
  });

  // ---------- lookups ----------
  const wo = (id) => S().wos.find((w) => w.id === id);
  const bom = (sku) => S().boms[sku];
  const count = (id) => S().counts.find((c) => c.id === id);
  const int = (n) => Number.isInteger(+n) && String(n).trim() !== '';

  // ---------- bills of material ----------
  /** bomCost(sku) -> {components:[{sku, qty, unitCost, ext}], material, labor, overhead, conversion, total}
   *  Roll-up at each component's current weighted average cost, per one assembly. */
  function bomCost(sku) {
    const b = need(bom(sku), `Bill of material for ${sku}`);
    const components = b.components.map((c) => { const it = E.item(c.sku); const unitCost = it ? it.avgCost : 0; return { sku: c.sku, qty: c.qty, unitCost, ext: r2(c.qty * unitCost) }; });
    const material = sum(components, (c) => c.ext);
    const labor = r2(b.laborHours * b.laborRate), overhead = r2(b.overheadPerUnit);
    return { sku, components, material, labor, overhead, conversion: r2(labor + overhead), total: r2(material + labor + overhead) };
  }
  /** saveBOM({sku, components:[{sku, qty}], laborHours, laborRate, overheadPerUnit}) — create or replace. */
  function saveBOM({ sku, components, laborHours = 0, laborRate = 0, overheadPerUnit = 0 }) {
    const it = need(E.item(sku), `Item ${sku}`);
    const comps = (components || []).filter((c) => c && c.sku && String(c.qty) !== '' && +c.qty !== 0).map((c) => ({ sku: String(c.sku), qty: +c.qty }));
    if (!comps.length) fail('A bill of material needs at least one component.');
    const seen = new Set();
    for (const c of comps) {
      need(E.item(c.sku), `Component ${c.sku}`);
      if (c.sku === it.sku) fail(`${it.sku} cannot be a component of itself.`);
      if (!(c.qty > 0) || !Number.isFinite(c.qty)) fail(`Enter a quantity greater than zero for ${c.sku}.`);
      if (seen.has(c.sku)) fail(`${c.sku} is on the bill twice. Combine it into one line.`);
      seen.add(c.sku);
      const sub = bom(c.sku); if (sub && sub.components.some((x) => x.sku === it.sku)) fail(`${c.sku} already uses ${it.sku}; a bill cannot loop.`);
    }
    const lh = +laborHours, lr = +laborRate, oh = +overheadPerUnit;
    if (![lh, lr, oh].every((x) => Number.isFinite(x) && x >= 0)) fail('Labor hours, labor rate and overhead must be zero or more.');
    const existed = !!bom(it.sku);
    S().boms[it.sku] = { components: comps, laborHours: lh, laborRate: r2(lr), overheadPerUnit: r2(oh) };
    it.make = true;
    E.log(existed ? 'Updated bill of material' : 'Created bill of material', it.sku, `${comps.length} component(s), standard ${money(bomCost(it.sku).total)}`);
    return S().boms[it.sku];
  }

  // ---------- work orders ----------
  /** WIP still sitting on a work order (issued material + absorbed conversion − relieved − variance). */
  const woWip = (w) => r2(w.issuedCost + w.absorbed - w.relieved - (w.variance || 0));
  const woRemaining = (w) => w.qty - w.completed;
  /** Component lines short for what is still to be issued. */
  function woShortages(w) {
    w = typeof w === 'string' ? need(wo(w), 'Work order') : w;
    return w.components.map((c) => { const left = r2(c.required - c.issued), oh = E.item(c.sku).onHand; return { sku: c.sku, needed: left, onHand: oh, short: Math.max(0, r2(left - oh)) }; }).filter((x) => x.short > 0);
  }
  /** createWO({sku, qty, start, due, note}) -> Planned work order (components snapshot from the BOM). */
  function createWO({ sku, qty, start, due, note = '' }) {
    ensureAccounts();
    const it = need(E.item(sku), `Item ${sku}`); const b = bom(it.sku);
    if (!b) fail(`${it.sku} has no bill of material. Create one on the Bills of material tab first.`);
    qty = +qty; if (!Number.isInteger(qty) || qty <= 0) fail('Enter a whole quantity greater than zero.');
    if (!isDate(start)) fail('Enter a valid start date.');
    due = due || addDays(start, 14); if (!isDate(due) || due < start) fail('The due date must be on or after the start date.');
    const w = {
      id: E.nextId('WO'), sku: it.sku, qty, start, due, note, status: 'Planned', completed: 0,
      components: b.components.map((c) => ({ sku: c.sku, per: c.qty, required: r2(c.qty * qty), issued: 0, issuedValue: 0 })),
      laborHours: b.laborHours, laborRate: b.laborRate, overheadPerUnit: b.overheadPerUnit,
      issuedCost: 0, absorbed: 0, relieved: 0, relievedMaterial: 0, variance: 0, completions: [], issues: [], journals: [],
      createdBy: S().user,
    };
    S().wos.push(w); E.log('Created work order', w.id, `${qty} x ${it.sku}`); return w;
  }
  /** releaseWO(id, {date, allowShortages}) — checks component availability; fails on shortages unless allowed. */
  function releaseWO(id, { date, allowShortages = false } = {}) {
    const w = need(wo(id), 'Work order'); if (w.status !== 'Planned') fail(`${id} is ${w.status}; only planned work orders can be released.`);
    const short = woShortages(w);
    if (short.length && !allowShortages) fail('Component shortages: ' + short.map((s) => `${s.sku} needs ${s.needed}, ${s.onHand} on hand`).join('; ') + '. Receive stock or release with shortages.');
    w.status = 'Released'; w.released = date && isDate(date) ? date : S()._date || E.TODAY; w.releasedBy = S().user; w.releaseShortages = short;
    E.log('Released work order', id, short.length ? `${short.length} component shortage(s)` : 'All components available');
    return { wo: w, shortages: short };
  }
  /** issueComponents(id, {date, lines:[{sku, qty}]}) — omit lines to issue everything still required. */
  function issueComponents(id, { date, lines } = {}) {
    const w = need(wo(id), 'Work order');
    if (!['Released', 'In progress'].includes(w.status)) fail(`${id} is ${w.status}. Release it before issuing components.`);
    E.assertOpen(date); ensureAccounts();
    const req = lines
      ? lines.filter((l) => l && l.sku && String(l.qty).trim() !== '' && +l.qty !== 0).map((l) => ({ sku: l.sku, qty: +l.qty }))
      : w.components.map((c) => ({ sku: c.sku, qty: r2(c.required - c.issued) })).filter((l) => l.qty > 0);
    if (!req.length) fail('Enter a quantity to issue on at least one component.');
    const seen = new Set();
    for (const l of req) {
      const c = w.components.find((x) => x.sku === l.sku); if (!c) fail(`${l.sku} is not a component of ${id}.`);
      if (seen.has(l.sku)) fail(`${l.sku} appears twice.`); seen.add(l.sku);
      if (!Number.isInteger(l.qty) || l.qty <= 0) fail(`${l.sku}: issue a whole quantity greater than zero.`);
      const left = r2(c.required - c.issued); if (l.qty > left) fail(`${l.sku}: only ${left} still required on ${id}, not ${l.qty}.`);
      const oh = E.item(l.sku).onHand; if (l.qty > oh) fail(`${l.sku}: only ${oh} on hand, cannot issue ${l.qty}. Receive stock first.`);
    }
    const priced = req.map((l) => { const it = E.item(l.sku); return { ...l, unitCost: it.avgCost, value: r2(l.qty * it.avgCost) }; });
    const value = sum(priced, (l) => l.value);
    const j = E.createJournal({ date, source: 'Manufacturing', desc: `Issue components to ${id} (${w.qty} x ${w.sku})`, ref: id, lines: [{ acct: '1300', dr: value, memo: 'Work in process' }, { acct: '1200', cr: value, memo: 'Components issued' }] });
    for (const l of priced) {
      const it = E.item(l.sku), c = w.components.find((x) => x.sku === l.sku);
      it.onHand -= l.qty; c.issued = r2(c.issued + l.qty); c.issuedValue = r2(c.issuedValue + l.value);
      S().invTxns.unshift({ id: E.nextId('IT'), date, sku: l.sku, type: 'WO Issue', qty: -l.qty, unitCost: r2(l.unitCost), value: r2(-l.qty * l.unitCost), ref: id, onHandAfter: it.onHand });
    }
    w.issuedCost = r2(w.issuedCost + value); w.status = 'In progress'; w.journals.push(j.id);
    w.issues.push({ date, journal: j.id, value, lines: priced.map((l) => ({ sku: l.sku, qty: l.qty, unitCost: l.unitCost })) });
    E.log('Issued components', id, money(value)); return j;
  }
  /** reportCompletion(id, {date, qty}) — absorbs labor and overhead, moves cost from WIP to finished goods. */
  function reportCompletion(id, { date, qty } = {}) {
    const w = need(wo(id), 'Work order');
    if (!['Released', 'In progress'].includes(w.status)) fail(`${id} is ${w.status} and cannot report completions.`);
    qty = +qty; if (!Number.isInteger(qty) || qty <= 0) fail('Enter a whole quantity greater than zero.');
    if (qty > woRemaining(w)) fail(`Only ${woRemaining(w)} of ${w.qty} left to complete on ${id}, not ${qty}.`);
    E.assertOpen(date); ensureAccounts();
    const cum = w.completed + qty;
    const missing = w.components.filter((c) => c.issued + 1e-9 < c.per * cum);
    if (missing.length) fail('Issue components first: ' + missing.map((c) => `${c.sku} needs ${r2(c.per * cum)} issued for ${cum} complete, ${c.issued} issued`).join('; ') + '.');
    // material consumed by the cumulative completed quantity, at each component's issued average cost
    const target = r2(w.components.reduce((a, c) => a + (c.issued > 0 ? c.issuedValue * Math.min(1, (c.per * cum) / c.issued) : 0), 0));
    const material = Math.max(0, r2(target - w.relievedMaterial));
    const labor = r2(w.laborHours * w.laborRate * qty), overhead = r2(w.overheadPerUnit * qty), conversion = r2(labor + overhead);
    const transfer = r2(material + conversion);
    const it = E.item(w.sku);
    const jA = conversion > 0 ? E.createJournal({ date, source: 'Manufacturing', desc: `Absorb labor and overhead ${id} (${qty} x ${w.sku})`, ref: id, lines: [
      { acct: '1300', dr: conversion, memo: `Labor ${w.laborHours} h x ${money(w.laborRate)} + overhead` }, { acct: '5300', cr: conversion, memo: 'Applied labor and overhead' }] }) : null;
    const jF = E.createJournal({ date, source: 'Manufacturing', desc: `Completion ${id}: ${qty} x ${w.sku} to finished goods`, ref: id, lines: [{ acct: '1200', dr: transfer, memo: 'Finished goods' }, { acct: '1300', cr: transfer, memo: 'Relieve work in process' }] });
    it.avgCost = it.onHand > 0 ? r2((it.onHand * it.avgCost + transfer) / (it.onHand + qty)) : r2(transfer / qty);
    it.onHand += qty; it.lastCost = r2(transfer / qty);
    S().invTxns.unshift({ id: E.nextId('IT'), date, sku: w.sku, type: 'WO Completion', qty, unitCost: r2(transfer / qty), value: transfer, ref: id, onHandAfter: it.onHand });
    // keep GL inventory exactly equal to the item subledger after average-cost rounding (as receivePO does)
    const subv = sum(S().items, (x) => x.onHand * x.avgCost), gl = E.balance('1200');
    const diff = r2(subv - gl); let jR = null;
    if (Math.abs(diff) >= 0.01) jR = E.createJournal({ date, source: 'Manufacturing', desc: `Average cost rounding ${id}`, ref: id, lines: diff > 0 ? [{ acct: '1200', dr: diff }, { acct: '5310', cr: diff }] : [{ acct: '5310', dr: -diff }, { acct: '1200', cr: -diff }] });
    w.completed = cum; w.absorbed = r2(w.absorbed + conversion); w.relieved = r2(w.relieved + transfer); w.relievedMaterial = r2(w.relievedMaterial + material);
    [jA, jF, jR].forEach((j) => j && w.journals.push(j.id));
    w.completions.push({ date, qty, material, labor, overhead, value: transfer, unitCost: r2(transfer / qty), journal: jF.id });
    if (w.completed >= w.qty) { w.status = 'Completed'; w.completedDate = date; }
    E.log('Reported completion', id, `${qty} x ${w.sku} at ${money(r2(transfer / qty))}`);
    return jF;
  }
  /** closeWO(id, date) — writes any residual WIP to 5310 Production variance. Completed (or short-closed in progress). */
  function closeWO(id, date) {
    const w = need(wo(id), 'Work order');
    if (!['Completed', 'In progress'].includes(w.status)) fail(`${id} is ${w.status}. Only completed or in-progress work orders can be closed.`);
    E.assertOpen(date); ensureAccounts();
    const resid = woWip(w); let j = null;
    if (Math.abs(resid) >= 0.01) j = E.createJournal({ date, source: 'Manufacturing', desc: `Close ${id}: residual work in process to production variance`, ref: id,
      lines: resid > 0 ? [{ acct: '5310', dr: resid }, { acct: '1300', cr: resid }] : [{ acct: '1300', dr: -resid }, { acct: '5310', cr: -resid }] });
    w.variance = r2((w.variance || 0) + (j ? resid : 0)); if (j) w.journals.push(j.id);
    w.shortClosed = w.status === 'In progress'; w.status = 'Closed'; w.closedDate = date; w.closedBy = S().user;
    E.log('Closed work order', id, j ? `Variance ${money(resid)}` : 'No variance'); return w;
  }
  /** cancelWO(id) — only before anything is issued. */
  function cancelWO(id) {
    const w = need(wo(id), 'Work order');
    if (!['Planned', 'Released'].includes(w.status) || w.issuedCost) fail(`${id} is ${w.status}; only work orders with nothing issued can be cancelled.`);
    w.status = 'Cancelled'; E.log('Cancelled work order', id); return w;
  }

  // ---------- supply planning (MRP-lite) ----------
  const lotSize = (it) => it.lot || (it.make ? 5 : it.sku === 'CB-010' || it.avgCost < 10 ? 500 : it.avgCost < 100 ? 25 : 10);
  /** One row per item: projected = onHand − SO demand − WO component demand + open PO + open requisitions (+ open WO output for make items). */
  function supplyPlan() {
    const st = S();
    const soDem = {}, woDem = {}, poSup = {}, reqSup = {}, woSup = {};
    const add = (m, k, v) => { m[k] = r2((m[k] || 0) + v); };
    st.sos.filter((o) => ['Booked', 'Credit Hold'].includes(o.status)).forEach((o) => o.lines.forEach((l) => add(soDem, l.sku, l.qty)));
    st.wos.filter((w) => OPEN_WO.includes(w.status)).forEach((w) => { w.components.forEach((c) => add(woDem, c.sku, Math.max(0, c.required - c.issued))); add(woSup, w.sku, woRemaining(w)); });
    st.pos.filter((p) => !['Closed', 'Received'].includes(p.status)).forEach((p) => p.lines.forEach((l) => add(poSup, l.sku, Math.max(0, l.qty - l.received))));
    st.reqs.filter((r) => ['Approved', 'Pending Approval'].includes(r.status)).forEach((r) => r.lines.forEach((l) => add(reqSup, l.sku, l.qty)));
    return st.items.map((it) => {
      const make = !!(it.make && bom(it.sku));
      const r = { sku: it.sku, name: it.name, make, onHand: it.onHand, reorder: it.reorder, soDemand: soDem[it.sku] || 0, woDemand: woDem[it.sku] || 0, poSupply: poSup[it.sku] || 0, reqSupply: reqSup[it.sku] || 0, woSupply: woSup[it.sku] || 0, lot: lotSize(it) };
      r.projected = r2(r.onHand - r.soDemand - r.woDemand + r.poSupply + r.reqSupply + r.woSupply);
      r.needed = r.reorder > 0 ? r.projected <= r.reorder : r.projected < 0;
      r.suggest = r.needed ? Math.max(r.lot, Math.ceil((r.reorder * 2 - r.projected) / r.lot) * r.lot) : 0;
      r.action = r.needed ? (make ? 'Make' : 'Buy') : '';
      r.estCost = r2(r.suggest * (make ? bomCost(it.sku).total : it.lastCost || it.avgCost));
      return r;
    });
  }
  /** createPlannedReqs({skus, date, requester}) — one requisition per selected buy suggestion. */
  function createPlannedReqs({ skus, date, requester } = {}) {
    if (!isDate(date)) fail('Enter a valid date.');
    const plan = supplyPlan().filter((r) => r.action === 'Buy' && (!skus || skus.includes(r.sku)));
    if (!plan.length) fail('Select at least one purchased item with a suggestion.');
    return plan.map((r) => E.createReq({ date, requester: requester || S().user, justification: `Supply plan: projected ${r.projected} vs reorder point ${r.reorder}`, lines: [{ sku: r.sku, qty: r.suggest, price: E.item(r.sku).lastCost || E.item(r.sku).avgCost }] }));
  }
  /** createPlannedWOs({skus, date}) — one planned work order per selected make suggestion. */
  function createPlannedWOs({ skus, date } = {}) {
    if (!isDate(date)) fail('Enter a valid date.');
    const plan = supplyPlan().filter((r) => r.action === 'Make' && (!skus || skus.includes(r.sku)));
    if (!plan.length) fail('Select at least one manufactured item with a suggestion.');
    return plan.map((r) => createWO({ sku: r.sku, qty: r.suggest, start: date, due: addDays(date, 14), note: `Supply plan: projected ${r.projected} vs reorder point ${r.reorder}` }));
  }

  // ---------- cycle counting ----------
  /** ABC class by on-hand value: A = first 70% of value, B = next 20%, C = rest. */
  function abcClasses() {
    const rows = S().items.map((it) => ({ sku: it.sku, value: r2(it.onHand * it.avgCost) })).sort((a, b) => b.value - a.value || a.sku.localeCompare(b.sku));
    const total = sum(rows, (r) => r.value) || 1; let cum = 0; const out = {};
    rows.forEach((r, i) => { const before = cum / total; out[r.sku] = i === 0 || before < 0.7 ? 'A' : before < 0.9 ? 'B' : 'C'; cum += r.value; });
    return out;
  }
  const lastCounted = (sku) => S().counts.filter((c) => c.status === 'Posted' && c.lines.some((l) => l.sku === sku)).map((c) => c.postedDate || c.date).sort().pop() || '';
  /** countSchedule(asOf) -> [{sku, cls, value, last, next, due}] */
  function countSchedule(asOf = S().today) {
    const cls = abcClasses();
    return S().items.map((it) => { const last = lastCounted(it.sku); const next = last ? addDays(last, COUNT_INTERVAL[cls[it.sku]]) : E.FY_START + '-01';
      return { sku: it.sku, name: it.name, cls: cls[it.sku], value: r2(it.onHand * it.avgCost), last, next, due: next <= asOf }; })
      .sort((a, b) => (b.due - a.due) || a.cls.localeCompare(b.cls) || b.value - a.value);
  }
  /** createCount({date, n, skus}) — picks the N most due items (A first) unless skus given. Snapshots system qty. */
  function createCount({ date, n = 4, skus } = {}) {
    if (!isDate(date)) fail('Enter a valid count date.');
    const busy = new Set(S().counts.filter((c) => c.status !== 'Posted' && c.status !== 'Cancelled').flatMap((c) => c.lines.map((l) => l.sku)));
    let pick;
    if (skus && skus.length) { pick = [...new Set(skus)]; pick.forEach((s) => { need(E.item(s), `Item ${s}`); if (busy.has(s)) fail(`${s} is already on an open count.`); }); }
    else { n = +n; if (!Number.isInteger(n) || n <= 0) fail('Count at least one item.'); pick = countSchedule(date).filter((r) => !busy.has(r.sku)).slice(0, n).map((r) => r.sku); }
    if (!pick.length) fail('Every item is already on an open count.');
    const cls = abcClasses();
    const c = { id: E.nextId('CC'), date, status: 'Open', createdBy: S().user, lines: pick.map((s) => { const it = E.item(s); return { sku: s, cls: cls[s], systemQty: it.onHand, unitCost: it.avgCost, counted: null }; }), journals: [] };
    S().counts.push(c); E.log('Created cycle count', c.id, `${c.lines.length} item(s)`); return c;
  }
  /** enterCounts(id, {sku: countedQty}) — blank leaves a line uncounted. Status Counted once every line has a count. */
  function enterCounts(id, counts) {
    const c = need(count(id), 'Cycle count'); if (!['Open', 'Counted'].includes(c.status)) fail(`${id} is ${c.status}.`);
    const vals = {};
    for (const [sku, v] of Object.entries(counts || {})) {
      const l = c.lines.find((x) => x.sku === sku); if (!l) fail(`${sku} is not on ${id}.`);
      if (v === '' || v == null) { vals[sku] = null; continue; }
      if (!int(v) || +v < 0) fail(`${sku}: enter a whole counted quantity of zero or more.`);
      vals[sku] = +v;
    }
    c.lines.forEach((l) => { if (Object.prototype.hasOwnProperty.call(vals, l.sku)) l.counted = vals[l.sku]; });
    c.status = c.lines.every((l) => l.counted != null) ? 'Counted' : 'Open';
    E.log('Entered count results', id, `${c.lines.filter((l) => l.counted != null).length}/${c.lines.length} counted`); return c;
  }
  /** Variance per line vs the snapshot: {qty, value at current avg cost}. */
  const countVariance = (l) => { if (l.counted == null) return { qty: 0, value: 0 }; const q = l.counted - l.systemQty; const it = E.item(l.sku); return { qty: q, value: r2(q * (it ? it.avgCost : l.unitCost)) }; };
  /** postCount(id, date) — adjustInventory for every non-zero variance, reason 'Cycle count CC-…'. */
  function postCount(id, date) {
    const c = need(count(id), 'Cycle count'); if (c.status === 'Posted') fail(`${id} is already posted.`);
    if (c.status === 'Cancelled') fail(`${id} is cancelled.`);
    if (c.lines.some((l) => l.counted == null)) fail(`Enter a count for every item on ${id} before posting.`);
    const d = date || S().today; E.assertOpen(d);
    const deltas = c.lines.map((l) => ({ l, q: l.counted - l.systemQty })).filter((x) => x.q !== 0);
    for (const { l, q } of deltas) { const it = E.item(l.sku); if (it.onHand + q < 0) fail(`${l.sku}: only ${it.onHand} on hand now, cannot adjust by ${q}.`); }
    for (const { l, q } of deltas) {
      const j = E.adjustInventory({ sku: l.sku, qty: q, date: d, reason: `Cycle count ${id}` });
      l.adjQty = q; l.adjValue = j.lines[0].dr; if (q < 0) l.adjValue = -l.adjValue; l.journal = j.id; c.journals.push(j.id);
    }
    c.status = 'Posted'; c.postedDate = d; c.postedBy = S().user; c.netValue = sum(c.lines, (l) => l.adjValue || 0);
    E.log('Posted cycle count', id, `${deltas.length} adjustment(s), net ${money(c.netValue)}`); return c;
  }
  function cancelCount(id) { const c = need(count(id), 'Cycle count'); if (c.status === 'Posted' || c.status === 'Cancelled') fail(`${id} is ${c.status}.`); c.status = 'Cancelled'; E.log('Cancelled cycle count', id); return c; }

  // ---------- hooks ----------
  E.on('reconcile', (b) => [{ name: 'Work in process', acct: '1300', sub: sum(S().wos.filter((w) => w.status !== 'Closed' && w.status !== 'Cancelled'), woWip), gl: b['1300'] || 0 }]);
  E.on('checklist', (p) => {
    const end = periodEnd(p);
    const open = S().wos.filter((w) => w.start <= end && !['Closed', 'Cancelled'].includes(w.status));
    const unposted = S().counts.filter((c) => periodOf(c.date) <= p && ['Open', 'Counted'].includes(c.status));
    return [
      { task: 'Open work orders reviewed', done: !open.length, detail: open.length ? `${open.length} work order(s) not closed (${open.map((w) => w.id).join(', ')})` : 'All work orders closed', advisory: true },
      { task: 'Cycle counts posted', done: !unposted.length, detail: unposted.length ? `${unposted.length} count(s) awaiting posting` : 'No counts outstanding', advisory: true },
    ];
  });
  E.on('search', (q, hit) => [
    ...S().wos.filter((w) => hit(w.id, w.sku, E.item(w.sku)?.name)).map((w) => ({ kind: 'wo', id: w.id, label: `${w.id} ${w.qty} x ${w.sku}`, sub: `Work order, ${w.status}` })),
    ...Object.keys(S().boms).filter((s) => hit(s, E.item(s)?.name, 'bom', 'bill of material')).map((s) => ({ kind: 'bom', id: s, label: `BOM ${s} ${E.item(s)?.name || ''}`, sub: `Bill of material, ${S().boms[s].components.length} component(s)` })),
    ...S().counts.filter((c) => hit(c.id)).map((c) => ({ kind: 'count', id: c.id, label: c.id, sub: `Cycle count, ${c.status}` })),
  ]);
  E.addPerms('Buyer', ['mfg.edit', 'mfg.plan']);

  // ---------- seed ----------
  E.on('seedSetup', (ctx) => {
    ensureAccounts();
    ctx.at('2026-07-01');
    const hx = E.addItem({ sku: 'HX-900', name: 'Field monitoring station', uom: 'Each', price: 4950, reorder: 8, cost: 1166 }); hx.make = true;
    const kt = E.addItem({ sku: 'KT-950', name: 'Calibration kit, premium', uom: 'Kit', price: 545, reorder: 15, cost: 233 }); kt.make = true;
    saveBOM({ sku: 'HX-900', components: [{ sku: 'PL-500', qty: 1 }, { sku: 'HX-100', qty: 4 }, { sku: 'HX-220', qty: 2 }, { sku: 'HX-310', qty: 1 }, { sku: 'CB-010', qty: 8 }], laborHours: 2.5, laborRate: 62, overheadPerUnit: 40 });
    saveBOM({ sku: 'KT-950', components: [{ sku: 'KT-900', qty: 1 }, { sku: 'HX-100', qty: 2 }, { sku: 'CB-010', qty: 10 }], laborHours: 0.75, laborRate: 62, overheadPerUnit: 12 });
  });
  /** Buy whatever a work order is short of (req -> PO -> receipt -> invoice -> payment), dated inside the month. */
  function sourceShortages(w, p, ctx) {
    const short = woShortages(w); if (!short.length) return;
    const lines = short.map((s) => { const it = E.item(s.sku); const lot = lotSize(it); return { sku: s.sku, qty: Math.ceil((s.short + it.reorder) / lot) * lot, price: it.lastCost }; });
    ctx.at(ctx.D(p, 4));
    const r = E.createReq({ date: ctx.D(p, 4), requester: ctx.buyer.name, justification: `Components for ${w.id}`, lines });
    if (r.status === 'Pending Approval') ctx.asRole('Controller', 'Avery Lin', () => E.approveReq(r.id));
    ctx.at(ctx.D(p, 5)); const po = E.createPO({ reqId: r.id, supplierId: ctx.sups[0].id, date: ctx.D(p, 5) });
    ctx.at(ctx.D(p, 11)); E.receivePO(po.id, ctx.D(p, 11), po.lines.map((l) => l.qty));
    ctx.at(ctx.D(p, 14)); const inv = E.enterAPInvoice({ poId: po.id, number: `ARD-M${p.replace('-', '')}${w.id.slice(-3)}`, date: ctx.D(p, 14), lines: po.lines.map((l, i) => ({ line: i, qty: l.qty, price: l.price })) });
    if (inv.status === 'Validated' && p < '2026-11') { ctx.at(ctx.D(p, 26)); E.payInvoices([inv.id], ctx.D(p, 26), 'ACH'); }
  }
  function runWO(sku, qty, p, ctx, { close = true, complete = [qty] } = {}) {
    ctx.at(ctx.D(p, 6)); const w = createWO({ sku, qty, start: ctx.D(p, 6), due: ctx.D(p, 20), note: 'Build to stock' });
    sourceShortages(w, p, ctx);
    ctx.at(ctx.D(p, 12)); releaseWO(w.id, { date: ctx.D(p, 12) });
    ctx.at(ctx.D(p, 12)); issueComponents(w.id, { date: ctx.D(p, 12) });
    complete.forEach((q, i) => { const d = ctx.D(p, 18 + i * 3); ctx.at(d); reportCompletion(w.id, { date: d, qty: q }); });
    if (close) { ctx.at(ctx.D(p, 27)); closeWO(w.id, ctx.D(p, 27)); }
    return w;
  }
  function sell(custName, sku, qty, date, ctx) {
    const c = S().customers.find((x) => x.name === custName); ctx.at(date);
    const o = E.createSO({ customerId: c.id, date, lines: [{ sku, qty }], poNumber: `MS-${date.slice(5, 7)}${qty}${c.id.slice(-2)}` });
    if (o.status === 'Credit Hold') ctx.asRole('Controller', 'Avery Lin', () => E.releaseCreditHold(o.id));
    const d2 = addDays(date, 2); ctx.at(d2); return E.shipSO(o.id, d2);
  }
  let sepInvoice = null;
  E.on('seedMonthly', (p, ctx) => {
    if (p === '2026-08') runWO('HX-900', 12, p, ctx, { complete: [5, 7] });
    if (p === '2026-09') {
      runWO('HX-900', 16, p, ctx);
      runWO('KT-950', 30, p, ctx);
      sepInvoice = sell('Meridian Water Authority', 'HX-900', 6, ctx.D(p, 22), ctx);
      sell('Solace Pharma', 'KT-950', 12, ctx.D(p, 23), ctx);
      ctx.at(ctx.D(p, 25)); createCount({ date: ctx.D(p, 25), skus: ['HX-310', 'PL-500', 'CB-010'] });
      const cc = S().counts[S().counts.length - 1];
      enterCounts(cc.id, { 'HX-310': cc.lines[0].systemQty, 'PL-500': cc.lines[1].systemQty - 1, 'CB-010': cc.lines[2].systemQty - 15 });
      ctx.at(ctx.D(p, 26)); postCount(cc.id, ctx.D(p, 26));
    }
    if (p === '2026-10') {
      runWO('HX-900', 18, p, ctx, { close: false, complete: [10, 8] });
      sell('Solace Pharma', 'HX-900', 5, ctx.D(p, 21), ctx);
      sell('Meridian Water Authority', 'HX-900', 4, ctx.D(p, 24), ctx);
      if (sepInvoice) { ctx.at(ctx.D(p, 20)); E.applyReceipt({ invoiceId: sepInvoice.id, date: ctx.D(p, 20), amount: sepInvoice.total, reference: 'WIRE' + sepInvoice.id.slice(-4) }); }
      ctx.at(ctx.D(p, 28)); createCount({ date: ctx.D(p, 28), skus: ['HX-900', 'HX-220'] });
      const cc = S().counts[S().counts.length - 1];
      enterCounts(cc.id, { 'HX-900': cc.lines[0].systemQty, 'HX-220': cc.lines[1].systemQty + 2 });
      ctx.at(ctx.D(p, 29)); postCount(cc.id, ctx.D(p, 29));
    }
  });
  E.on('seedFinal', (ctx) => {
    const p = '2026-11';
    // In-progress station build: released, components issued, 4 of 12 reported
    ctx.at(ctx.D(p, 9)); const w = createWO({ sku: 'HX-900', qty: 12, start: ctx.D(p, 9), due: ctx.D(p, 24), note: 'Meridian rollout, phase 2' });
    sourceShortages(w, p, ctx);
    ctx.at(ctx.D(p, 10)); releaseWO(w.id, { date: ctx.D(p, 10) });
    ctx.at(ctx.D(p, 10)); issueComponents(w.id, { date: ctx.D(p, 10) });
    ctx.at(ctx.D(p, 16)); reportCompletion(w.id, { date: ctx.D(p, 16), qty: 4 });
    // Planned kit build for next week
    ctx.at(ctx.D(p, 16)); createWO({ sku: 'KT-950', qty: 20, start: ctx.D(p, 23), due: ctx.D(p, 30), note: 'Q4 service kits' });
    // Cycle count counted, awaiting posting
    ctx.at(ctx.D(p, 16)); const cc = createCount({ date: ctx.D(p, 16), n: 4 });
    const counts = {}; cc.lines.forEach((l, i) => { counts[l.sku] = Math.max(0, l.systemQty + [0, -3, 0, 1][i % 4]); });
    ctx.at(ctx.D(p, 17)); enterCounts(cc.id, counts);
  });

  E.extend({
    MFG: { OPEN_WO, WO_STEPS, COUNT_INTERVAL },
    wo, bom, count, bomCost, saveBOM, woWip, woShortages, woRemaining,
    createWO, releaseWO, issueComponents, reportCompletion, closeWO, cancelWO,
    supplyPlan, lotSize, createPlannedReqs, createPlannedWOs,
    abcClasses, countSchedule, createCount, enterCounts, countVariance, postCount, cancelCount,
  });
})(typeof window !== 'undefined' ? window : globalThis);
