/* Ledgerline Suite: views-cash.js
 * Cash management: cash position and 13-week forecast, bank statements, and the
 * statement-to-book reconciliation workbench (auto-match, manual match, accounting
 * for bank-only items, mark reconciled). Rules live in ext-cash.js.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, num = App.num, fdate = App.fdate, pill = App.pill;
  const ui = App.ui;
  const sdate = (d) => { const [, m, dd] = d.split('-'); return `${+dd} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]}`; };
  const amt = (n) => `<span style="color:${n < 0 ? 'var(--ink)' : 'var(--good)'}">${fmt(n)}</span>`;
  const KIND_LABEL = { gl: 'Book item', fee: 'Bank charge', interest: 'Interest', returned: 'Returned payment', other: 'Unidentified' };
  const statements = () => E.S.bankStatements.slice().sort((a, b) => a.endDate.localeCompare(b.endDate) || a.id.localeCompare(b.id));
  function currentStmt() {
    const list = statements(); if (!list.length) return null;
    const sel = ui.filter.cashStmt && E.bankStatement(ui.filter.cashStmt);
    return sel || list.find((s) => s.status !== 'Reconciled') || list[list.length - 1];
  }
  const unmatchedOpen = () => E.S.bankStatements.filter((s) => s.status !== 'Reconciled').reduce((a, s) => a + s.lines.filter((l) => !l.matched).length, 0);

  // ---------- chart ----------
  const compact = (v) => { const a = Math.abs(v); return (v < 0 ? '-' : '') + (a >= 1e6 ? (a / 1e6).toFixed(a % 1e6 ? 1 : 0) + 'M' : a >= 1e3 ? Math.round(a / 1e3) + 'k' : String(Math.round(a))); };
  const niceStep = (raw) => { const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1)))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };
  function chartSvg(weeks, W) {
    W = Math.max(280, Math.round(W || 640));
    const H = 240, ml = 46, mr = 8, mt = 10, mb = 26, pw = W - ml - mr, ph = H - mt - mb;
    const max = Math.max(1, ...weeks.map((w) => Math.max(w.receipts, -w.outflows)));
    let step = niceStep(max / 4); if (Math.ceil(max / step) > 5) step = niceStep(max / 3);
    const top = Math.ceil(max / step) * step;
    const y = (v) => mt + ph - (Math.max(0, v) / top) * ph;
    const gw = pw / weeks.length, bw = Math.max(4, Math.min(18, gw * 0.3)), gap = 2;
    const every = gw < 24 ? 3 : gw < 44 ? 2 : 1;
    const bar = (x, v, color, label) => { const yt = y(v), h = mt + ph - yt; if (h <= 0) return ''; const r = Math.min(3, bw / 2, h);
      return `<path d="M${x.toFixed(1)},${mt + ph} V${(yt + r).toFixed(1)} Q${x.toFixed(1)},${yt.toFixed(1)} ${(x + r).toFixed(1)},${yt.toFixed(1)} H${(x + bw - r).toFixed(1)} Q${(x + bw).toFixed(1)},${yt.toFixed(1)} ${(x + bw).toFixed(1)},${(yt + r).toFixed(1)} V${mt + ph} Z" fill="${color}"><title>${esc(label)}</title></path>`; };
    let grid = '';
    for (let v = 0; v <= top + 1e-6; v += step) {
      const yy = y(v).toFixed(1);
      grid += `<line x1="${ml}" x2="${W - mr}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1" ${v ? 'stroke-dasharray="2 3"' : ''}/>`
        + `<text x="${ml - 8}" y="${yy}" dy="0.32em" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--mono)">${compact(v)}</text>`;
    }
    const groups = weeks.map((w, i) => {
      const cx = ml + gw * i + gw / 2;
      return bar(cx - bw - gap / 2, w.receipts, 'var(--series-1)', `Week of ${sdate(w.start)}: receipts ${fmt(w.receipts)}`)
        + bar(cx + gap / 2, -w.outflows, 'var(--series-2)', `Week of ${sdate(w.start)}: payments ${fmt(-w.outflows)}`)
        + (i % every === 0 ? `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${sdate(w.start)}</text>` : '');
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Weekly forecast receipts and payments, 13 weeks from ${esc(sdate(weeks[0].start))}" style="display:block;height:auto">${grid}${groups}</svg>`;
  }
  function weekTable(f) {
    return App.table([
      { h: 'Week of', f: (w) => `${fdate(w.start)}` },
      { h: 'Opening', num: true, f: (w) => fmt(w.opening) },
      { h: 'Receipts', num: true, f: (w) => fmt(w.receipts) },
      { h: 'Supplier payments', num: true, f: (w) => fmt(w.payments) },
      { h: 'Payroll', num: true, f: (w) => fmt(w.payroll) },
      { h: 'Rent', num: true, f: (w) => fmt(w.rent) },
      { h: 'Net flow', num: true, f: (w) => amt(w.net) },
      { h: 'Closing', num: true, f: (w) => `<b>${fmt(w.closing)}</b>` },
    ], f.weeks, { foot: ['13 weeks', fmt(f.opening), fmt(f.totals.receipts), fmt(f.totals.payments), fmt(f.totals.payroll), fmt(f.totals.rent), fmt(f.totals.net), fmt(f.closing)] });
  }

  // ---------- tabs ----------
  function positionTab() {
    const pos = E.cashPosition(), f = E.cashForecast();
    const book = U.sum(pos, (p) => p.book);
    const asTable = ui.filter.cashChart === 'table';
    const kpis = `<div class="kpis">${App.kpi('Cash today (book)', App.fmt0(book), `${pos.length} bank account(s), GL ${pos.map((p) => p.account.gl).join(', ')}`)}${App.kpi('Last statement balance', pos[0]?.lastStatement ? App.fmt0(pos[0].lastStatement.closing) : 'None', pos[0]?.lastStatement ? `as of ${fdate(pos[0].lastStatement.date)}` : '')}${App.kpi('Projected in 13 weeks', App.fmt0(f.closing), `net ${fmt(f.totals.net)} to ${fdate(f.horizon)}`)}${App.kpi('Lowest projected balance', App.fmt0(f.low.closing), `week of ${fdate(f.low.start)}`)}</div>`;
    const accts = App.table([
      { h: 'Bank account', f: (p) => `${esc(p.label)}<div class="small muted">${esc(p.account.currency)}, GL ${App.link('acct', p.account.gl)}</div>` },
      { h: 'Book balance', num: true, f: (p) => fmt(p.book) },
      { h: 'Last statement', f: (p) => p.lastStatement ? `${App.link('bankstmt', p.lastStatement.id)} <span class="small muted">${fdate(p.lastStatement.date)}</span>` : '<span class="muted">None</span>' },
      { h: 'Statement balance', num: true, f: (p) => p.lastStatement ? fmt(p.lastStatement.closing) : '' },
      { h: 'Reconciled to', f: (p) => p.lastReconciled ? fdate(p.lastReconciled) : '<span class="muted">Never</span>' },
      { h: 'To reconcile', num: true, f: (p) => `${num(p.unmatchedLines)} bank / ${num(p.unreconciledGL)} book` },
    ], pos);
    const chart = `<div class="card"><div class="card-h"><span>13-week cash forecast</span>${App.btn(asTable ? 'View as chart' : 'View as table', 'cash-chart-toggle', {}, null, 'sm')}</div><div class="pad">`
      + (asTable ? weekTable(f) : `<div class="legend" style="margin-bottom:8px"><span><i style="background:var(--series-1)"></i>Receipts (open receivables by due date)</span><span><i style="background:var(--series-2)"></i>Payments (payables, payroll, rent)</span></div><div id="cashChart" data-w="0">${chartSvg(f.weeks, 640)}</div>`)
      + `<p class="small muted" style="margin:10px 0 0">Receipts come from open receivables by due date and payments from validated payables by due date; overdue items are assumed in week 1. Payroll is estimated at month end as active salaries / 12 less ${Math.round(E.WITHHOLDING_RATE * 100)}% withholding (${fmt(f.netPayEstimate)} a month). Rent of ${fmt(f.rent)} is due on the 1st.</p></div></div>`;
    const items = App.table([
      { h: 'Date', f: (x) => fdate(x.date) + (x.due && x.due < f.today ? ` <span class="small muted">(due ${fdate(x.due)})</span>` : '') },
      { h: 'Week', num: true, f: (x) => x.week + 1 },
      { h: 'Type', f: (x) => esc({ receipt: 'Customer receipt', payment: 'Supplier payment', payroll: 'Payroll', rent: 'Rent' }[x.kind]) },
      { h: 'Source', f: (x) => x.ref ? App.link(x.kind === 'receipt' ? 'arinv' : 'apinv', x.ref) : '<span class="muted">Estimate</span>' },
      { h: 'Description', f: (x) => esc(x.desc) },
      { h: 'Amount', num: true, f: (x) => amt(x.amount) },
    ], f.items, { empty: 'Nothing expected in the next 13 weeks.' });
    return kpis + `<div class="stack"><div class="card"><h3>Cash by bank account</h3>${accts}</div>${chart}`
      + (asTable ? '' : `<div class="card"><h3>Weekly forecast</h3>${weekTable(f)}</div>`)
      + `<div class="card"><h3>Forecast items (${f.items.length})</h3>${items}</div></div>`;
  }

  function statementsTab() {
    const list = statements().slice().reverse();
    return `<div class="card">${App.table([
      { h: 'Statement', f: (s) => App.link('bankstmt', s.id) },
      { h: 'Bank account', f: (s) => esc(E.bankAccountLabel(E.bankAccount(s.account))) },
      { h: 'Period', f: (s) => `${fdate(s.startDate)} to ${fdate(s.endDate)}` },
      { h: 'Opening', num: true, f: (s) => fmt(s.opening) },
      { h: 'Closing', num: true, f: (s) => fmt(s.closing) },
      { h: 'Lines', num: true, f: (s) => num(s.lines.length) },
      { h: 'Unmatched', num: true, f: (s) => num(s.lines.filter((l) => !l.matched).length) },
      { h: 'Status', f: (s) => pill(s.status, s.status === 'Reconciled' ? 'good' : 'info') + (s.reconciledBy ? `<div class="small muted">${esc(s.reconciledBy)}, ${fdate(s.reconciledOn)}</div>` : '') },
      { h: '', f: (s) => App.btn(s.status === 'Reconciled' ? 'View' : 'Reconcile', 'cash-go-rec', { id: s.id }, null, 'sm' + (s.status === 'Reconciled' ? '' : ' primary')) },
    ], list, { empty: 'No bank statements loaded.' })}</div>`;
  }

  function reportHtml(r) {
    const row = (label, v, strong) => `<tr><td>${strong ? `<b>${label}</b>` : label}</td><td class="num">${strong ? `<b>${fmt(v)}</b>` : fmt(v)}</td></tr>`;
    const sum = `<div class="tbl-wrap"><table class="t"><tbody>${row(`Statement closing balance, ${fdate(r.end)}`, r.closing)}${row(`Add deposits in transit (${r.depositsInTransit.length})`, r.ditTotal)}${row(`Less outstanding payments (${r.outstandingPayments.length})`, r.opTotal)}${r.bookedLater.length ? row(`Less bank items booked after ${fdate(r.end)} (${r.bookedLater.length})`, -r.bookedLaterTotal) : ''}${row('Adjusted bank balance', r.adjustedBank, true)}${row(`Book balance, GL ${esc(r.account.gl)} at ${fdate(r.end)}`, r.book, true)}${row('Difference', r.difference, true)}</tbody></table></div>`;
    const list = (title, rows) => rows.length ? `<h3 style="margin:0;font-size:14px">${title}</h3>` + App.table([{ h: 'Date', f: (o) => fdate(o.date) }, { h: 'Journal', f: (o) => App.link('je', o.id || o.journal) }, { h: 'Description', f: (o) => esc(o.desc) }, { h: 'Amount', num: true, f: (o) => fmt(o.amount) }], rows) : '';
    const unm = r.unmatched.length ? `<h3 style="margin:0;font-size:14px">Bank items not yet in the books (explain the difference)</h3>` + App.table([{ h: 'Date', f: (l) => fdate(l.date) }, { h: 'Line', f: (l) => esc(l.id) }, { h: 'Description', f: (l) => esc(l.desc) }, { h: 'Amount', num: true, f: (l) => fmt(l.amount) }], r.unmatched, { foot: ['Total', '', '', fmt(r.unmatchedTotal)] }) : '';
    return sum + list('Deposits in transit', r.depositsInTransit) + list('Outstanding payments', r.outstandingPayments) + unm;
  }

  function reconcileTab() {
    const st = currentStmt(); if (!st) return '<div class="empty">No bank statements loaded.</div>';
    const r = E.bankReconReport(st.id); const done = st.status === 'Reconciled';
    const book = E.unreconciledCash(st.account).filter((x) => x.date <= U.addDays(st.endDate, E.CASH_MATCH_WINDOW));
    const picker = `<div class="row" style="margin-bottom:12px;align-items:end">${App.field('Bank statement', App.select('cashStmt', statements().map((s) => [s.id, `${s.id}  ${U.periodLabel(s.period)} (${s.status})`]), st.id))}<div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">`
      + (done ? App.btn('Reopen', 'cash-reopen', { id: st.id }, 'cash.reconcile')
        : App.btn('Auto-match', 'cash-auto', { id: st.id }, 'cash.reconcile') + (r.complete ? App.btn('Mark reconciled', 'cash-mark', { id: st.id }, 'cash.reconcile', 'primary')
          : `<button type="button" class="btn primary" disabled title="${r.priorOpen.length ? 'Reconcile earlier statements first' : 'Available when every line is matched and the difference is zero'}">Mark reconciled</button>`))
      + '</div></div>';
    const tone = Math.abs(r.difference) < 0.005 ? 'good' : 'warn';
    const kpis = `<div class="kpis">${App.kpi('Statement closing', App.fmt0(r.closing), fdate(r.end))}${App.kpi('Deposits in transit', fmt(r.ditTotal), `${r.depositsInTransit.length} item(s)`)}${App.kpi('Outstanding payments', fmt(r.opTotal), `${r.outstandingPayments.length} item(s)`)}${App.kpi('Book balance', App.fmt0(r.book), `GL ${esc(r.account.gl)} at ${fdate(r.end)}`)}${App.kpi('Difference', `<span style="color:var(--${tone})">${fmt(r.difference)}</span>`, done ? 'Reconciled' : `${r.linesUnmatched} statement line(s) unmatched`)}</div>`;
    const status = done ? `<div class="callout good" style="margin-bottom:16px">${esc(st.id)} was reconciled by ${esc(st.reconciledBy)} on ${fdate(st.reconciledOn)}. Reopen it to change matches.</div>`
      : r.priorOpen.length ? `<div class="callout warn" style="margin-bottom:16px">Reconcile ${r.priorOpen.map((id) => App.link('bankstmt', id)).join(', ')} first. Statements reconcile in order.</div>` : '';
    const lines = App.table([
      { h: 'Date', f: (l) => sdate(l.date) },
      { h: 'Description', f: (l) => `${esc(l.desc)}<div class="small muted">${esc(l.type)}${l.ref ? ' · ' + esc(l.ref) : ''}${l.kind !== 'gl' ? ' · ' + esc(KIND_LABEL[l.kind] || l.kind) : ''}</div>` },
      { h: 'Amount', num: true, f: (l) => amt(l.amount) },
      { h: 'Match', f: (l) => l.matched ? `${pill(l.status, l.status === 'Reconciled' ? 'good' : 'accent')} ${App.link('je', l.matched)}` : pill('Unmatched', 'warn') },
      { h: '', f: (l) => done ? '' : `<div class="actions" style="display:flex;gap:6px;flex-wrap:wrap">${l.matched ? App.btn('Unmatch', 'cash-unmatch', { stmt: st.id, line: l.id }, 'cash.reconcile', 'sm')
        : (l.kind !== 'gl' ? App.btn('Create accounting', 'cash-acct', { stmt: st.id, line: l.id }, 'cash.reconcile', 'sm primary') : '') + App.btn('Match', 'cash-match-line', { stmt: st.id, line: l.id }, 'cash.reconcile', 'sm')}</div>` },
    ], st.lines, { empty: 'This statement has no lines.' });
    const gl = App.table([
      { h: 'Date', f: (x) => sdate(x.date) },
      { h: 'Journal', f: (x) => App.link('je', x.id) },
      { h: 'Description', f: (x) => esc(x.desc) },
      { h: 'Amount', num: true, f: (x) => amt(x.amount) },
      { h: '', f: (x) => done ? '' : App.btn('Match', 'cash-match-gl', { stmt: st.id, je: x.id }, 'cash.reconcile', 'sm') },
    ], book, { empty: 'Every book cash entry up to this statement is matched.' });
    return picker + status + kpis
      + `<div class="grid g2" style="margin-bottom:16px"><div class="card"><h3><span>Statement lines (${st.lines.length})</span><span class="small muted">${esc(E.bankAccountLabel(E.bankAccount(st.account)))}</span></h3>${lines}</div>`
      + `<div class="card"><h3><span>Unreconciled book cash (${book.length})</span><span class="small muted">GL ${esc(r.account.gl)} to ${fdate(U.addDays(st.endDate, E.CASH_MATCH_WINDOW))}</span></h3>${gl}</div></div>`
      + `<div class="card"><h3>Reconciliation report ${esc(st.id)}</h3><div class="pad stack">${reportHtml(r)}</div></div>`;
  }

  App.view('cash', {
    title: 'Cash management', group: 'Financials',
    render() {
      const tab = App.tabOf('cash', 'position');
      const head = App.head('Financials', 'Cash management', 'Bank balances, statement reconciliation against the general ledger, and a 13-week cash forecast built from receivables, payables and payroll.');
      const tabs = App.tabs('cash', [['position', 'Position & forecast'], ['statements', `Statements (${E.S.bankStatements.length})`], ['reconcile', `Reconcile${unmatchedOpen() ? ` (${unmatchedOpen()})` : ''}`]]);
      return head + tabs + (tab === 'statements' ? statementsTab() : tab === 'reconcile' ? reconcileTab() : positionTab());
    },
    after(root) {
      const sel = root.querySelector('#cashStmt');
      if (sel) sel.addEventListener('change', () => { ui.filter.cashStmt = sel.value; App.render(); });
      const wrap = root.querySelector('#cashChart');
      if (wrap) { const f = E.cashForecast(); const draw = () => { const w = wrap.clientWidth; if (w && +wrap.dataset.w !== w) { wrap.dataset.w = w; wrap.innerHTML = chartSvg(f.weeks, w); } }; draw(); }
    },
  });
  window.addEventListener('resize', () => { const wrap = document.getElementById('cashChart'); if (wrap && App.current === 'cash') { const w = wrap.clientWidth; if (w && +wrap.dataset.w !== w) { wrap.dataset.w = w; wrap.innerHTML = chartSvg(E.cashForecast().weeks, w); } } });

  // ---------- actions ----------
  App.act('cash-chart-toggle', () => { ui.filter.cashChart = ui.filter.cashChart === 'table' ? 'chart' : 'table'; App.render(); });
  App.act('cash-go-rec', (ds) => { App.closeDrawer(); ui.filter.cashStmt = ds.id; ui.tab.cash = 'reconcile'; App.go('cash'); App.render(); });
  App.act('cash-auto', (ds) => App.try(() => E.autoMatchStatement(ds.id), (n) => n ? `${n} line(s) matched automatically.` : 'No new matches found (same amount, within 5 days).'));
  App.act('cash-unmatch', (ds) => App.try(() => E.unmatchBankLine(ds.stmt, ds.line), `Line ${ds.line} unmatched.`));
  App.act('cash-mark', (ds) => App.try(() => E.markStatementReconciled(ds.id), `${ds.id} reconciled.`));
  App.act('cash-reopen', (ds) => App.confirm('Reopen bank statement', `Reopen ${esc(ds.id)} so its matches can be changed? Accounting already created stays posted.`, 'Reopen', () => E.reopenBankStatement(ds.id), `${ds.id} reopened.`));
  App.act('cash-match-line', (ds) => {
    const st = E.bankStatement(ds.stmt), l = st.lines.find((x) => x.id === ds.line);
    const cands = E.unreconciledCash(st.account).filter((x) => Math.abs(x.amount - l.amount) < 0.005);
    const html = `<div class="callout">Statement line ${esc(l.id)}: ${fdate(l.date)}, ${esc(l.desc)}, <b class="num">${fmt(l.amount)}</b>. Matches are one-to-one at the same amount.</div>`
      + (cands.length ? App.table([
        { h: '', f: (x) => `<input type="radio" name="cashJe" id="cj-${esc(x.id)}" value="${esc(x.id)}" ${x === cands[0] ? 'checked' : ''} aria-label="Match ${esc(x.id)}">` },
        { h: 'Journal', f: (x) => esc(x.id) }, { h: 'Date', f: (x) => `${fdate(x.date)} <span class="small muted">(${U.daysBetween(x.date, l.date)}d)</span>` }, { h: 'Description', f: (x) => esc(x.desc) }, { h: 'Amount', num: true, f: (x) => fmt(x.amount) },
      ], cands) : `<div class="empty">No unmatched book cash entries for ${fmt(l.amount)}.${l.kind !== 'gl' ? ' Use Create accounting to book this bank item.' : ''}</div>`);
    App.drawer(`Match ${l.id}`, html, cands.length ? { submitLabel: 'Match', onSubmit: (f) => { const c = f.querySelector('input[name="cashJe"]:checked'); if (!c) throw new Error('Choose a journal.'); return E.matchBankLine(st.id, l.id, c.value); }, success: (x) => `${x.id} matched to ${x.matched}.` } : {});
  });
  App.act('cash-match-gl', (ds) => {
    const st = E.bankStatement(ds.stmt), j = E.je(ds.je), a = E.bankAccount(st.account), v = E.cashOf(j, a.gl);
    const cands = st.lines.filter((l) => !l.matched && Math.abs(l.amount - v) < 0.005);
    const html = `<div class="callout">Book entry ${esc(j.id)}: ${fdate(j.date)}, ${esc(j.desc)}, <b class="num">${fmt(v)}</b>.</div>`
      + (cands.length ? App.table([
        { h: '', f: (l) => `<input type="radio" name="cashLine" id="cl-${esc(l.id)}" value="${esc(l.id)}" ${l === cands[0] ? 'checked' : ''} aria-label="Match line ${esc(l.id)}">` },
        { h: 'Line', f: (l) => esc(l.id) }, { h: 'Date', f: (l) => fdate(l.date) }, { h: 'Description', f: (l) => esc(l.desc) }, { h: 'Amount', num: true, f: (l) => fmt(l.amount) },
      ], cands) : `<div class="empty">No unmatched line on ${esc(st.id)} for ${fmt(v)}. It stays outstanding until it clears the bank.</div>`);
    App.drawer(`Match ${j.id}`, html, cands.length ? { submitLabel: 'Match', onSubmit: (f) => { const c = f.querySelector('input[name="cashLine"]:checked'); if (!c) throw new Error('Choose a statement line.'); return E.matchBankLine(st.id, c.value, j.id); }, success: (x) => `${x.id} matched to ${x.matched}.` } : {});
  });
  App.act('cash-acct', (ds) => {
    const st = E.bankStatement(ds.stmt), l = st.lines.find((x) => x.id === ds.line), a = E.bankAccount(st.account);
    const kind = l.kind === 'gl' ? 'other' : l.kind;
    let body;
    if (kind === 'returned') {
      const rc = E.S.receipts.find((r) => r.id === l.receiptId);
      body = `<div class="callout warn">The bank returned ${esc(E.cust(rc.customerId).name)}'s payment ${esc(rc.reference)} of <b class="num">${fmt(rc.amount)}</b>. This posts Dr 1100 Accounts receivable / Cr ${esc(a.gl)} Cash and reopens ${App.link('arinv', rc.invoiceId)} so it is collected again.</div>`;
    } else {
      const def = E.CASH_DEFAULT_OFFSET[kind];
      const opts = App.accountOptions().filter(([c]) => c !== a.gl && c !== '1100' && c !== '2000');
      if (!opts.some(([c]) => c === def)) opts.unshift([def, `${def} ${def === '6600' ? 'Bank charges' : 'Cash in suspense (unidentified)'}`]);
      body = App.field('Offset account', App.select('cashOff', opts, def), l.amount < 0 ? `Posts Dr offset / Cr ${a.gl} Cash` : `Posts Dr ${a.gl} Cash / Cr offset`);
    }
    App.drawer(`Create accounting for ${l.id}`, `<div class="dl"><div><span>Bank line</span>${esc(l.desc)}</div><div><span>Type</span>${esc(KIND_LABEL[kind])}</div><div><span>Amount</span><span class="num">${fmt(l.amount)}</span></div></div>`
      + `<div class="row">${App.field('Accounting date', App.input('cashDate', l.date, 'date'))}</div>` + body,
      { submitLabel: 'Post and match', onSubmit: (f) => E.createBankAccounting(st.id, l.id, { date: App.val(f, 'cashDate'), acct: App.val(f, 'cashOff') || undefined }), success: (j) => `${j.id} posted and matched to ${l.id}.` });
  });

  // ---------- detail ----------
  App.detail('bankstmt', (id) => {
    const st = E.bankStatement(id); if (!st) return null; const r = E.bankReconReport(id); const a = E.bankAccount(st.account);
    return { title: `Bank statement ${st.id}`,
      html: App.dl([['Bank account', esc(E.bankAccountLabel(a))], ['Period', `${fdate(st.startDate)} to ${fdate(st.endDate)}`], ['Status', pill(st.status, st.status === 'Reconciled' ? 'good' : 'info')], ['Opening balance', `<span class="num">${fmt(st.opening)}</span>`], ['Closing balance', `<span class="num">${fmt(st.closing)}</span>`], ['Difference to book', `<span class="num">${fmt(r.difference)}</span>`], st.reconciledBy && ['Reconciled by', `${esc(st.reconciledBy)}, ${fdate(st.reconciledOn)}`]])
        + App.table([{ h: 'Date', f: (l) => fdate(l.date) }, { h: 'Description', f: (l) => esc(l.desc) + (l.ref ? `<div class="small muted">${esc(l.ref)}</div>` : '') }, { h: 'Amount', num: true, f: (l) => fmt(l.amount) }, { h: 'Matched to', f: (l) => l.matched ? App.link('je', l.matched) : pill('Unmatched', 'warn') }], st.lines,
          { foot: ['', 'Opening + lines = closing', fmt(U.sum(st.lines, (l) => l.amount)), ''] })
        + '<h3 style="margin:0;font-size:14px">Reconciliation report</h3>' + reportHtml(r)
        + '<h3 style="margin:0;font-size:14px">Accounting created from this statement</h3>' + App.jeList(E.S.journals.filter((j) => j.ref === id)),
      buttons: App.btn(st.status === 'Reconciled' ? 'Open in workbench' : 'Reconcile', 'cash-go-rec', { id }, null, 'primary') };
  });
  App.refKind('BST-', 'bankstmt');
  App.navCount('cash', unmatchedOpen);
})();
