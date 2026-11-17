/* Ledgerline Suite: ext-cash.js
 * Cash management: bank accounts, bank statements, statement-to-book reconciliation
 * (auto-match, manual match/unmatch, accounting for bank-only items), the per-statement
 * reconciliation report, today's cash position and a 13-week cash forecast.
 * No DOM. Every GL effect goes through E.createJournal. Validate first, mutate after.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { r2, sum, periodOf, periodEnd, periodLabel, addDays, daysBetween, money } = E.util;
  const fail = E.fail;

  const MATCH_WINDOW_DAYS = 5;
  const FORECAST_WEEKS = 13;
  const DEFAULT_OFFSET = { fee: '6600', interest: '4900', returned: '1100', other: '1050' };
  const S = () => E.S;

  E.on('state', (st) => {
    if (!st.bankAccounts) st.bankAccounts = [{ id: 'BA-1', name: 'Operating account', bank: 'First Harbor Bank', mask: '4417', gl: '1000', currency: 'USD' }];
    if (!st.bankStatements) st.bankStatements = [];
  });
  E.on('seedSetup', () => {
    E.ensureAccount('1050', 'Cash in suspense (unidentified)', 'Asset');
    E.ensureAccount('6600', 'Bank charges', 'Expense');
  });

  // ---------- helpers ----------
  const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const bankAccount = (id) => S().bankAccounts.find((a) => a.id === id);
  const bankStatement = (id) => S().bankStatements.find((s) => s.id === id);
  const accountLabel = (a) => `${a.name}, ${a.bank} ****${a.mask}`;
  /** Net effect of a journal on a cash GL account (dr - cr). */
  const cashOf = (j, gl = '1000') => r2(j.lines.reduce((a, l) => a + (l.acct === gl ? l.dr - l.cr : 0), 0));
  const stmtsOf = (accountId) => S().bankStatements.filter((s) => s.account === accountId).sort((a, b) => a.endDate.localeCompare(b.endDate));
  /** journalId -> {stmt, line} for every matched statement line. */
  function matchedMap() {
    const m = new Map();
    for (const st of S().bankStatements) for (const l of st.lines) if (l.matched) m.set(l.matched, { stmt: st, line: l });
    return m;
  }
  /** Posted journals that move this cash account, excluding opening balances (brought forward on the first statement). */
  function cashJournals(gl = '1000') {
    return S().journals.filter((j) => j.status === 'Posted' && j.source !== 'Opening').map((j) => ({ j, amount: cashOf(j, gl) })).filter((x) => x.amount);
  }
  /** GL cash items not yet matched to any statement line, oldest first. */
  function unreconciledCash(accountId = 'BA-1') {
    const a = E.need(bankAccount(accountId), 'Bank account'); const m = matchedMap();
    return cashJournals(a.gl).filter((x) => !m.has(x.j.id)).map((x) => ({ id: x.j.id, date: x.j.date, desc: x.j.desc, ref: x.j.ref, amount: x.amount, source: x.j.source }))
      .sort((p, q) => p.date.localeCompare(q.date) || p.id.localeCompare(q.id));
  }
  const bookBalanceAt = (gl, date) => r2(S().journals.filter((j) => j.status === 'Posted' && j.date <= date).reduce((a, j) => a + cashOf(j, gl), 0));
  function setStatus(st) { st.lines.forEach((l) => { l.status = st.status === 'Reconciled' ? 'Reconciled' : l.matched ? 'Matched' : 'Unmatched'; }); }
  function openStmt(stmtId) {
    const st = E.need(bankStatement(stmtId), 'Bank statement');
    if (st.status === 'Reconciled') fail(`${st.id} is reconciled. Reopen it before changing matches.`);
    return st;
  }
  const lineOf = (st, lineId) => E.need(st.lines.find((l) => l.id === lineId), `Statement line ${lineId}`);
  const refMatches = (line, j) => !!line.ref && (j.ref === line.ref || j.id === line.ref || String(j.desc).includes(line.ref));

  // ---------- matching ----------
  /** Auto-match: same amount, dates within ±5 days, one-to-one. Exact reference matches win, then nearest date. Returns number matched. */
  function autoMatchStatement(stmtId) {
    const st = openStmt(stmtId); const a = bankAccount(st.account);
    const m = matchedMap();
    const pool = cashJournals(a.gl).filter((x) => !m.has(x.j.id));
    const used = new Set(); const pairs = [];
    const open = st.lines.filter((l) => !l.matched);
    const cands = (l) => pool.filter((x) => !used.has(x.j.id) && Math.abs(x.amount - l.amount) < 0.005 && Math.abs(daysBetween(x.j.date, l.date)) <= MATCH_WINDOW_DAYS);
    const taken = new Set();
    // pass 1: exact reference
    for (const l of open) {
      const c = cands(l).filter((x) => refMatches(l, x.j)).sort((p, q) => Math.abs(daysBetween(p.j.date, l.date)) - Math.abs(daysBetween(q.j.date, l.date)));
      if (c.length) { used.add(c[0].j.id); taken.add(l.id); pairs.push([l, c[0].j.id]); }
    }
    // pass 2: amount + nearest date
    for (const l of open) {
      if (taken.has(l.id)) continue;
      const c = cands(l).sort((p, q) => Math.abs(daysBetween(p.j.date, l.date)) - Math.abs(daysBetween(q.j.date, l.date)) || p.j.date.localeCompare(q.j.date));
      if (c.length) { used.add(c[0].j.id); taken.add(l.id); pairs.push([l, c[0].j.id]); }
    }
    pairs.forEach(([l, jid]) => { l.matched = jid; });
    setStatus(st);
    if (pairs.length) E.log('Auto-matched bank statement', st.id, `${pairs.length} line(s) matched`);
    return pairs.length;
  }
  /** Manual one-to-one match of a statement line to a posted cash journal of the same amount. */
  function matchBankLine(stmtId, lineId, journalId) {
    const st = openStmt(stmtId); const l = lineOf(st, lineId); const a = bankAccount(st.account);
    if (l.matched) fail(`Line ${l.id} is already matched to ${l.matched}. Unmatch it first.`);
    const j = E.need(E.je(journalId), 'Journal');
    if (j.status !== 'Posted') fail(`${j.id} is ${j.status}. Only posted journals can be matched.`);
    if (j.source === 'Opening') fail('The opening balance journal is brought forward on the first statement and cannot be matched.');
    const amt = cashOf(j, a.gl);
    if (!amt) fail(`${j.id} does not post to cash account ${a.gl}.`);
    if (Math.abs(amt - l.amount) >= 0.005) fail(`Amounts differ: statement line ${money(l.amount)}, ${j.id} ${money(amt)}. Matches are one-to-one at the same amount.`);
    const other = matchedMap().get(j.id); if (other) fail(`${j.id} is already matched to line ${other.line.id} on ${other.stmt.id}.`);
    l.matched = j.id; setStatus(st); E.log('Matched bank statement line', st.id, `${l.id} to ${j.id}`); return l;
  }
  function unmatchBankLine(stmtId, lineId) {
    const st = openStmt(stmtId); const l = lineOf(st, lineId);
    if (!l.matched) fail(`Line ${l.id} is not matched.`);
    const was = l.matched; l.matched = null; setStatus(st); E.log('Unmatched bank statement line', st.id, `${l.id} from ${was}`); return l;
  }
  /** Book a bank-only line (fee, interest, returned payment, unidentified item) and match it to the new journal. */
  function createBankAccounting(stmtId, lineId, opts = {}) {
    const st = openStmt(stmtId); const l = lineOf(st, lineId); const a = bankAccount(st.account);
    if (l.matched) fail(`Line ${l.id} is already matched to ${l.matched}.`);
    const kind = l.kind === 'gl' ? 'other' : l.kind || 'other';
    const date = opts.date || l.date;
    E.assertOpen(date);
    let lines, rc = null, inv = null;
    if (kind === 'returned') {
      rc = E.need(S().receipts.find((r) => r.id === l.receiptId), 'Original customer receipt');
      if (rc.returned) fail(`Receipt ${rc.id} has already been reversed.`);
      inv = E.need(E.arinv(rc.invoiceId), 'Invoice');
      if (Math.abs(-l.amount - rc.amount) >= 0.005) fail('The returned amount does not equal the original receipt.');
      lines = [{ acct: '1100', dr: -l.amount, memo: `Reopen ${inv.id}: payment returned` }, { acct: a.gl, cr: -l.amount, memo: l.desc }];
    } else {
      const off = String(opts.acct || DEFAULT_OFFSET[kind] || '1050');
      if (off === a.gl) fail('Choose an offset account other than the bank account itself.');
      if (off === '1100' || off === '2000') fail(`Account ${off} is a subledger control account. Record customer receipts or supplier payments in Receivables or Payables instead.`);
      if (off === '6600') E.ensureAccount('6600', 'Bank charges', 'Expense');
      if (off === '1050') E.ensureAccount('1050', 'Cash in suspense (unidentified)', 'Asset');
      if (!E.acct(off)) fail(`Account ${off} does not exist.`);
      lines = l.amount > 0 ? [{ acct: a.gl, dr: l.amount, memo: l.desc }, { acct: off, cr: l.amount }] : [{ acct: off, dr: -l.amount, memo: l.desc }, { acct: a.gl, cr: -l.amount }];
    }
    const desc = kind === 'returned' ? `Returned customer payment ${rc.reference || rc.id} (${E.cust(rc.customerId).name})` : `Bank ${kind === 'fee' ? 'charges' : kind === 'interest' ? 'interest earned' : 'item'}: ${l.desc}`;
    const j = E.createJournal({ date, source: 'Cash', desc, ref: st.id, lines });
    if (rc) { rc.returned = true; rc.returnedJournal = j.id; inv.paid = r2(inv.paid - rc.amount); inv.status = inv.paid <= 0 ? 'Open' : 'Partially Paid'; }
    l.matched = j.id; l.created = j.id; setStatus(st);
    E.log('Created accounting for bank line', st.id, `${l.id} ${money(l.amount)} as ${j.id}`);
    return j;
  }

  // ---------- reconciliation report ----------
  /** Statement closing vs GL book balance at the statement date. difference = closing + outstanding GL - bank items booked later - book. */
  function bankReconReport(stmtId) {
    const st = E.need(bankStatement(stmtId), 'Bank statement'); const a = bankAccount(st.account); const end = st.endDate;
    const all = stmtsOf(st.account).filter((x) => x.endDate <= end);
    const lineCleared = new Map(); // journal -> line date
    S().bankStatements.filter((x) => x.account === st.account).forEach((x) => x.lines.forEach((l) => { if (l.matched) lineCleared.set(l.matched, l.date); }));
    const outstanding = cashJournals(a.gl).filter((x) => x.j.date <= end && !(lineCleared.has(x.j.id) && lineCleared.get(x.j.id) <= end))
      .map((x) => ({ id: x.j.id, date: x.j.date, desc: x.j.desc, amount: x.amount })).sort((p, q) => p.date.localeCompare(q.date));
    const early = [];
    all.forEach((x) => x.lines.forEach((l) => { const j = l.matched && E.je(l.matched); if (j && j.date > end) early.push({ line: l.id, journal: j.id, date: l.date, desc: l.desc, amount: l.amount }); }));
    const unmatched = []; all.forEach((x) => x.lines.forEach((l) => { if (!l.matched) unmatched.push({ stmt: x.id, ...l }); }));
    const dit = outstanding.filter((o) => o.amount > 0), op = outstanding.filter((o) => o.amount < 0);
    const book = bookBalanceAt(a.gl, end);
    const adjustedBank = r2(st.closing + sum(outstanding, (o) => o.amount) - sum(early, (e) => e.amount));
    const difference = r2(adjustedBank - book);
    const linesUnmatched = st.lines.filter((l) => !l.matched).length;
    const prior = stmtsOf(st.account).filter((x) => x.endDate < end && x.status !== 'Reconciled');
    return {
      id: st.id, account: a, end, opening: st.opening, closing: st.closing, book,
      depositsInTransit: dit, outstandingPayments: op, ditTotal: sum(dit, (o) => o.amount), opTotal: sum(op, (o) => o.amount),
      bookedLater: early, bookedLaterTotal: sum(early, (e) => e.amount), unmatched, unmatchedTotal: sum(unmatched, (u) => u.amount),
      adjustedBank, difference, linesUnmatched, priorOpen: prior.map((x) => x.id),
      complete: Math.abs(difference) < 0.005 && !linesUnmatched && !prior.length,
    };
  }
  function markStatementReconciled(stmtId) {
    const st = openStmt(stmtId); const r = bankReconReport(stmtId);
    if (r.priorOpen.length) fail(`Reconcile ${r.priorOpen.join(', ')} first. Statements reconcile in order.`);
    if (r.linesUnmatched) fail(`${r.linesUnmatched} statement line(s) are not matched. Match them or create accounting first.`);
    if (Math.abs(r.difference) >= 0.005) fail(`The reconciliation is out by ${money(r.difference)}.`);
    st.status = 'Reconciled'; st.reconciledBy = S().user; st.reconciledOn = S()._date || E.TODAY; setStatus(st);
    E.log('Reconciled bank statement', st.id, `${periodLabel(st.period)} closing ${money(st.closing)}`); return st;
  }
  function reopenBankStatement(stmtId) {
    const st = E.need(bankStatement(stmtId), 'Bank statement'); if (st.status !== 'Reconciled') fail(`${st.id} is not reconciled.`);
    const later = stmtsOf(st.account).filter((x) => x.endDate > st.endDate && x.status === 'Reconciled');
    if (later.length) fail(`Reopen ${later.map((x) => x.id).join(', ')} first.`);
    st.status = 'Open'; delete st.reconciledBy; delete st.reconciledOn; setStatus(st); E.log('Reopened bank statement', st.id); return st;
  }

  // ---------- position and forecast ----------
  function cashPosition() {
    return S().bankAccounts.map((a) => {
      const sts = stmtsOf(a.id); const last = sts[sts.length - 1]; const lastRec = sts.filter((x) => x.status === 'Reconciled').pop();
      return { account: a, label: accountLabel(a), book: E.balance(a.gl), lastStatement: last ? { id: last.id, date: last.endDate, closing: last.closing } : null,
        lastReconciled: lastRec ? lastRec.endDate : null, unreconciledGL: unreconciledCash(a.id).length,
        unmatchedLines: sum(sts.filter((x) => x.status !== 'Reconciled'), (x) => x.lines.filter((l) => !l.matched).length) };
    });
  }
  /** 13-week forecast from today: open AR by due date, validated AP by due date, net payroll at month end, rent on the 1st. Overdue items land in week 1. */
  function cashForecast(weeks = FORECAST_WEEKS) {
    const today = S().today || E.TODAY; const horizon = addDays(today, weeks * 7 - 1);
    const items = [];
    const when = (d) => (d < today ? today : d);
    S().arInvoices.filter((i) => i.status !== 'Paid' && r2(i.total - i.paid) > 0).forEach((i) => { const d = when(i.due); if (d <= horizon) items.push({ date: d, due: i.due, kind: 'receipt', ref: i.id, desc: `${E.cust(i.customerId)?.name || i.customerId}${i.due < today ? ' (overdue)' : ''}`, amount: r2(i.total - i.paid) }); });
    S().apInvoices.filter((i) => i.status === 'Validated' && r2(i.total - i.paid) > 0).forEach((i) => { const d = when(i.due); if (d <= horizon) items.push({ date: d, due: i.due, kind: 'payment', ref: i.id, desc: `${E.sup(i.supplierId)?.name || i.supplierId} inv ${i.number}${i.due < today ? ' (overdue)' : ''}`, amount: -r2(i.total - i.paid) }); });
    const netPay = r2(sum(S().employees.filter((e) => e.status === 'Active'), (e) => r2(e.salary / 12)) * (1 - E.WITHHOLDING_RATE));
    const rentJ = S().journals.filter((j) => j.status === 'Posted' && /^Rent/.test(j.desc) && j.lines.some((l) => l.acct === '6100')).sort((p, q) => p.date.localeCompare(q.date)).pop();
    const rent = rentJ ? rentJ.lines.filter((l) => l.acct === '6100').reduce((x, l) => x + l.dr, 0) : 14500;
    for (let p = periodOf(today); ; ) {
      const pe = periodEnd(p); const first = p + '-01';
      if (first > horizon) break;
      if (pe >= today && pe <= horizon && !S().payruns.some((r) => r.period === p) && netPay > 0) items.push({ date: pe, kind: 'payroll', ref: '', desc: `Net payroll ${periodLabel(p)} (estimate)`, amount: -netPay });
      if (first > today && first <= horizon && rent) items.push({ date: first, kind: 'rent', ref: '', desc: `Rent ${periodLabel(p)}`, amount: -r2(rent) });
      p = periodOf(addDays(pe, 1));
    }
    const opening = r2(sum(S().bankAccounts, (a) => E.balance(a.gl)));
    let bal = opening;
    const rows = [];
    for (let k = 0; k < weeks; k++) {
      const start = addDays(today, k * 7), end = addDays(start, 6);
      const w = items.filter((x) => x.date >= start && x.date <= end);
      w.forEach((x) => (x.week = k));
      const receipts = sum(w.filter((x) => x.kind === 'receipt'), (x) => x.amount);
      const payments = sum(w.filter((x) => x.kind === 'payment'), (x) => x.amount);
      const payroll = sum(w.filter((x) => x.kind === 'payroll'), (x) => x.amount);
      const rentW = sum(w.filter((x) => x.kind === 'rent'), (x) => x.amount);
      const net = r2(receipts + payments + payroll + rentW); const open = bal; bal = r2(bal + net);
      rows.push({ week: k + 1, start, end, opening: open, receipts, payments, payroll, rent: rentW, outflows: r2(payments + payroll + rentW), net, closing: bal });
    }
    return { today, horizon, opening, netPayEstimate: netPay, rent: r2(rent), weeks: rows, items: items.sort((p, q) => p.date.localeCompare(q.date)),
      totals: { receipts: sum(rows, (r) => r.receipts), payments: sum(rows, (r) => r.payments), payroll: sum(rows, (r) => r.payroll), rent: sum(rows, (r) => r.rent), net: sum(rows, (r) => r.net) },
      closing: bal, low: rows.reduce((m, r) => (r.closing < m.closing ? r : m), rows[0]) };
  }

  // ---------- seed: statements from the GL, plus bank-only items ----------
  const BANK_CUTOFF = '2026-11-14';
  function bankText(j, amount) {
    const d = j.desc; const h = hash(j.id);
    const rc = S().receipts.find((r) => r.journal === j.id);
    if (rc) return { desc: `WIRE IN ${(E.cust(rc.customerId)?.name || '').toUpperCase()} REF ${rc.reference || rc.id}`, ref: rc.reference || '', type: 'WIRE', lag: h % 2, receiptId: rc.id };
    const pay = S().payments.find((p) => p.journal === j.id);
    if (pay) return { desc: `ACH DEBIT ${(E.sup(pay.supplierId)?.name || '').toUpperCase()} ${pay.id}`, ref: pay.id, type: 'ACH', lag: 1 + (h % 3) };
    if (j.source === 'Payroll' && /^Payroll/.test(d)) return { desc: `ACH PAYROLL BATCH ${j.ref || ''}`.trim(), ref: j.ref || '', type: 'ACH', lag: 1 };
    if (/payroll taxes/i.test(d)) return { desc: 'EFTPS FEDERAL TAX DEPOSIT', ref: '', type: 'ACH', lag: h % 2 };
    if (/^Rent/.test(d)) return { desc: 'ACH DEBIT FENWICK PARK PROPERTIES RENT', ref: '', type: 'ACH', lag: h % 2 };
    if (/Electricity/i.test(d)) { const chk = String(2000 + (h % 900)); return { desc: `CHK ${chk} CITY UTILITIES`, ref: chk, type: 'CHK', lag: 2 + (h % 2) }; }
    if (/software/i.test(d)) return { desc: 'ACH DEBIT SOFTWARE LICENSING', ref: '', type: 'ACH', lag: h % 3 };
    if (/travel/i.test(d)) return { desc: 'CORPORATE CARD SETTLEMENT', ref: '', type: 'ACH', lag: 1 + (h % 3) };
    const words = d.replace(/[^A-Za-z0-9 ]/g, ' ').trim().toUpperCase().split(/\s+/).slice(0, 4).join(' ');
    return { desc: `${amount > 0 ? 'ACH CREDIT' : 'ACH DEBIT'} ${words}`, ref: j.ref && !/^JE-/.test(j.ref) ? j.ref : '', type: 'ACH', lag: h % 4 };
  }
  E.on('seedFinal', (ctx) => {
    const st = S(); const a = st.bankAccounts[0]; if (!a) return;
    const months = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
    const opening = r2(st.journals.filter((j) => j.status === 'Posted' && j.source === 'Opening').reduce((x, j) => x + cashOf(j, a.gl), 0));
    const byMonth = {}; months.forEach((p) => (byMonth[p] = []));
    const truth = new Map(); // line -> source journal (seed fallback only)
    cashJournals(a.gl).forEach(({ j, amount }) => {
      const t = bankText(j, amount); const d = addDays(j.date, t.lag);
      if (d > BANK_CUTOFF || !byMonth[periodOf(d)]) return;
      const l = { date: d, desc: t.desc, amount, ref: t.ref, type: t.type, kind: 'gl' };
      if (t.receiptId) l.receiptId = t.receiptId;
      byMonth[periodOf(d)].push(l); truth.set(l, j.id);
    });
    months.forEach((p) => {
      const h = hash('bank' + p);
      if (p !== '2026-11') {
        byMonth[p].push({ date: periodEnd(p), desc: 'MONTHLY ACCOUNT SERVICE FEE', amount: -r2(45 + (h % 7500) / 100), ref: '', type: 'FEE', kind: 'fee' });
        byMonth[p].push({ date: periodEnd(p), desc: 'INTEREST EARNED', amount: r2(300 + ((h >>> 8) % 60000) / 100), ref: '', type: 'INT', kind: 'interest' });
      } else {
        byMonth[p].push({ date: '2026-11-06', desc: 'WIRE TRANSFER SERVICE CHARGES', amount: -45, ref: '', type: 'FEE', kind: 'fee' });
        const rcl = byMonth[p].filter((l) => l.receiptId && l.date <= '2026-11-10').pop();
        if (rcl) {
          const rc = st.receipts.find((r) => r.id === rcl.receiptId);
          byMonth[p].push({ date: addDays(rcl.date, 3) > BANK_CUTOFF ? BANK_CUTOFF : addDays(rcl.date, 3), desc: `RETURNED ITEM R01 INSUFFICIENT FUNDS ${(E.cust(rc.customerId)?.name || '').toUpperCase()} REF ${rc.reference}`, amount: -rc.amount, ref: rc.reference, type: 'RET', kind: 'returned', receiptId: rc.id });
        }
      }
    });
    let bal = opening;
    const created = months.map((p) => {
      const lines = byMonth[p].sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount);
      const id = E.nextId('BST');
      lines.forEach((l, n) => { l.id = `${id}-${String(n + 1).padStart(2, '0')}`; l.matched = null; l.status = 'Unmatched'; });
      const stmt = { id, account: a.id, period: p, startDate: p + '-01', endDate: p === '2026-11' ? BANK_CUTOFF : periodEnd(p), opening: bal, closing: r2(bal + sum(lines, (l) => l.amount)), lines, status: 'Open', received: addDays(p === '2026-11' ? BANK_CUTOFF : periodEnd(p), 1) };
      bal = stmt.closing; st.bankStatements.push(stmt); return stmt;
    });
    ctx.asRole('Controller', 'Avery Lin', () => {
      created.filter((s) => s.period <= '2026-10').forEach((s) => {
        ctx.at(s.received <= E.TODAY ? s.received : s.endDate);
        autoMatchStatement(s.id);
        s.lines.filter((l) => !l.matched && l.kind === 'gl').forEach((l) => matchBankLine(s.id, l.id, truth.get(l)));
        ctx.at(s.endDate);
        s.lines.filter((l) => !l.matched).forEach((l) => createBankAccounting(s.id, l.id));
        ctx.at(s.received);
        markStatementReconciled(s.id);
      });
    });
  });

  // ---------- hooks ----------
  E.on('checklist', (p) => {
    const sts = S().bankStatements.filter((s) => s.period === p);
    if (!sts.length) return [{ task: 'Bank statement reconciled', done: false, advisory: true, detail: 'No bank statement loaded for this period' }];
    const open = sts.filter((s) => s.status !== 'Reconciled');
    return [{ task: 'Bank statement reconciled', done: !open.length, detail: open.length ? `${open.map((s) => s.id).join(', ')} open, ${sum(open, (s) => s.lines.filter((l) => !l.matched).length)} unmatched line(s)` : sts.map((s) => s.id).join(', ') + ' reconciled' }];
  });
  /** Optional reconcile() row (not registered: tests/engine.test.js expects exactly the core rows).
   *  Enable with E.on('reconcile', E.bankReconcileRows). */
  const bankReconcileRows = () => S().bankAccounts.map((a) => {
    const last = stmtsOf(a.id).filter((s) => s.status === 'Reconciled').pop(); if (!last) return null;
    const r = bankReconReport(last.id);
    return { name: `Bank statement vs book (${last.id}, ${last.endDate})`, acct: a.gl, sub: r.adjustedBank, gl: r.book };
  }).filter(Boolean);
  E.on('search', (q, hit) => S().bankStatements.filter((s) => hit(s.id, periodLabel(s.period), 'bank statement', ...s.lines.map((l) => l.ref))).map((s) => {
    const a = bankAccount(s.account);
    return { kind: 'bankstmt', id: s.id, label: `${s.id} bank statement ${periodLabel(s.period)}`, sub: `${a ? accountLabel(a) : s.account}, ${s.status}` };
  }));
  E.addPerms('Controller', ['cash.reconcile']);
  E.addPerms('AP Specialist', ['cash.reconcile']);

  E.extend({
    bankAccount, bankStatement, bankAccountLabel: accountLabel, cashOf, unreconciledCash, bookBalanceAt,
    autoMatchStatement, matchBankLine, unmatchBankLine, createBankAccounting, bankReconReport, markStatementReconciled, reopenBankStatement,
    cashPosition, cashForecast, bankReconcileRows, CASH_MATCH_WINDOW: MATCH_WINDOW_DAYS, CASH_DEFAULT_OFFSET: DEFAULT_OFFSET,
  });
})(typeof window !== 'undefined' ? window : globalThis);
