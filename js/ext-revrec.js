/* Ledgerline Suite: ext-revrec.js
 * Revenue contracts (ASC 606-style, simplified) and year-end close. No DOM; runs in Node.
 *
 * Accounts
 *  - 2450 Deferred revenue (Liability). 2400 is already "Accrued liabilities" in this chart (used by
 *    expense accruals), so contract liabilities get their own account and reconcile on their own.
 *  - 2410 Customer refunds payable (Liability), 4200 Service contract revenue, 4000 Product revenue.
 *
 * Conventions
 *  - Transaction price = sum of qty x price. With standalone selling prices (ssp per unit), the price
 *    is allocated by relative SSP (qty x ssp weights); the last line takes the rounding remainder.
 *    Lines without ssp use their own price as SSP.
 *  - Recognition is monthly, straight-line over the term. The start month counts as a full month
 *    (no daily proration); the term is whole months; the last month takes the rounding remainder,
 *    so every schedule sums exactly to the allocated amount. Product (instrument) lines are a
 *    point-in-time obligation recognized in full in the start month to 4000.
 *  - Billing: 'annual' (in advance, one invoice per 12-month block, covering exactly the schedule
 *    amounts of those months, so the product portion is in the first invoice) or 'monthly' (one
 *    invoice per month). Every invoice credits 2450; recognition always moves 2450 to revenue, so
 *    both billing plans use one path. The first installment is billed when the contract is created
 *    (if its period is open); later ones by runContractBilling(p).
 *  - runRecognition(p): one journal per open period, dated the period end, Dr 2450 / Cr 4200 (+ Cr 4000)
 *    for every unrecognized schedule line in periods <= p (catches up contracts entered late). Once per period.
 *  - Cancellation on date d: months after d's period are cancelled; months up to d's period stay
 *    (recognized by the next run, billable if unbilled). For cancelled months that were already billed:
 *    the unpaid part of that invoice is credited (Dr 2450 / Cr 1100, invoice.credited increases, so AR
 *    still reconciles); any part the customer already paid becomes a refund liability (Dr 2450 / Cr 2410).
 *    Unbilled cancelled months simply drop out (nothing was booked).
 *  - Year-end close: yearEndPreview / yearEndClose('FY2027') move every Revenue and Expense balance of
 *    the fiscal year into 3100 Retained earnings, per entity (line.entity || 'US01'), dated the last
 *    day of the year. Preconditions: first 11 periods Closed, last period Open, no pending journals in the year.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { r2, sum, money, periodOf, periodLabel, periodEnd, isDate } = E.util;
  const fail = (m) => { throw new Error(m); };
  const ACCT = { deferred: '2450', refund: '2410', service: '4200', product: '4000', ar: '1100', re: '3100' };
  const DEFAULT_ENTITY = 'US01';
  const CATALOGUE = [
    { code: 'SV-100', name: 'Annual calibration plan', basis: 'year', list: 1800, unit: 'per instrument per year' },
    { code: 'SV-200', name: 'Extended warranty, 24 months', basis: 'term', list: 2400, term: 24, unit: 'per instrument for 24 months' },
    { code: 'SV-300', name: 'Remote monitoring subscription', basis: 'month', list: 95, unit: 'per sensor per month' },
  ];
  const svc = (code) => CATALOGUE.find((c) => c.code === code);

  const pIdx = (p) => { const [y, m] = p.split('-').map(Number); return y * 12 + (m - 1); };
  const pOf = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  const addP = (p, n) => pOf(pIdx(p) + n);
  const dayIn = (p, d) => `${p}-${String(Math.min(d, +periodEnd(p).slice(8))).padStart(2, '0')}`;

  E.on('state', (S) => {
    S.rcontracts = S.rcontracts || [];
    S.revrecRuns = S.revrecRuns || {};
    S.yearEnd = S.yearEnd || {};
  });
  const ensureAccounts = () => {
    E.ensureAccount(ACCT.deferred, 'Deferred revenue', 'Liability');
    E.ensureAccount(ACCT.refund, 'Customer refunds payable', 'Liability');
    E.ensureAccount(ACCT.service, 'Service contract revenue', 'Revenue');
  };
  const rcontract = (id) => E.S.rcontracts.find((c) => c.id === id);

  /** Default unit price for a service line over a term (months). */
  function listPrice(code, term) {
    const s = svc(code); if (!s) return 0;
    return s.basis === 'year' ? r2(s.list * term / 12) : s.basis === 'month' ? r2(s.list * term) : s.list;
  }
  /** Relative-SSP allocation: allocate(total, [weights]) -> amounts summing exactly to total. */
  function allocate(total, weights) {
    const W = weights.reduce((a, b) => a + b, 0); let acc = 0;
    return weights.map((w, i) => { if (i === weights.length - 1) return r2(total - acc); const v = W ? r2(total * w / W) : 0; acc = r2(acc + v); return v; });
  }
  /** Straight-line monthly split of amount over n months; remainder to the last month. */
  function straightLine(amount, n) {
    const m = r2(amount / n); const out = Array.from({ length: n }, () => m); out[n - 1] = r2(amount - m * (n - 1)); return out;
  }

  /** Validates input and builds the contract object (lines, allocation, schedule, installments). No state change. */
  function buildContract({ customerId, start, term, lines, billing = 'annual', name = '' }) {
    const c = E.need(E.cust(customerId), 'Customer');
    if (!isDate(start)) fail('Enter a valid start date (YYYY-MM-DD).');
    term = +term; if (!Number.isInteger(term) || term < 1 || term > 60) fail('Term must be a whole number of months from 1 to 60.');
    if (!['annual', 'monthly'].includes(billing)) fail('Billing must be annual in advance or monthly.');
    const sp = periodOf(start); if (!E.S.periods[sp]) fail(`Start ${start} is outside the FY2027 calendar.`);
    const ls = (lines || []).filter((l) => l && (l.service || l.sku) && +l.qty).map((l) => {
      const kind = l.sku ? 'product' : 'service';
      if (kind === 'service' && !svc(l.service)) fail(`Service ${l.service} is not in the catalogue.`);
      if (kind === 'product' && !E.item(l.sku)) fail(`Item ${l.sku} does not exist.`);
      const qty = +l.qty; if (!(qty > 0) || !Number.isFinite(qty)) fail('Quantities must be greater than zero.');
      const price = l.price === '' || l.price == null ? (kind === 'product' ? E.item(l.sku).price : listPrice(l.service, term)) : r2(+l.price);
      if (!(price >= 0) || !Number.isFinite(price)) fail('Prices must be zero or more.');
      const ssp = l.ssp === '' || l.ssp == null ? null : r2(+l.ssp);
      if (ssp != null && (!(ssp > 0) || !Number.isFinite(ssp))) fail('Standalone selling prices must be greater than zero.');
      const desc = kind === 'product' ? `${l.sku} ${E.item(l.sku).name}` : `${l.service} ${svc(l.service).name}`;
      return { kind, service: l.service || '', sku: l.sku || '', desc, qty, price, ssp, amount: r2(qty * price) };
    });
    if (!ls.length) fail('Add at least one line with a quantity.');
    const total = sum(ls, (l) => l.amount); if (!(total > 0)) fail('The contract total must be greater than zero.');
    const useSsp = ls.some((l) => l.ssp != null);
    const alloc = useSsp ? allocate(total, ls.map((l) => l.qty * (l.ssp != null ? l.ssp : l.price))) : ls.map((l) => l.amount);
    ls.forEach((l, i) => { l.allocated = alloc[i]; });
    // schedule: one row per month of the term
    const sched = Array.from({ length: term }, (_, k) => ({ period: addP(sp, k), product: 0, service: 0 }));
    ls.forEach((l) => {
      if (l.kind === 'product') sched[0].product = r2(sched[0].product + l.allocated);
      else straightLine(l.allocated, term).forEach((v, k) => { sched[k].service = r2(sched[k].service + v); });
    });
    const day = +start.slice(8);
    const inst = [];
    const block = billing === 'monthly' ? 1 : 12;
    for (let k = 0; k < term; k += block) inst.push({ n: inst.length + 1, due: k === 0 ? start : dayIn(addP(sp, k), day), from: addP(sp, k), to: addP(sp, Math.min(term, k + block) - 1), amount: 0, invoiceId: '', status: 'Scheduled' });
    sched.forEach((s, k) => { s.amount = r2(s.product + s.service); s.inst = Math.floor(k / block); s.journal = ''; s.status = 'Scheduled'; inst[s.inst].amount = r2(inst[s.inst].amount + s.amount); });
    return { customerId: c.id, name: String(name || '').trim(), start, end: periodEnd(addP(sp, term - 1)), term, billing, lines: ls, total, allocation: useSsp ? 'Relative SSP' : 'Contract price', schedule: sched, installments: inst };
  }
  /** Preview (no posting): same object createContract would store, without id. */
  const contractPreview = (args) => buildContract(args);

  /** createContract({customerId, start, term, lines:[{service|sku, qty, price?, ssp?}], billing:'annual'|'monthly', name?})
   *  Bills the first installment now if its period is open. */
  function createContract(args) {
    const S = E.S; const k = buildContract(args);
    const firstOpen = S.periods[periodOf(k.installments[0].due)] === 'Open';
    ensureAccounts();
    const rc = { id: E.nextId('RC'), ...k, status: 'Active', createdBy: S.user, createdAt: S._date || S.today, history: [] };
    rc.history.push({ date: S._date || S.today, type: 'Created', detail: `${money(rc.total)}, ${rc.term} months from ${rc.start}, ${rc.billing === 'monthly' ? 'billed monthly' : 'billed annually in advance'}${rc.allocation === 'Relative SSP' ? ', allocated by relative SSP' : ''}` });
    if (firstOpen) billInstallment(rc, rc.installments[0]);
    S.rcontracts.push(rc);
    E.log('Created revenue contract', rc.id, `${E.cust(rc.customerId).name} ${money(rc.total)}`);
    return rc;
  }
  function billInstallment(rc, ins) {
    if (ins.invoiceId) fail(`Installment ${ins.n} of ${rc.id} is already billed.`);
    if (!(ins.amount > 0)) { ins.status = 'Nothing to bill'; return null; }
    const inv = E.createARInvoice({ customerId: rc.customerId, date: ins.due, source: 'Revenue', ref: rc.id,
      lines: [{ acct: ACCT.deferred, desc: `${rc.id} ${periodLabel(ins.from)}${ins.to !== ins.from ? ' to ' + periodLabel(ins.to) : ''}`, amount: ins.amount }] });
    ins.invoiceId = inv.id; ins.status = 'Billed';
    rc.history.push({ date: ins.due, type: 'Billed', detail: `Installment ${ins.n}, ${money(ins.amount)}`, invoice: inv.id, journal: inv.journal });
    return inv;
  }
  /** Installments due (due date in a period <= p) and not yet billed, for active contracts. */
  const billingDue = (p) => E.S.rcontracts.flatMap((c) => c.installments.filter((i) => !i.invoiceId && i.status === 'Scheduled' && periodOf(i.due) <= p).map((i) => ({ contract: c, inst: i })));
  /** runContractBilling(p): bills every unbilled installment due up to p, each dated max(due, first of p). Returns invoices. */
  function runContractBilling(p) {
    if (E.S.periods[p] !== 'Open') fail(`${periodLabel(p)} is not open.`);
    const due = billingDue(p); if (!due.length) fail(`No contract installments are due for billing in ${periodLabel(p)}.`);
    const out = due.map(({ contract, inst }) => { if (inst.due < p + '-01') inst.due = p + '-01'; return billInstallment(contract, inst); }).filter(Boolean);
    E.log('Ran contract billing', periodLabel(p), `${out.length} invoice(s)`); return out;
  }

  /** Unrecognized schedule lines in periods <= p (all active contracts). */
  function recognitionDue(p) {
    const rows = [];
    E.S.rcontracts.forEach((c) => c.schedule.forEach((s) => { if (s.status === 'Scheduled' && s.period <= p && s.amount) rows.push({ contract: c, line: s }); }));
    return rows;
  }
  function recognitionPreview(p) {
    const rows = recognitionDue(p);
    return { period: p, rows: rows.map(({ contract, line }) => ({ id: contract.id, customerId: contract.customerId, period: line.period, product: line.product, service: line.service, amount: line.amount })),
      product: sum(rows, (r) => r.line.product), service: sum(rows, (r) => r.line.service), total: sum(rows, (r) => r.line.amount), run: E.S.revrecRuns[p] || '' };
  }
  /** runRecognition(p): Dr 2450 / Cr 4200 (and Cr 4000 for product obligations) for everything due through p. Once per period. */
  function runRecognition(p) {
    const S = E.S;
    if (!S.periods[p]) fail('Choose a period inside the FY2027 calendar.');
    if (S.revrecRuns[p]) fail(`Revenue recognition for ${periodLabel(p)} was already run (${S.revrecRuns[p]}).`);
    if (S.periods[p] !== 'Open') fail(`${periodLabel(p)} is ${S.periods[p]}. Recognition runs only in an open period.`);
    const pv = recognitionPreview(p); if (!(pv.total > 0)) fail(`Nothing is due for recognition through ${periodLabel(p)}.`);
    ensureAccounts();
    const lines = [{ acct: ACCT.deferred, dr: pv.total, memo: `${new Set(pv.rows.map((r) => r.id)).size} contract(s)` }];
    if (pv.service) lines.push({ acct: ACCT.service, cr: pv.service, memo: 'Services recognized over time' });
    if (pv.product) lines.push({ acct: ACCT.product, cr: pv.product, memo: 'Bundled instruments, point in time' });
    const j = E.createJournal({ date: periodEnd(p), source: 'Revenue', desc: `Revenue recognition ${periodLabel(p)}`, ref: 'REVREC-' + p, lines });
    recognitionDue(p).forEach(({ contract, line }) => { line.status = 'Recognized'; line.journal = j.id; line.runPeriod = p; });
    S.rcontracts.forEach((c) => { if (c.status === 'Active' && c.schedule.every((s) => s.status !== 'Scheduled')) c.status = 'Completed'; });
    S.revrecRuns[p] = j.id; E.log('Ran revenue recognition', j.id, `${periodLabel(p)} ${money(pv.total)}`);
    return j;
  }

  /** Billed-but-unrecognized amount of one contract (its share of GL 2450). */
  function deferredOf(c) {
    return sum(c.schedule.filter((s) => s.status === 'Scheduled' && c.installments[s.inst].invoiceId), (s) => s.amount);
  }
  const recognizedOf = (c) => sum(c.schedule.filter((s) => s.status === 'Recognized'), (s) => s.amount);
  const billedOf = (c) => sum(c.installments.filter((i) => i.invoiceId), (i) => i.amount);

  /** Preview of a cancellation: which months drop and how billed amounts unwind. */
  function cancelPreview(id, date) {
    const S = E.S; const c = E.need(rcontract(id), 'Revenue contract');
    if (c.status !== 'Active') fail(`${id} is ${c.status} and cannot be cancelled.`);
    if (!isDate(date)) fail('Enter a valid cancellation date.');
    if (date < c.start) fail(`Cancel on or after the start date ${c.start}. To undo a contract entirely, cancel it on its start date.`);
    const cp = periodOf(date);
    const drop = c.schedule.filter((s) => s.status === 'Scheduled' && s.period > cp);
    if (!drop.length) fail(`${id} has no unrecognized months after ${periodLabel(cp)} to cancel.`);
    const perInv = [];
    c.installments.forEach((ins, k) => {
      const amt = sum(drop.filter((s) => s.inst === k), (s) => s.amount);
      if (!amt || !ins.invoiceId) return;
      const inv = E.arinv(ins.invoiceId); const open = E.openAmt(inv);
      const credit = r2(Math.min(open, amt)); perInv.push({ inst: ins.n, invoiceId: inv.id, amount: amt, credit, refund: r2(amt - credit) });
    });
    return { id, date, period: cp, months: drop.length, dropped: sum(drop, (s) => s.amount), unbilled: sum(drop.filter((s) => !c.installments[s.inst].invoiceId), (s) => s.amount),
      invoices: perInv, credit: sum(perInv, (x) => x.credit), refund: sum(perInv, (x) => x.refund) };
  }
  /** cancelContract(id, date, reason): cancels months after date's period (see header for the accounting). */
  function cancelContract(id, date, reason = '') {
    const S = E.S; const c = rcontract(id); const pv = cancelPreview(id, date);
    if (pv.credit || pv.refund) E.assertOpen(date);
    ensureAccounts();
    let j = null;
    if (pv.credit || pv.refund) {
      const lines = [{ acct: ACCT.deferred, dr: r2(pv.credit + pv.refund), memo: `${id} cancelled months` }];
      if (pv.credit) lines.push({ acct: ACCT.ar, cr: pv.credit, memo: E.cust(c.customerId).name });
      if (pv.refund) lines.push({ acct: ACCT.refund, cr: pv.refund, memo: `Refund due to ${E.cust(c.customerId).name}` });
      j = E.createJournal({ date, source: 'Revenue', desc: `Cancellation of ${id} after ${periodLabel(pv.period)}${reason ? ': ' + reason : ''}`, ref: id, lines });
      pv.invoices.forEach((x) => {
        if (!x.credit) return; const inv = E.arinv(x.invoiceId);
        inv.credited = r2((inv.credited || 0) + x.credit);
        if (E.openAmt(inv) <= 0.004) inv.status = (inv.paid || 0) > 0.004 ? 'Paid' : 'Credited';
        (inv.adjustments = inv.adjustments || []).push({ date, amount: x.credit, journal: j.id, ref: id, reason: 'Contract cancellation' });
      });
    }
    c.schedule.forEach((s) => { if (s.status === 'Scheduled' && s.period > pv.period) s.status = 'Cancelled'; });
    c.installments.forEach((ins) => { if (!ins.invoiceId && c.schedule.filter((s) => s.inst === ins.n - 1).every((s) => s.status === 'Cancelled')) ins.status = 'Cancelled';
      else if (!ins.invoiceId) ins.amount = sum(c.schedule.filter((s) => s.inst === ins.n - 1 && s.status !== 'Cancelled'), (s) => s.amount); });
    c.status = 'Cancelled'; c.cancelled = { date, reason, journal: j ? j.id : '', credit: pv.credit, refund: pv.refund, dropped: pv.dropped, by: S.user };
    c.refundOpen = r2((c.refundOpen || 0) + pv.refund);
    c.history.push({ date, type: 'Cancelled', detail: `${pv.months} month(s) after ${periodLabel(pv.period)} cancelled (${money(pv.dropped)}); credited ${money(pv.credit)} on open invoices, refund due ${money(pv.refund)}`, journal: j ? j.id : '' });
    E.log('Cancelled revenue contract', id, `${money(pv.dropped)} removed`);
    return c;
  }

  /** Waterfall: unrecognized amounts by month for 12 months from `from` (default today's period); earlier catch-up goes to the
   *  first month, later months to `later`. opts.billedOnly limits to billed amounts (ties to GL 2450). */
  function waterfall(from, opts = {}) {
    const S = E.S; from = from || periodOf(S.today);
    const periods = Array.from({ length: 12 }, (_, k) => addP(from, k)); const last = periods[11];
    const rows = S.rcontracts.map((c) => {
      const amounts = periods.map(() => 0); let later = 0;
      c.schedule.forEach((s) => {
        if (s.status !== 'Scheduled') return;
        if (opts.billedOnly && !c.installments[s.inst].invoiceId) return;
        if (s.period > last) later = r2(later + s.amount); else { const k = Math.max(0, pIdx(s.period) - pIdx(from)); amounts[k] = r2(amounts[k] + s.amount); }
      });
      return { id: c.id, customerId: c.customerId, amounts, later, total: r2(sum(amounts) + later), deferred: deferredOf(c) };
    }).filter((r) => r.total);
    const totals = periods.map((_, k) => sum(rows, (r) => r.amounts[k]));
    return { periods, rows, totals, later: sum(rows, (r) => r.later), total: sum(rows, (r) => r.total), deferred: sum(S.rcontracts, deferredOf) };
  }
  /** Deferred revenue roll-forward from GL 2450 for fromP..toP. */
  function deferredRollForward(fromP, toP) {
    const S = E.S; if (!S.periods[fromP] || !S.periods[toP]) fail('Choose periods inside the FY2027 calendar.');
    if (fromP > toP) fail('The first period must not be after the last period.');
    let opening = 0, billings = 0, recognized = 0, cancellations = 0, other = 0;
    S.journals.forEach((j) => {
      if (j.status !== 'Posted') return;
      j.lines.forEach((l) => {
        if (l.acct !== ACCT.deferred) return; const v = r2(l.cr - l.dr);
        if (j.period < fromP) { opening += v; return; }
        if (j.period > toP) return;
        if (j.ref && j.ref.startsWith('REVREC-')) recognized -= v;
        else if (j.ref && j.ref.startsWith('ARINV-') && v > 0) billings += v;
        else if (j.ref && j.ref.startsWith('RC-')) cancellations -= v;
        else other += v;
      });
    });
    [opening, billings, recognized, cancellations, other] = [opening, billings, recognized, cancellations, other].map(r2);
    const closing = r2(opening + billings - recognized - cancellations + other);
    return { from: fromP, to: toP, opening, billings, recognized, cancellations, other, closing, gl: r2(-E.balance(ACCT.deferred, { toPeriod: toP })) };
  }

  // ---------- hooks ----------
  E.on('reconcile', (b) => {
    const S = E.S; if (!S.rcontracts.length && !b[ACCT.deferred] && !b[ACCT.refund]) return [];
    return [
      { name: 'Deferred revenue (contracts)', acct: ACCT.deferred, sub: sum(S.rcontracts, deferredOf), gl: r2(-(b[ACCT.deferred] || 0)) },
      { name: 'Customer refunds payable', acct: ACCT.refund, sub: sum(S.rcontracts, (c) => c.refundOpen || 0), gl: r2(-(b[ACCT.refund] || 0)) },
    ];
  });
  const periodDue = (p) => recognitionPreview(p).total > 0;
  E.on('checklist', (p) => {
    const S = E.S; const run = S.revrecRuns[p]; const due = periodDue(p);
    const bill = billingDue(p).length;
    return [
      { task: 'Revenue recognition run', done: !!run || !due, detail: run ? `${run} posted` : due ? `${money(recognitionPreview(p).total)} due through ${periodLabel(p)}` : 'Nothing due' },
      { task: 'Contract installments billed', advisory: true, done: !bill, detail: bill ? `${bill} installment(s) due and not billed` : 'All due installments billed' },
    ];
  });
  E.on('search', (q, hit) => E.S.rcontracts.filter((c) => hit(c.id, c.name, E.cust(c.customerId)?.name, ...c.lines.map((l) => l.desc))).map((c) => ({ kind: 'rcontract', id: c.id, label: `${c.id} ${E.cust(c.customerId)?.name || ''}`, sub: `Revenue contract, ${c.status}, ${money(c.total)}` })));
  E.addPerms('Controller', ['rev.edit', 'rev.run']);
  E.addPerms('Order Manager', ['rev.edit']);

  // ---------- year-end close ----------
  function fyPeriods(fy) {
    const y = +String(fy || '').replace(/\D/g, ''); if (!y) fail('Name the fiscal year, for example FY2027.');
    const ps = Array.from({ length: 12 }, (_, k) => addP(`${y - 1}-07`, k));
    if (!ps.every((p) => E.S.periods[p])) fail(`${fy} is not fully inside the calendar.`);
    return ps;
  }
  function yearEndChecks(fy = 'FY2027') {
    const S = E.S; const ps = fyPeriods(fy); const last = ps[11];
    const notClosed = ps.slice(0, 11).filter((p) => S.periods[p] !== 'Closed');
    const pend = S.journals.filter((j) => ps.includes(j.period) && j.status === 'Pending Approval');
    return [
      { task: `${periodLabel(ps[0])} to ${periodLabel(ps[10])} closed`, done: !notClosed.length, detail: notClosed.length ? `Still ${notClosed.length} not closed: ${notClosed.map(periodLabel).join(', ')}` : 'All closed' },
      { task: `${periodLabel(last)} open for the closing entry`, done: S.periods[last] === 'Open', detail: S.periods[last] },
      { task: 'No journals awaiting approval in the year', done: !pend.length, detail: pend.length ? `${pend.length} pending: ${pend.slice(0, 4).map((j) => j.id).join(', ')}${pend.length > 4 ? '...' : ''}` : 'None pending' },
      { task: 'Year not already closed', done: !S.yearEnd[fy], detail: S.yearEnd[fy] ? `Closed by ${S.yearEnd[fy]}` : 'Not closed' },
    ];
  }
  /** yearEndPreview(fy) -> {fy, date, lines:[{acct, dr, cr, entity, memo}], byEntity:[{entity, netIncome}], netIncome, ready, checks}. */
  function yearEndPreview(fy = 'FY2027') {
    const S = E.S; const ps = fyPeriods(fy);
    const bal = {}; // entity -> acct -> dr-cr
    S.journals.forEach((j) => {
      if (j.status !== 'Posted' || !ps.includes(j.period)) return;
      j.lines.forEach((l) => { const a = E.acct(l.acct); if (!a || (a.type !== 'Revenue' && a.type !== 'Expense')) return;
        const ent = l.entity || DEFAULT_ENTITY; bal[ent] = bal[ent] || {}; bal[ent][l.acct] = (bal[ent][l.acct] || 0) + l.dr - l.cr; });
    });
    const lines = []; const byEntity = [];
    Object.keys(bal).sort().forEach((ent) => {
      let net = 0; // credit-positive net income
      Object.keys(bal[ent]).sort().forEach((code) => { const v = r2(bal[ent][code]); if (!v) return; net = r2(net - v);
        lines.push(v > 0 ? { acct: code, cr: v, dr: 0, entity: ent, memo: 'Close to retained earnings' } : { acct: code, dr: -v, cr: 0, entity: ent, memo: 'Close to retained earnings' }); });
      if (net) lines.push(net > 0 ? { acct: ACCT.re, cr: net, dr: 0, entity: ent, memo: `${fy} net income` } : { acct: ACCT.re, dr: -net, cr: 0, entity: ent, memo: `${fy} net loss` });
      byEntity.push({ entity: ent, netIncome: net });
    });
    const checks = yearEndChecks(fy);
    return { fy, date: periodEnd(ps[11]), periods: ps, lines, byEntity, netIncome: sum(byEntity, (x) => x.netIncome), checks, ready: checks.every((c) => c.done) && lines.length > 0 };
  }
  /** yearEndClose(fy): posts the closing journal into the last period of the year; S.yearEnd[fy] = journal id. */
  function yearEndClose(fy = 'FY2027') {
    const S = E.S; const pv = yearEndPreview(fy);
    const bad = pv.checks.find((c) => !c.done); if (bad) fail(`Year-end close for ${fy} is blocked: ${bad.task} (${bad.detail}).`);
    if (!pv.lines.length) fail(`${fy} has no revenue or expense balances to close.`);
    const j = E.createJournal({ date: pv.date, source: 'Year-end', desc: `${fy} year-end close: revenue and expense to retained earnings`, ref: 'YE-' + fy, lines: pv.lines });
    j.yearEnd = fy; S.yearEnd[fy] = j.id; E.log('Closed fiscal year', fy, `${j.id}, net income ${money(pv.netIncome)}`);
    return j;
  }

  // ---------- seed ----------
  E.on('seedSetup', () => ensureAccounts());
  const SEED = {
    '2026-07': [
      { d: '2026-07-06', cust: 0, term: 12, billing: 'annual', name: 'Calibration plan, Corran QC lab', lines: [{ service: 'SV-100', qty: 10 }] },
      { d: '2026-07-20', cust: 1, term: 24, billing: 'annual', name: 'Flow meters with extended warranty', lines: [{ sku: 'HX-310', qty: 4, price: 1300, ssp: 1450 }, { service: 'SV-200', qty: 4, price: 2000, ssp: 2400 }] },
    ],
    '2026-08': [{ d: '2026-08-03', cust: 3, term: 12, billing: 'monthly', name: 'Campus remote monitoring', lines: [{ service: 'SV-300', qty: 25 }] }],
    '2026-09': [{ d: '2026-09-15', cust: 4, term: 12, billing: 'annual', name: 'Calibration plan, Solace fill line', lines: [{ service: 'SV-100', qty: 6 }] }],
    '2026-10': [{ d: '2026-10-01', cust: 0, term: 12, billing: 'annual', name: 'Remote monitoring, Corran cold rooms', lines: [{ service: 'SV-300', qty: 40 }] }],
    '2026-11': [{ d: '2026-11-04', cust: 4, term: 12, billing: 'annual', name: 'Calibration and monitoring, Solace site 2', lines: [{ service: 'SV-100', qty: 8 }, { service: 'SV-300', qty: 8 }] }],
  };
  E.on('seedMonthly', (p, ctx) => {
    const S = ctx.S;
    // collect last month's contract invoices (contracts from October on stay open for the demo)
    const prev = addP(p, -1);
    S.rcontracts.forEach((c) => c.installments.forEach((ins) => {
      if (!ins.invoiceId || periodOf(ins.due) !== prev || c.start >= '2026-10-01') return;
      const inv = E.arinv(ins.invoiceId); if (inv.status !== 'Open') return;
      const d = `${p}-${String(Math.min(26, +ins.due.slice(8) + 2)).padStart(2, '0')}`;
      ctx.at(d); E.applyReceipt({ invoiceId: inv.id, date: d, amount: E.openAmt(inv), reference: `ACH-${c.id}` });
    }));
    (SEED[p] || []).forEach((x) => { ctx.at(x.d); createContract({ customerId: ctx.custs[x.cust].id, start: x.d, term: x.term, billing: x.billing, name: x.name, lines: x.lines }); });
    if (billingDue(p).length) { ctx.at(p + '-03'); runContractBilling(p); }
    if (p !== '2026-11') { ctx.at(periodEnd(p)); ctx.asRole('Controller', 'Avery Lin', () => runRecognition(p)); }
  });

  E.extend({
    REVREC_ACCOUNTS: ACCT, SERVICE_CATALOGUE: CATALOGUE, service: svc, rcontract, serviceListPrice: listPrice, sspAllocate: allocate,
    contractPreview, createContract, runContractBilling, contractBillingDue: billingDue, recognitionPreview, runRecognition,
    contractDeferred: deferredOf, contractRecognized: recognizedOf, contractBilled: billedOf, cancelPreview, cancelContract,
    revenueWaterfall: waterfall, deferredRollForward, recognitionDuePeriods: () => Object.keys(E.S.periods).filter((p) => E.S.periods[p] === 'Open' && !E.S.revrecRuns[p] && periodDue(p)),
    yearEndChecks, yearEndPreview, yearEndClose,
  });
})(typeof window !== 'undefined' ? window : globalThis);
