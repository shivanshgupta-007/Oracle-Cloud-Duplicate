/* Ledgerline Suite — views-fin.js
 * Financials: Journals, Chart of accounts, Financial reports (TB / IS / BS /
 * reconciliation), Accounting periods, Payables, Receivables.
 * Views only read engine state; every write goes through a drawer onSubmit
 * (snapshot + rollback in ui.js) or App.try.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, fdate = App.fdate, pill = App.pill, fmtC = App.fmtC;
  const fd = (d) => `<span style="white-space:nowrap">${fdate(d)}</span>`; // date in a table cell
  const TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];
  const TYPE_PLURAL = { Asset: 'Assets', Liability: 'Liabilities', Equity: 'Equity', Revenue: 'Revenue', Expense: 'Expenses' };
  const card = (title, inner, right = '') => `<div class="card">${title ? `<div class="card-h"><span>${title}</span>${right}</div>` : ''}${inner}</div>`;
  const filt = (view) => (App.ui.filter[view] = App.ui.filter[view] || {});
  const curPeriod = () => U.periodOf(E.S.today);
  const acctLabel = (code) => `${App.link('acct', code)} ${esc(E.acct(code)?.name)}`;
  const byNewest = (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id, undefined, { numeric: true });
  /** Binds <select data-filter="view:key"> to App.ui.filter and re-renders. */
  const bindFilters = (root) => App.$$('[data-filter]', root).forEach((el) => el.addEventListener('change', () => {
    const [view, key] = el.dataset.filter.split(':'); filt(view)[key] = el.value; App.render();
  }));
  const filterSelect = (view, key, label, options, value) => `<label class="field" style="min-width:170px"><span>${label}</span><select id="f-${view}-${key}" data-filter="${view}:${key}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;

  // =====================================================================
  // 1. Journals
  // =====================================================================
  App.view('journals', {
    title: 'Journals',
    render() {
      const f = filt('journals');
      const all = E.S.journals;
      const periodsUsed = [...new Set(all.map((j) => j.period))].sort().reverse();
      const sources = [...new Set(all.map((j) => j.source))].sort();
      const isPL = (code) => ['Revenue', 'Expense'].includes(E.acct(code)?.type);
      const deptHit = (j) => !f.dept || (f.dept === E.UNASSIGNED ? j.lines.some((l) => !l.dept && isPL(l.acct)) : j.lines.some((l) => l.dept === f.dept));
      const entHit = (j) => !f.entity || j.lines.some((l) => E.lineEntity(l) === f.entity);
      const list = all.filter((j) => (!f.period || j.period === f.period) && (!f.source || j.source === f.source) && (!f.status || j.status === f.status) && deptHit(j) && entHit(j)).slice().sort(byNewest);
      const pending = all.filter((j) => j.status === 'Pending Approval');
      const actions = App.btn('Run depreciation', 'fin-depr', {}, 'gl.depr') + App.btn('Intercompany', 'fin-ic-new', {}, 'gl.post') + App.btn('New journal', 'fin-je-new', {}, 'gl.post', 'primary');
      const tabs = App.tabs('journals', [['list', `Journals (${all.length})`], ['rec', `Recurring (${E.S.recurring.length})`], ['ic', `Intercompany (${E.S.intercompany.length})`]]);
      if (App.tabOf('journals', 'list') === 'ic') return App.head('Financials', 'Journals', 'Charges between legal entities. Each posts one journal that balances in both entities through 1800 Intercompany receivable and 2800 Intercompany payable; recharges and the investment in US02 are eliminated on consolidation.', actions) + tabs + intercompanyHtml();
      if (App.tabOf('journals', 'list') === 'rec') return App.head('Financials', 'Journals', 'Monthly recurring templates. Generate posts a template into the earliest open period that does not have it yet, once per period.', actions) + tabs + recurringHtml();
      const callout = pending.length
        ? `<div class="callout warn" style="margin-bottom:16px"><b>${pending.length} journal${pending.length > 1 ? 's' : ''} awaiting approval</b> (${fmt(U.sum(pending, (j) => j.total))}). Manual journals over ${fmt(E.JE_APPROVAL_LIMIT)} post only after a Controller approves them: ${pending.map((j) => App.link('je', j.id)).join(', ')}.</div>`
        : '';
      const filters = `<div class="row" style="margin-bottom:14px;max-width:1080px;flex-wrap:wrap">
        ${filterSelect('journals', 'period', 'Period', [['', 'All periods'], ...periodsUsed.map((p) => [p, U.periodLabel(p)])], f.period || '')}
        ${filterSelect('journals', 'source', 'Source', [['', 'All sources'], ...sources.map((s) => [s, s])], f.source || '')}
        ${filterSelect('journals', 'status', 'Status', [['', 'All statuses'], ['Posted', 'Posted'], ['Pending Approval', 'Pending Approval'], ['Rejected', 'Rejected']], f.status || '')}
        ${filterSelect('journals', 'entity', 'Entity', [['', 'All entities'], ...E.entities().map((x) => [x.code, `${x.code} ${x.name}`])], f.entity || '')}
        ${filterSelect('journals', 'dept', 'Department', [['', 'All departments'], ...E.S.departments.map((d) => [d, d]), [E.UNASSIGNED, 'Unassigned (P&L lines)']], f.dept || '')}
      </div>`;
      const filtered = f.period || f.source || f.status || f.entity || f.dept;
      const tbl = App.table([
        { h: 'Journal', f: (j) => App.link('je', j.id) },
        { h: 'Date', f: (j) => fd(j.date) },
        { h: 'Period', f: (j) => U.periodLabel(j.period) },
        { h: 'Source', f: (j) => esc(j.source) },
        { h: 'Description', f: (j) => esc(j.desc) },
        { h: 'Entity', f: (j) => esc([...new Set(j.lines.map((l) => E.lineEntity(l)))].join(', ')) },
        { h: 'Amount', num: true, f: (j) => fmt(j.total) },
        { h: 'Status', f: (j) => pill(j.status) + (j.reversedBy ? ' ' + pill('Reversed', '') : '') + (j.reversalOf ? ' ' + pill('Reversal', 'info') : '') + (j.autoReverse && !j.reversedBy ? ' ' + pill('Accrual', 'warn') : '') },
        { h: 'Created by', f: (j) => esc(j.createdBy) },
      ], list, { empty: filtered ? 'No journals match these filters. Choose "All" in a filter to widen the list.' : 'No journals yet. Use New journal to record the first entry.' });
      return App.head('Financials', 'Journals', `Every accounting entry in the general ledger, from subledgers and manual entry. Showing ${list.length} of ${all.length}.`, actions)
        + tabs + callout + filters + card('', tbl);
    },
    after: bindFilters,
  });
  function intercompanyHtml() {
    const es = E.entities();
    const pos = []; es.forEach((a) => es.forEach((b) => { if (a.code !== b.code) pos.push(E.icBalances(a.code, b.code)); }));
    const ptbl = App.table([
      { h: 'Owed to', f: (x) => esc(x.from) },
      { h: 'Owed by', f: (x) => esc(x.to) },
      { h: `Receivable (1800 in creditor)`, num: true, f: (x) => fmt(x.receivable) },
      { h: `Payable (2800 in debtor)`, num: true, f: (x) => fmt(x.payable) },
      { h: 'Status', f: (x) => (Math.abs(x.diff) < 0.05 ? pill('Agrees', 'good') : pill(`Differs by ${fmt(x.diff)}`, 'bad')) },
      { h: '', f: (x) => (x.payable > 0.004 ? App.btn('Settle in cash', 'fin-ic-settle', { payer: x.to, payee: x.from }, 'gl.post', 'sm') : '') },
    ], pos);
    const list = E.S.intercompany.slice().sort(byNewest);
    const tbl = App.table([
      { h: 'Reference', f: (t) => esc(t.id) },
      { h: 'Date', f: (t) => fd(t.date) },
      { h: 'Type', f: (t) => pill(t.kind, t.kind === 'Settlement' ? '' : t.kind === 'Recharge' ? 'info' : 'warn') },
      { h: 'From', f: (t) => esc(t.fromEntity) },
      { h: 'To', f: (t) => esc(t.toEntity) },
      { h: 'Description', f: (t) => esc(t.desc) },
      { h: 'Amount', num: true, f: (t) => fmt(t.amount) },
      { h: 'Journal', f: (t) => App.link('je', t.journal) },
    ], list, { empty: 'No intercompany charges yet. Use Intercompany to post one.' });
    return card('Open intercompany balances', ptbl) + '<div style="height:14px"></div>' + card('Intercompany transactions', tbl)
      + `<p class="hint">${es.map((x) => `${esc(x.code)} ${esc(x.name)} (${esc(x.currency)} functional)`).join('; ')}. All entities report in USD, so no currency translation is needed on consolidation.</p>`;
  }
  App.act('fin-ic-new', () => {
    const open = App.openPeriods(); if (!open.length) { App.toast('No accounting period is open.', 'bad'); return; }
    const defDate = open.includes(curPeriod()) ? E.S.today : U.periodEnd(open[open.length - 1]);
    const ents = E.entities().map((x) => [x.code, `${x.code} ${x.name}`]);
    const pl = E.S.accounts.filter((a) => !E.IC_ACCTS.includes(a.code)).map((a) => [a.code, `${a.code} ${a.name}`]);
    App.drawer('New intercompany charge', `<div class="row">${App.field('Charging entity (from)', App.select('icFrom', ents, 'US01'))}${App.field('Charged entity (to)', App.select('icTo', ents, ents[1] ? ents[1][0] : ''))}</div>
      <div class="row">${App.field('Date', App.input('icDate', defDate, 'date'))}${App.field('Amount', App.input('icAmt', '', 'number', 'step="0.01" min="0"'))}</div>
      ${App.field('Description', App.input('icDesc', '', 'text', 'placeholder="e.g. Engineering support recharge, December"'))}
      <div class="row">${App.field('Credit in charging entity', App.select('icFromAcct', pl, '4950'), '4950 for a recharge, 1000 when paying on the other entity\'s behalf')}${App.field('Debit in charged entity', App.select('icToAcct', pl, '6850'))}</div>
      <div class="row">${App.field('Department (from)', App.select('icFromDept', App.deptOptions()))}${App.field('Department (to)', App.select('icToDept', App.deptOptions()))}</div>
      <div class="callout" id="icInfo"></div>`, {
      submitLabel: 'Post intercompany',
      oninput: (f) => { const fr = App.val(f, 'icFrom'), to = App.val(f, 'icTo'), a = +App.val(f, 'icAmt') || 0, fa = App.val(f, 'icFromAcct'), ta = App.val(f, 'icToAcct');
        const pl2 = (c) => ['Revenue', 'Expense'].includes(E.acct(c)?.type);
        App.$('#icInfo', f).innerHTML = `${esc(fr)}: Dr 1800 Intercompany receivable / Cr ${esc(fa)} <b class="num">${fmt(a)}</b>. ${esc(to)}: Dr ${esc(ta)} / Cr 2800 Intercompany payable. ${pl2(fa) && pl2(ta) ? 'Recharge: income and expense are eliminated on consolidation.' : 'Only 1800 / 2800 are eliminated; the cost stays in the charged entity.'}`; },
      onSubmit: (f) => E.createIntercompany({ date: App.val(f, 'icDate'), fromEntity: App.val(f, 'icFrom'), toEntity: App.val(f, 'icTo'), amount: App.val(f, 'icAmt'), desc: App.val(f, 'icDesc'), fromAcct: App.val(f, 'icFromAcct'), toAcct: App.val(f, 'icToAcct'), fromDept: App.val(f, 'icFromDept'), toDept: App.val(f, 'icToDept') }),
      success: (t) => `${t.id} posted as ${t.journal}: ${t.fromEntity} charged ${t.toEntity} ${fmt(t.amount)}.`,
    });
  });
  App.act('fin-ic-settle', (ds) => {
    const x = E.icBalances(ds.payee, ds.payer); const open = App.openPeriods(); if (!open.length) { App.toast('No accounting period is open.', 'bad'); return; }
    const defDate = open.includes(curPeriod()) ? E.S.today : U.periodEnd(open[open.length - 1]);
    App.drawer(`Settle ${ds.payer} payable to ${ds.payee}`, `<p>${esc(ds.payer)} owes ${esc(ds.payee)} <b class="num">${fmt(x.payable)}</b>.</p><div class="row">${App.field('Date', App.input('icsDate', defDate, 'date'))}${App.field('Amount', App.input('icsAmt', x.payable, 'number', 'step="0.01"'))}</div>
      <div class="callout">${esc(ds.payer)}: Dr 2800 / Cr 1000 Cash. ${esc(ds.payee)}: Dr 1000 Cash / Cr 1800.</div>`, {
      submitLabel: 'Post settlement',
      onSubmit: (f) => E.settleIntercompany({ date: App.val(f, 'icsDate'), payer: ds.payer, payee: ds.payee, amount: App.val(f, 'icsAmt') }),
      success: (t) => `${t.id}: ${t.fromEntity} paid ${t.toEntity} ${fmt(t.amount)}.`,
    });
  });
  function recurringHtml() {
    const ts = E.S.recurring;
    const open = App.openPeriods();
    const tbl = App.table([
      { h: 'Template', f: (t) => App.link('rj', t.id, t.name) },
      { h: 'Lines', f: (t) => t.lines.map((l) => `${esc(l.acct)} ${l.dr ? 'Dr' : 'Cr'}`).join(', ') },
      { h: 'Day', num: true, f: (t) => String(t.day) },
      { h: 'Amount', num: true, f: (t) => fmt(t.total) },
      { h: 'Last generated', f: (t) => { const ps = Object.keys(t.generated).sort(); const p = ps[ps.length - 1]; return p ? `${esc(U.periodLabel(p))} ${App.link('je', t.generated[p])}` : '<span class="muted">Never</span>'; } },
      { h: 'Due in open periods', f: (t) => { const due = open.filter((p) => p >= t.startPeriod && !t.generated[p]); return due.length ? pill(due.map(U.periodLabel).join(', '), 'warn') : pill('Up to date', 'good'); } },
      { h: 'Status', f: (t) => (t.active ? pill('Active', 'good') : pill('Paused', '')) },
      { h: '', f: (t) => (t.active && open.some((p) => p >= t.startPeriod && !t.generated[p]) ? App.btn('Generate', 'rj-generate', { id: t.id }, 'gl.recurring', 'sm primary') : '') },
    ], ts, { empty: 'No recurring journals yet. Open a posted journal and choose Make recurring.' });
    return `<div class="actions" style="margin-bottom:12px">${App.btn('New from journal', 'fin-rj-new', {}, 'gl.recurring', 'primary')}</div>` + card('', tbl)
      + '<p class="hint">Each template posts once per period; generating twice for the same period is refused. History posted before a template existed is linked, not reposted.</p>';
  }
  App.act('fin-rj-new', () => {
    const js = E.S.journals.filter((j) => j.status === 'Posted' && !j.reversalOf && ['Manual', 'Payables', 'Recurring'].includes(j.source) && j.lines.length <= 6).slice().sort(byNewest).slice(0, 60);
    if (!js.length) { App.toast('No posted journal to copy.', 'bad'); return; }
    App.drawer('New recurring journal', `${App.field('Copy lines from journal', App.select('rjSrc', js.map((j) => [j.id, `${j.id} ${U.periodLabel(j.period)}: ${j.desc} (${fmt(j.total)})`])))}${App.field('Template name', App.input('rjName2', '', 'text', 'placeholder="Defaults to the journal description"'))}
      <div class="row">${App.field('First period', App.select('rjStart2', E.periods().map((p) => [p.period, `${p.label} (${p.status})`]), App.openPeriods().pop() || ''))}${App.field('Day of month', App.input('rjDay2', '1', 'number', 'min="1" max="31" step="1"'))}</div>`, {
      submitLabel: 'Create template',
      onSubmit: (f) => E.recurringFromJournal(App.val(f, 'rjSrc'), { name: App.val(f, 'rjName2') || undefined, startPeriod: App.val(f, 'rjStart2'), day: App.val(f, 'rjDay2') }),
      success: (t) => `Recurring journal ${t.name} created (${t.id}).`,
    });
  });

  const jeLineCols = () => [
    { key: 'acct', label: 'Account', type: 'select', options: App.accountOptions(), width: '28%' },
    { key: 'entity', label: 'Entity', type: 'select', options: E.entities().map((x) => [x.code, x.code]) },
    { key: 'dept', label: 'Department', type: 'select', options: App.deptOptions('None') },
    { key: 'memo', label: 'Memo', type: 'text' },
    { key: 'dr', label: 'Debit', type: 'number', width: '17%' },
    { key: 'cr', label: 'Credit', type: 'number', width: '17%' },
  ];
  App.act('fin-je-new', () => {
    const open = App.openPeriods();
    if (!open.length) { App.toast('No accounting period is open. Open a period on the Accounting periods page first.', 'bad'); return; }
    const defDate = open.includes(curPeriod()) ? E.S.today : U.periodEnd(open[open.length - 1]);
    App.drawer('New manual journal', `<div class="row">${App.field('Accounting date', App.input('jeDate', defDate, 'date'), `Open periods: ${open.map(U.periodLabel).join(', ')}`)}${App.field('Description', App.input('jeDesc', '', 'text', 'placeholder="e.g. Accrue November audit fees"'))}</div>
      ${App.lines('jeLines', jeLineCols(), [{ acct: '6400', entity: App.entity() === 'All' ? E.DEFAULT_ENTITY : App.entity() }, { acct: '2200', entity: App.entity() === 'All' ? E.DEFAULT_ENTITY : App.entity() }])}
      <div class="callout" id="jeBal" aria-live="polite"></div>
      <label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="jeAccrual" name="jeAccrual" style="width:auto"><span>Accrual (auto-reverse on the first day of the next period)</span></label>
      <p class="hint">Journals totalling more than ${fmt(E.JE_APPROVAL_LIMIT)} are submitted to a Controller for approval instead of posting immediately. An accrual reverses as soon as the next period is open (now, or when it is opened).</p>`, {
      submitLabel: 'Save journal',
      oninput: (form) => {
        const ls = App.readLines(form, 'jeLines');
        const dr = U.sum(ls, (l) => +l.dr || 0), cr = U.sum(ls, (l) => +l.cr || 0), diff = U.r2(dr - cr);
        const el = App.$('#jeBal', form);
        el.className = 'callout ' + (Math.abs(diff) < 0.005 ? (dr > 0 ? 'good' : '') : 'warn');
        const byEnt = {}; ls.forEach((l) => { const e = l.entity || E.DEFAULT_ENTITY; byEnt[e] = U.r2((byEnt[e] || 0) + (+l.dr || 0) - (+l.cr || 0)); });
        const offEnt = Object.keys(byEnt).filter((e) => Math.abs(byEnt[e]) >= 0.005);
        if (offEnt.length && Math.abs(diff) < 0.005) el.className = 'callout warn';
        el.innerHTML = `Debits <b class="num">${fmt(dr)}</b> / Credits <b class="num">${fmt(cr)}</b> / Difference <b class="num">${fmt(diff)}</b>`
          + (offEnt.length && Math.abs(diff) < 0.005 ? `<br>Each legal entity must balance on its own: ${offEnt.map((e) => `${esc(e)} off by <b class="num">${fmt(byEnt[e])}</b>`).join(', ')}. Use Intercompany to move amounts between entities.` : '')
          + (dr > E.JE_APPROVAL_LIMIT && Math.abs(diff) < 0.005 ? ' <span class="pill warn">Needs approval</span>' : '');
      },
      onSubmit: (form) => E.createManualJournal({ date: App.val(form, 'jeDate'), desc: App.val(form, 'jeDesc'), lines: App.readLines(form, 'jeLines'), autoReverse: App.$('#jeAccrual', form).checked }),
      success: (j) => j.status === 'Posted'
        ? `${j.id} posted to ${U.periodLabel(j.period)}, ${fmt(j.total)}.${j.reversedBy ? ` Auto-reversal ${j.reversedBy} posted.` : j.autoReverse ? ' It reverses when the next period opens.' : ''}`
        : `${j.id} is over ${fmt(E.JE_APPROVAL_LIMIT)} and was sent to a Controller for approval. It is not posted yet.`,
    });
  });

  App.act('fin-depr', () => {
    const avail = App.openPeriods().filter((p) => !E.S.depreciationRuns[p]);
    if (!avail.length) { App.toast('Depreciation has already been posted for every open period.', 'bad'); return; }
    const preview = (p) => (E.depreciationPreview ? E.depreciationPreview(p).total : U.r2(E.balance('1500', { toPeriod: p }) / E.DEPRECIATION_MONTHS));
    App.drawer('Run depreciation', `${App.field('Period', App.select('deprPeriod', avail.map((p) => [p, U.periodLabel(p)]), avail[0]))}
      <div class="callout" id="deprInfo"></div>
      <p class="hint">Straight-line over ${E.DEPRECIATION_MONTHS} months on the equipment cost in 1500. Posts Dr 6300 Depreciation and Cr 1510 Accumulated depreciation, dated the last day of the period.</p>`, {
      submitLabel: 'Post depreciation',
      oninput: (form) => { const p = App.val(form, 'deprPeriod'); App.$('#deprInfo', form).innerHTML = `Equipment cost <b class="num">${fmt(E.balance('1500', { toPeriod: p }))}</b>. Charge for ${esc(U.periodLabel(p))}: <b class="num">${fmt(preview(p))}</b>, dated ${fdate(U.periodEnd(p))}.`; },
      onSubmit: (form) => E.runDepreciation(App.val(form, 'deprPeriod')),
      success: (j) => `Depreciation for ${U.periodLabel(j.period)} posted as ${j.id}, ${fmt(j.total)}.`,
    });
  });

  // =====================================================================
  // 2. Chart of accounts
  // =====================================================================
  App.view('accounts', {
    title: 'Chart of accounts',
    render() {
      const b = E.balances();
      const rows = [];
      TYPES.forEach((t) => {
        const accts = E.S.accounts.filter((a) => a.type === t);
        if (!accts.length) return;
        rows.push({ kind: 'grp', type: t });
        accts.forEach((a) => rows.push({ kind: 'acct', a, bal: E.natural(a.code, b[a.code] || 0) }));
        rows.push({ kind: 'sub', type: t, bal: U.sum(accts, (a) => E.natural(a.code, b[a.code] || 0)) });
      });
      const tbl = App.table([
        { h: 'Code', f: (r) => r.kind === 'grp' ? esc(TYPE_PLURAL[r.type]) : r.kind === 'acct' ? App.link('acct', r.a.code) : '' },
        { h: 'Name', f: (r) => r.kind === 'acct' ? esc(r.a.name) : r.kind === 'sub' ? `Total ${esc(TYPE_PLURAL[r.type].toLowerCase())}` : '' },
        { h: 'Type', f: (r) => r.kind === 'acct' ? esc(r.a.type) : '' },
        { h: 'Normal balance', f: (r) => r.kind === 'acct' ? (E.natural(r.a.code, 1) > 0 ? 'Debit' : 'Credit') : '' },
        { h: 'Balance', num: true, f: (r) => r.kind === 'grp' ? '' : r.kind === 'sub' ? `<b>${fmt(r.bal)}</b>` : fmt(r.bal) },
      ], rows, { rowCls: (r) => r.kind === 'grp' ? 'grp' : r.kind === 'sub' ? 'sub' : '', empty: 'No accounts yet. Add one with New account.' });
      return App.head('Financials', 'Chart of accounts', `${E.S.accounts.length} accounts. Balances are shown in each account's natural sign, across all posted journals. Open an account code to see its ledger.`, App.btn('New account', 'fin-acct-new', {}, 'gl.coa', 'primary'))
        + card('', tbl);
    },
  });
  App.act('fin-acct-new', () => {
    App.drawer('New account', `<div class="row">${App.field('Code', App.input('acCode', '', 'text', 'inputmode="numeric" maxlength="4" placeholder="e.g. 6600"'), '4 digits. 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx-6xxx expenses.')}${App.field('Type', App.select('acType', [['', 'Choose a type'], ...TYPES.map((t) => [t, t])], ''))}</div>${App.field('Name', App.input('acName', '', 'text', 'placeholder="e.g. Professional fees"'))}
      <p class="hint">Expense accounts below 6000 report under Cost of sales; 6000 and above under Operating expenses.</p>`, {
      submitLabel: 'Create account',
      onSubmit: (form) => E.addAccount({ code: App.val(form, 'acCode'), name: App.val(form, 'acName'), type: App.val(form, 'acType') }),
      success: (a) => `Account ${a.code} ${a.name} created.`,
    });
  });

  // =====================================================================
  // 3. Financial reports
  // =====================================================================
  function reportPeriods() {
    const all = E.periods();
    const lastPosted = all.filter((p) => p.posted > 0).map((p) => p.period).pop() || all[0].period;
    const lastOpen = App.openPeriods().pop() || lastPosted;
    const cap = lastPosted > lastOpen ? lastPosted : lastOpen;
    return all.filter((p) => p.period <= cap);
  }
  const stmtTable = (cols, rows) => App.table(cols, rows, { rowCls: (r) => r.cls || '' });
  const sectionRows = (title, list, totalLabel, total, amountsKey = 'amount') => [
    { cls: 'grp', label: title },
    ...list.map((r) => ({ code: r.code, label: esc(r.name), amounts: r[amountsKey] })),
    { cls: 'sub', label: totalLabel, amounts: total, bold: true },
  ];

  App.view('reports', {
    title: 'Financial reports',
    render() {
      const f = filt('reports');
      const plist = reportPeriods();
      const def = App.openPeriods().pop() || plist[plist.length - 1].period;
      const p = plist.some((x) => x.period === f.period) ? f.period : def;
      const tab = App.tabOf('reports', 'tb');
      const ent = f.entity && (f.entity === 'All' || E.entity(f.entity)) ? f.entity : App.entity();
      const showEnt = ['tb', 'is', 'bs', 'dept'].includes(tab);
      const sel = `<div class="row" style="margin-bottom:14px;max-width:${showEnt ? 640 : 260}px;flex-wrap:wrap">${filterSelect('reports', 'period', 'Period', plist.map((x) => [x.period, `${x.label} (${x.status})`]), p)}${showEnt ? filterSelect('reports', 'entity', 'Legal entity', App.entityOptions(true), ent) : ''}${tab === 'dept' ? filterSelect('reports', 'range', 'Range', [['ytd', 'Fiscal year to date'], ['period', 'Selected period only']], f.range || 'ytd') : ''}</div>`;
      let body = '';
      if (tab === 'tb') body = trialBalanceHtml(p, ent);
      else if (tab === 'is') body = incomeHtml(p, ent);
      else if (tab === 'bs') body = balanceSheetHtml(p, ent);
      else if (tab === 'cons') body = consolidationHtml(p);
      else if (tab === 'dept') body = deptHtml(p, ent, f.range || 'ytd');
      else if (tab === 'tax') body = salesTaxHtml();
      else body = reconHtml();
      return App.head('Financials', 'Financial reports', `${esc(showEnt ? App.entityLabel(ent) : 'Halden group, all legal entities')}, FY2027 (from ${esc(U.periodLabel(E.FY_START))}). Figures include posted journals only; pending approvals are excluded.${showEnt && ent === 'All' && tab !== 'tb' ? ' Consolidated: intercompany balances, recharges and the investment in US02 are eliminated.' : ''}`)
        + App.tabs('reports', [['tb', 'Trial balance'], ['is', 'Income statement'], ['bs', 'Balance sheet'], ['cons', 'Consolidation'], ['dept', 'By department'], ['rec', 'Reconciliation'], ['tax', 'Sales tax']])
        + (tab === 'rec' || tab === 'tax' ? '' : sel) + body;
    },
    after: bindFilters,
  });

  function trialBalanceHtml(p, ent) {
    const tb = E.trialBalance(p, { entity: ent });
    const ok = Math.abs(tb.dr - tb.cr) < 0.005;
    const tbl = App.table([
      { h: 'Account', f: (r) => App.link('acct', r.code) },
      { h: 'Name', f: (r) => esc(r.name) },
      { h: 'Type', f: (r) => esc(r.type) },
      { h: 'Debit', num: true, f: (r) => (r.dr ? fmt(r.dr) : '') },
      { h: 'Credit', num: true, f: (r) => (r.cr ? fmt(r.cr) : '') },
    ], tb.rows, { empty: 'No posted balances up to this period.', foot: ['Total', '', ok ? pill('Balanced', 'good') : pill('Out of balance', 'bad'), fmt(tb.dr), fmt(tb.cr)] });
    return card(`Trial balance as of ${esc(fdate(U.periodEnd(p)))}${ent && ent !== 'All' ? ', ' + esc(ent) : ', all entities (before eliminations)'}`, tbl, ok ? pill('Balanced', 'good') : pill(`Out of balance by ${fmt(U.r2(tb.dr - tb.cr))}`, 'bad'));
  }

  function incomeHtml(p, ent) {
    const cur = E.incomeStatement(p, p, { entity: ent }), ytd = E.incomeStatement(E.FY_START, p, { entity: ent });
    const merge = (key) => {
      const codes = [...new Set([...cur[key], ...ytd[key]].map((r) => r.code))].sort();
      return codes.map((code) => ({ code, name: E.acct(code).name, amount: [cur[key].find((r) => r.code === code)?.amount || 0, ytd[key].find((r) => r.code === code)?.amount || 0] }));
    };
    const pct = (s) => (s.totalRevenue ? ` <span class="muted">(${(s.grossMargin / s.totalRevenue * 100).toFixed(1)}%)</span>` : '');
    const rows = [
      ...sectionRows('Revenue', merge('revenue'), 'Total revenue', [cur.totalRevenue, ytd.totalRevenue]),
      ...sectionRows('Cost of sales', merge('cogs'), 'Total cost of sales', [cur.totalCogs, ytd.totalCogs]),
      { cls: 'grp', label: 'Gross margin', amounts: [cur.grossMargin, ytd.grossMargin], extra: [pct(cur), pct(ytd)] },
      ...sectionRows('Operating expenses', merge('opex'), 'Total operating expenses', [cur.totalOpex, ytd.totalOpex]),
      { cls: 'grp', label: 'Net income', amounts: [cur.netIncome, ytd.netIncome] },
    ];
    const amt = (i) => (r) => r.amounts ? (r.bold ? `<b>${fmt(r.amounts[i])}</b>` : fmt(r.amounts[i])) + (r.extra ? r.extra[i] : '') : '';
    const tbl = stmtTable([
      { h: 'Line', f: (r) => r.code ? `<span style="padding-left:16px">${acctLabel(r.code)}</span>` : r.label },
      { h: esc(U.periodLabel(p)), num: true, f: amt(0) },
      { h: `FY to date (${esc(U.periodLabel(E.FY_START))} to ${esc(U.periodLabel(p))})`, num: true, f: amt(1) },
    ], rows);
    return card(`Income statement, ${esc(U.periodLabel(p))} and fiscal year to date`, tbl, ytd.netIncome >= 0 ? pill(`YTD profit ${fmt(ytd.netIncome)}`, 'good') : pill(`YTD loss ${fmt(ytd.netIncome)}`, 'bad'));
  }

  function balanceSheetHtml(p, ent) {
    const bs = E.balanceSheet(p, { entity: ent });
    const one = (list) => list.map((r) => ({ ...r, amount: [r.amount] }));
    const rows = [
      ...sectionRows('Assets', one(bs.assets), 'Total assets', [bs.totalAssets]),
      ...sectionRows('Liabilities', one(bs.liabilities), 'Total liabilities', [bs.totalLiabilities]),
      { cls: 'grp', label: 'Equity' },
      ...one(bs.equity).map((r) => ({ code: r.code, amounts: r.amount })),
      { label: `<span style="padding-left:16px">Current year earnings</span> <span class="muted small">(net income ${esc(U.periodLabel(E.FY_START))} to ${esc(U.periodLabel(p))})</span>`, amounts: [bs.currentEarnings] },
      { cls: 'sub', label: 'Total equity', amounts: [bs.totalEquity], bold: true },
      { cls: 'grp', label: 'Total liabilities and equity', amounts: [U.r2(bs.totalLiabilities + bs.totalEquity)] },
    ];
    const tbl = stmtTable([
      { h: 'Line', f: (r) => r.code ? `<span style="padding-left:16px">${acctLabel(r.code)}</span>` : r.label },
      { h: `As of ${esc(fdate(U.periodEnd(p)))}`, num: true, f: (r) => r.amounts ? (r.bold ? `<b>${fmt(r.amounts[0])}</b>` : fmt(r.amounts[0])) : '' },
    ], rows);
    const check = bs.balanced ? pill('Assets = Liabilities + Equity', 'good') : pill(`Out of balance by ${fmt(U.r2(bs.totalAssets - bs.totalLiabilities - bs.totalEquity))}`, 'bad');
    return card(`Balance sheet as of ${esc(fdate(U.periodEnd(p)))}`, tbl, check);
  }

  function consolidationHtml(p) {
    const c = E.consolidation(p);
    const head = { elim: 'Eliminations', cons: 'Consolidated' };
    const cols = c.cols.map((k) => ({ h: esc(head[k] || k), num: true, f: (r) => (r.v ? (r.bold ? `<b>${fmt(r.v[k])}</b>` : r.v[k] ? fmt(r.v[k]) : '<span class="muted">-</span>') : '') }));
    const lineCol = { h: 'Line', f: (r) => (r.code ? `<span style="padding-left:16px">${acctLabel(r.code)}</span>${r.ic ? ' ' + pill('IC', 'info') : ''}` : r.label) };
    const sect = (rows, g, title, total, totLabel) => [{ cls: 'grp', label: title }, ...rows.filter((r) => r.group === g), { cls: 'sub', label: totLabel, v: total, bold: true }];
    const I = c.is.totals, B = c.bs.totals;
    const isRows = [...sect(c.is.rows, 'revenue', 'Revenue', I.revenue, 'Total revenue'), ...sect(c.is.rows, 'cogs', 'Cost of sales', I.cogs, 'Total cost of sales'), ...sect(c.is.rows, 'opex', 'Operating expenses', I.opex, 'Total operating expenses'), { cls: 'grp', label: 'Net income', v: I.net, bold: true }];
    const tle = {}; c.cols.forEach((k) => (tle[k] = U.r2(B.liability[k] + B.totalEquity[k])));
    const bsRows = [...sect(c.bs.rows, 'asset', 'Assets', B.asset, 'Total assets'), ...sect(c.bs.rows, 'liability', 'Liabilities', B.liability, 'Total liabilities'),
      ...sect(c.bs.rows, 'equity', 'Equity', B.equity, 'Total share capital and reserves').slice(0, -1), { label: '<span style="padding-left:16px">Current year earnings</span>', v: B.earnings }, { cls: 'sub', label: 'Total equity', v: B.totalEquity, bold: true },
      { cls: 'grp', label: 'Total liabilities and equity', v: tle, bold: true },
      { label: 'Balanced', v: null, chk: true }];
    const bsCols = c.cols.map((k, i) => ({ ...cols[i], f: (r) => (r.chk ? (B.balanced[k] ? pill('Balanced', 'good') : pill('Out of balance', 'bad')) : cols[i].f(r)) }));
    const allOk = c.cols.every((k) => B.balanced[k]);
    const sumOk = c.is.rows.concat(c.bs.rows).every((r) => Math.abs(c.entities.reduce((a, k) => a + r.v[k], 0) + r.v.elim - r.v.cons) < 0.005);
    return `<div class="callout ${allOk && sumOk ? 'good' : 'bad'}" style="margin-bottom:14px">${allOk ? 'Each entity balances on its own and the consolidated balance sheet balances.' : 'At least one balance sheet does not balance.'} Consolidated = ${c.entities.map(esc).join(' + ')} + eliminations${sumOk ? ', on every line' : ' (difference found)'}. All entities are USD functional, so no currency translation is needed.</div>`
      + card(`Consolidating income statement, ${esc(U.periodLabel(c.fromPeriod))} to ${esc(U.periodLabel(p))}`, stmtTable([lineCol, ...cols], isRows))
      + '<div style="height:14px"></div>'
      + card(`Consolidating balance sheet as of ${esc(fdate(U.periodEnd(p)))}`, stmtTable([lineCol, ...bsCols], bsRows), allOk ? pill('All balanced', 'good') : pill('Check balances', 'bad'))
      + '<p class="hint">Eliminations remove every line flagged intercompany: 1800 / 2800 balances between entities, intercompany service income (4950) against intercompany service charges (6850), and US01\'s investment in US02 (1850) against US02 share capital. Costs that US01 paid on US02\'s behalf stay in US02.</p>';
  }

  function deptHtml(p, ent, range) {
    const from = range === 'period' ? p : E.FY_START;
    const d = E.deptPL(from, p, { entity: ent });
    const is = E.incomeStatement(from, p, { entity: ent });
    const cols = [...d.depts, 'total'];
    const cell = (r, k) => { const v = k === 'total' ? r.total : r.by[k]; return v ? fmt(v) : '<span class="muted">-</span>'; };
    const rows = [];
    [['revenue', 'Revenue'], ['cogs', 'Cost of sales'], ['opex', 'Operating expenses']].forEach(([g, t]) => {
      const list = d.rows.filter((r) => r.group === g); if (!list.length) return;
      rows.push({ cls: 'grp', label: t }); list.forEach((r) => rows.push(r));
      rows.push({ cls: 'sub', label: `Total ${t.toLowerCase()}`, tot: g });
    });
    rows.push({ cls: 'grp', label: 'Net contribution', tot: 'net' });
    const tbl = stmtTable([
      { h: 'Account', f: (r) => (r.code ? `${acctLabel(r.code)}` : `<b>${r.label}</b>`) },
      ...cols.map((k) => ({ h: esc(k === 'total' ? 'Total' : k), num: true, f: (r) => (r.code ? cell(r, k) : r.tot ? `<b>${fmt(d.totals[k][r.tot])}</b>` : '') })),
    ], rows);
    const tie = Math.abs(d.totals.total.net - is.netIncome) < 0.01 && Math.abs(d.totals.total.opex - is.totalOpex) < 0.01;
    return card(`Profit and loss by department, ${esc(U.periodLabel(from))}${from !== p ? ' to ' + esc(U.periodLabel(p)) : ''}`, tbl, tie ? pill('Ties to income statement', 'good') : pill('Differs from income statement', 'bad'))
      + `<p class="hint">Lines without a department (rent, utilities, revenue and most subledger postings) show under Unassigned. Payroll posts to each employee's department; other costs carry the department entered on the journal line.${ent === 'All' ? ' Consolidated, so intercompany recharges are eliminated.' : ''}</p>`;
  }

  function salesTaxHtml() {
    const rows = E.salesTaxReport();
    const ps = [...new Set(rows.map((r) => r.period))].sort().reverse();
    const out = [];
    ps.forEach((p) => {
      const list = rows.filter((r) => r.period === p);
      const due = U.sum(list, (r) => r.netTax), rem = E.S.taxRemits.find((x) => x.period === p);
      out.push({ cls: 'grp', label: `${esc(U.periodLabel(p))}`, p, due, rem, head: true });
      list.forEach((r) => out.push(r));
    });
    const unremitted = U.sum(ps.filter((p) => !E.S.taxRemits.some((x) => x.period === p)), (p) => E.salesTaxDue(p));
    const gl = -E.balance('2300'); const tie = Math.abs(unremitted - gl) < 0.01;
    const cur = U.periodOf(E.S.today);
    const tbl = App.table([
      { h: 'Period / tax code', f: (r) => r.head ? `<b>${r.label}</b>` : `<span style="padding-left:16px">${esc(r.code || 'None')}</span> <span class="muted small">${esc(r.name)}</span>` },
      { h: 'Invoices', num: true, f: (r) => (r.head ? '' : App.num(r.invoices)) },
      { h: 'Taxable sales', num: true, f: (r) => (r.head ? '' : fmt(r.taxable)) },
      { h: 'Tax billed', num: true, f: (r) => (r.head ? '' : fmt(r.tax)) },
      { h: 'Credit memos', num: true, f: (r) => (r.head ? '' : r.creditTax ? fmt(-r.creditTax) : '') },
      { h: 'Net tax', num: true, f: (r) => (r.head ? `<b>${fmt(r.due)}</b>` : fmt(r.netTax)) },
      { h: 'Remittance', f: (r) => !r.head ? '' : r.rem ? `${pill('Remitted', 'good')} ${App.link('je', r.rem.journal)}` : r.due <= 0 ? '<span class="muted">Nothing due</span>' : (r.p < cur || App.openPeriods().some((x) => x > r.p)) ? App.btn('Remit sales tax', 'fin-tax-remit', { p: r.p }, 'gl.post', 'sm primary') : pill('Accruing', 'info') },
    ], out, { rowCls: (r) => (r.head ? 'grp' : ''), empty: 'No invoices yet.' });
    return `<div class="kpis">${App.kpi('Sales tax payable', fmt(gl), 'GL 2300')}${App.kpi('Unremitted per report', fmt(unremitted), tie ? 'Agrees with GL 2300' : 'Differs from GL 2300')}${App.kpi('Remitted FY to date', fmt(U.sum(E.S.taxRemits, (x) => x.amount)), `${E.S.taxRemits.length} remittance(s)`)}</div>`
      + card('Sales tax liability by period and tax code', tbl, tie ? pill('Ties to GL', 'good') : pill('Check GL 2300', 'warn'))
      + `<p class="hint">Tax is charged on shipment (or on manual invoices) at the customer's tax code: ${E.S.taxCodes.map((t) => `${esc(t.code)} ${(t.rate * 100).toFixed(3).replace(/\.?0+$/, '')}%`).join(', ')}. Credit memos reduce the tax of the period they are dated in. Remitting posts Dr 2300 Sales tax payable and Cr 1000 Cash, once per period after it ends.</p>`;
  }
  App.act('fin-tax-remit', (ds) => {
    const due = E.salesTaxDue(ds.p); const open = App.openPeriods();
    const def = open.includes(U.periodOf(E.S.today)) ? E.S.today : U.addDays(U.periodEnd(ds.p), 1);
    App.drawer(`Remit sales tax ${U.periodLabel(ds.p)}`, `<p>Net sales tax due for ${esc(U.periodLabel(ds.p))}: <b class="num">${fmt(due)}</b>.</p><div class="row">${App.field('Payment date', App.input('stxDate', def, 'date'))}${App.field('Reference', App.input('stxRef', '', 'text', 'placeholder="e.g. state filing number"'))}</div><div class="callout">Posts Dr 2300 Sales tax payable and Cr 1000 Cash.</div>`,
      { submitLabel: 'Remit', onSubmit: (f) => E.remitSalesTax({ period: ds.p, date: App.val(f, 'stxDate'), reference: App.val(f, 'stxRef') }), success: (r) => `Sales tax for ${U.periodLabel(r.period)} remitted, ${fmt(r.amount)}.` });
  });

  function reconHtml() {
    const rows = E.reconcile();
    const ok = rows.every((r) => r.ok);
    const tbl = App.table([
      { h: 'Control account', f: (r) => `${App.link('acct', r.acct)} ${esc(r.name)}` },
      { h: 'Subledger total', num: true, f: (r) => fmt(r.sub) },
      { h: 'GL balance', num: true, f: (r) => fmt(r.gl) },
      { h: 'Difference', num: true, f: (r) => fmt(r.diff) },
      { h: 'Status', f: (r) => (r.ok ? pill('Reconciled', 'good') : pill('Difference', 'bad')) },
    ], rows);
    return `<div class="callout ${ok ? 'good' : 'bad'}" style="margin-bottom:14px">${ok ? 'All control accounts tie out to their subledgers, and intercompany balances agree between entities.' : 'At least one control account does not agree with its subledger. Open the account to review postings.'} Reconciliation uses current balances across all periods.</div>`
      + card('Subledger to general ledger', tbl)
      + '<p class="hint">Payables: validated, unpaid invoices. Receivables: open customer invoices. Inventory: on hand quantity times average cost. Received not invoiced: PO quantity received but not yet billed, at PO price.</p>';
  }

  // =====================================================================
  // 4. Accounting periods
  // =====================================================================
  App.view('periods', {
    title: 'Accounting periods',
    render() {
      const ps = E.periods();
      const firstOpen = ps.find((p) => p.status === 'Open');
      const firstFuture = ps.find((p) => p.status === 'Future');
      let checklist = '';
      if (firstOpen) {
        const items = E.closeChecklist(firstOpen.period);
        const pend = E.S.journals.filter((j) => j.period === firstOpen.period && j.status === 'Pending Approval');
        const tone = (t) => (t.done ? 'good' : t.advisory ? 'warn' : t.task === 'Period closed' ? 'info' : 'bad');
        const tbl = App.table([
          { h: 'Task', f: (t) => esc(t.task) + (t.advisory ? ' <span class="muted small">(advisory)</span>' : '') },
          { h: 'Status', f: (t) => pill(t.done ? 'Done' : t.advisory ? 'Review' : t.task === 'Period closed' ? 'Open' : 'Not done', tone(t)) },
          { h: 'Detail', f: (t) => {
            const d = /^(JE|PR)-\d+$/.test(t.detail) ? App.link(t.detail.startsWith('JE') ? 'je' : 'payrun', t.detail) : esc(t.detail);
            return t.task === 'Journals approved' && pend.length ? `${d}: ${pend.map((j) => App.link('je', j.id)).join(', ')}` : d;
          } },
        ], items);
        const blockers = items.filter((t) => !t.done && !t.advisory && t.task !== 'Period closed').length;
        checklist = card(`Close checklist: ${esc(firstOpen.label)}`, tbl, blockers ? pill(`${blockers} open item${blockers > 1 ? 's' : ''}`, 'warn') : pill('Ready to close', 'good'))
          + '<p class="hint" style="margin:6px 0 16px">Only journals awaiting approval block a close in the system. The other tasks are the controller\'s review list.</p>';
      }
      const tbl = App.table([
        { h: 'Period', f: (p) => `<b>${esc(p.label)}</b>` },
        { h: 'Dates', f: (p) => `${fdate(p.period + '-01')} to ${fdate(U.periodEnd(p.period))}` },
        { h: 'Status', f: (p) => pill(p.status) },
        { h: 'Posted journals', num: true, f: (p) => App.num(p.posted) },
        { h: 'Pending approval', num: true, f: (p) => (p.pending ? `<span class="pill warn">${App.num(p.pending)}</span>` : '0') },
        { h: 'Depreciation', f: (p) => (E.S.depreciationRuns[p.period] ? App.link('je', E.S.depreciationRuns[p.period]) : '<span class="muted">None</span>') },
        { h: 'Actions', f: (p) => p.status === 'Open' ? App.btn('Close', 'fin-period-close', { p: p.period }, 'gl.close', 'sm')
          : p.status === 'Closed' ? App.btn('Reopen', 'fin-period-reopen', { p: p.period }, 'gl.close', 'sm')
          : firstFuture && p.period === firstFuture.period ? App.btn('Open', 'fin-period-open', { p: p.period }, 'gl.close', 'sm') : '' },
      ], ps, { rowCls: (p) => (p.status === 'Future' ? 'sub' : '') });
      return App.head('Financials', 'Accounting periods', 'FY2027 calendar. Transactions post only into open periods. Periods open and close in order, and a period cannot close while journals in it await approval.')
        + checklist + card('FY2027 periods', tbl);
    },
  });
  App.act('fin-period-close', (ds) => App.try(() => E.closePeriod(ds.p), `${U.periodLabel(ds.p)} closed. No further postings can be made to it.`));
  App.act('fin-period-reopen', (ds) => App.confirm('Reopen period', `Reopen ${esc(U.periodLabel(ds.p))}? Users will be able to post into it again until it is closed. The reopen is recorded in the audit trail.`, 'Reopen period', () => E.reopenPeriod(ds.p), `${U.periodLabel(ds.p)} reopened.`));
  App.act('fin-period-open', (ds) => App.try(() => E.openPeriod(ds.p), `${U.periodLabel(ds.p)} opened for posting.`));

  // =====================================================================
  // 5. Payables
  // =====================================================================
  App.view('payables', {
    title: 'Payables',
    render() {
      const invs = E.S.apInvoices;
      const today = E.S.today, horizon = U.addDays(today, 30);
      const validated = invs.filter((i) => i.status === 'Validated');
      const holds = invs.filter((i) => i.status === 'On Hold');
      const apMemos = E.S.creditMemos.filter((m) => m.side === 'AP');
      const due = validated.filter((i) => i.due <= horizon);
      const overdue = due.filter((i) => i.due < today);
      const paidNow = E.S.payments.filter((p) => U.periodOf(p.date) === curPeriod());
      const kpis = `<div class="kpis">
        ${App.kpi('Open payables', fmt(-E.balance('2000')), `GL 2000, ${validated.length} validated invoice${validated.length === 1 ? '' : 's'}`)}
        ${App.kpi('Invoices on hold', String(holds.length), holds.length ? `${fmt(U.sum(holds, (i) => i.total))} awaiting release` : 'No match exceptions')}
        ${App.kpi('Due in next 30 days', fmt(U.sum(due, (i) => E.openAmt(i))), `${due.length} invoice${due.length === 1 ? '' : 's'}${overdue.length ? `, ${overdue.length} already past due` : ''}`)}
        ${App.kpi('Paid this period', fmt(U.sum(paidNow, (p) => p.amount)), `${paidNow.length} payment${paidNow.length === 1 ? '' : 's'} in ${U.periodLabel(curPeriod())}`)}
      </div>`;
      const tab = App.tabOf('payables', 'inv');
      let body = '';
      if (tab === 'inv') {
        body = card('', App.table([
          { h: 'Invoice', f: (i) => App.link('apinv', i.id) },
          { h: 'Supplier', f: (i) => App.link('sup', i.supplierId, E.sup(i.supplierId)?.name) },
          { h: 'Supplier no.', f: (i) => `<span class="mono">${esc(i.number)}</span>` },
          { h: 'PO', f: (i) => App.link('po', i.poId) },
          { h: 'Date', f: (i) => fd(i.date) },
          { h: 'Due', f: (i) => fd(i.due) + (i.status === 'Validated' && i.due < today ? ' <span class="pill bad">Past due</span>' : '') },
          { h: 'Amount', num: true, f: (i) => fmt(i.total) + (E.isFx(i) ? `<div class="small muted">${fmtC(i.fxTotal, i.currency)}</div>` : '') },
          { h: 'Open', num: true, f: (i) => (i.status === 'Validated' ? fmt(E.openAmt(i)) : '') + (i.credited ? `<div class="small muted">credited ${fmt(i.credited)}</div>` : '') },
          { h: 'Status', f: (i) => pill(i.status) + (i.status === 'On Hold' && i.holds?.length ? `<div class="small muted" style="max-width:320px;white-space:normal">${esc(i.holds[0])}${i.holds.length > 1 ? ` (+${i.holds.length - 1} more)` : ''}</div>` : '') },
          { h: '', f: (i) => i.status === 'Validated' ? App.btn('Pay', 'ap-pay', { id: i.id }, 'ap.pay', 'sm') : i.status === 'On Hold' ? App.btn('Release', 'ap-release', { id: i.id }, 'ap.release', 'sm') : '' },
        ], invs.slice().sort(byNewest), { empty: 'No supplier invoices yet. Receive goods on a purchase order, then use Enter invoice to match the bill.' }));
      } else if (tab === 'cm') {
        body = card('', App.table([
          { h: 'Memo', f: (m) => App.link('cm', m.id) },
          { h: 'Date', f: (m) => fd(m.date) },
          { h: 'Supplier', f: (m) => App.link('sup', m.supplierId, E.sup(m.supplierId)?.name) },
          { h: 'Invoice', f: (m) => App.link('apinv', m.invoiceId) },
          { h: 'Reason', f: (m) => esc(m.reason) },
          { h: 'Journal', f: (m) => App.link('je', m.journal) },
          { h: 'Amount', num: true, f: (m) => fmt(m.amount) + (m.fxAmount != null ? `<div class="small muted">${fmtC(m.fxAmount, m.currency)}</div>` : '') },
        ], apMemos.slice().sort(byNewest), { empty: 'No supplier credit memos. Open a validated invoice and choose Credit memo.' }));
      } else if (tab === 'pay') {
        body = card('', App.table([
          { h: 'Payment', f: (p) => App.link('pay', p.id) },
          { h: 'Date', f: (p) => fd(p.date) },
          { h: 'Supplier', f: (p) => App.link('sup', p.supplierId, E.sup(p.supplierId)?.name) },
          { h: 'Method', f: (p) => esc(p.method) },
          { h: 'Invoices', f: (p) => p.invoices.map((id) => App.link('apinv', id)).join(', ') },
          { h: 'Journal', f: (p) => App.link('je', p.journal) },
          { h: 'Amount', num: true, f: (p) => fmt(p.amount) },
        ], E.S.payments.slice().sort(byNewest), { empty: 'No payments yet. Validated invoices can be paid with Pay due invoices.', foot: E.S.payments.length ? ['Total', '', '', '', '', '', fmt(U.sum(E.S.payments, (p) => p.amount))] : null }));
      } else {
        const rows = E.S.suppliers.map((s) => { const mine = invs.filter((i) => i.supplierId === s.id); return { s, open: U.sum(mine.filter((i) => i.status === 'Validated'), (i) => E.openAmt(i)), holds: mine.filter((i) => i.status === 'On Hold').length }; });
        body = `<div class="actions" style="margin-bottom:12px">${App.btn('New supplier', 'fin-sup-new', {}, 'supplier.edit', 'primary')}</div>` + card('', App.table([
          { h: 'Supplier', f: (r) => App.link('sup', r.s.id, r.s.name) },
          { h: 'ID', f: (r) => `<span class="mono">${esc(r.s.id)}</span>` },
          { h: 'Site', f: (r) => esc(r.s.site) || '<span class="muted">Not set</span>' },
          { h: 'Terms', f: (r) => `Net ${esc(r.s.terms)}` },
          { h: 'Currency', f: (r) => esc(r.s.currency || 'USD') },
          { h: 'On hold', num: true, f: (r) => (r.holds ? `<span class="pill bad">${r.holds}</span>` : '0') },
          { h: 'Open balance', num: true, f: (r) => fmt(r.open) },
        ], rows, { empty: 'No suppliers yet. Add one with New supplier.', foot: rows.length ? ['Total', '', '', '', '', '', fmt(U.sum(rows, (r) => r.open))] : null }));
      }
      return App.head('Financials', 'Payables', 'Supplier invoices are matched to the purchase order and receipt before they post to Accounts payable.',
        App.btn('Enter invoice', 'ap-enter', {}, 'ap.enter') + App.btn('Enter direct invoice', 'ap-direct', {}, 'ap.enter') + App.btn('Pay due invoices', 'ap-pay', {}, 'ap.pay', 'primary'))
        + kpis + App.tabs('payables', [['inv', `Invoices (${invs.length})`], ['cm', `Credit memos (${apMemos.length})`], ['pay', `Payments (${E.S.payments.length})`], ['sup', `Suppliers (${E.S.suppliers.length})`]]) + body;
    },
  });
  App.act('fin-sup-new', () => {
    App.drawer('New supplier', `${App.field('Supplier name', App.input('supName', '', 'text', 'placeholder="e.g. Northgate Metals Inc."'))}<div class="row">${App.field('Site', App.input('supSite', '', 'text', 'placeholder="City, region"'))}${App.field('Payment terms (days)', App.input('supTerms', '30', 'number', 'min="0" step="1"'))}${App.field('Currency', App.select('supCcy', E.S.currencies.map((c) => [c.code, `${c.code} ${c.name}`]), 'USD'), 'Direct invoices only; POs are in USD')}</div>${App.field('Remittance email', App.input('supEmail', '', 'email', 'placeholder="ap@supplier.example"'))}`, {
      submitLabel: 'Create supplier',
      onSubmit: (form) => E.addSupplier({ name: App.val(form, 'supName'), site: App.val(form, 'supSite'), terms: App.val(form, 'supTerms'), email: App.val(form, 'supEmail'), currency: App.val(form, 'supCcy') || 'USD' }),
      success: (s) => `Supplier ${s.name} created as ${s.id}.`,
    });
  });

  // =====================================================================
  // 6. Receivables
  // =====================================================================
  App.view('receivables', {
    title: 'Receivables',
    render() {
      const today = E.S.today;
      const invs = E.S.arInvoices;
      const isOpen = (i) => E.openAmt(i) > 0.004 && i.status !== 'Paid';
      const open = invs.filter(isOpen);
      const arMemos = E.S.creditMemos.filter((m) => m.side === 'AR');
      const isLate = (i) => isOpen(i) && U.daysBetween(i.due, today) > 0;
      const late = open.filter(isLate);
      const rcNow = E.S.receipts.filter((r) => U.periodOf(r.date) === curPeriod());
      const openAR = E.balance('1100');
      const since = U.addDays(today, -90);
      const sales90 = U.sum(invs.filter((i) => i.date > since && i.date <= today), (i) => i.total);
      const dso = sales90 > 0 ? Math.round(openAR / sales90 * 90) : 0;
      const kpis = `<div class="kpis">
        ${App.kpi('Open receivables', fmt(openAR), `GL 1100, ${open.length} open invoice${open.length === 1 ? '' : 's'}`)}
        ${App.kpi('Overdue', fmt(U.sum(late, (i) => E.openAmt(i))), late.length ? `${late.length} invoice${late.length === 1 ? '' : 's'} past due` : 'Nothing past due')}
        ${App.kpi('Collected this period', fmt(U.sum(rcNow, (r) => r.amount)), `${rcNow.length} receipt${rcNow.length === 1 ? '' : 's'} in ${U.periodLabel(curPeriod())}`)}
        ${App.kpi('DSO (approx.)', sales90 > 0 ? `${dso} days` : 'n/a', 'Open AR / last 90 days of billing x 90')}
      </div>`;
      const tab = App.tabOf('receivables', 'inv');
      let body = '';
      if (tab === 'inv') {
        body = card('', App.table([
          { h: 'Invoice', f: (i) => App.link('arinv', i.id) },
          { h: 'Customer', f: (i) => App.link('cust', i.customerId, E.cust(i.customerId)?.name) },
          { h: 'Source', f: (i) => (i.soId ? App.link('so', i.soId) : App.refLink(i.ref || '') ) },
          { h: 'Date', f: (i) => fd(i.date) },
          { h: 'Due', f: (i) => fd(i.due) + (isLate(i) ? ` <span class="small muted">${U.daysBetween(i.due, today)} days late</span>` : '') },
          { h: 'Amount', num: true, f: (i) => fmt(i.total) + (E.isFx(i) ? `<div class="small muted">${fmtC(i.fxTotal, i.currency)}</div>` : i.tax ? `<div class="small muted">incl. tax ${fmt(i.tax)}</div>` : '') },
          { h: 'Open', num: true, f: (i) => fmt(E.openAmt(i)) + (i.credited ? `<div class="small muted">credited ${fmt(i.credited)}</div>` : '') },
          { h: 'Status', f: (i) => pill(isLate(i) ? 'Overdue' : i.status) },
          { h: '', f: (i) => (isOpen(i) ? App.btn('Record receipt', 'ar-receipt', { id: i.id }, 'ar.receipt', 'sm') : '') },
        ], invs.slice().sort(byNewest), { empty: 'No customer invoices yet. Invoices are raised automatically when a sales order ships.' }));
      } else if (tab === 'aging') {
        const ag = E.arAging(today);
        const cols = [{ h: 'Customer', f: (r) => App.link('cust', r.customerId, r.name) },
          ...ag.buckets.map((b) => ({ h: b === 'Current' ? 'Current' : `${b} days`, num: true, f: (r) => (r[b] ? fmt(r[b]) : '<span class="muted">-</span>') })),
          { h: 'Total', num: true, f: (r) => `<b>${fmt(r.total)}</b>` }];
        const foot = ['Total', ...ag.buckets.map((b) => fmt(U.sum(ag.rows, (r) => r[b]))), fmt(U.sum(ag.rows, (r) => r.total))];
        body = `<p class="hint" style="margin:0 0 10px">Open balances by days past due as of ${fdate(today)}.</p>` + card('', App.table(cols, ag.rows.slice().sort((a, b) => b.total - a.total), { empty: 'No open receivables. Every customer invoice is paid.', foot: ag.rows.length ? foot : null }));
      } else if (tab === 'cm') {
        body = card('', App.table([
          { h: 'Memo', f: (m) => App.link('cm', m.id) },
          { h: 'Date', f: (m) => fd(m.date) },
          { h: 'Customer', f: (m) => App.link('cust', m.customerId, E.cust(m.customerId)?.name) },
          { h: 'Invoice', f: (m) => App.link('arinv', m.invoiceId) },
          { h: 'Reason', f: (m) => esc(m.reason) + (m.returns?.length ? ` <span class="pill info">Returned ${m.returns.map((r) => `${r.qty} ${esc(r.sku)}`).join(', ')}</span>` : '') },
          { h: 'Tax', num: true, f: (m) => fmt(m.tax) },
          { h: 'Amount', num: true, f: (m) => fmt(m.amount) + (m.fxAmount != null ? `<div class="small muted">${fmtC(m.fxAmount, m.currency)}</div>` : '') },
        ], arMemos.slice().sort(byNewest), { empty: 'No credit memos. Open an invoice and choose Credit memo.' }));
      } else if (tab === 'rc') {
        body = card('', App.table([
          { h: 'Receipt', f: (r) => `<span class="mono">${esc(r.id)}</span>` },
          { h: 'Date', f: (r) => fd(r.date) },
          { h: 'Customer', f: (r) => App.link('cust', r.customerId, E.cust(r.customerId)?.name) },
          { h: 'Invoice', f: (r) => App.link('arinv', r.invoiceId) },
          { h: 'Reference', f: (r) => esc(r.reference) || '<span class="muted">None</span>' },
          { h: 'Journal', f: (r) => App.link('je', r.journal) },
          { h: 'Amount', num: true, f: (r) => fmt(r.amount) + (r.fxAmount != null ? `<div class="small muted">${fmtC(r.fxAmount, r.currency)}, FX ${fmt(r.fxGainLoss)}</div>` : '') },
        ], E.S.receipts.slice().sort(byNewest), { empty: 'No receipts yet. Use Record receipt on an open invoice when a customer pays.', foot: E.S.receipts.length ? ['Total', '', '', '', '', '', fmt(U.sum(E.S.receipts, (r) => r.amount))] : null }));
      } else {
        const rows = E.S.customers.map((c) => { const o = E.openAR(c.id); return { c, open: o, avail: U.r2(c.creditLimit - o) }; });
        body = `<div class="actions" style="margin-bottom:12px">${App.btn('New customer', 'fin-cust-new', {}, 'customer.edit', 'primary')}</div>` + card('', App.table([
          { h: 'Customer', f: (r) => App.link('cust', r.c.id, r.c.name) },
          { h: 'Segment', f: (r) => esc(r.c.segment) || '<span class="muted">Not set</span>' },
          { h: 'Terms', f: (r) => `Net ${esc(r.c.terms)}` },
          { h: 'Tax / currency', f: (r) => `${esc(r.c.taxCode || 'None')} / ${esc(r.c.currency || 'USD')}` },
          { h: 'Credit limit', num: true, f: (r) => fmt(r.c.creditLimit) },
          { h: 'Open AR', num: true, f: (r) => fmt(r.open) },
          { h: 'Available credit', num: true, f: (r) => (r.avail < 0 ? `<span class="pill bad">${fmt(r.avail)}</span>` : fmt(r.avail)) },
        ], rows, { empty: 'No customers yet. Add one with New customer.', foot: rows.length ? ['Total', '', '', '', fmt(U.sum(rows, (r) => r.c.creditLimit)), fmt(U.sum(rows, (r) => r.open)), ''] : null }));
      }
      return App.head('Financials', 'Receivables', 'Customer invoices raised on shipment or entered manually, credit memos, collections and aging.', App.btn('New invoice', 'ar-new', {}, 'ar.receipt', 'primary'))
        + kpis + App.tabs('receivables', [['inv', `Invoices (${invs.length})`], ['cm', `Credit memos (${arMemos.length})`], ['aging', 'Aging'], ['rc', `Receipts (${E.S.receipts.length})`], ['cust', `Customers (${E.S.customers.length})`]]) + body;
    },
  });
  App.act('fin-cust-new', () => {
    App.drawer('New customer', `${App.field('Customer name', App.input('cuName', '', 'text', 'placeholder="e.g. Harbor Point Labs"'))}<div class="row">${App.field('Segment', App.select('cuSeg', ['Life sciences', 'Public utility', 'Food processing', 'Education', 'Industrial', 'Distributor']))}${App.field('Payment terms (days)', App.input('cuTerms', '30', 'number', 'min="0" step="1"'))}${App.field('Credit limit', App.input('cuLimit', '50000', 'number', 'min="0" step="1000"'))}</div><div class="row">${App.field('Tax code', App.select('cuTax', [['', 'No tax'], ...E.S.taxCodes.map((t) => [t.code, t.name])], 'MA'))}${App.field('Currency', App.select('cuCcy', E.S.currencies.map((c) => [c.code, `${c.code} ${c.name}`]), 'USD'), 'Manual invoices; sales orders bill in USD')}</div><p class="hint">New sales orders that push exposure (open AR plus booked orders) over the credit limit go on credit hold.</p>`, {
      submitLabel: 'Create customer',
      onSubmit: (form) => E.addCustomer({ name: App.val(form, 'cuName'), segment: App.val(form, 'cuSeg'), terms: App.val(form, 'cuTerms'), creditLimit: App.val(form, 'cuLimit'), taxCode: App.val(form, 'cuTax'), currency: App.val(form, 'cuCcy') || 'USD' }),
      success: (c) => `Customer ${c.name} created as ${c.id}.`,
    });
  });
})();
