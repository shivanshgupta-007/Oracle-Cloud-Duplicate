/* Ledgerline Suite: views-mfg.js
 * Supply chain screens for manufacturing (work orders, bills of material with cost
 * roll-up), supply planning (MRP-lite suggestions) and cycle counting.
 * Rules live in js/ext-mfg.js; every mutation runs inside a drawer or App.try so a
 * failure rolls back and a success saves and re-renders.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, num = App.num, fdate = App.fdate, pill = App.pill;
  const today = () => E.S.today;
  const pct = (n) => (isFinite(n) ? (n * 100).toFixed(1) + '%' : '-');
  const WO_TONE = { Planned: '', Released: 'info', 'In progress': 'warn', Completed: 'accent', Closed: 'good', Cancelled: '' };
  const woPill = (s) => pill(s, WO_TONE[s]);
  const CC_TONE = { Open: 'info', Counted: 'warn', Posted: 'good', Cancelled: '' };
  const ccPill = (s) => pill(s === 'Counted' ? 'Awaiting posting' : s, CC_TONE[s]);
  const itemName = (sku) => esc(E.item(sku)?.name || '');
  const h3 = (t) => `<h3 style="margin:0;font-size:14px">${t}</h3>`;
  const makeItems = () => E.S.items.filter((i) => E.bom(i.sku));

  // ---------- shared pieces ----------
  function rollupTable(sku, c) {
    c = c || E.bomCost(sku);
    return App.table([
      { h: 'Component', f: (x) => x.sku === '_l' ? 'Labor' : x.sku === '_o' ? 'Overhead' : `${App.link('item', x.sku)} ${itemName(x.sku)}` },
      { h: 'Qty per', num: true, f: (x) => x.qtyLabel ?? num(x.qty) },
      { h: 'Unit cost', num: true, f: (x) => x.rate ?? fmt(x.unitCost) },
      { h: 'Extended', num: true, f: (x) => fmt(x.ext) },
    ], [...c.components, { sku: '_l', qtyLabel: `${E.bom(sku).laborHours} h`, rate: fmt(E.bom(sku).laborRate) + '/h', ext: c.labor }, { sku: '_o', qtyLabel: '1', rate: fmt(c.overhead), ext: c.overhead }],
    { foot: ['Standard cost per unit', '', '', fmt(c.total)] });
  }
  function woActions(w, small = true) {
    const cls = small ? 'sm' : '';
    const b = [];
    if (w.status === 'Planned') b.push(App.btn('Release', 'wo-release', { id: w.id }, 'mfg.edit', cls + ' primary'), App.btn('Cancel', 'wo-cancel', { id: w.id }, 'mfg.edit', cls + ' danger'));
    if (['Released', 'In progress'].includes(w.status) && w.components.some((c) => c.issued < c.required)) b.push(App.btn('Issue components', 'wo-issue', { id: w.id }, 'mfg.edit', cls + (w.status === 'Released' ? ' primary' : '')));
    if (['Released', 'In progress'].includes(w.status) && E.woRemaining(w) > 0) b.push(App.btn('Report completion', 'wo-complete', { id: w.id }, 'mfg.edit', cls + (w.status === 'In progress' ? ' primary' : '')));
    if (w.status === 'Released' && !w.issuedCost) b.push(App.btn('Cancel', 'wo-cancel', { id: w.id }, 'mfg.edit', cls + ' danger'));
    if (w.status === 'Completed') b.push(App.btn('Close', 'wo-close', { id: w.id }, 'mfg.edit', cls + ' primary'));
    if (w.status === 'In progress' && w.completed > 0 && !small) b.push(App.btn('Short close', 'wo-close', { id: w.id }, 'mfg.edit', 'danger'));
    return b.join('');
  }

  // ---------- detail panels ----------
  App.detail('wo', (id) => {
    const w = E.wo(id); if (!w) return null;
    const step = w.status === 'Cancelled' ? -1 : E.MFG.WO_STEPS.indexOf(w.status);
    const wip = E.woWip(w);
    const html = App.stepFlow(E.MFG.WO_STEPS, step)
      + App.dl([['Status', woPill(w.status)], ['Assembly', `${App.link('item', w.sku)} ${itemName(w.sku)}`], ['Quantity', `${num(w.completed)} of ${num(w.qty)} complete`], ['Start', fdate(w.start)], ['Due', fdate(w.due)],
        w.released && ['Released', fdate(w.released)], w.closedDate && ['Closed', fdate(w.closedDate) + (w.shortClosed ? ' (short close)' : '')], ['Bill of material', App.link('bom', w.sku, 'View BOM')], w.note && ['Note', esc(w.note)]])
      + h3('Components')
      + App.table([
        { h: 'Component', f: (c) => `${App.link('item', c.sku)} ${itemName(c.sku)}` },
        { h: 'Per unit', num: true, f: (c) => num(c.per) },
        { h: 'Required', num: true, f: (c) => num(c.required) },
        { h: 'Issued', num: true, f: (c) => num(c.issued) },
        { h: 'On hand', num: true, f: (c) => num(E.item(c.sku).onHand) },
        { h: 'Issued value', num: true, f: (c) => fmt(c.issuedValue) },
        { h: '', f: (c) => c.issued >= c.required ? pill('Issued', 'good') : E.item(c.sku).onHand >= c.required - c.issued ? pill('Available', 'info') : pill(`Short ${num(U.r2(c.required - c.issued - E.item(c.sku).onHand))}`, 'bad') },
      ], w.components)
      + h3('Costs')
      + App.dl([['Material issued', `<span class="num">${fmt(w.issuedCost)}</span>`], ['Labor and overhead absorbed', `<span class="num">${fmt(w.absorbed)}</span>`], ['Moved to finished goods', `<span class="num">${fmt(w.relieved)}</span>`], ['Production variance', `<span class="num">${fmt(w.variance || 0)}</span>`], ['Work in process now', `<span class="num"><b>${fmt(wip)}</b></span>`],
        ['Conversion rate', `${w.laborHours} h x ${fmt(w.laborRate)} + ${fmt(w.overheadPerUnit)} overhead per unit`]])
      + (w.completions.length ? h3('Completions') + App.table([{ h: 'Date', f: (x) => fdate(x.date) }, { h: 'Qty', num: true, f: (x) => num(x.qty) }, { h: 'Material', num: true, f: (x) => fmt(x.material) }, { h: 'Labor + overhead', num: true, f: (x) => fmt(U.r2(x.labor + x.overhead)) }, { h: 'Unit cost', num: true, f: (x) => fmt(x.unitCost) }, { h: 'Value', num: true, f: (x) => fmt(x.value) }], w.completions) : '')
      + h3('Accounting') + App.jeList(E.S.journals.filter((j) => j.ref === id));
    return { title: `Work order ${w.id}`, html, buttons: woActions(w, false) };
  });
  App.detail('bom', (sku) => {
    const it = E.item(sku), b = E.bom(sku); if (!it || !b) return null;
    const c = E.bomCost(sku);
    const used = E.S.wos.filter((w) => w.sku === sku).slice().reverse();
    return { title: `Bill of material ${sku}`, html: App.dl([['Assembly', `${App.link('item', sku)} ${itemName(sku)}`], ['On hand', num(it.onHand)], ['Average cost', `<span class="num">${fmt(it.avgCost)}</span>`], ['Standard (current roll-up)', `<span class="num">${fmt(c.total)}</span>`], ['List price', `<span class="num">${fmt(it.price)}</span>`], ['Margin at standard', pct((it.price - c.total) / it.price)]])
      + rollupTable(sku, c) + h3('Work orders') + App.table([{ h: 'Work order', f: (w) => App.link('wo', w.id) }, { h: 'Start', f: (w) => fdate(w.start) }, { h: 'Qty', num: true, f: (w) => `${num(w.completed)} / ${num(w.qty)}` }, { h: 'Status', f: (w) => woPill(w.status) }], used, { empty: 'No work orders for this assembly yet.' }),
      buttons: App.btn('Edit bill', 'bom-edit', { sku }, 'mfg.edit') + App.btn('New work order', 'wo-new', { sku }, 'mfg.edit', 'primary') };
  });
  App.detail('count', (id) => {
    const c = E.count(id); if (!c) return null;
    const rows = c.lines.map((l) => ({ l, v: E.countVariance(l) }));
    return { title: `Cycle count ${c.id}`, html: App.stepFlow(['Open', 'Counted', 'Posted'], c.status === 'Open' ? 0 : c.status === 'Counted' ? 1 : c.status === 'Posted' ? 3 : -1)
      + App.dl([['Status', ccPill(c.status)], ['Count date', fdate(c.date)], ['Created by', esc(c.createdBy)], c.postedDate && ['Posted', `${fdate(c.postedDate)} by ${esc(c.postedBy)}`], c.status === 'Posted' && ['Net adjustment', `<span class="num">${fmt(c.netValue)}</span>`]])
      + App.table([
        { h: 'Item', f: (r) => `${App.link('item', r.l.sku)} ${itemName(r.l.sku)}` },
        { h: 'Class', f: (r) => esc(r.l.cls) },
        { h: 'System qty', num: true, f: (r) => num(r.l.systemQty) },
        { h: 'Counted', num: true, f: (r) => (r.l.counted == null ? '<span class="muted">Not counted</span>' : num(r.l.counted)) },
        { h: 'Variance qty', num: true, f: (r) => (r.l.counted == null ? '' : (r.v.qty > 0 ? '+' : '') + num(r.v.qty)) },
        { h: 'Variance value', num: true, f: (r) => (r.l.counted == null ? '' : fmt(r.l.adjValue ?? r.v.value)) },
        { h: 'Journal', f: (r) => (r.l.journal ? App.link('je', r.l.journal) : '') },
      ], rows, { foot: ['Total', '', '', '', '', fmt(U.sum(rows, (r) => r.l.adjValue ?? r.v.value)), ''] }),
      buttons: ccButtons(c, false) };
  });
  function ccButtons(c, small = true) {
    const cls = small ? 'sm' : '';
    if (!['Open', 'Counted'].includes(c.status)) return '';
    return App.btn('Enter counts', 'cc-enter', { id: c.id }, 'inv.adjust', cls + (c.status === 'Open' ? ' primary' : ''))
      + (c.status === 'Counted' ? App.btn('Post adjustments', 'cc-post', { id: c.id }, 'inv.adjust', cls + ' primary') : '')
      + (small ? '' : App.btn('Cancel count', 'cc-cancel', { id: c.id }, 'inv.adjust', 'danger'));
  }
  App.refKind('WO-', 'wo');
  App.refKind('CC-', 'count');

  // ---------- work order drawers ----------
  App.act('wo-new', (ds) => {
    const list = makeItems(); if (!list.length) { App.toast('Create a bill of material first.', 'bad'); return; }
    const sku = ds.sku || list[0].sku;
    App.drawer('New work order', `<div class="row">${App.field('Assembly', App.select('woSku', list.map((i) => [i.sku, `${i.sku} ${i.name}`]), sku))}${App.field('Quantity', App.input('woQty', ds.qty || '10', 'number', 'step="1" min="1"'))}</div>
      <div class="row">${App.field('Start date', App.input('woStart', today(), 'date'))}${App.field('Due date', App.input('woDue', U.addDays(today(), 14), 'date'))}</div>${App.field('Note', App.input('woNote', ''))}<div id="woInfo"></div>`, {
      submitLabel: 'Create work order',
      oninput: (f) => {
        const s = App.val(f, 'woSku'), q = Math.max(0, +App.val(f, 'woQty') || 0), c = E.bomCost(s);
        const rows = E.bom(s).components.map((x) => ({ sku: x.sku, need: U.r2(x.qty * q), oh: E.item(x.sku).onHand }));
        App.$('#woInfo', f).innerHTML = `<div class="callout">Standard cost ${fmt(c.total)} per unit (material ${fmt(c.material)}, labor ${fmt(c.labor)}, overhead ${fmt(c.overhead)}). Estimated build cost <b class="num">${fmt(c.total * q)}</b>.</div>`
          + App.table([{ h: 'Component', f: (r) => esc(r.sku) }, { h: 'Needed', num: true, f: (r) => num(r.need) }, { h: 'On hand', num: true, f: (r) => num(r.oh) }, { h: '', f: (r) => r.oh >= r.need ? pill('Available', 'good') : pill(`Short ${num(U.r2(r.need - r.oh))}`, 'bad') }], rows);
      },
      onSubmit: (f) => E.createWO({ sku: App.val(f, 'woSku'), qty: App.val(f, 'woQty'), start: App.val(f, 'woStart'), due: App.val(f, 'woDue'), note: App.val(f, 'woNote') }),
      success: (w) => `${w.id} planned: ${w.qty} x ${w.sku}. Release it to start production.`,
    });
  });
  App.act('wo-release', (ds) => {
    const w = E.wo(ds.id); const short = E.woShortages(w);
    App.drawer(`Release ${w.id}`, App.field('Release date', App.input('relDate', today(), 'date'))
      + App.table([{ h: 'Component', f: (c) => esc(c.sku) }, { h: 'Required', num: true, f: (c) => num(c.required - c.issued) }, { h: 'On hand', num: true, f: (c) => num(E.item(c.sku).onHand) }, { h: '', f: (c) => { const s = short.find((x) => x.sku === c.sku); return s ? pill(`Short ${num(s.short)}`, 'bad') : pill('Available', 'good'); } }], w.components)
      + (short.length ? `<div class="callout warn">${short.length} component(s) are short. Receive stock first, or release anyway and issue what is available.</div><label class="field" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="relForce"> <span>Release with shortages</span></label>` : '<div class="callout good">All components are available.</div>'),
    { submitLabel: 'Release', onSubmit: (f) => E.releaseWO(w.id, { date: App.val(f, 'relDate'), allowShortages: !!App.$('#relForce', f)?.checked }), success: (r) => `${w.id} released${r.shortages.length ? ` with ${r.shortages.length} shortage(s)` : ''}.` });
  });
  App.act('wo-issue', (ds) => {
    const w = E.wo(ds.id);
    const rows = w.components.filter((c) => c.issued < c.required);
    App.drawer(`Issue components to ${w.id}`, App.field('Issue date', App.input('isDate', today(), 'date'))
      + App.table([{ h: 'Component', f: (c) => esc(c.sku) }, { h: 'Still required', num: true, f: (c) => num(U.r2(c.required - c.issued)) }, { h: 'On hand', num: true, f: (c) => num(E.item(c.sku).onHand) }, { h: 'Avg cost', num: true, f: (c) => fmt(E.item(c.sku).avgCost) },
        { h: 'Issue now', num: true, f: (c) => `<input class="cell-in num" style="max-width:100px" type="number" min="0" step="1" data-iss="${esc(c.sku)}" id="iss-${esc(c.sku)}" aria-label="Issue ${esc(c.sku)}" value="${Math.min(U.r2(c.required - c.issued), E.item(c.sku).onHand)}">` }], rows)
      + '<div class="callout" id="issInfo"></div>', {
      submitLabel: 'Issue to work in process',
      oninput: (f) => { const v = App.$$('[data-iss]', f).reduce((a, x) => a + (+x.value || 0) * E.item(x.dataset.iss).avgCost, 0); App.$('#issInfo', f).innerHTML = `Posts Dr 1300 Work in process / Cr 1200 Inventory for <b class="num">${fmt(v)}</b> at average cost.`; },
      onSubmit: (f) => E.issueComponents(w.id, { date: App.val(f, 'isDate'), lines: App.$$('[data-iss]', f).map((x) => ({ sku: x.dataset.iss, qty: x.value })) }),
      success: (j) => `Components issued to ${w.id} (${fmt(j.total)}).`,
    });
  });
  App.act('wo-complete', (ds) => {
    const w = E.wo(ds.id);
    // most units the issued components cover
    const cover = Math.min(...w.components.map((c) => Math.floor((c.issued + 1e-9) / c.per))) - w.completed;
    const def = Math.max(0, Math.min(E.woRemaining(w), cover));
    App.drawer(`Report completion on ${w.id}`, `<div class="row">${App.field('Completion date', App.input('wcDate', today(), 'date'))}${App.field('Quantity completed', App.input('wcQty', def, 'number', 'step="1" min="1"'), `${num(E.woRemaining(w))} left to complete; components issued cover ${num(Math.max(0, cover))}`)}</div><div class="callout" id="wcInfo"></div>`, {
      submitLabel: 'Report completion',
      oninput: (f) => {
        const q = Math.max(0, +App.val(f, 'wcQty') || 0), cum = w.completed + q;
        const target = w.components.reduce((a, c) => a + (c.issued > 0 ? c.issuedValue * Math.min(1, (c.per * cum) / c.issued) : 0), 0);
        const mat = Math.max(0, U.r2(target - w.relievedMaterial)), conv = U.r2(w.laborHours * w.laborRate * q + w.overheadPerUnit * q);
        App.$('#wcInfo', f).innerHTML = `Absorbs <b class="num">${fmt(conv)}</b> labor and overhead (Dr 1300 / Cr 5300), then moves <b class="num">${fmt(mat + conv)}</b> to finished goods (Dr 1200 / Cr 1300)${q ? `, ${fmt((mat + conv) / q)} per unit` : ''}.`;
      },
      onSubmit: (f) => E.reportCompletion(w.id, { date: App.val(f, 'wcDate'), qty: App.val(f, 'wcQty') }),
      success: (j) => `${j.desc}.`,
    });
  });
  App.act('wo-close', (ds) => {
    const w = E.wo(ds.id), wip = E.woWip(w);
    App.drawer(`Close ${w.id}`, App.field('Close date', App.input('wclDate', today(), 'date'))
      + `<div class="callout ${Math.abs(wip) >= 0.01 ? 'warn' : ''}">${w.status === 'In progress' ? `Short close: ${num(E.woRemaining(w))} unit(s) will not be built. ` : ''}${Math.abs(wip) >= 0.01 ? `Residual work in process of <b class="num">${fmt(wip)}</b> posts to 5310 Production variance.` : 'No residual work in process; the order closes with no variance.'}</div>`,
    { submitLabel: 'Close work order', onSubmit: (f) => E.closeWO(w.id, App.val(f, 'wclDate')), success: `${w.id} closed.` });
  });
  App.act('wo-cancel', (ds) => App.confirm('Cancel work order', `Cancel ${esc(ds.id)}? Nothing has been issued, so there is no accounting.`, 'Cancel work order', () => E.cancelWO(ds.id), `${ds.id} cancelled.`));

  // ---------- BOM editor ----------
  App.act('bom-edit', (ds) => {
    const cand = E.S.items;
    const sku = ds.sku || (cand.find((i) => !E.bom(i.sku)) || cand[0]).sku;
    const b = E.bom(sku) || { components: [{}], laborHours: 0, laborRate: 62, overheadPerUnit: 0 };
    const cols = [{ key: 'sku', label: 'Component', type: 'select', options: [['', 'Choose an item']].concat(App.itemOptions()) }, { key: 'qty', label: 'Qty per', type: 'number', width: '90px' }, { key: 'cost', label: 'Avg cost', type: 'text', readonly: true, width: '110px' }, { key: 'ext', label: 'Extended', type: 'text', readonly: true, width: '120px' }];
    App.drawer(E.bom(sku) ? `Edit bill of material ${sku}` : 'New bill of material',
      (ds.sku ? `<input type="hidden" id="bomSku" value="${esc(sku)}"><p><b>${esc(sku)}</b> ${itemName(sku)}</p>` : App.field('Assembly item', App.select('bomSku', cand.map((i) => [i.sku, `${i.sku} ${i.name}${E.bom(i.sku) ? ' (has BOM)' : ''}`]), sku)))
      + App.lines('bomLines', cols, b.components.map((c) => ({ sku: c.sku, qty: c.qty })))
      + `<div class="row">${App.field('Labor hours per unit', App.input('bomLh', b.laborHours, 'number', 'step="0.05" min="0"'))}${App.field('Labor rate per hour', App.input('bomLr', b.laborRate, 'number', 'step="0.01" min="0"'))}${App.field('Overhead per unit', App.input('bomOh', b.overheadPerUnit, 'number', 'step="0.01" min="0"'))}</div>
      <div class="callout" id="bomInfo"></div>`, {
      submitLabel: 'Save bill of material',
      oninput: (f) => {
        let mat = 0;
        App.$$('#bomLines tbody tr', f).forEach((tr) => { const it = E.item(App.$('[data-k="sku"]', tr).value); const q = +App.$('[data-k="qty"]', tr).value || 0; App.$('[data-k="cost"]', tr).value = it ? fmt(it.avgCost) : ''; const ext = it ? U.r2(q * it.avgCost) : 0; App.$('[data-k="ext"]', tr).value = ext ? fmt(ext) : ''; mat += ext; });
        const lab = U.r2((+App.val(f, 'bomLh') || 0) * (+App.val(f, 'bomLr') || 0)), oh = U.r2(+App.val(f, 'bomOh') || 0), tot = U.r2(mat + lab + oh);
        const it = E.item(App.val(f, 'bomSku'));
        App.$('#bomInfo', f).innerHTML = `Cost roll-up: material <b class="num">${fmt(mat)}</b> + labor <b class="num">${fmt(lab)}</b> + overhead <b class="num">${fmt(oh)}</b> = <b class="num">${fmt(tot)}</b> per unit${it ? `; margin at list ${fmt(it.price)} is ${pct((it.price - tot) / it.price)}` : ''}.`;
      },
      onSubmit: (f) => E.saveBOM({ sku: App.val(f, 'bomSku'), components: App.readLines(f, 'bomLines').filter((l) => l.sku), laborHours: App.val(f, 'bomLh'), laborRate: App.val(f, 'bomLr'), overheadPerUnit: App.val(f, 'bomOh') }),
      success: () => 'Bill of material saved.',
    });
  });

  App.view('manufacturing', {
    title: 'Manufacturing', group: 'Supply chain',
    render() {
      const S = E.S;
      const open = S.wos.filter((w) => E.MFG.OPEN_WO.includes(w.status));
      const mtd = S.wos.flatMap((w) => w.completions).filter((c) => U.periodOf(c.date) === U.periodOf(today()));
      const fg = makeItems();
      const head = App.head('Supply chain', 'Manufacturing', 'Build assemblies from bills of material. Issued components and absorbed labor and overhead sit in work in process (GL 1300) until completions move them to finished goods at actual cost.',
        App.btn('New bill of material', 'bom-edit', {}, 'mfg.edit') + App.btn('New work order', 'wo-new', {}, 'mfg.edit', 'primary'));
      const kpis = `<div class="kpis">${App.kpi('Open work orders', num(open.length), `${num(open.reduce((a, w) => a + E.woRemaining(w), 0))} unit(s) to build`)}${App.kpi('Work in process', fmt(E.balance('1300')), 'GL 1300 balance')}${App.kpi('Completed this month', num(mtd.reduce((a, c) => a + c.qty, 0)), fmt(U.sum(mtd, (c) => c.value)) + ' to finished goods')}${App.kpi('Finished goods', fmt(U.sum(fg, (i) => i.onHand * i.avgCost)), fg.map((i) => `${esc(i.sku)} ${num(i.onHand)}`).join(', '))}</div>`;
      const flow = `<div class="card pad" style="margin-bottom:16px"><div class="small muted" style="margin-bottom:6px">Work order lifecycle</div>${App.stepFlow(['Planned', 'Released (availability check)', 'Issue components (Dr 1300 / Cr 1200)', 'Complete (absorb 5300; Dr 1200 / Cr 1300)', 'Close (residual to 5310)'], -1)}</div>`;
      const tab = App.tabOf('manufacturing', 'wos');
      const tabs = App.tabs('manufacturing', [['wos', `Work orders (${S.wos.length})`], ['boms', `Bills of material (${Object.keys(S.boms).length})`]]);
      let body;
      if (tab === 'wos') {
        const rows = S.wos.slice().sort((a, b) => b.start.localeCompare(a.start) || b.id.localeCompare(a.id));
        body = App.table([
          { h: 'Work order', f: (w) => App.link('wo', w.id) },
          { h: 'Assembly', f: (w) => `${App.link('item', w.sku)}<div class="small muted">${itemName(w.sku)}</div>` },
          { h: 'Complete / qty', num: true, f: (w) => `${num(w.completed)} / ${num(w.qty)}` },
          { h: 'Start', f: (w) => fdate(w.start) },
          { h: 'Due', f: (w) => fdate(w.due) },
          { h: 'WIP', num: true, f: (w) => fmt(E.woWip(w)) },
          { h: 'Status', f: (w) => woPill(w.status) + (w.status === 'Planned' && E.woShortages(w).length ? ` ${pill('Shortage', 'bad')}` : '') },
          { h: '', f: (w) => `<div class="actions">${woActions(w)}</div>` },
        ], rows, { empty: 'No work orders yet. Use New work order to build an assembly.', foot: ['Total WIP', '', '', '', '', fmt(U.sum(rows.filter((w) => w.status !== 'Closed'), E.woWip)), '', ''] });
      } else {
        body = makeItems().map((it) => {
          const c = E.bomCost(it.sku);
          return `<div class="pad" style="border-bottom:1px solid var(--line-2)"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px"><div><b>${App.link('bom', it.sku, it.sku)}</b> ${esc(it.name)}<div class="small muted">Standard ${fmt(c.total)} · average cost ${fmt(it.avgCost)} · list ${fmt(it.price)} · margin ${pct((it.price - c.total) / it.price)}</div></div><div class="actions">${App.btn('Edit', 'bom-edit', { sku: it.sku }, 'mfg.edit', 'sm')}${App.btn('New work order', 'wo-new', { sku: it.sku }, 'mfg.edit', 'sm primary')}</div></div>${rollupTable(it.sku, c)}</div>`;
        }).join('') || '<div class="empty">No bills of material yet.</div>';
      }
      return head + kpis + flow + tabs + `<div class="card">${body}</div>`;
    },
  });

  // ---------- supply planning ----------
  const planCount = () => E.supplyPlan().filter((r) => r.needed).length;
  App.navCount('supply', planCount);
  function createFromPlan(kind) {
    const skus = App.$$('[data-plan]:checked').map((x) => x.dataset.plan).filter((s) => E.supplyPlan().find((r) => r.sku === s)?.action === kind);
    if (!skus.length) { App.toast(`Select at least one ${kind === 'Buy' ? 'purchased' : 'manufactured'} item with a suggestion.`, 'bad'); return; }
    if (kind === 'Buy') App.try(() => E.createPlannedReqs({ skus, date: today() }), (list) => `${list.length} requisition(s) created: ${list.map((r) => `${r.id} ${r.status === 'Pending Approval' ? '(awaiting approval)' : '(approved)'}`).join(', ')}.`);
    else App.try(() => E.createPlannedWOs({ skus, date: today() }), (list) => `${list.length} planned work order(s) created: ${list.map((w) => w.id).join(', ')}.`);
  }
  App.act('plan-reqs', () => createFromPlan('Buy'));
  App.act('plan-wos', () => createFromPlan('Make'));
  App.view('supply', {
    title: 'Supply planning', group: 'Supply chain',
    render() {
      const plan = E.supplyPlan();
      const need = plan.filter((r) => r.needed), buy = need.filter((r) => r.action === 'Buy'), make = need.filter((r) => r.action === 'Make');
      const head = App.head('Supply chain', 'Supply planning', 'Projected available = on hand − open sales orders − work order component demand + open purchase orders + open requisitions + open work order output. Items at or below their reorder point get a suggestion back up to twice the reorder point, in lot sizes.',
        App.btn('Create requisitions', 'plan-reqs', {}, 'mfg.plan') + App.btn('Create work orders', 'plan-wos', {}, 'mfg.plan', 'primary'));
      const kpis = `<div class="kpis">${App.kpi('Items needing action', num(need.length), need.map((r) => esc(r.sku)).join(', ') || 'All items covered')}${App.kpi('Buy suggestions', fmt(U.sum(buy, (r) => r.estCost)), `${buy.length} item(s); over ${App.fmt0(E.REQ_APPROVAL_LIMIT)} needs approval`)}${App.kpi('Make suggestions', num(make.reduce((a, r) => a + r.suggest, 0)) + ' units', `${make.length} assembly(ies)`)}${App.kpi('Open PO supply', num(plan.reduce((a, r) => a + r.poSupply, 0)) + ' units', 'Ordered, not received')}</div>`;
      const body = App.table([
        { h: 'Select', f: (r) => r.needed ? `<input type="checkbox" data-plan="${esc(r.sku)}" id="plan-${esc(r.sku)}" checked aria-label="Select ${esc(r.sku)}">` : '' },
        { h: 'Item', f: (r) => `${App.link('item', r.sku)}<div class="small muted">${esc(r.name)}</div>` },
        { h: 'Type', f: (r) => (r.make ? 'Make' : 'Buy') },
        { h: 'On hand', num: true, f: (r) => num(r.onHand) },
        { h: 'Sales demand', num: true, f: (r) => (r.soDemand ? '−' + num(r.soDemand) : '0') },
        { h: 'WO demand', num: true, f: (r) => (r.woDemand ? '−' + num(r.woDemand) : '0') },
        { h: 'Open POs', num: true, f: (r) => (r.poSupply ? '+' + num(r.poSupply) : '0') },
        { h: 'Open reqs', num: true, f: (r) => (r.reqSupply ? '+' + num(r.reqSupply) : '0') },
        { h: 'WO output', num: true, f: (r) => (r.woSupply ? '+' + num(r.woSupply) : '0') },
        { h: 'Projected', num: true, f: (r) => `<b>${num(r.projected)}</b>` },
        { h: 'Reorder point', num: true, f: (r) => num(r.reorder) },
        { h: 'Suggested', num: true, f: (r) => (r.suggest ? `${num(r.suggest)}<div class="small muted">lot ${num(r.lot)}</div>` : '') },
        { h: 'Est. cost', num: true, f: (r) => (r.suggest ? fmt(r.estCost) : '') },
        { h: 'Action', f: (r) => r.needed ? pill(r.make ? 'Make' : 'Buy', r.projected < 0 ? 'bad' : 'warn') : pill('Covered', 'good') },
      ], plan.slice().sort((a, b) => b.needed - a.needed || a.sku.localeCompare(b.sku)));
      return head + kpis + `<div class="callout" style="margin-bottom:16px">Select suggestions and use <b>Create requisitions</b> for purchased items (one requisition per item; those over ${fmt(E.REQ_APPROVAL_LIMIT)} go to a Controller) or <b>Create work orders</b> for assemblies (created as Planned).</div>` + `<div class="card">${body}</div>`;
    },
  });

  // ---------- cycle counts ----------
  App.navCount('counts', () => E.S.counts.filter((c) => c.status === 'Counted').length);
  App.act('cc-new', () => {
    App.drawer('New cycle count', `<div class="row">${App.field('Count date', App.input('ccDate', today(), 'date'))}${App.field('Items to count', App.input('ccN', '4', 'number', 'step="1" min="1"'), 'Most overdue first; A items are counted monthly, B quarterly, C twice a year')}</div><div id="ccPrev"></div>`, {
      submitLabel: 'Create count',
      oninput: (f) => {
        const busy = new Set(E.S.counts.filter((c) => ['Open', 'Counted'].includes(c.status)).flatMap((c) => c.lines.map((l) => l.sku)));
        const n = Math.max(0, Math.floor(+App.val(f, 'ccN') || 0));
        const rows = E.countSchedule(App.val(f, 'ccDate') || today()).filter((r) => !busy.has(r.sku)).slice(0, n);
        App.$('#ccPrev', f).innerHTML = App.table([{ h: 'Item', f: (r) => esc(r.sku) + ' ' + esc(r.name) }, { h: 'Class', f: (r) => r.cls }, { h: 'Last counted', f: (r) => (r.last ? fdate(r.last) : 'Never') }, { h: '', f: (r) => (r.due ? pill('Due', 'warn') : pill('Not due', '')) }], rows, { empty: 'Every item is already on an open count.' });
      },
      onSubmit: (f) => E.createCount({ date: App.val(f, 'ccDate'), n: App.val(f, 'ccN') }),
      success: (c) => `${c.id} created for ${c.lines.length} item(s). Enter the counted quantities next.`,
    });
  });
  App.act('cc-enter', (ds) => {
    const c = E.count(ds.id);
    App.drawer(`Enter counts on ${c.id}`, `<p class="small muted">Count each bin blind, then enter what you found. Variances are measured against the system quantity when the count was created.</p>`
      + App.table([{ h: 'Item', f: (l) => `${esc(l.sku)}<div class="small muted">${itemName(l.sku)}</div>` }, { h: 'System qty', num: true, f: (l) => num(l.systemQty) },
        { h: 'Counted', num: true, f: (l) => `<input class="cell-in num" style="max-width:100px" type="number" min="0" step="1" data-cnt="${esc(l.sku)}" id="cnt-${esc(l.sku)}" aria-label="Counted ${esc(l.sku)}" value="${l.counted ?? ''}">` },
        { h: 'Variance', num: true, f: (l) => `<span data-var="${esc(l.sku)}"></span>` }], c.lines)
      + '<div class="callout" id="cntInfo"></div>', {
      submitLabel: 'Save counts',
      oninput: (f) => {
        let tot = 0;
        App.$$('[data-cnt]', f).forEach((x) => { const l = c.lines.find((y) => y.sku === x.dataset.cnt); const out = App.$(`[data-var="${x.dataset.cnt}"]`, f); if (x.value === '') { out.textContent = ''; return; } const q = (+x.value) - l.systemQty, v = U.r2(q * E.item(l.sku).avgCost); tot += v; out.textContent = `${q > 0 ? '+' : ''}${num(q)} (${fmt(v)})`; });
        App.$('#cntInfo', f).innerHTML = `Net variance <b class="num">${fmt(tot)}</b> at average cost. Saving does not post; use Post adjustments once every line is counted.`;
      },
      onSubmit: (f) => { const counts = {}; App.$$('[data-cnt]', f).forEach((x) => (counts[x.dataset.cnt] = x.value)); return E.enterCounts(c.id, counts); },
      success: (r) => r.status === 'Counted' ? `${c.id} counted. Review the variances and post the adjustments.` : `${c.id} saved; some items still need a count.`,
    });
  });
  App.act('cc-post', (ds) => {
    const c = E.count(ds.id); const adj = c.lines.filter((l) => l.counted != null && l.counted !== l.systemQty);
    App.drawer(`Post ${c.id}`, App.field('Posting date', App.input('ccpDate', today(), 'date'))
      + `<div class="callout">${adj.length ? `${adj.length} adjustment(s) post to inventory (Dr/Cr 1200 against 5000), net <b class="num">${fmt(U.sum(adj, (l) => E.countVariance(l).value))}</b>.` : 'No variances: the count posts without any adjustment.'}</div>`,
    { submitLabel: 'Post adjustments', onSubmit: (f) => E.postCount(c.id, App.val(f, 'ccpDate')), success: (r) => `${c.id} posted, net adjustment ${fmt(r.netValue)}.` });
  });
  App.act('cc-cancel', (ds) => App.confirm('Cancel cycle count', `Cancel ${esc(ds.id)}? Nothing has been posted.`, 'Cancel count', () => E.cancelCount(ds.id), `${ds.id} cancelled.`));

  App.view('counts', {
    title: 'Cycle counts', group: 'Supply chain',
    render() {
      const S = E.S;
      const open = S.counts.filter((c) => ['Open', 'Counted'].includes(c.status));
      const sched = E.countSchedule();
      const posted = S.counts.filter((c) => c.status === 'Posted');
      const lines = posted.flatMap((c) => c.lines);
      const acc = lines.length ? lines.filter((l) => l.counted === l.systemQty).length / lines.length : NaN;
      const head = App.head('Supply chain', 'Cycle counts', 'Count a few items at a time instead of a full stocktake. Items are ranked A, B, C by on-hand value; posting a count adjusts inventory for each variance.',
        App.btn('New cycle count', 'cc-new', {}, 'inv.adjust', 'primary'));
      const kpis = `<div class="kpis">${App.kpi('Open counts', num(open.length), `${open.filter((c) => c.status === 'Counted').length} awaiting posting`)}${App.kpi('Items due', num(sched.filter((r) => r.due).length), `of ${num(sched.length)} items`)}${App.kpi('Count accuracy', pct(acc), `${num(lines.length)} line(s) posted`)}${App.kpi('Net adjustments', fmt(U.sum(posted, (c) => c.netValue || 0)), 'All posted counts')}</div>`;
      const tab = App.tabOf('counts', 'counts');
      const tabs = App.tabs('counts', [['counts', `Counts (${S.counts.length})`], ['sched', 'ABC schedule']]);
      let body;
      if (tab === 'counts') {
        body = App.table([
          { h: 'Count', f: (c) => App.link('count', c.id) },
          { h: 'Date', f: (c) => fdate(c.date) },
          { h: 'Items', f: (c) => c.lines.map((l) => esc(l.sku)).join(', ') },
          { h: 'Counted', num: true, f: (c) => `${c.lines.filter((l) => l.counted != null).length} / ${c.lines.length}` },
          { h: 'Variance value', num: true, f: (c) => fmt(c.status === 'Posted' ? c.netValue : U.sum(c.lines, (l) => E.countVariance(l).value)) },
          { h: 'Status', f: (c) => ccPill(c.status) },
          { h: '', f: (c) => `<div class="actions">${ccButtons(c)}</div>` },
        ], S.counts.slice().reverse(), { empty: 'No cycle counts yet. Use New cycle count to pick the items that are due.' });
      } else {
        body = App.table([
          { h: 'Item', f: (r) => `${App.link('item', r.sku)} ${esc(r.name)}` },
          { h: 'Class', f: (r) => r.cls },
          { h: 'On-hand value', num: true, f: (r) => fmt(r.value) },
          { h: 'Frequency', f: (r) => ({ A: 'Monthly', B: 'Quarterly', C: 'Twice a year' }[r.cls]) },
          { h: 'Last counted', f: (r) => (r.last ? fdate(r.last) : '<span class="muted">Never</span>') },
          { h: 'Next due', f: (r) => fdate(r.next) },
          { h: 'Status', f: (r) => (r.due ? pill('Due', 'warn') : pill('Current', 'good')) },
        ], sched);
      }
      return head + kpis + tabs + `<div class="card">${body}</div>`;
    },
  });
})();
