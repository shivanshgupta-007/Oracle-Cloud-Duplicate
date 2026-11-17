/* Ledgerline Suite: views-revrec.js
 * Revenue contracts: contract list and detail, new contract drawer (catalogue lines, SSP allocation preview),
 * billing and recognition runs, waterfall and deferred revenue roll-forward, cancellation, year-end close.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, num = App.num, fdate = App.fdate, pill = App.pill;
  const today = () => E.S.today;
  const card = (title, inner, right = '') => `<div class="card">${title ? `<div class="card-h"><span>${title}</span>${right}</div>` : ''}${inner}</div>`;
  const filt = () => (App.ui.filter.revenue = App.ui.filter.revenue || {});
  const custName = (id) => E.cust(id)?.name || id;
  const statusPill = (s) => pill(s, s === 'Active' ? 'good' : s === 'Cancelled' ? 'bad' : s === 'Completed' ? 'accent' : undefined);
  const billingLabel = (b) => (b === 'monthly' ? 'Monthly' : 'Annual in advance');
  const A = () => E.REVREC_ACCOUNTS;

  // ---------- new contract ----------
  const lineOptions = () => [['', 'Choose...']].concat(E.SERVICE_CATALOGUE.map((s) => [s.code, `${s.code} ${s.name}`])).concat(E.S.items.map((i) => ['item:' + i.sku, `Instrument ${i.sku} ${i.name}`]));
  const readContract = (f) => ({
    customerId: App.val(f, 'rcCust'), start: App.val(f, 'rcStart'), term: +App.val(f, 'rcTerm'), billing: App.val(f, 'rcBill'), name: App.val(f, 'rcName'),
    lines: App.readLines(f, 'rcLines').filter((l) => l.what).map((l) => ({ ...(l.what.startsWith('item:') ? { sku: l.what.slice(5) } : { service: l.what }), qty: l.qty, price: l.price, ssp: l.ssp })),
  });
  App.act('rc-new', () => {
    const S = E.S;
    const html = `<div class="row">${App.field('Customer', App.select('rcCust', S.customers.map((c) => [c.id, c.name])))}${App.field('Contract name', App.input('rcName', '', 'text', 'placeholder="e.g. Calibration plan, QC lab"'))}</div>
      <div class="row">${App.field('Start date', App.input('rcStart', today(), 'date'))}${App.field('Term (months)', App.input('rcTerm', '12', 'number', 'min="1" max="60" step="1"'))}${App.field('Billing', App.select('rcBill', [['annual', 'Annual in advance'], ['monthly', 'Monthly']], 'annual'))}</div>
      <p class="hint">Price blank = catalogue list price for the term (or the item price). Standalone selling price (SSP) per unit is optional: when any line has one, the contract price is allocated by relative SSP.</p>
      ${App.lines('rcLines', [{ key: 'what', label: 'Service or instrument', type: 'select', options: lineOptions() }, { key: 'qty', label: 'Qty', type: 'number', width: '80px' }, { key: 'price', label: 'Unit price', type: 'number', width: '120px' }, { key: 'ssp', label: 'SSP', type: 'number', width: '110px' }], [{ what: 'SV-100', qty: 5 }])}
      <div id="rcInfo" style="margin-top:12px"></div>`;
    App.drawer('New revenue contract', html, {
      submitLabel: 'Create contract', wide: true,
      oninput: (f) => {
        const box = App.$('#rcInfo', f);
        try {
          const k = E.contractPreview(readContract(f));
          const first = k.installments[0]; const open = E.S.periods[U.periodOf(first.due)] === 'Open';
          box.innerHTML = App.table([{ h: 'Line', f: (l) => esc(l.desc) }, { h: 'Qty', num: true, f: (l) => num(l.qty) }, { h: 'Price', num: true, f: (l) => fmt(l.amount) }, { h: 'Allocated', num: true, f: (l) => fmt(l.allocated) }, { h: 'Recognized', f: (l) => (l.kind === 'product' ? 'At start' : `Over ${k.term} months`) }], k.lines, { foot: ['Total', '', fmt(k.total), fmt(U.sum(k.lines, (l) => l.allocated)), ''] })
            + `<div class="callout" style="margin-top:8px">${k.allocation === 'Relative SSP' ? 'Allocated by relative standalone selling price. ' : ''}${k.installments.length} installment(s); first <b class="num">${fmt(first.amount)}</b> on ${fdate(first.due)} ${open ? 'is invoiced now (Dr 1100, Cr 2450 Deferred revenue).' : 'is invoiced by the billing run once its period is open.'} Recognition moves 2450 to 4200 monthly (4000 for instruments at start).</div>`;
        } catch (err) { box.innerHTML = `<div class="callout warn">${esc(err.message)}</div>`; }
      },
      onSubmit: (f) => E.createContract(readContract(f)),
      success: (c) => `${c.id} created, ${fmt(c.total)}${c.installments[0].invoiceId ? `; invoiced ${c.installments[0].invoiceId}` : ''}.`,
    });
  });

  // ---------- runs ----------
  App.act('rc-recognize', (ds) => {
    const avail = App.openPeriods().filter((p) => !E.S.revrecRuns[p]);
    if (!avail.length) { App.toast('Recognition has been run for every open period.', 'bad'); return; }
    const def = ds.period && avail.includes(ds.period) ? ds.period : avail.find((p) => E.recognitionPreview(p).total > 0) || avail[0];
    App.drawer('Run revenue recognition', `${App.field('Period', App.select('rrPeriod', avail.map((p) => [p, U.periodLabel(p)]), def))}<div id="rrInfo"></div>
      <p class="hint">Posts one journal dated the last day of the period: Dr 2450 Deferred revenue, Cr 4200 Service contract revenue (and Cr 4000 for bundled instruments). Includes any earlier months not yet recognized. Once per period.</p>`, {
      submitLabel: 'Post recognition',
      oninput: (f) => {
        const pv = E.recognitionPreview(App.val(f, 'rrPeriod'));
        App.$('#rrInfo', f).innerHTML = `<div class="callout" style="margin-bottom:8px">Services <b class="num">${fmt(pv.service)}</b>, instruments <b class="num">${fmt(pv.product)}</b>, total <b class="num">${fmt(pv.total)}</b>.</div>`
          + App.table([{ h: 'Contract', f: (r) => `${esc(r.id)}<div class="small muted">${esc(custName(r.customerId))}</div>` }, { h: 'Month', f: (r) => esc(U.periodLabel(r.period)) }, { h: 'Amount', num: true, f: (r) => fmt(r.amount) }], pv.rows, { empty: 'Nothing due.' });
      },
      onSubmit: (f) => E.runRecognition(App.val(f, 'rrPeriod')),
      success: (j) => `Recognition for ${U.periodLabel(j.period)} posted as ${j.id}, ${fmt(j.total)}.`,
    });
  });
  App.act('rc-bill', () => {
    const avail = App.openPeriods().filter((p) => E.contractBillingDue(p).length);
    if (!avail.length) { App.toast('No contract installments are due in an open period.', 'bad'); return; }
    App.drawer('Run contract billing', `${App.field('Period', App.select('rbPeriod', avail.map((p) => [p, U.periodLabel(p)]), avail[0]))}<div id="rbInfo"></div>`, {
      submitLabel: 'Raise invoices',
      oninput: (f) => {
        const due = E.contractBillingDue(App.val(f, 'rbPeriod'));
        App.$('#rbInfo', f).innerHTML = App.table([{ h: 'Contract', f: (x) => esc(x.contract.id) }, { h: 'Customer', f: (x) => esc(custName(x.contract.customerId)) }, { h: 'Due', f: (x) => fdate(x.inst.due) }, { h: 'Amount', num: true, f: (x) => fmt(x.inst.amount) }], due, { empty: 'Nothing due.' });
      },
      onSubmit: (f) => E.runContractBilling(App.val(f, 'rbPeriod')),
      success: (list) => `${list.length} invoice(s) raised.`,
    });
  });
  App.act('rc-cancel', (ds) => {
    const c = E.rcontract(ds.id);
    App.drawer(`Cancel ${c.id}`, `<p>${esc(custName(c.customerId))}: ${fmt(c.total)} over ${c.term} months from ${fdate(c.start)}. Months after the cancellation month are removed; that month and earlier ones are still recognized.</p>
      <div class="row">${App.field('Cancellation date', App.input('rxDate', today(), 'date'))}${App.field('Reason', App.input('rxWhy', '', 'text', 'placeholder="e.g. Site closed"'))}</div><div id="rxInfo"></div>`, {
      submitLabel: 'Cancel remaining term',
      oninput: (f) => {
        const box = App.$('#rxInfo', f);
        try {
          const x = E.cancelPreview(c.id, App.val(f, 'rxDate'));
          box.innerHTML = `<div class="callout warn">${x.months} month(s) removed, ${fmt(x.dropped)} (${fmt(x.unbilled)} never billed). Unpaid invoice balance credited: <b class="num">${fmt(x.credit)}</b> (Dr 2450, Cr 1100). Already paid, refund due: <b class="num">${fmt(x.refund)}</b> (Dr 2450, Cr 2410 Customer refunds payable).</div>`;
        } catch (err) { box.innerHTML = `<div class="callout bad">${esc(err.message)}</div>`; }
      },
      onSubmit: (f) => E.cancelContract(c.id, App.val(f, 'rxDate'), App.val(f, 'rxWhy')),
      success: (r) => `${r.id} cancelled.`,
    });
  });
  App.act('ye-close', () => App.confirm('Close fiscal year FY2027', 'Posts the closing journal moving every revenue and expense balance into 3100 Retained earnings. This is final for the year.', 'Post closing entry', () => E.yearEndClose('FY2027'), 'FY2027 closed to retained earnings.'));

  // ---------- detail ----------
  App.detail('rcontract', (id) => {
    const c = E.rcontract(id); if (!c) return null;
    const html = App.dl([
      ['Status', statusPill(c.status)], ['Customer', App.link('cust', c.customerId, custName(c.customerId))], c.name && ['Name', esc(c.name)],
      ['Term', `${fdate(c.start)} to ${fdate(c.end)} (${c.term} months)`], ['Billing', billingLabel(c.billing)], ['Allocation', esc(c.allocation)],
      ['Total', `<span class="num">${fmt(c.total)}</span>`], ['Billed', `<span class="num">${fmt(E.contractBilled(c))}</span>`],
      ['Recognized', `<span class="num">${fmt(E.contractRecognized(c))}</span>`], ['Deferred (billed, not recognized)', `<span class="num">${fmt(E.contractDeferred(c))}</span>`],
      c.cancelled && ['Cancelled', `${fdate(c.cancelled.date)}${c.cancelled.reason ? ', ' + esc(c.cancelled.reason) : ''}${c.cancelled.journal ? ' ' + App.link('je', c.cancelled.journal) : ''}`],
      c.refundOpen && ['Refund due', `<span class="num">${fmt(c.refundOpen)}</span>`],
    ])
      + '<h3 style="margin:0;font-size:14px">Performance obligations</h3>' + App.table([{ h: 'Line', f: (l) => esc(l.desc) }, { h: 'Qty', num: true, f: (l) => num(l.qty) }, { h: 'Price', num: true, f: (l) => fmt(l.amount) }, { h: 'SSP', num: true, f: (l) => (l.ssp != null ? fmt(l.ssp) : '') }, { h: 'Allocated', num: true, f: (l) => fmt(l.allocated) }, { h: 'Timing', f: (l) => (l.kind === 'product' ? 'Point in time' : 'Over time') }], c.lines)
      + '<h3 style="margin:0;font-size:14px">Billing</h3>' + App.table([{ h: '#', f: (i) => num(i.n) }, { h: 'Due', f: (i) => fdate(i.due) }, { h: 'Covers', f: (i) => esc(U.periodLabel(i.from) + (i.to !== i.from ? ' to ' + U.periodLabel(i.to) : '')) }, { h: 'Amount', num: true, f: (i) => fmt(i.amount) }, { h: 'Invoice', f: (i) => (i.invoiceId ? App.link('arinv', i.invoiceId) : pill(i.status)) }], c.installments)
      + '<h3 style="margin:0;font-size:14px">Recognition schedule</h3>' + App.table([{ h: 'Month', f: (s) => esc(U.periodLabel(s.period)) }, { h: 'Instruments', num: true, f: (s) => (s.product ? fmt(s.product) : '') }, { h: 'Services', num: true, f: (s) => fmt(s.service) }, { h: 'Amount', num: true, f: (s) => fmt(s.amount) }, { h: 'Status', f: (s) => pill(s.status, s.status === 'Recognized' ? 'good' : s.status === 'Cancelled' ? 'bad' : undefined) }, { h: 'Journal', f: (s) => (s.journal ? App.link('je', s.journal) : '') }], c.schedule, { foot: ['Total', '', '', fmt(U.sum(c.schedule, (s) => s.amount)), '', ''] })
      + '<h3 style="margin:0;font-size:14px">History</h3>' + App.table([{ h: 'Date', f: (x) => fdate(x.date) }, { h: 'Event', f: (x) => esc(x.type) }, { h: 'Detail', f: (x) => esc(x.detail) }, { h: 'Ref', f: (x) => (x.invoice ? App.link('arinv', x.invoice) : x.journal ? App.link('je', x.journal) : '') }], c.history.slice().reverse());
    const buttons = c.status === 'Active' ? App.btn('Cancel remaining term', 'rc-cancel', { id }, 'rev.edit', 'danger') : '';
    return { title: `${c.id} ${custName(c.customerId)}`, html, buttons };
  });
  App.refKind('RC-', 'rcontract');
  App.navCount('revenue', () => E.recognitionDuePeriods().length);

  // ---------- tabs ----------
  function contractsTab() {
    const f = filt(); const st = f.status || 'All';
    const list = E.S.rcontracts.filter((c) => st === 'All' || c.status === st).slice().reverse();
    const sel = `<label class="field" style="max-width:200px;margin-bottom:12px"><span>Status</span><select id="rc-f-status" data-rc-filter="status">${['All', 'Active', 'Completed', 'Cancelled'].map((s) => `<option ${s === st ? 'selected' : ''}>${s}</option>`).join('')}</select></label>`;
    return sel + card('Contracts', App.table([
      { h: 'Contract', f: (c) => `${App.link('rcontract', c.id)}<div class="small">${esc(c.name || '')}</div>` },
      { h: 'Customer', f: (c) => esc(custName(c.customerId)) },
      { h: 'Term', f: (c) => `<span style="white-space:nowrap">${fdate(c.start)}</span><div class="small muted">${c.term} mo, ${billingLabel(c.billing).toLowerCase()}</div>` },
      { h: 'Total', num: true, f: (c) => fmt(c.total) }, { h: 'Recognized', num: true, f: (c) => fmt(E.contractRecognized(c)) },
      { h: 'Deferred', num: true, f: (c) => fmt(E.contractDeferred(c)) }, { h: 'Status', f: (c) => statusPill(c.status) },
    ], list, { empty: 'No contracts. Use New contract.', foot: ['Total', `${list.length} contracts`, '', fmt(U.sum(list, (c) => c.total)), fmt(U.sum(list, E.contractRecognized)), fmt(U.sum(list, E.contractDeferred)), ''] }));
  }
  function recognitionTab() {
    const S = E.S;
    const rows = Object.keys(S.periods).sort().filter((p) => S.periods[p] !== 'Future').map((p) => ({ p, run: S.revrecRuns[p], pv: E.recognitionPreview(p) }));
    const runs = App.table([
      { h: 'Period', f: (r) => esc(U.periodLabel(r.p)) }, { h: 'Status', f: (r) => pill(S.periods[r.p]) },
      { h: 'Journal', f: (r) => (r.run ? App.link('je', r.run) : '<span class="muted">Not run</span>') },
      { h: 'Recognized', num: true, f: (r) => (r.run ? fmt(E.je(r.run).total) : '') }, { h: 'Due now', num: true, f: (r) => (r.run ? '' : fmt(r.pv.total)) },
      { h: '', f: (r) => (!r.run && S.periods[r.p] === 'Open' && r.pv.total > 0 ? App.btn('Run', 'rc-recognize', { period: r.p }, 'rev.run', 'sm primary') : '') },
    ], rows);
    const bill = App.openPeriods().flatMap((p) => E.contractBillingDue(p).map((x) => ({ p, ...x })));
    const billT = App.table([{ h: 'Contract', f: (x) => App.link('rcontract', x.contract.id) }, { h: 'Customer', f: (x) => esc(custName(x.contract.customerId)) }, { h: 'Due', f: (x) => fdate(x.inst.due) }, { h: 'Amount', num: true, f: (x) => fmt(x.inst.amount) }], bill.filter((x, i) => bill.findIndex((y) => y.inst === x.inst) === i), { empty: 'All due installments are billed.' });
    return `<div class="stack">${card('Recognition runs', runs, App.btn('Run recognition', 'rc-recognize', {}, 'rev.run', 'sm'))}${card('Installments due for billing', billT, App.btn('Run billing', 'rc-bill', {}, 'rev.run', 'sm'))}</div>`;
  }
  function waterfallTab() {
    const w = E.revenueWaterfall(null, { billedOnly: !!filt().billedOnly });
    const cols = [{ h: 'Contract', f: (r) => `${App.link('rcontract', r.id)}<div class="small muted">${esc(custName(r.customerId))}</div>` }]
      .concat(w.periods.map((p, k) => ({ h: esc(U.periodLabel(p)), num: true, f: (r) => App.fmt0(r.amounts[k]) })))
      .concat([{ h: 'Later', num: true, f: (r) => App.fmt0(r.later) }, { h: 'Total', num: true, f: (r) => App.fmt0(r.total) }]);
    const t = App.table(cols, w.rows, { empty: 'Nothing left to recognize.', foot: ['Total'].concat(w.totals.map((x) => App.fmt0(x))).concat([App.fmt0(w.later), App.fmt0(w.total)]) });
    const ps = Object.keys(E.S.periods).sort(); const f = filt();
    const from = f.from || E.FY_START, to = f.to || U.periodOf(today());
    const sel = (key, label, v) => `<label class="field" style="min-width:140px"><span>${label}</span><select id="rc-rf-${key}" data-rc-filter="${key}">${ps.map((p) => `<option value="${p}" ${p === v ? 'selected' : ''}>${esc(U.periodLabel(p))}</option>`).join('')}</select></label>`;
    let rf;
    try {
      const r = E.deferredRollForward(from, to);
      rf = App.table([{ h: '', f: (x) => x[0] }, { h: 'Amount', num: true, f: (x) => (x[2] ? `<b>${fmt(x[1])}</b>` : fmt(x[1])) }], [
        [`Opening, start of ${U.periodLabel(from)}`, r.opening], ['Billings', r.billings], ['Recognized', -r.recognized], ['Cancellations', -r.cancellations], r.other ? ['Other journals', r.other] : null,
        [`Closing, end of ${U.periodLabel(to)}`, r.closing, true], ['GL 2450 (credit)', r.gl]].filter(Boolean));
    } catch (err) { rf = `<div class="callout warn">${esc(err.message)}</div>`; }
    return `<div class="stack">${card(`Recognition waterfall, ${esc(U.periodLabel(w.periods[0]))} onward`, `<div class="row" style="margin:10px 16px;align-items:center"><label class="small"><input type="checkbox" data-rc-filter="billedOnly" ${f.billedOnly ? 'checked' : ''}> Billed only (ties to deferred revenue ${fmt(w.deferred)})</label></div>${t}`)}
      ${card('Deferred revenue roll-forward', `<div class="row" style="margin:10px 16px;max-width:360px">${sel('from', 'From period', from)}${sel('to', 'To period', to)}</div>${rf}`)}</div>`;
  }
  function yearEndTab() {
    const pv = E.yearEndPreview('FY2027');
    const checks = App.table([{ h: 'Precondition', f: (c) => esc(c.task) }, { h: 'Status', f: (c) => pill(c.done ? 'Ready' : 'Not ready', c.done ? 'good' : 'warn') }, { h: 'Detail', f: (c) => esc(c.detail) }], pv.checks);
    const lines = App.table([{ h: 'Entity', f: (l) => esc(l.entity) }, { h: 'Account', f: (l) => `${App.link('acct', l.acct)} ${esc(E.acct(l.acct)?.name || '')}` }, { h: 'Debit', num: true, f: (l) => (l.dr ? fmt(l.dr) : '') }, { h: 'Credit', num: true, f: (l) => (l.cr ? fmt(l.cr) : '') }],
      pv.lines, { empty: 'No revenue or expense balances.', foot: ['Total', '', fmt(U.sum(pv.lines, (l) => l.dr)), fmt(U.sum(pv.lines, (l) => l.cr))] });
    const done = E.S.yearEnd.FY2027;
    const btn = done ? App.link('je', done) : `<button type="button" class="btn sm primary" data-act="ye-close" ${pv.ready && App.can('gl.close') ? '' : 'disabled'}>Close FY2027</button>`;
    return `<div class="stack">${card('Year-end close, FY2027', `<p class="small muted" style="margin:10px 16px">Posts one journal dated ${fdate(pv.date)} moving every revenue and expense balance for the year into 3100 Retained earnings, per entity. Requires Jul-26 to May-27 closed, Jun-27 open and no journals awaiting approval. Net income to close: <b class="num">${fmt(pv.netIncome)}</b>.</p>${checks}`, btn)}
      ${card('Preview of the closing journal (year to date)', lines)}</div>`;
  }

  App.view('revenue', {
    title: 'Revenue contracts', group: 'Financials',
    render() {
      const S = E.S;
      const w = E.revenueWaterfall();
      const active = S.rcontracts.filter((c) => c.status === 'Active');
      const due = E.recognitionDuePeriods();
      const head = App.head('Financials', 'Revenue contracts', `Service contracts billed to ${A().deferred} Deferred revenue and recognized straight-line by month to ${A().service} (bundled instruments at start to ${A().product}, by relative standalone selling price). Deferred revenue reconciles to the contracts.`,
        App.btn('Run recognition', 'rc-recognize', {}, 'rev.run') + App.btn('New contract', 'rc-new', {}, 'rev.edit', 'primary'));
      const kpis = `<div class="kpis">${App.kpi('Active contracts', num(active.length), fmt(U.sum(active, (c) => c.total)))}${App.kpi('Deferred revenue', fmt(w.deferred), `GL ${A().deferred}`)}${App.kpi('Next 12 months', fmt(U.sum(w.totals)), 'Scheduled recognition')}${App.kpi('Recognition due', num(due.length), due.length ? due.map(U.periodLabel).join(', ') : 'All open periods run')}</div>`;
      const tab = App.tabOf('revenue', 'contracts');
      const tabs = App.tabs('revenue', [['contracts', 'Contracts'], ['recognition', 'Recognition'], ['waterfall', 'Waterfall'], ['yearend', 'Year-end close']]);
      const body = tab === 'recognition' ? recognitionTab() : tab === 'waterfall' ? waterfallTab() : tab === 'yearend' ? yearEndTab() : contractsTab();
      return head + kpis + tabs + body;
    },
    after(root) {
      App.$$('[data-rc-filter]', root).forEach((el) => el.addEventListener('change', () => { filt()[el.dataset.rcFilter] = el.type === 'checkbox' ? el.checked : el.value; App.render(); }));
    },
  });
})();
