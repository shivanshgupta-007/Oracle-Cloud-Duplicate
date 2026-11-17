/* Ledgerline Suite: views-assets.js
 * Fixed assets: register, depreciation runs and projection, roll-forward; asset detail
 * drawer with history and journals; add / approve / reject / transfer / retire / run depreciation.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, num = App.num, fdate = App.fdate, pill = App.pill;
  const today = () => E.S.today;
  const catName = (c) => E.assetCategory(c)?.name || c;
  const card = (title, inner, right = '') => `<div class="card">${title ? `<div class="card-h"><span>${title}</span>${right}</div>` : ''}${inner}</div>`;
  const filt = () => (App.ui.filter.assets = App.ui.filter.assets || {});
  const empName = (id) => E.emp(id)?.name || '';
  const statusPill = (a) => (a.status === 'Active' && E.assetNBV(a.id) - a.salvage <= 0.004 ? pill('Fully depreciated', 'accent') : pill(a.status, a.status === 'Retired' ? '' : undefined));
  const deprAvail = () => App.openPeriods().filter((p) => !E.S.depreciationRuns[p]);
  const h3 = (t) => `<h3 style="margin:0;font-size:14px">${t}</h3>`;

  // ---------- add asset ----------
  App.act('asset-add', () => {
    const S = E.S;
    const active = S.employees.filter((e) => e.status === 'Active');
    const cats = E.FA_CATEGORIES;
    const html = `<div class="row">${App.field('Asset description', App.input('faName', '', 'text', 'placeholder="e.g. Torque calibration rig"'))}${App.field('Asset tag', App.input('faTag', '', 'text', 'placeholder="Auto-assigned"'), 'Leave blank to assign the next tag')}</div>
      <div class="row">${App.field('Category', App.select('faCat', cats.map((c) => [c.code, `${c.name} (${c.life} months)`]), cats[0].code))}${App.field('Useful life (months)', App.input('faLife', cats[0].life, 'number', 'min="1" step="1"'))}${App.field('Capitalization date', App.input('faDate', today(), 'date'))}</div>
      <div class="row">${App.field('Cost', App.input('faCost', '', 'number', 'min="0" step="0.01"'))}${App.field('Salvage value', App.input('faSalvage', '0', 'number', 'min="0" step="0.01"'), 'Optional; depreciation stops at cost less salvage')}</div>
      <div class="row">${App.field('Department', App.select('faDept', S.departments, 'Operations'))}${App.field('Location', App.input('faLoc', 'Boston, MA'))}${App.field('Custodian', App.select('faCust', [['', 'No custodian']].concat(active.map((e) => [e.id, e.name]))))}</div>
      <div class="row">${App.field('Paid by', App.select('faMethod', [['cash', 'Cash (bank transfer)'], ['invoice', 'Supplier invoice']], 'cash'))}${App.field('Supplier', App.select('faSup', S.suppliers.map((s) => [s.id, s.name])))}${App.field('Supplier invoice no.', App.input('faInv', '', 'text', 'placeholder="e.g. VAL-26-1201"'))}</div>
      <div class="callout" id="faInfo"></div>`;
    App.drawer('Add asset', html, {
      submitLabel: 'Add asset', wide: true,
      oninput: (f) => {
        const c = E.assetCategory(App.val(f, 'faCat'));
        if (f.dataset.cat !== c.code) { if (f.dataset.cat) App.$('#faLife', f).value = c.life; f.dataset.cat = c.code; }
        const inv = App.val(f, 'faMethod') === 'invoice';
        App.$('#faSup', f).disabled = !inv; App.$('#faInv', f).disabled = !inv;
        const cost = +App.val(f, 'faCost') || 0, salv = +App.val(f, 'faSalvage') || 0, life = +App.val(f, 'faLife') || 0;
        const m = life > 0 ? U.r2(Math.max(0, cost - salv) / life) : 0;
        const over = cost > E.FA_APPROVAL_LIMIT;
        const box = App.$('#faInfo', f); box.className = 'callout' + (over ? ' warn' : '');
        box.innerHTML = `Monthly depreciation <b class="num">${fmt(m)}</b> over ${num(life)} months, starting the capitalization month (full-month convention). `
          + (over ? `Over ${fmt(E.FA_APPROVAL_LIMIT)}: the addition goes to a Controller for approval and nothing posts until it is approved.`
            : inv ? 'Posts a supplier invoice: Dr 1500 Equipment, Cr 2000 Accounts payable.' : 'Posts Dr 1500 Equipment, Cr 1000 Cash.');
      },
      onSubmit: (f) => E.addAsset({ name: App.val(f, 'faName'), tag: App.val(f, 'faTag'), category: App.val(f, 'faCat'), life: +App.val(f, 'faLife'), date: App.val(f, 'faDate'), cost: App.val(f, 'faCost'), salvage: App.val(f, 'faSalvage') || 0,
        dept: App.val(f, 'faDept'), location: App.val(f, 'faLoc'), custodian: App.val(f, 'faCust'), method: App.val(f, 'faMethod'), supplierId: App.val(f, 'faSup'), invoiceNumber: App.val(f, 'faInv') }),
      success: (a) => (a.status === 'Pending Approval' ? `${a.id} submitted for Controller approval (${fmt(a.cost)}).` : `${a.id} capitalized, ${fmt(a.cost)}.`),
    });
  });

  // ---------- approve / reject (shared with the Approvals page via the detail drawer) ----------
  App.act('asset-approve', (ds) => App.try(() => { const a = E.asset(ds.id); return E.approveAsset(ds.id, a && App.openPeriods().includes(U.periodOf(a.date)) ? null : today()); }, `${ds.id} approved and capitalized.`));
  App.act('asset-reject', (ds) => App.try(() => E.rejectAsset(ds.id, 'Rejected by approver'), `${ds.id} rejected.`));

  // ---------- run depreciation ----------
  App.act('asset-depr', () => {
    const avail = deprAvail();
    if (!avail.length) { App.toast('Depreciation has already been posted for every open period.', 'bad'); return; }
    App.drawer('Run depreciation', `${App.field('Period', App.select('fadPeriod', avail.map((p) => [p, U.periodLabel(p)]), avail[0]))}<div id="fadInfo"></div>
      <p class="hint">Straight-line by asset, full-month convention. Posts one journal dated the last day of the period: Dr 6300 Depreciation, Cr 1510 Accumulated depreciation, one line pair per category.</p>`, {
      submitLabel: 'Post depreciation',
      oninput: (f) => {
        const p = App.val(f, 'fadPeriod'); const pv = E.depreciationPreview(p);
        App.$('#fadInfo', f).innerHTML = `<div class="callout" style="margin-bottom:8px">${pv.lines.length} asset(s), total <b class="num">${fmt(pv.total)}</b>, dated ${fdate(U.periodEnd(p))}.</div>`
          + App.table([{ h: 'Asset', f: (l) => `${esc(l.assetId)} ${esc(E.asset(l.assetId).name)}` }, { h: 'Months', num: true, f: (l) => num(l.months) }, { h: 'Charge', num: true, f: (l) => fmt(l.amount) }], pv.lines, { empty: 'Nothing to depreciate.' });
      },
      onSubmit: (f) => E.runDepreciation(App.val(f, 'fadPeriod')),
      success: (j) => `Depreciation for ${U.periodLabel(j.period)} posted as ${j.id}, ${fmt(j.total)}.`,
    });
  });

  // ---------- transfer ----------
  App.act('asset-transfer', (ds) => {
    const a = E.asset(ds.id); const S = E.S;
    App.drawer(`Transfer ${a.id}`, `<div class="row">${App.field('Transfer date', App.input('ftDate', today(), 'date'))}${App.field('Department', App.select('ftDept', S.departments, a.dept))}</div>
      <div class="row">${App.field('Location', App.input('ftLoc', a.location))}${App.field('Custodian', App.select('ftCust', [['', 'No custodian']].concat(S.employees.filter((e) => e.status === 'Active').map((e) => [e.id, e.name])), a.custodian))}</div>
      <div class="callout">Transfers change who holds the asset and where. They do not post to the ledger.</div>`,
    { submitLabel: 'Transfer', onSubmit: (f) => E.transferAsset({ id: a.id, date: App.val(f, 'ftDate'), dept: App.val(f, 'ftDept'), location: App.val(f, 'ftLoc'), custodian: App.val(f, 'ftCust') }), success: `${a.id} transferred.` });
  });

  // ---------- retire / dispose ----------
  App.act('asset-retire', (ds) => {
    const a = E.asset(ds.id);
    App.drawer(`Retire ${a.id}`, `<p>${esc(a.name)}: cost <b class="num">${fmt(a.cost)}</b>, accumulated depreciation <b class="num">${fmt(a.accumulated)}</b>, net book value <b class="num">${fmt(E.assetNBV(a.id))}</b>.</p>
      <div class="row">${App.field('Disposal date', App.input('frDate', today(), 'date'))}${App.field('Cash proceeds', App.input('frProc', '0', 'number', 'min="0" step="0.01"'), 'Enter 0 for a scrapped asset')}</div>
      ${App.field('Reason', App.input('frWhy', '', 'text', 'placeholder="e.g. Sold, replaced by newer model"'))}<div id="frInfo"></div>`, {
      submitLabel: 'Retire asset',
      oninput: (f) => {
        const box = App.$('#frInfo', f);
        try {
          const x = E.disposalPreview(a.id, App.val(f, 'frDate'), App.val(f, 'frProc'));
          box.innerHTML = `<div class="callout ${x.gainLoss < 0 ? 'warn' : 'good'}">${x.catchUp > 0 ? `Depreciation to the disposal month (${x.catchUpMonths} month(s), full-month convention): <b class="num">${fmt(x.catchUp)}</b>.<br>` : ''}Accumulated at disposal <b class="num">${fmt(x.accumulated)}</b>, net book value <b class="num">${fmt(x.nbv)}</b>.<br>${x.gainLoss >= 0 ? 'Gain' : 'Loss'} on disposal <b class="num">${fmt(Math.abs(x.gainLoss))}</b> (${x.gainLoss >= 0 ? 'Cr 4910 Gain on disposal' : 'Dr 6910 Loss on disposal'}).</div>`;
        } catch (err) { box.innerHTML = `<div class="callout bad">${esc(err.message)}</div>`; }
      },
      onSubmit: (f) => E.retireAsset({ id: a.id, date: App.val(f, 'frDate'), proceeds: App.val(f, 'frProc') || 0, reason: App.val(f, 'frWhy') }),
      success: (r) => `${r.id} retired. ${r.retired.gainLoss >= 0 ? 'Gain' : 'Loss'} ${fmt(Math.abs(r.retired.gainLoss))}.`,
    });
  });

  // ---------- detail drawer ----------
  App.detail('asset', (id) => {
    const a = E.asset(id); if (!a) return null;
    const flow = App.stepFlow(['Submitted', 'Approved', 'In service', 'Retired'], { 'Pending Approval': 1, Rejected: 1, Active: 2, Retired: 4 }[a.status] ?? 0);
    const lines = E.S.depreciationLines.filter((l) => l.assetId === id).slice().sort((x, y) => y.period.localeCompare(x.period));
    const fully = a.status === 'Active' && E.assetNBV(id) - a.salvage <= 0.004;
    const html = flow + App.dl([
      ['Status', statusPill(a)], ['Tag', `<span class="mono">${esc(a.tag)}</span>`], ['Category', esc(catName(a.category))], ['Capitalized', fdate(a.date)],
      ['Cost', `<span class="num">${fmt(a.cost)}</span>`], ['Salvage value', `<span class="num">${fmt(a.salvage)}</span>`], ['Useful life', `${num(a.life)} months`],
      ['Monthly charge', `<span class="num">${fmt(fully || a.status !== 'Active' ? 0 : E.assetMonthly(id))}</span>`],
      ['Accumulated depreciation', `<span class="num">${fmt(a.accumulated)}</span>`], ['Net book value', `<span class="num">${fmt(E.assetNBV(id))}</span>`],
      ['Depreciated through', a.deprThrough && a.status !== 'Pending Approval' ? esc(U.periodLabel(a.deprThrough)) : '<span class="muted">Not started</span>'],
      ['Department', esc(a.dept || '')], ['Location', esc(a.location || '')], ['Custodian', a.custodian ? App.link('emp', a.custodian, empName(a.custodian)) : '<span class="muted">None</span>'],
      ['Acquired by', a.method === 'opening' ? 'Opening balance (migrated)' : a.method === 'cash' ? 'Cash purchase' : `Supplier invoice ${esc(a.invoiceNumber)}`],
      a.supplierId && ['Supplier', App.link('sup', a.supplierId, E.sup(a.supplierId)?.name)], a.invoiceId && ['Payables invoice', App.link('apinv', a.invoiceId)],
      a.journal && ['Acquisition journal', App.link('je', a.journal)], ['Entered by', esc(a.createdBy)], a.approvedBy && ['Approved by', esc(a.approvedBy)],
      a.retired && ['Disposal', `${fdate(a.retired.date)}, proceeds <span class="num">${fmt(a.retired.proceeds)}</span>, ${a.retired.gainLoss >= 0 ? 'gain' : 'loss'} <span class="num">${fmt(Math.abs(a.retired.gainLoss))}</span>`],
      a.rejectReason && ['Rejection reason', esc(a.rejectReason)],
    ])
      + (a.status === 'Pending Approval' ? `<div class="callout warn">This addition is over ${fmt(E.FA_APPROVAL_LIMIT)} and needs Controller approval. Nothing has posted to the ledger yet.</div>` : '')
      + h3('History') + App.table([{ h: 'Date', f: (x) => fdate(x.date) }, { h: 'Event', f: (x) => esc(x.type) }, { h: 'Detail', f: (x) => esc(x.detail) }, { h: 'By', f: (x) => esc(x.by || '') }, { h: 'Journal', f: (x) => (x.journal ? App.link('je', x.journal) : '') }], (a.history || []).slice().reverse(), { empty: 'No events.' })
      + h3('Depreciation history') + App.table([{ h: 'Period', f: (l) => esc(U.periodLabel(l.period)) }, { h: 'Type', f: (l) => esc(l.kind || 'Monthly') }, { h: 'Months', num: true, f: (l) => num(l.months) }, { h: 'Amount', num: true, f: (l) => fmt(l.amount) }, { h: 'Journal', f: (l) => App.link('je', l.journal) }], lines,
        { empty: a.openingAccum ? `Only the opening balance of ${fmt(a.openingAccum)} so far.` : 'No depreciation yet.', foot: lines.length ? ['Total', '', '', fmt(U.sum(lines, (l) => l.amount)), ''] : null })
      + h3('Accounting') + App.jeList(E.assetJournals(id));
    let buttons = '';
    if (a.status === 'Pending Approval') {
      buttons = a.createdBy === E.S.user && E.S.role !== 'Administrator'
        ? '<span class="muted small">You entered this addition, so another approver must review it.</span>'
        : App.btn('Reject', 'asset-reject', { id }, 'fa.approve', 'danger') + App.btn('Approve and capitalize', 'asset-approve', { id }, 'fa.approve', 'primary');
    } else if (a.status === 'Active') buttons = App.btn('Transfer', 'asset-transfer', { id }, 'fa.edit') + App.btn('Retire or dispose', 'asset-retire', { id }, 'fa.edit', 'danger');
    return { title: `${a.id} ${a.name}`, html, buttons };
  });
  App.refKind('FA-', 'asset');
  App.navCount('assets', () => E.S.assets.filter((a) => a.status === 'Pending Approval').length);

  // ---------- tabs ----------
  function registerTab() {
    const reg = E.assetRegister();
    const byId = (id) => E.asset(id);
    const table = App.table([
      { h: 'Asset', f: (r) => `${App.link('asset', r.id)}<div class="small">${esc(r.name)}</div><div class="small muted mono">${esc(r.tag)}</div>` },
      { h: 'Category', f: (r) => `${esc(catName(r.category))}<div class="small muted">${esc(r.dept)}${byId(r.id).custodian ? ', ' + esc(empName(byId(r.id).custodian)) : ''}</div>` },
      { h: 'In service', f: (r) => `<span style="white-space:nowrap">${fdate(r.date)}</span>` },
      { h: 'Cost', num: true, f: (r) => fmt(r.cost) },
      { h: 'Accumulated', num: true, f: (r) => fmt(r.accumulated) },
      { h: 'Net book value', num: true, f: (r) => fmt(r.nbv) },
      { h: 'Monthly', num: true, f: (r) => (r.fully ? pill('Fully depreciated', 'accent') : fmt(r.monthly)) },
      { h: 'Life left', num: true, f: (r) => `${num(r.remainingLife)} mo` },
    ], reg.rows, { empty: 'No assets in the book. Use Add asset.', foot: ['Total', `${reg.rows.length} assets`, '', fmt(reg.totals.cost), fmt(reg.totals.accumulated), fmt(reg.totals.nbv), fmt(reg.totals.monthly), ''] });
    const pend = E.S.assets.filter((a) => a.status === 'Pending Approval');
    const other = E.S.assets.filter((a) => a.status === 'Retired' || a.status === 'Rejected');
    const pendT = pend.length ? card('Pending approval', App.table([
      { h: 'Asset', f: (a) => `${App.link('asset', a.id)}<div class="small">${esc(a.name)}</div>` }, { h: 'Date', f: (a) => fdate(a.date) }, { h: 'Cost', num: true, f: (a) => fmt(a.cost) },
      { h: '', f: (a) => `<div class="actions">${App.btn('View', 'open', { kind: 'asset', id: a.id }, null, 'sm')}${a.createdBy === E.S.user && E.S.role !== 'Administrator' ? '' : App.btn('Approve', 'asset-approve', { id: a.id }, 'fa.approve', 'sm primary')}</div>` },
    ], pend), `<span class="pill warn">${pend.length}</span>`) : '';
    const otherT = other.length ? card('Retired and rejected', App.table([
      { h: 'Asset', f: (a) => `${App.link('asset', a.id)}<div class="small">${esc(a.name)}</div>` }, { h: 'Status', f: (a) => pill(a.status, a.status === 'Retired' ? '' : undefined) },
      { h: 'Date', f: (a) => fdate(a.retired?.date || a.date) }, { h: 'Cost', num: true, f: (a) => fmt(a.cost) },
      { h: 'Proceeds', num: true, f: (a) => (a.retired ? fmt(a.retired.proceeds) : '') }, { h: 'Gain / loss', num: true, f: (a) => (a.retired ? fmt(a.retired.gainLoss) : '') },
    ], other)) : '';
    return `<div class="stack">${pendT}${card('Asset register', table)}${otherT}</div>`;
  }
  function deprTab() {
    const S = E.S;
    const runs = Object.entries(S.depreciationRuns).sort((a, b) => b[0].localeCompare(a[0])).map(([p, jid]) => ({ p, j: E.je(jid), n: S.depreciationLines.filter((l) => l.journal === jid).length }));
    const runT = App.table([
      { h: 'Period', f: (r) => esc(U.periodLabel(r.p)) }, { h: 'Journal', f: (r) => App.link('je', r.j?.id) }, { h: 'Assets', num: true, f: (r) => num(r.n) },
      { h: 'Amount', num: true, f: (r) => fmt(r.j?.total) }, { h: 'Period status', f: (r) => pill(S.periods[r.p] || '') },
    ], runs, { empty: 'No depreciation runs yet.' });
    const pr = E.depreciationProjection();
    const cols = [{ h: 'Category', f: (r) => esc(r.name) }].concat(pr.periods.map((p, i) => ({ h: esc(U.periodLabel(p)), num: true, f: (r) => App.fmt0(r.amounts[i]) }))).concat([{ h: 'Total', num: true, f: (r) => App.fmt0(r.total) }]);
    const projT = App.table(cols, pr.byCategory, { empty: 'Nothing left to depreciate.', foot: ['Total'].concat(pr.totals.map((t) => App.fmt0(t))).concat([App.fmt0(pr.total)]) });
    return `<div class="stack">${card('Depreciation runs', runT, App.btn('Run depreciation', 'asset-depr', {}, 'gl.depr', 'sm'))}
      ${card(`Projection, next 12 months from ${esc(U.periodLabel(pr.periods[0]))}`, `<p class="small muted" style="margin:10px 16px">Assets in the book today, straight-line, full-month convention. Pending additions are excluded until approved; assets caught up for missed months show the extra months in the first period.</p>${projT}`)}</div>`;
  }
  function rollTab() {
    const ps = Object.keys(E.S.periods).sort();
    const f = filt();
    const from = f.from || E.FY_START, to = f.to || U.periodOf(today());
    const sel = (key, label, v) => `<label class="field" style="min-width:150px"><span>${label}</span><select id="fa-rf-${key}" data-fa-filter="${key}">${ps.map((p) => `<option value="${p}" ${p === v ? 'selected' : ''}>${esc(U.periodLabel(p))}</option>`).join('')}</select></label>`;
    let body;
    try {
      const rf = E.rollForward(from, to);
      const row = (label, v, link) => ({ label, v, link });
      const t = (rows) => App.table([{ h: '', f: (r) => r.label }, { h: 'Amount', num: true, f: (r) => (r.bold ? `<b>${fmt(r.v)}</b>` : fmt(r.v)) }], rows);
      const costRows = [row(`Opening cost, start of ${U.periodLabel(from)}`, rf.cost.opening), row(`Additions (${rf.added.length})`, rf.cost.additions), row(`Disposals (${rf.disposed.length})`, -rf.cost.disposals), { ...row(`Closing cost, end of ${U.periodLabel(to)}`, rf.cost.closing), bold: true }, row('GL 1500 at end of period', rf.gl.cost)];
      const accRows = [row('Opening accumulated depreciation', rf.accum.opening), row('Depreciation charged', rf.accum.depreciation), row('Disposals', -rf.accum.disposals), { ...row('Closing accumulated depreciation', rf.accum.closing), bold: true }, row('GL 1510 at end of period (credit)', rf.gl.accum)];
      const ok = Math.abs(rf.cost.closing - rf.gl.cost) < 0.05 && Math.abs(rf.accum.closing - rf.gl.accum) < 0.05;
      const ids = (list) => list.length ? list.map((id) => App.link('asset', id)).join(' ') : '<span class="muted">None</span>';
      body = `<div class="callout ${ok ? 'good' : 'warn'}" style="margin-bottom:16px">${ok ? 'Closing balances agree with the general ledger.' : 'Closing balances differ from the general ledger. Check for manual journals to 1500 or 1510.'} Net book value ${fmt(rf.nbv.opening)} to ${fmt(rf.nbv.closing)}.</div>
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">${card('Cost', t(costRows))}${card('Accumulated depreciation', t(accRows))}</div>
        <div class="card pad" style="margin-top:16px"><div class="small muted">Additions</div><div>${ids(rf.added)}</div><div class="small muted" style="margin-top:8px">Disposals</div><div>${ids(rf.disposed)}</div></div>`;
    } catch (err) { body = `<div class="callout warn">${esc(err.message)}</div>`; }
    return `<div class="row" style="margin-bottom:16px;max-width:420px">${sel('from', 'From period', from)}${sel('to', 'To period', to)}</div>${body}`;
  }

  App.view('assets', {
    title: 'Fixed assets', group: 'Financials',
    render() {
      const reg = E.assetRegister();
      const pend = E.S.assets.filter((a) => a.status === 'Pending Approval');
      const next = deprAvail()[0];
      const head = App.head('Financials', 'Fixed assets', `Straight-line monthly depreciation with a full-month convention. Additions over ${fmt(E.FA_APPROVAL_LIMIT)} need Controller approval before they post. The register reconciles to GL 1500 and 1510.`,
        App.btn('Run depreciation', 'asset-depr', {}, 'gl.depr') + App.btn('Add asset', 'asset-add', {}, 'fa.edit', 'primary'));
      const kpis = `<div class="kpis">${App.kpi('Cost in service', fmt(reg.totals.cost), `${reg.rows.length} assets`)}${App.kpi('Net book value', fmt(reg.totals.nbv), `${fmt(reg.totals.accumulated)} accumulated`)}${App.kpi('Monthly depreciation', fmt(reg.totals.monthly), next ? `Next run ${U.periodLabel(next)}` : 'All open periods run')}${App.kpi('Pending approval', num(pend.length), fmt(U.sum(pend, (a) => a.cost)))}</div>`;
      const tab = App.tabOf('assets', 'register');
      const tabs = App.tabs('assets', [['register', 'Register'], ['depr', 'Depreciation'], ['roll', 'Roll-forward']]);
      const body = tab === 'depr' ? deprTab() : tab === 'roll' ? rollTab() : registerTab();
      return head + kpis + tabs + body;
    },
    after(root) {
      App.$$('[data-fa-filter]', root).forEach((el) => el.addEventListener('change', () => { filt()[el.dataset.faFilter] = el.value; App.render(); }));
    },
  });
})();
