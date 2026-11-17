/* Ledgerline Suite: views-wms.js
 * Warehouses: stock by location (items x locations + in transit, checked against on hand),
 * transfers (request, ship, receive), lots and serials (search and trace).
 * Rules live in js/ext-wms.js. Mutations run in drawers or App.try (rollback on failure).
 * Also replaces the core "Ship and invoice" drawer with one that lets you pick a location.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E;
  const esc = App.esc, num = App.num, fdate = App.fdate, pill = App.pill, fmt = App.fmt;
  const today = () => E.S.today;
  const TR_TONE = { Requested: 'info', Shipped: 'warn', Received: 'good', Cancelled: '' };
  const trPill = (s) => pill(s === 'Shipped' ? 'In transit' : s, TR_TONE[s]);
  const locOpts = () => E.S.locations.map((l) => [l.code, `${l.code} ${l.name}`]);
  const itemOpts = () => [['', 'Choose an item']].concat(App.itemOptions());
  const ctl = (it) => (it.serialControlled ? ' <span class="pill info">Serial</span>' : it.lotControlled ? ' <span class="pill info">Lot</span>' : '');
  const h3 = (t) => `<h3 style="margin:0 0 8px;font-size:14px">${t}</h3>`;
  const short = (list, n = 3) => (list || []).length > n ? `${list.slice(0, n).map(esc).join(', ')} +${list.length - n} more` : (list || []).map(esc).join(', ');
  const lotList = (lots) => (lots || []).map((x) => `${App.link('lot', x.lot)} <span class="num">${num(x.qty)}</span>`).join(', ');

  function trActions(t, cls = 'sm') {
    const b = [];
    if (t.status === 'Requested') b.push(App.btn('Ship', 'tr-ship', { id: t.id }, 'wms.transfer', cls + ' primary'), App.btn('Cancel', 'tr-cancel', { id: t.id }, 'wms.transfer', cls + ' danger'));
    if (t.status === 'Shipped') b.push(App.btn('Receive', 'tr-receive', { id: t.id }, 'wms.transfer', cls + ' primary'));
    return b.join('');
  }

  // ---------- detail panels ----------
  App.detail('transfer', (id) => {
    const t = E.transfer(id); if (!t) return null;
    const step = t.status === 'Cancelled' ? -1 : E.WMS.TR_STEPS.indexOf(t.status);
    const html = App.stepFlow(['Requested', 'Shipped (in transit)', 'Received'], step)
      + App.dl([['Status', trPill(t.status)], ['From', esc(t.from) + ' ' + esc(E.location(t.from)?.name || '')], ['To', esc(t.to) + ' ' + esc(E.location(t.to)?.name || '')],
        ['Requested', `${fdate(t.date)} by ${esc(t.requestedBy || '')}`], t.shipDate && ['Shipped', fdate(t.shipDate)], t.receiveDate && ['Received', fdate(t.receiveDate)], t.note && ['Note', esc(t.note)]])
      + App.table([
        { h: 'Item', f: (l) => `${App.link('item', l.sku)}${ctl(E.item(l.sku))}` },
        { h: 'Qty', num: true, f: (l) => num(l.qty) },
        { h: 'Serials / lots', f: (l) => l.serials && l.serials.length ? l.serials.map((sn) => App.link('serial', sn)).join(' ') : l.lots && l.lots.length ? lotList(l.lots) : '<span class="muted">-</span>' },
      ], t.lines)
      + '<div class="callout">Transfers move units, not value: inventory stays at company average cost and no journal posts. While shipped, the units count in on hand but are not at any location.</div>';
    return { title: `Transfer ${id}`, html, buttons: trActions(t, '') };
  });
  App.detail('serial', (sn) => {
    const t = E.traceSerial(sn); if (!t) return null;
    const where = t.status === 'In stock' ? `${esc(t.loc)} ${esc(E.location(t.loc)?.name || '')}` : t.status === 'In transit' ? `In transit on ${App.link('transfer', t.transfer)}` : t.out ? `${esc(t.status)} on ${App.refLink(t.out.ref)} ${fdate(t.out.date)}` : esc(t.status);
    const html = App.dl([['Serial', `<span class="mono">${esc(sn)}</span>`], ['Item', `${App.link('item', t.sku)} ${esc(E.item(t.sku)?.name || '')}`], ['Status', pill(t.status, t.status === 'In stock' ? 'good' : t.status === 'Shipped' ? 'info' : 'warn')], ['Where', where],
      ['Received', `${fdate(t.received)} on ${t.poId ? App.link('po', t.poId) : esc(t.receiptType || t.receiptRef)}${t.supplier ? ' from ' + esc(t.supplier) : ''}`],
      t.so && ['Customer', `${esc(t.customer)} (${App.link('so', t.so)}${t.invoiceId ? ', ' + App.link('arinv', t.invoiceId) : ''})`]])
      + h3('Movement history') + App.table([
        { h: 'Date', f: (e) => fdate(e.date) }, { h: 'Type', f: (e) => esc(e.type) }, { h: 'Reference', f: (e) => App.refLink(e.ref) || esc(e.ref) }, { h: 'Location', f: (e) => esc(e.loc) },
        { h: 'Direction', f: (e) => (e.qty > 0 ? pill('In', 'good') : pill('Out', 'warn')) }], t.history, { sort: false });
    return { title: `Serial ${sn}`, html };
  });
  App.detail('lot', (id) => {
    const t = E.traceLot(id); if (!t) return null;
    const html = App.dl([['Lot', `<span class="mono">${esc(id)}</span>`], ['Item', `${App.link('item', t.sku)} ${esc(E.item(t.sku)?.name || '')}`], ['Received', `${fdate(t.received)} on ${App.refLink(t.ref) || esc(t.ref)}`], ['Expires', fdate(t.expiry) + (t.expiry < today() ? ' ' + pill('Expired', 'bad') : '')],
      ['On hand', `${num(t.onHand)} (${Object.entries(t.qty).map(([l, q]) => `${esc(l)} ${num(q)}`).join(', ') || 'none'})${t.transit ? `, ${num(t.transit)} in transit` : ''}`]])
      + h3('Where used') + App.table([
        { h: 'Date', f: (u) => fdate(u.date) }, { h: 'Type', f: (u) => esc(u.type) }, { h: 'Reference', f: (u) => App.refLink(u.ref) || esc(u.ref) }, { h: 'Location', f: (u) => esc(u.loc) },
        { h: 'Customer', f: (u) => esc(u.customer || '') }, { h: 'Qty', num: true, f: (u) => (u.lotQty > 0 ? '+' : '') + num(u.lotQty) }], t.uses, { sort: false });
    return { title: `Lot ${id}`, html };
  });
  App.refKind('TR-', 'transfer');
  App.refKind('LOT-', 'lot');
  App.navCount('warehouse', () => E.S.transfers.filter((t) => t.status === 'Requested' || t.status === 'Shipped').length);

  // ---------- actions ----------
  function pickHint(sku, from) {
    const it = E.item(sku); if (!it) return '';
    if (it.serialControlled) return `Serials (oldest first): ${short(E.serialsAt(sku, from), 4)}`;
    if (it.lotControlled) return `Lots (first expiry first): ${E.lotsAt(sku, from).map((x) => `${esc(x.lot)} ${num(x.qty)}`).join(', ')}`;
    return '';
  }
  App.act('tr-new', (ds) => {
    App.drawer('New transfer', `<div class="row">${App.field('Date', App.input('trDate', today(), 'date'))}${App.field('From', App.select('trFrom', locOpts(), ds.from || 'BOS-MAIN'))}${App.field('To', App.select('trTo', locOpts(), ds.to || 'DAY-FIELD'))}</div>`
      + App.lines('trLines', [{ key: 'sku', label: 'Item', type: 'select', options: itemOpts() }, { key: 'qty', label: 'Qty', type: 'number', width: '110px' }, { key: 'avail', label: 'At source', type: 'text', readonly: true, width: '110px' }], [{ sku: ds.sku || '', qty: '' }])
      + App.field('Note', App.input('trNote', '', 'text', 'placeholder="Why is the stock moving?"'))
      + '<div class="callout">The transfer is requested first; shipping deducts it from the source (in transit), receiving adds it at the destination. Serials and lots are picked oldest first unless you choose them when shipping.</div>',
    { submitLabel: 'Request transfer',
      oninput: (f) => { const from = App.val(f, 'trFrom'); App.$$('#trLines tbody tr', f).forEach((tr) => { const s = App.$('[data-k="sku"]', tr).value; const a = App.$('[data-k="avail"]', tr); if (a) a.value = s ? num(E.stockAt(s, from)) : ''; }); },
      onSubmit: (f) => E.createTransfer({ date: App.val(f, 'trDate'), from: App.val(f, 'trFrom'), to: App.val(f, 'trTo'), note: App.val(f, 'trNote'), lines: App.readLines(f, 'trLines').map((l) => ({ sku: l.sku, qty: l.qty })) }),
      success: (t) => `${t.id} requested: ${t.from} to ${t.to}.` });
  });
  App.act('tr-ship', (ds) => {
    const t = E.transfer(ds.id);
    const rows = t.lines.map((l) => { const it = E.item(l.sku); return { ...l, it, at: E.stockAt(l.sku, t.from) }; });
    App.drawer(`Ship ${t.id}`, App.field('Ship date', App.input('tsDate', today(), 'date'))
      + App.table([{ h: 'Item', f: (r) => `${esc(r.sku)}${ctl(r.it)}` }, { h: 'Qty', num: true, f: (r) => num(r.qty) }, { h: `At ${esc(t.from)}`, num: true, f: (r) => num(r.at) }, { h: '', f: (r) => (r.at >= r.qty ? pill('Available', 'good') : pill('Short', 'bad')) }], rows, { sort: false })
      + rows.filter((r) => r.it.serialControlled || r.it.lotControlled).map((r) => App.field(`${esc(r.sku)}: ${r.it.serialControlled ? 'serial numbers' : 'lots'} to ship (optional, comma separated)`, App.input('pick-' + r.sku, '', 'text', `data-pick="${esc(r.sku)}" placeholder="Leave blank to pick oldest first"`), pickHint(r.sku, t.from))).join('')
      + `<div class="callout">Deducts the units from ${esc(t.from)}. They stay in on hand as in transit until ${esc(t.to)} receives them.</div>`,
    { submitLabel: 'Ship transfer', onSubmit: (f) => { const opts = { serials: {}, lots: {} }; App.$$('[data-pick]', f).forEach((el) => { const v = el.value.split(/[\s,]+/).filter(Boolean); if (v.length) opts[E.item(el.dataset.pick).serialControlled ? 'serials' : 'lots'][el.dataset.pick] = v; }); return E.shipTransfer(t.id, App.val(f, 'tsDate'), opts); },
      success: (x) => `${x.id} shipped from ${x.from}; in transit to ${x.to}.` });
  });
  App.act('tr-receive', (ds) => {
    const t = E.transfer(ds.id);
    App.drawer(`Receive ${t.id}`, App.field('Receipt date', App.input('trrDate', today(), 'date')) + App.table([{ h: 'Item', f: (l) => esc(l.sku) }, { h: 'Qty', num: true, f: (l) => num(l.qty) }], t.lines, { sort: false })
      + `<div class="callout">Adds the units at ${esc(t.to)} with the same serials and lots that shipped.</div>`,
    { submitLabel: 'Receive transfer', onSubmit: (f) => E.receiveTransfer(t.id, App.val(f, 'trrDate')), success: (x) => `${x.id} received at ${x.to}.` });
  });
  App.act('tr-cancel', (ds) => App.confirm('Cancel transfer', `Cancel ${esc(ds.id)}? Nothing has moved yet.`, 'Cancel transfer', () => E.cancelTransfer(ds.id), `${ds.id} cancelled.`));
  App.act('wms-trace', (ds) => App.open(E.serial(ds.id) ? 'serial' : 'lot', ds.id));

  // Ship and invoice with a pick location (replaces the core drawer; same engine call plus options).
  App.act('so-ship', (ds) => {
    const o = E.so(ds.id);
    const picks = E.S.locations.filter((l) => l.pickable);
    const col = (l) => ({ h: esc(l.code), num: true, f: (x) => num(E.stockAt(x.sku, l.code)) });
    App.drawer(`Ship ${o.id}`, `<div class="row">${App.field('Ship date', App.input('shipDate', today(), 'date'))}${App.field('Ship from', App.select('shipLoc', [['', `Auto: ${E.WMS.PICK_ORDER.join(', then ')}`]].concat(picks.map((l) => [l.code, `${l.code} ${l.name}`]))))}</div>`
      + App.table([{ h: 'Item', f: (l) => `${esc(l.sku)}${ctl(E.item(l.sku))}` }, { h: 'Qty', num: true, f: (l) => num(l.qty) }, ...picks.map(col), { h: 'In transit', num: true, f: (l) => num(E.inTransit(l.sku)) }, { h: 'Avg cost', num: true, f: (l) => fmt(E.item(l.sku).avgCost) },
        { h: 'Status', f: (l) => { const a = picks.reduce((s, p) => s + E.stockAt(l.sku, p.code), 0); return a >= l.qty ? pill('Available', 'good') : E.item(l.sku).onHand >= l.qty ? pill('Transfer needed', 'warn') : pill('Short', 'bad'); } }], o.lines, { sort: false })
      + o.lines.filter((l) => E.item(l.sku).serialControlled || E.item(l.sku).lotControlled).map((l) => App.field(`${esc(l.sku)}: ${E.item(l.sku).serialControlled ? 'serial numbers' : 'lots'} (optional, comma separated)`, App.input('spick-' + l.sku, '', 'text', `data-spick="${esc(l.sku)}" placeholder="Leave blank to pick oldest first"`))).join('')
      + '<div class="callout">Auto-pick takes stock from the main warehouse first, then the field depot, and may split a line. Shipping relieves inventory at average cost (Dr 5000 COGS, Cr 1200 Inventory) and raises the customer invoice (Dr 1100 Receivables, Cr 4000 Revenue).</div>',
    { submitLabel: 'Ship and invoice',
      onSubmit: (f) => { const opts = { location: App.val(f, 'shipLoc') || undefined, serials: {}, lots: {} }; App.$$('[data-spick]', f).forEach((el) => { const v = el.value.split(/[\s,]+/).filter(Boolean); if (v.length) opts[E.item(el.dataset.spick).serialControlled ? 'serials' : 'lots'][el.dataset.spick] = v; }); return E.shipSO(o.id, App.val(f, 'shipDate'), opts); },
      success: (inv) => `${o.id} shipped. Invoice ${inv.id} raised for ${fmt(inv.total)}.` });
  });

  // ---------- view ----------
  App.view('warehouse', {
    title: 'Warehouses', group: 'Supply chain',
    render() {
      const S = E.S;
      const rows = E.stockByLocation();
      const chk = E.wmsCheck();
      const transit = S.transfers.filter((t) => t.status === 'Shipped');
      const open = S.transfers.filter((t) => t.status === 'Requested');
      const head = App.head('Supply chain', 'Warehouses', 'Stock by location, transfers between sites, and lot and serial traceability. On hand stays the company total at average cost; locations split it.',
        App.btn('New transfer', 'tr-new', {}, 'wms.transfer', 'primary'));
      const kpis = `<div class="kpis">${App.kpi('Locations', num(S.locations.length), S.locations.map((l) => esc(l.code)).join(', '))}${App.kpi('Units in transit', num(rows.reduce((a, r) => a + r.transit, 0)), transit.length ? transit.map((t) => esc(t.id)).join(', ') : 'Nothing in transit')}${App.kpi('Transfers to ship', num(open.length), open.length ? open.map((t) => esc(t.id)).join(', ') : 'None requested')}${App.kpi('Location check', chk.ok ? pill('Ties out', 'good') : pill('Drift', 'bad'), chk.ok ? 'Locations + in transit = on hand' : 'See the rows marked below')}</div>`;
      const tab = App.tabOf('warehouse', 'stock');
      const tabs = App.tabs('warehouse', [['stock', 'Stock by location'], ['transfers', `Transfers (${S.transfers.length})`], ['trace', 'Lots and serials']]);
      let body;
      if (tab === 'stock') {
        const tot = (f) => num(rows.reduce((a, r) => a + f(r), 0));
        body = App.table([
          { h: 'Item', f: (r) => `${App.link('item', r.sku)} ${esc(r.name)}${ctl(r)}` },
          ...S.locations.map((L) => ({ h: esc(L.code), num: true, f: (r) => (r.by[L.code] ? num(r.by[L.code]) : '<span class="muted">0</span>') })),
          { h: 'In transit', num: true, f: (r) => num(r.transit) },
          { h: 'Total', num: true, f: (r) => num(r.total) },
          { h: 'On hand', num: true, f: (r) => num(r.onHand) },
          { h: 'Check', f: (r) => (r.ok ? pill('Ties', 'good') : pill(`Off by ${num(r.total - r.onHand)}`, 'bad')) },
        ], rows, { foot: ['Total', ...S.locations.map((L) => tot((r) => r.by[L.code] || 0)), tot((r) => r.transit), tot((r) => r.total), tot((r) => r.onHand), ''] })
          + `<p class="hint pad">Locations: ${S.locations.map((l) => `<b>${esc(l.code)}</b> ${esc(l.name)} (${esc(l.site)}${l.pickable ? '' : ', not pickable'})`).join('; ')}. Receipts and completions go to BOS-MAIN; customer returns to BOS-QA.</p>`;
      } else if (tab === 'transfers') {
        const list = S.transfers.slice().reverse();
        body = App.table([
          { h: 'Transfer', f: (t) => App.link('transfer', t.id) },
          { h: 'Date', f: (t) => fdate(t.date) },
          { h: 'From', f: (t) => esc(t.from) }, { h: 'To', f: (t) => esc(t.to) },
          { h: 'Lines', f: (t) => t.lines.map((l) => `${num(l.qty)} ${esc(l.sku)}`).join(', ') },
          { h: 'Status', f: (t) => trPill(t.status) },
          { h: '', f: (t) => `<div class="actions">${trActions(t)}</div>` },
        ], list, { empty: 'No transfers yet. Use New transfer to move stock between locations.' });
      } else {
        const q = (App.ui.filter.wmsTrace || '').trim().toUpperCase();
        const sns = Object.values(S.serials).filter((s) => !q || s.sn.includes(q) || s.sku === q);
        const lots = Object.values(S.lots).filter((l) => !q || l.lot.includes(q) || l.sku === q);
        const form = `<div class="pad" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">${App.field('Find serial, lot or item', App.input('wmsQ', App.ui.filter.wmsTrace || '', 'search', 'placeholder="e.g. HX310-26-00123 or LOT-2609"'))}<span class="hint">${num(sns.length)} serial(s), ${num(lots.length)} lot(s)</span></div>`;
        body = form + `<div class="pad">${h3('Lots')}</div>` + App.table([
          { h: 'Lot', f: (l) => App.link('lot', l.lot) }, { h: 'Item', f: (l) => App.link('item', l.sku) }, { h: 'Received', f: (l) => fdate(l.received) },
          { h: 'Expires', f: (l) => fdate(l.expiry) }, { h: 'On hand', num: true, f: (l) => num(Object.values(l.qty).reduce((a, b) => a + b, 0)) },
          { h: 'Locations', f: (l) => Object.entries(l.qty).map(([k, v]) => `${esc(k)} ${num(v)}`).join(', ') || '<span class="muted">Used up</span>' }], lots, { empty: 'No lots match.' })
          + `<div class="pad">${h3('Serial numbers')}</div>` + App.table([
          { h: 'Serial', f: (s) => App.link('serial', s.sn) }, { h: 'Item', f: (s) => App.link('item', s.sku) }, { h: 'Received', f: (s) => `${fdate(s.received)} ${App.refLink(s.receiptRef) || ''}` },
          { h: 'Status', f: (s) => pill(s.status, s.status === 'In stock' ? 'good' : s.status === 'Shipped' ? 'info' : 'warn') },
          { h: 'Location or destination', f: (s) => s.status === 'In stock' ? esc(s.loc) : s.status === 'In transit' ? App.link('transfer', s.transfer) : s.out ? `${App.refLink(s.out.ref) || esc(s.out.ref)}${s.out.customerId ? ' ' + esc(E.cust(s.out.customerId)?.name || '') : ''}` : '' }],
          sns.slice().reverse(), { empty: 'No serial numbers match.' });
      }
      return head + kpis + tabs + `<div class="card">${body}</div>`;
    },
    after(root) {
      const q = App.$('#wmsQ', root);
      if (q) q.addEventListener('change', () => { App.ui.filter.wmsTrace = q.value; App.render(); });
    },
  });
})();
