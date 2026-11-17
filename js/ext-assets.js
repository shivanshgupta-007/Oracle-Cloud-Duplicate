/* Ledgerline Suite: ext-assets.js
 * Fixed assets book: asset register, straight-line monthly depreciation (full-month
 * convention), additions (cash or supplier invoice) with Controller approval above
 * $25,000, transfers, retirement/disposal with gain or loss, and reports
 * (register, 12-month projection, roll-forward). No DOM; runs in Node for tests.
 *
 * Conventions
 *  - Full-month convention: an asset depreciates a full month in the month it is
 *    capitalized and a full month in the month it is disposed of.
 *  - Each asset remembers the last period it was depreciated through (deprThrough).
 *    A run for period p charges every month from deprThrough+1 to p, so an asset added
 *    after its month's run is caught up in the next run.
 *  - Charges stop at cost - salvage; the final month takes the rounding remainder.
 *  - Disposal posts depreciation for any months not yet charged up to and including
 *    the disposal month inside the disposal journal, so the asset is never charged twice.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { r2, sum, money, periodOf, periodLabel, periodEnd, isDate } = E.util;
  const fail = (m) => { throw new Error(m); };

  const APPROVAL_LIMIT = 25000;
  const ACCT = { cost: '1500', accum: '1510', expense: '6300', cash: '1000', gain: '4910', loss: '6910' };
  const CATEGORIES = [
    { code: 'LAB', name: 'Lab and test equipment', life: 60 },
    { code: 'IT', name: 'Computers', life: 36 },
    { code: 'VEH', name: 'Vehicles', life: 60 },
    { code: 'FUR', name: 'Furniture and fittings', life: 84 },
    { code: 'LHI', name: 'Leasehold improvements', life: 120 },
  ];
  const cat = (code) => CATEGORIES.find((c) => c.code === code || c.name === code);

  // ---------- period arithmetic ----------
  const pIdx = (p) => { const [y, m] = p.split('-').map(Number); return y * 12 + (m - 1); };
  const pOf = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  const nextP = (p) => pOf(pIdx(p) + 1);
  const prevP = (p) => pOf(pIdx(p) - 1);

  // ---------- state ----------
  E.on('state', (S) => {
    S.assets = S.assets || [];
    S.depreciationLines = S.depreciationLines || [];
    S.depreciationRuns = S.depreciationRuns || {};
  });

  const asset = (id) => E.S.assets.find((a) => a.id === id);
  const monthly = (a) => r2((a.cost - a.salvage) / a.life);
  const remaining = (a, accum = a.accumulated) => r2(a.cost - a.salvage - accum);
  const nbv = (a) => r2(a.cost - a.accumulated);
  const isFully = (a) => remaining(a) <= 0;
  const inBook = (a) => a.status === 'Active';

  /** Depreciation due for asset a for every uncharged month up to and including p.
   *  st = {accumulated, deprThrough} lets projections simulate without mutating. */
  function chargeFor(a, p, st = a) {
    if (periodOf(a.date) > p) return { amount: 0, months: 0 };
    const start = st.deprThrough ? nextP(st.deprThrough) : periodOf(a.date);
    const from = start > periodOf(a.date) ? start : periodOf(a.date);
    const months = pIdx(p) - pIdx(from) + 1;
    const left = remaining(a, st.accumulated);
    if (months <= 0 || left <= 0) return { amount: 0, months: 0 };
    const elapsed = pIdx(p) - pIdx(periodOf(a.date)) + 1;     // months of life used through p
    const amount = elapsed >= a.life ? left : Math.min(left, r2(monthly(a) * months));
    return { amount: r2(amount), months };
  }
  /** Per-asset depreciation a run for period p would post now. */
  function depreciationPreview(p) {
    const lines = E.S.assets.filter(inBook).map((a) => ({ a, ...chargeFor(a, p) })).filter((x) => x.amount > 0)
      .map((x) => ({ assetId: x.a.id, category: x.a.category, amount: x.amount, months: x.months }));
    return { period: p, lines, total: sum(lines, (l) => l.amount) };
  }

  // ---------- depreciation run (replaces the core straight-line-on-GL version) ----------
  function runDepreciation(p) {
    const S = E.S;
    if (S.depreciationRuns[p]) fail(`Depreciation for ${periodLabel(p)} already posted (${S.depreciationRuns[p]}).`);
    if (!S.periods[p]) fail(`There is no accounting period ${p}.`);
    E.assertOpen(periodEnd(p));
    const missing = Object.keys(S.periods).filter((q) => q < p && !S.depreciationRuns[q]).sort();
    if (missing.length) fail(`Run depreciation for ${periodLabel(missing[0])} first. Depreciation runs in period order.`);
    const pv = depreciationPreview(p);
    if (!(pv.total > 0)) fail(`There is nothing to depreciate for ${periodLabel(p)}: every asset is fully depreciated, retired or not yet in service.`);
    const byCat = {};
    pv.lines.forEach((l) => { const c = (byCat[l.category] = byCat[l.category] || { amt: 0, n: 0 }); c.amt = r2(c.amt + l.amount); c.n++; });
    const lines = [];
    CATEGORIES.filter((c) => byCat[c.code]).forEach((c) => {
      const memo = `${c.name} (${byCat[c.code].n} asset${byCat[c.code].n > 1 ? 's' : ''})`;
      lines.push({ acct: ACCT.expense, dr: byCat[c.code].amt, memo }, { acct: ACCT.accum, cr: byCat[c.code].amt, memo });
    });
    const j = E.createJournal({ date: periodEnd(p), source: 'Assets', desc: `Straight-line depreciation ${periodLabel(p)} (${pv.lines.length} assets)`, lines });
    pv.lines.forEach((l) => {
      const a = asset(l.assetId); a.accumulated = r2(a.accumulated + l.amount); a.deprThrough = p;
      S.depreciationLines.push({ period: p, assetId: a.id, amount: l.amount, months: l.months, journal: j.id, kind: l.months > 1 ? 'Catch-up' : 'Monthly' });
    });
    S.depreciationRuns[p] = j.id;
    E.log('Ran depreciation', j.id, `${periodLabel(p)} ${money(j.total)}`);
    return j;
  }

  // ---------- additions ----------
  function validateAddition(o) {
    const S = E.S;
    const name = String(o.name || '').trim(); if (!name) fail('Describe the asset (for example "Calibration bench").');
    const c = cat(o.category); if (!c) fail('Choose an asset category.');
    const cost = r2(+o.cost); if (!Number.isFinite(cost) || !(cost > 0)) fail('Cost must be greater than zero.');
    const salvage = r2(+(o.salvage || 0)); if (!Number.isFinite(salvage) || salvage < 0) fail('Salvage value cannot be negative.');
    if (salvage >= cost) fail('Salvage value must be less than cost.');
    const life = o.life === undefined || o.life === '' ? c.life : +o.life;
    if (!Number.isInteger(life) || life < 1 || life > 600) fail('Useful life must be a whole number of months (1 to 600).');
    if (!isDate(o.date)) fail('Enter a valid capitalization date (YYYY-MM-DD).');
    E.assertOpen(o.date);
    const dept = o.dept || ''; if (dept && !S.departments.includes(dept)) fail(`Department ${dept} does not exist.`);
    if (o.custodian && !E.emp(o.custodian)) fail('Custodian (employee) was not found.');
    const method = o.method || 'cash'; if (!['cash', 'invoice'].includes(method)) fail('Choose how the asset was paid for: cash or supplier invoice.');
    let supplierId = '', invoiceNumber = '';
    if (method === 'invoice') {
      if (!E.sup(o.supplierId)) fail('Choose the supplier.');
      supplierId = o.supplierId; invoiceNumber = String(o.invoiceNumber || '').trim();
      if (!invoiceNumber) fail("Enter the supplier's invoice number.");
      const dup = S.apInvoices.some((i) => i.supplierId === supplierId && i.number === invoiceNumber && i.status !== 'Cancelled')
        || S.assets.some((a) => a.status === 'Pending Approval' && a.supplierId === supplierId && a.invoiceNumber === invoiceNumber);
      if (dup) fail(`Invoice ${invoiceNumber} from this supplier is already entered (duplicate check).`);
    }
    return { name, category: c.code, cost, salvage, life, date: o.date, dept, location: String(o.location || '').trim(), custodian: o.custodian || '', method, supplierId, invoiceNumber, tag: String(o.tag || '').trim() };
  }
  function capitalize(a, date) {
    const S = E.S;
    if (a.method === 'cash') {
      const cash = E.balance(ACCT.cash); if (a.cost > cash) fail(`Paying ${money(a.cost)} exceeds operating cash of ${money(cash)}.`);
      const j = E.createJournal({ date, source: 'Assets', desc: `Asset addition ${a.id} ${a.name} (cash purchase)`, ref: a.id, lines: [{ acct: ACCT.cost, dr: a.cost, memo: a.name }, { acct: ACCT.cash, cr: a.cost, memo: 'Paid by bank transfer' }] });
      a.journal = j.id;
    } else {
      const inv = E.createAPInvoice({ supplierId: a.supplierId, number: a.invoiceNumber, date, source: 'Assets', ref: a.id, lines: [{ acct: ACCT.cost, desc: `${a.id} ${a.name}`, amount: a.cost }] });
      a.invoiceId = inv.id; a.journal = inv.journal;
    }
    a.date = date; a.status = 'Active'; a.deprThrough = prevP(periodOf(date));
    void S;
  }
  /** addAsset({name, category, cost, salvage, life?, date, dept, location, custodian, method:'cash'|'invoice', supplierId, invoiceNumber, tag})
   *  Over $25,000 -> 'Pending Approval' with no GL; otherwise capitalized immediately. */
  function addAsset(o) {
    const S = E.S; const v = validateAddition(o || {});
    const a = { id: E.nextId('FA'), ...v, tag: v.tag || E.nextId('HI'), status: 'Draft', accumulated: 0, openingAccum: 0, deprThrough: '', journal: '', invoiceId: '', createdBy: S.user, history: [] };
    if (S.assets.some((x) => x.tag === a.tag)) fail(`Asset tag ${a.tag} is already in use.`);
    if (a.cost > APPROVAL_LIMIT) {
      a.status = 'Pending Approval';
      a.history.push({ date: a.date, type: 'Submitted', detail: `Over ${money(APPROVAL_LIMIT)}: sent to a Controller for approval`, by: S.user });
      S.assets.push(a); E.log('Submitted asset addition for approval', a.id, `${a.name} ${money(a.cost)}`);
      return a;
    }
    capitalize(a, a.date);
    a.history.push({ date: a.date, type: 'Capitalized', detail: a.method === 'cash' ? 'Cash purchase' : `Supplier invoice ${a.invoiceNumber}`, journal: a.journal, by: S.user });
    S.assets.push(a); E.log('Added asset', a.id, `${a.name} ${money(a.cost)}`);
    return a;
  }
  /** approveAsset(id, date?) — posts the acquisition. date overrides the GL date (e.g. when the original period closed). */
  function approveAsset(id, date) {
    const S = E.S; const a = E.need(asset(id), 'Asset');
    if (a.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`);
    if (a.createdBy === S.user && S.role !== 'Administrator') fail('You cannot approve an asset addition you entered (segregation of duties).');
    const d = date || a.date; E.assertOpen(d);
    capitalize(a, d);
    a.approvedBy = S.user;
    a.history.push({ date: d, type: 'Approved', detail: `Capitalized: ${a.method === 'cash' ? 'cash purchase' : 'supplier invoice ' + a.invoiceNumber}`, journal: a.journal, by: S.user });
    E.log('Approved asset addition', id, `${a.name} ${money(a.cost)}`);
    return a;
  }
  function rejectAsset(id, reason) {
    const S = E.S; const a = E.need(asset(id), 'Asset');
    if (a.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`);
    a.status = 'Rejected'; a.rejectReason = reason || ''; a.history.push({ date: S.today, type: 'Rejected', detail: reason || '', by: S.user });
    E.log('Rejected asset addition', id, reason); return a;
  }

  // ---------- transfers ----------
  function transferAsset({ id, date, dept, location, custodian }) {
    const S = E.S; const a = E.need(asset(id), 'Asset');
    if (a.status !== 'Active') fail(`${id} is ${a.status} and cannot be transferred.`);
    if (!isDate(date)) fail('Enter a valid transfer date.');
    if (dept && !S.departments.includes(dept)) fail(`Department ${dept} does not exist.`);
    if (custodian && !E.emp(custodian)) fail('Custodian (employee) was not found.');
    const nd = dept ?? a.dept, nl = location === undefined ? a.location : String(location).trim(), nc = custodian ?? a.custodian;
    if (nd === a.dept && nl === a.location && nc === a.custodian) fail('Nothing changed. Pick a new department, location or custodian.');
    const who = (e) => (e ? E.emp(e)?.name : 'nobody');
    const parts = [];
    if (nd !== a.dept) parts.push(`department ${a.dept || 'none'} to ${nd}`);
    if (nl !== a.location) parts.push(`location ${a.location || 'none'} to ${nl}`);
    if (nc !== a.custodian) parts.push(`custodian ${who(a.custodian)} to ${who(nc)}`);
    a.dept = nd; a.location = nl; a.custodian = nc;
    a.history.push({ date, type: 'Transferred', detail: parts.join('; '), by: S.user });
    E.log('Transferred asset', id, parts.join('; ')); return a;
  }

  // ---------- retirement / disposal ----------
  /** Figures a disposal on `date` for `proceeds` would post (no mutation). */
  function disposalPreview(id, date, proceeds) {
    const a = E.need(asset(id), 'Asset');
    if (a.status !== 'Active') fail(`${id} is ${a.status} and cannot be retired.`);
    if (!isDate(date)) fail('Enter a valid disposal date.');
    if (date < a.date) fail(`${id} was capitalized on ${a.date}; the disposal date cannot be earlier.`);
    proceeds = r2(+(proceeds || 0)); if (!Number.isFinite(proceeds) || proceeds < 0) fail('Proceeds cannot be negative. Enter 0 for a scrapped asset.');
    const d = periodOf(date);
    if (a.deprThrough && a.deprThrough > d) fail(`Depreciation on ${id} is posted through ${periodLabel(a.deprThrough)}. Date the disposal in ${periodLabel(a.deprThrough)} or later.`);
    const catchUp = chargeFor(a, d);
    const accum = r2(a.accumulated + catchUp.amount);
    const book = r2(a.cost - accum);
    return { asset: a, period: d, proceeds, catchUp: catchUp.amount, catchUpMonths: catchUp.months, accumulated: accum, nbv: book, gainLoss: r2(proceeds - book) };
  }
  /** retireAsset({id, date, proceeds, reason}) — Dr 1000 proceeds, Dr 1510 accumulated, Cr 1500 cost, gain Cr 4910 / loss Dr 6910. */
  function retireAsset({ id, date, proceeds = 0, reason = '' }) {
    const S = E.S; const x = disposalPreview(id, date, proceeds); const a = x.asset;
    E.assertOpen(date);
    E.ensureAccount(ACCT.gain, 'Gain on disposal', 'Revenue'); E.ensureAccount(ACCT.loss, 'Loss on disposal', 'Expense');
    const lines = [];
    if (x.catchUp > 0) lines.push({ acct: ACCT.expense, dr: x.catchUp, memo: `Depreciation to disposal (${x.catchUpMonths} month${x.catchUpMonths > 1 ? 's' : ''})` }, { acct: ACCT.accum, cr: x.catchUp, memo: 'Depreciation to disposal' });
    if (x.proceeds > 0) lines.push({ acct: ACCT.cash, dr: x.proceeds, memo: 'Sale proceeds' });
    lines.push({ acct: ACCT.accum, dr: x.accumulated, memo: 'Remove accumulated depreciation' }, { acct: ACCT.cost, cr: a.cost, memo: 'Remove cost' });
    if (x.gainLoss > 0) lines.push({ acct: ACCT.gain, cr: x.gainLoss, memo: 'Gain on disposal' });
    if (x.gainLoss < 0) lines.push({ acct: ACCT.loss, dr: -x.gainLoss, memo: 'Loss on disposal' });
    const j = E.createJournal({ date, source: 'Assets', desc: `Disposal of ${a.id} ${a.name}${reason ? ': ' + reason : ''}`, ref: a.id, lines });
    if (x.catchUp > 0) { S.depreciationLines.push({ period: x.period, assetId: a.id, amount: x.catchUp, months: x.catchUpMonths, journal: j.id, kind: 'At disposal' }); a.deprThrough = x.period; }
    a.accumulated = x.accumulated; a.status = 'Retired';
    a.retired = { date, proceeds: x.proceeds, accumulated: x.accumulated, nbv: x.nbv, gainLoss: x.gainLoss, journal: j.id, reason };
    a.history.push({ date, type: 'Retired', detail: `${x.proceeds > 0 ? 'Sold for ' + money(x.proceeds) : 'Scrapped'}; ${x.gainLoss >= 0 ? 'gain' : 'loss'} ${money(Math.abs(x.gainLoss))}${reason ? ' (' + reason + ')' : ''}`, journal: j.id, by: S.user });
    E.log('Retired asset', a.id, `${a.name}: proceeds ${money(x.proceeds)}, ${x.gainLoss >= 0 ? 'gain' : 'loss'} ${money(Math.abs(x.gainLoss))}`);
    return a;
  }

  // ---------- reports ----------
  function remainingLife(a) { const m = monthly(a); const left = remaining(a); return left <= 0 || !(m > 0) ? 0 : Math.ceil(left / m - 1e-9); }
  /** Register of assets in the book with totals. */
  function assetRegister() {
    const rows = E.S.assets.filter(inBook).map((a) => ({ id: a.id, tag: a.tag, name: a.name, category: a.category, dept: a.dept, date: a.date, cost: a.cost, salvage: a.salvage, accumulated: a.accumulated, nbv: nbv(a), monthly: isFully(a) ? 0 : monthly(a), remainingLife: remainingLife(a), fully: isFully(a) }));
    return { rows, totals: { cost: sum(rows, (r) => r.cost), accumulated: sum(rows, (r) => r.accumulated), nbv: sum(rows, (r) => r.nbv), monthly: sum(rows, (r) => r.monthly) } };
  }
  /** First period without a depreciation run (where the projection starts). */
  function nextDepreciationPeriod() {
    const S = E.S; const ps = Object.keys(S.periods).sort();
    const p = ps.find((q) => !S.depreciationRuns[q]);
    return p || nextP(ps[ps.length - 1]);
  }
  /** Projected depreciation for n months from `from` (default: first un-run period), per asset and by category. */
  function depreciationProjection(from, n = 12) {
    from = from || nextDepreciationPeriod();
    const periods = Array.from({ length: n }, (_, i) => pOf(pIdx(from) + i));
    const rows = E.S.assets.filter(inBook).map((a) => {
      const st = { accumulated: a.accumulated, deprThrough: a.deprThrough };
      const amounts = periods.map((p) => { const c = chargeFor(a, p, st); if (c.amount > 0) { st.accumulated = r2(st.accumulated + c.amount); st.deprThrough = p; } return c.amount; });
      return { id: a.id, name: a.name, category: a.category, amounts, total: sum(amounts) };
    }).filter((r) => r.total > 0);
    const totals = periods.map((_, i) => sum(rows, (r) => r.amounts[i]));
    const byCategory = CATEGORIES.map((c) => { const rs = rows.filter((r) => r.category === c.code); return { category: c.code, name: c.name, amounts: periods.map((_, i) => sum(rs, (r) => r.amounts[i])), total: sum(rs, (r) => r.total) }; }).filter((r) => r.total > 0);
    return { periods, rows, byCategory, totals, total: sum(totals) };
  }
  /** Roll-forward of cost and accumulated depreciation for fromP..toP (inclusive). */
  function rollForward(fromP, toP) {
    if (!fromP || !toP || fromP > toP) fail('Choose a period range where the start is on or before the end.');
    const S = E.S;
    const capP = (a) => (a.opening ? '0000-00' : periodOf(a.date));
    const booked = S.assets.filter((a) => a.status === 'Active' || a.status === 'Retired');
    const retP = (a) => (a.status === 'Retired' ? periodOf(a.retired.date) : '9999-99');
    const deprBefore = (a, p) => r2((a.openingAccum || 0) + sum(S.depreciationLines.filter((l) => l.assetId === a.id && l.period < p), (l) => l.amount));
    const openSet = booked.filter((a) => capP(a) < fromP && retP(a) >= fromP);
    const added = booked.filter((a) => capP(a) >= fromP && capP(a) <= toP);
    const disposed = booked.filter((a) => retP(a) >= fromP && retP(a) <= toP);
    const cost = { opening: sum(openSet, (a) => a.cost), additions: sum(added, (a) => a.cost), disposals: sum(disposed, (a) => a.cost) };
    cost.closing = r2(cost.opening + cost.additions - cost.disposals);
    const accum = { opening: sum(openSet, (a) => deprBefore(a, fromP)), depreciation: sum(S.depreciationLines.filter((l) => l.period >= fromP && l.period <= toP), (l) => l.amount), disposals: sum(disposed, (a) => a.retired.accumulated) };
    accum.closing = r2(accum.opening + accum.depreciation - accum.disposals);
    const gl = { cost: E.balance(ACCT.cost, { toPeriod: toP }), accum: -E.balance(ACCT.accum, { toPeriod: toP }) };
    return { from: fromP, to: toP, cost, accum, nbv: { opening: r2(cost.opening - accum.opening), closing: r2(cost.closing - accum.closing) }, gl, added: added.map((a) => a.id), disposed: disposed.map((a) => a.id) };
  }
  const assetJournals = (id) => {
    const a = asset(id); if (!a) return [];
    const ids = new Set([a.journal, a.retired?.journal, ...E.S.depreciationLines.filter((l) => l.assetId === id).map((l) => l.journal)].filter(Boolean));
    return E.S.journals.filter((j) => ids.has(j.id) || j.ref === id || (a.invoiceId && j.ref === a.invoiceId));
  };

  // ---------- hooks ----------
  E.on('reconcile', (b) => {
    const S = E.S; const book = S.assets.filter(inBook);
    return [
      { name: 'Fixed assets cost', acct: ACCT.cost, sub: sum(book, (a) => a.cost), gl: b[ACCT.cost] || 0 },
      { name: 'Accumulated depreciation', acct: ACCT.accum, sub: sum(book, (a) => a.accumulated), gl: r2(-(b[ACCT.accum] || 0)) },
    ];
  });
  E.on('approvals', () => E.S.assets.filter((a) => a.status === 'Pending Approval').map((a) => ({
    kind: 'asset', id: a.id, title: `Asset addition ${money(a.cost)}: ${a.name}`, who: a.createdBy, date: a.date, perm: 'fa.approve', why: `Over ${money(APPROVAL_LIMIT)} capitalization limit`,
  })));
  E.on('checklist', (p) => {
    const S = E.S; if (!S.assets.length) return [];
    const run = S.depreciationRuns[p];
    const end = periodEnd(p);
    const behind = S.assets.filter((a) => inBook(a) && a.date <= end && !isFully(a) && (!a.deprThrough || a.deprThrough < p));
    const j = run && E.je(run);
    const lines = sum(S.depreciationLines.filter((l) => l.journal === run), (l) => l.amount);
    const tie = !!j && Math.abs(j.total - lines) < 0.01;
    const done = !!run && tie && !behind.length;
    return [{ task: 'Depreciation matches asset register', advisory: true, done,
      detail: !run ? 'No depreciation run yet' : !tie ? `${run} does not tie to the register lines` : behind.length ? `${behind.length} asset(s) not yet depreciated for ${periodLabel(p)} (caught up in the next run)` : `${run} ties to ${S.depreciationLines.filter((l) => l.journal === run).length} register lines` }];
  });
  E.on('search', (q, hit) => E.S.assets.filter((a) => hit(a.id, a.tag, a.name, cat(a.category)?.name, E.emp(a.custodian)?.name)).map((a) => ({ kind: 'asset', id: a.id, label: `${a.tag} ${a.name}`, sub: `Asset ${a.id}, ${a.status}, NBV ${money(nbv(a))}` })));
  E.addPerms('Controller', ['fa.edit', 'fa.approve']);

  // ---------- seed ----------
  const OPENING = [
    // [name, cat, cost, salvage, in-service, dept, location, custodian]
    ['Environmental test chamber', 'LAB', 48000, 3000, '2025-09-15', 'Engineering', 'Boston, MA: test lab', 'Oliver Brandt'],
    ['Calibration bench, 6-channel', 'LAB', 32000, 2000, '2025-01-20', 'Operations', 'Boston, MA: calibration room', 'Marco Bellini'],
    ['Precision multimeter set', 'LAB', 8800, 400, '2025-07-08', 'Engineering', 'Boston, MA: test lab', 'Hana Sato'],
    ['Delivery van, diesel', 'VEH', 36000, 6000, '2024-04-02', 'Operations', 'Boston, MA: loading dock', 'Marco Bellini'],
    ['Laptops, finance and sales (12)', 'IT', 21600, 0, '2025-07-14', 'Finance', 'Boston, MA: head office', 'Theo Okafor'],
    ['Engineering workstations (4)', 'IT', 14400, 0, '2026-01-12', 'Engineering', 'Boston, MA: head office', 'Lena Park'],
    ['Office fit-out, Fenwick Park unit 4', 'LHI', 54000, 0, '2025-11-03', 'Executive', 'Fenwick Park unit 4', 'Margit Halden'],
    ['Office furniture and fittings', 'FUR', 16800, 0, '2025-10-06', 'People', 'Fenwick Park unit 4', 'Rosa Medina'],
    ['Warehouse racking and pallet truck', 'FUR', 8400, 0, '2025-07-21', 'Operations', 'Boston, MA: warehouse', 'Marco Bellini'],
  ];
  const OPENING_COST = 240000, OPENING_ACCUM = 48000, TAKE_ON = '2026-06';
  E.on('seedSetup', (ctx) => {
    const S = ctx.S;
    E.ensureAccount(ACCT.gain, 'Gain on disposal', 'Revenue'); E.ensureAccount(ACCT.loss, 'Loss on disposal', 'Expense');
    const byName = (n) => S.employees.find((e) => e.name === n)?.id || '';
    const list = OPENING.map(([name, c, cost, salvage, date, dept, location, who]) => {
      const life = cat(c).life;
      const a = { id: E.nextId('FA'), tag: E.nextId('HI'), name, category: c, cost, salvage, life, date, dept, location, custodian: byName(who), method: 'opening', supplierId: '', invoiceNumber: '', status: 'Active', opening: true, journal: '', invoiceId: '', createdBy: 'Data migration', history: [] };
      const months = Math.min(life, pIdx(TAKE_ON) - pIdx(periodOf(date)) + 1);
      a.accumulated = Math.min(r2(monthly(a) * months), r2(cost - salvage));
      return a;
    });
    // make the take-on totals tie exactly to the opening journal (prior-system rounding goes to the largest asset)
    const costDiff = r2(OPENING_COST - sum(list, (a) => a.cost));
    if (costDiff) fail(`Opening register cost does not tie to the opening journal by ${money(costDiff)}.`);
    const diff = r2(OPENING_ACCUM - sum(list, (a) => a.accumulated));
    const big = list.slice().sort((x, y) => y.cost - x.cost)[0]; big.accumulated = r2(big.accumulated + diff);
    list.forEach((a) => {
      a.openingAccum = a.accumulated; a.deprThrough = TAKE_ON;
      a.history.push({ date: '2026-07-01', type: 'Opening balance', detail: `Migrated with cost ${money(a.cost)} and accumulated depreciation ${money(a.accumulated)} as of 30 Jun 2026`, by: 'Data migration' });
      S.assets.push(a);
    });
  });
  E.on('seedMonthly', (p, ctx) => {
    const S = ctx.S; const byName = (n) => S.employees.find((e) => e.name === n)?.id || '';
    if (p === '2026-08') {
      ctx.at('2026-08-18');
      addAsset({ name: 'Mixed-signal oscilloscope, 8-channel', category: 'LAB', cost: 18400, salvage: 400, date: '2026-08-18', dept: 'Engineering', location: 'Boston, MA: test lab', custodian: byName('Hana Sato'), method: 'invoice', supplierId: ctx.sups[1].id, invoiceNumber: 'KES-26-0815' });
    }
    if (p === '2026-09') {
      ctx.at('2026-09-10');
      addAsset({ name: 'Laptops, field engineers (6)', category: 'IT', cost: 10800, date: '2026-09-10', dept: 'Sales', location: 'Boston, MA: head office', custodian: byName('Jonas Weller'), method: 'cash' });
    }
    if (p === '2026-10') {
      ctx.at('2026-10-20');
      const van = addAsset({ name: 'Delivery van, electric', category: 'VEH', cost: 41500, salvage: 7500, date: '2026-10-20', dept: 'Operations', location: 'Boston, MA: loading dock', custodian: byName('Marco Bellini'), method: 'cash' });
      ctx.at('2026-10-21'); ctx.asRole('Controller', 'Avery Lin', () => approveAsset(van.id));
      ctx.at('2026-10-28');
      const old = S.assets.find((a) => a.name === 'Delivery van, diesel');
      retireAsset({ id: old.id, date: '2026-10-28', proceeds: 21250, reason: 'Sold to a dealer, replaced by electric van' });
    }
  });
  E.on('seedFinal', (ctx) => {
    const S = ctx.S;
    ctx.at('2026-11-16');
    addAsset({ name: 'Climatic chamber, 1,000 L', category: 'LAB', cost: 68000, salvage: 4000, date: '2026-11-16', dept: 'Engineering', location: 'Boston, MA: test lab', custodian: S.employees.find((e) => e.name === 'Oliver Brandt')?.id || '', method: 'invoice', supplierId: ctx.sups[1].id, invoiceNumber: 'KES-26-1142' });
  });

  E.extend({
    FA_APPROVAL_LIMIT: APPROVAL_LIMIT, FA_CATEGORIES: CATEGORIES, FA_ACCOUNTS: ACCT,
    asset, assetCategory: cat, runDepreciation, depreciationPreview, assetCharge: (id, p) => chargeFor(E.need(asset(id), 'Asset'), p),
    addAsset, approveAsset, rejectAsset, transferAsset, retireAsset, disposalPreview,
    assetRegister, depreciationProjection, rollForward, nextDepreciationPeriod, assetJournals,
    assetNBV: (id) => nbv(E.need(asset(id), 'Asset')), assetMonthly: (id) => monthly(E.need(asset(id), 'Asset')),
  });
})(typeof window !== 'undefined' ? window : globalThis);
