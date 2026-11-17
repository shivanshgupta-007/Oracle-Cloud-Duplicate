/* Ledgerline Suite — views-scm.js
 * Supply chain: Purchasing (requisitions, purchase orders, receiving hand-off to
 * payables), Inventory (items, movements) and Sales orders (order to cash).
 * Mutations go through engine functions inside drawers or App.try, so every
 * failure rolls back and every success saves and re-renders.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, num = App.num, fdate = App.fdate, pill = App.pill;
  const today = () => E.S.today;
  const pct = (n) => (isFinite(n) ? (n * 100).toFixed(1) + '%' : '-');
  const itemOpts = () => [['', 'Choose an item']].concat(App.itemOptions());
  const lineQty = (p, k) => p.lines.reduce((a, l) => a + (+l[k] || 0), 0);
  const belowReorder = (it) => it.onHand <= it.reorder;
  const replenishQty = (it) => Math.max(1, it.reorder * 2 - it.onHand);

  // ---------- shared line editor behaviour ----------
  /** Keeps each row's price in step with its item until the user types a price.
   *  priceOf(item) gives the default; returns the line total. */
  function syncLines(f, tableId, priceOf, extra) {
    let total = 0;
    App.$$(`#${tableId} tbody tr`, f).forEach((tr) => {
      const skuEl = App.$('[data-k="sku"]', tr), qtyEl = App.$('[data-k="qty"]', tr), priceEl = App.$('[data-k="price"]', tr), amtEl = App.$('[data-k="amount"]', tr);
      const it = E.item(skuEl.value);
      if (tr.dataset.sku !== skuEl.value) {
        const untouched = priceEl.value === '' || priceEl.value === (tr.dataset.auto || '');
        if (it && untouched) { priceEl.value = String(priceOf(it)); tr.dataset.auto = priceEl.value; }
        tr.dataset.sku = skuEl.value;
      }
      const amt = U.r2((+qtyEl.value || 0) * (+priceEl.value || 0));
      if (amtEl) amtEl.value = amt ? fmt(amt) : '';
      if (extra) extra(tr, it, +qtyEl.value || 0);
      total += amt;
    });
    return U.r2(total);
  }
  const cleanLines = (f, id) => App.readLines(f, id).filter((l) => l.sku).map((l) => ({ sku: l.sku, qty: l.qty, price: l.price }));
  const lineCols = (priceLabel, more = []) => [
    { key: 'sku', label: 'Item', type: 'select', options: itemOpts() },
    { key: 'qty', label: 'Qty', type: 'number', width: '90px' },
    { key: 'price', label: priceLabel, type: 'number', width: '120px' },
    ...more,
    { key: 'amount', label: 'Amount', type: 'text', readonly: true, width: '130px' },
  ];

  // ---------- requisition drawer (shared: purchasing, inventory replenish) ----------
  function reqDrawer(prefill = {}) {
    const it = prefill.sku && E.item(prefill.sku);
    const rows = it ? [{ sku: it.sku, qty: prefill.qty || replenishQty(it), price: it.lastCost }] : [{}];
    const html = `<div class="row">${App.field('Requester', App.input('rqBy', E.S.user))}${App.field('Need-by date', App.input('rqDate', today(), 'date'))}</div>`
      + App.field('Justification', App.input('rqWhy', it ? `Replenish ${it.sku} above reorder point (${num(it.onHand)} on hand, reorder at ${num(it.reorder)})` : '', 'text', 'placeholder="What is this for? Approvers read this."'))
      + App.lines('rqLines', lineCols('Est. price'), rows)
      + `<div class="callout" id="rqInfo"></div>`;
    App.drawer('New requisition', html, {
      submitLabel: 'Submit requisition',
      oninput: (f) => {
        const t = syncLines(f, 'rqLines', (x) => x.lastCost);
        const over = t > E.REQ_APPROVAL_LIMIT;
        const box = App.$('#rqInfo', f); box.className = 'callout' + (over ? ' warn' : '');
        box.innerHTML = `Estimated total <b class="num">${fmt(t)}</b>. ` + (over
          ? `This is over the ${fmt(E.REQ_APPROVAL_LIMIT)} limit, so it goes to a Controller for approval before it can be ordered.`
          : `Requisitions up to ${fmt(E.REQ_APPROVAL_LIMIT)} are approved automatically and can be turned into a purchase order straight away.`);
      },
      onSubmit: (f) => E.createReq({ date: App.val(f, 'rqDate'), requester: App.val(f, 'rqBy').trim(), justification: App.val(f, 'rqWhy').trim(), lines: cleanLines(f, 'rqLines') }),
      success: (r) => r.status === 'Pending Approval' ? `${r.id} submitted for approval (${fmt(r.total)}).` : `${r.id} approved automatically (${fmt(r.total)}). Create a purchase order from it on the Requisitions tab.`,
    });
  }
  App.act('req-new', (ds) => reqDrawer({ sku: ds.sku, qty: ds.qty ? +ds.qty : undefined }));

  // ---------- purchase order drawer (from requisition or blank) ----------
  function poDrawer(reqId) {
    const r = reqId && E.req(reqId);
    const sups = E.S.suppliers.filter((s) => s.active !== false);
    if (!sups.length) { App.toast('Add a supplier before raising a purchase order.', 'bad'); return; }
    const rows = r ? r.lines.map((l) => ({ sku: l.sku, qty: l.qty, price: l.price })) : [{}];
    const html = (r ? App.stepFlow(['Requisition', 'Approved', 'Purchase order', 'Receipt', 'Invoice'], 2)
        + `<div class="callout">Ordering requisition ${App.link('req', r.id)} from ${esc(r.requester)}: ${esc(r.justification || 'no justification given')}. Estimated ${fmt(r.total)}. Confirm the supplier's prices below.</div>` : '')
      + `<div class="row">${App.field('Supplier', App.select('poSup', sups.map((s) => [s.id, `${s.name} (Net ${s.terms})`])))}${App.field('Order date', App.input('poDate', today(), 'date'))}</div>`
      + App.lines('poLines', lineCols('Unit price'), rows)
      + `<div class="callout" id="poInfo"></div>`;
    App.drawer(r ? `Create purchase order from ${r.id}` : 'New purchase order', html, {
      submitLabel: 'Issue purchase order',
      oninput: (f) => {
        const t = syncLines(f, 'poLines', (x) => x.lastCost);
        App.$('#poInfo', f).innerHTML = `Order total <b class="num">${fmt(t)}</b>. Nothing posts to the ledger until goods are received (Dr 1200 Inventory, Cr 2100 Received not invoiced).`;
      },
      onSubmit: (f) => E.createPO({ reqId: r ? r.id : '', supplierId: App.val(f, 'poSup'), date: App.val(f, 'poDate'), lines: cleanLines(f, 'poLines') }),
      success: (p) => `${p.id} issued to ${E.sup(p.supplierId).name} for ${fmt(p.total)}.`,
    });
  }
  App.act('po-new', (ds) => poDrawer(ds.req));

  // ---------- Purchasing ----------
  App.view('purchasing', {
    title: 'Purchasing',
    render() {
      const S = E.S;
      const openPOs = S.pos.filter((p) => ['Open', 'Partially Received'].includes(p.status));
      const openVal = U.sum(openPOs.flatMap((p) => p.lines), (l) => (l.qty - l.received) * l.price);
      const pend = S.reqs.filter((r) => r.status === 'Pending Approval');
      const appr = S.reqs.filter((r) => r.status === 'Approved');
      const rni = -E.balance('2100');
      const head = App.head('Supply chain', 'Purchasing', `Requisitions over ${fmt(E.REQ_APPROVAL_LIMIT)} need a Controller's approval. Approved requisitions become purchase orders; receipts post to inventory and invoices are matched to the PO and receipt.`,
        App.btn('New requisition', 'req-new', {}, 'req.create') + App.btn('New purchase order', 'po-new', {}, 'po.create', 'primary'));
      const kpis = `<div class="kpis">${App.kpi('Open PO value', fmt(openVal), `${openPOs.length} PO(s) awaiting goods`)}${App.kpi('Awaiting approval', num(pend.length), `${fmt(U.sum(pend, (r) => r.total))} in requisitions`)}${App.kpi('Approved, not ordered', num(appr.length), `${fmt(U.sum(appr, (r) => r.total))} ready for a PO`)}${App.kpi('Received not invoiced', fmt(rni), 'GL 2100 accrual')}</div>`;
      const tab = App.tabOf('purchasing', 'reqs');
      const tabs = App.tabs('purchasing', [['reqs', `Requisitions (${S.reqs.length})`], ['pos', `Purchase orders (${S.pos.length})`]]);
      const flow = `<div class="card pad" style="margin-bottom:16px"><div class="small muted" style="margin-bottom:6px">Procure to pay</div>${App.stepFlow(['Requisition', `Approval over ${App.fmt0(E.REQ_APPROVAL_LIMIT)}`, 'Purchase order', 'Receipt', 'Supplier invoice (3-way match)', 'Payment'], -1)}</div>`;
      let body;
      if (tab === 'reqs') {
        const rows = S.reqs.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
        body = App.table([
          { h: 'Requisition', f: (r) => App.link('req', r.id) },
          { h: 'Date', f: (r) => fdate(r.date) },
          { h: 'Requester', f: (r) => esc(r.requester) },
          { h: 'Items', f: (r) => { const s = r.lines.slice(0, 2).map((l) => `${esc(l.sku)} &times; ${num(l.qty)}`).join(', '); return s + (r.lines.length > 2 ? ` <span class="muted">+${r.lines.length - 2} more</span>` : '') + (r.justification ? `<div class="small muted">${esc(r.justification)}</div>` : ''); } },
          { h: 'Total', num: true, f: (r) => fmt(r.total) },
          { h: 'Status', f: (r) => pill(r.status) + (r.poId ? ` ${App.link('po', r.poId)}` : '') + (r.rejectReason ? `<div class="small muted">${esc(r.rejectReason)}</div>` : '') },
          { h: '', f: (r) => `<div class="actions">${r.status === 'Pending Approval' ? App.btn('Approve', 'req-approve', { id: r.id }, 'req.approve', 'sm primary') + App.btn('Reject', 'req-reject', { id: r.id }, 'req.approve', 'sm danger') : r.status === 'Approved' ? App.btn('Create PO', 'po-new', { req: r.id }, 'po.create', 'sm primary') : ''}</div>` },
        ], rows, { empty: 'No requisitions yet. Use New requisition to request stock or services.' });
      } else {
        const rows = S.pos.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
        body = App.table([
          { h: 'PO', f: (p) => App.link('po', p.id) + (p.reqId ? `<div class="small muted">from ${esc(p.reqId)}</div>` : '') },
          { h: 'Supplier', f: (p) => App.link('sup', p.supplierId, E.sup(p.supplierId)?.name) },
          { h: 'Date', f: (p) => fdate(p.date) },
          { h: 'Total', num: true, f: (p) => fmt(p.total) },
          { h: 'Ordered / received / billed', num: true, f: (p) => `${num(lineQty(p, 'qty'))} / ${num(lineQty(p, 'received'))} / ${num(lineQty(p, 'invoiced'))}` },
          { h: 'Status', f: (p) => pill(p.status) },
          { h: '', f: (p) => `<div class="actions">${['Open', 'Partially Received'].includes(p.status) ? App.btn('Receive', 'po-receive', { id: p.id }, 'po.receive', 'sm') : ''}${p.lines.some((l) => l.received > l.invoiced) ? App.btn('Enter invoice', 'ap-enter', { po: p.id }, 'ap.enter', 'sm') : ''}</div>` },
        ], rows, { empty: 'No purchase orders yet. Create one from an approved requisition, or use New purchase order.' });
      }
      return head + kpis + flow + tabs + `<div class="card">${body}</div>`;
    },
  });

  // ---------- Inventory ----------
  App.act('item-new', () => {
    App.drawer('New item', `<div class="row">${App.field('SKU', App.input('itSku', '', 'text', 'placeholder="e.g. HX-410"'))}${App.field('Name', App.input('itName', '', 'text', 'placeholder="e.g. Dissolved oxygen probe"'))}${App.field('Unit of measure', App.select('itUom', ['Each', 'Kit', 'Box', 'Meter', 'Kg']))}</div>
      <div class="row">${App.field('List price', App.input('itPrice', '', 'number', 'step="0.01" min="0"'))}${App.field('Standard cost', App.input('itCost', '', 'number', 'step="0.01" min="0"'), 'Used as the first estimate on requisitions')}${App.field('Reorder point', App.input('itReorder', '0', 'number', 'step="1" min="0"'))}</div>
      <div class="callout" id="itInfo"></div>`, {
      submitLabel: 'Create item',
      oninput: (f) => { const p = +App.val(f, 'itPrice') || 0, c = +App.val(f, 'itCost') || 0; App.$('#itInfo', f).innerHTML = p && c ? `Margin at list price: <b>${pct((p - c) / p)}</b>. New items start with zero on hand; receive a purchase order to stock them.` : 'New items start with zero on hand; receive a purchase order to stock them.'; },
      onSubmit: (f) => E.addItem({ sku: App.val(f, 'itSku'), name: App.val(f, 'itName'), uom: App.val(f, 'itUom'), price: App.val(f, 'itPrice'), cost: App.val(f, 'itCost'), reorder: App.val(f, 'itReorder') }),
      success: (it) => `Item ${it.sku} created.`,
    });
  });

  App.view('inventory', {
    title: 'Inventory',
    render() {
      const S = E.S;
      const value = E.balance('1200');
      const low = S.items.filter(belowReorder);
      const units = S.items.reduce((a, i) => a + i.onHand, 0);
      const head = App.head('Supply chain', 'Inventory', 'Perpetual inventory at weighted average cost. Receipts raise cost, shipments and adjustments relieve it, and the item subledger ties to GL 1200.',
        App.btn('Adjust quantity', 'inv-adjust', {}, 'inv.adjust') + App.btn('New item', 'item-new', {}, 'item.edit', 'primary'));
      const kpis = `<div class="kpis">${App.kpi('Inventory value', fmt(value), 'GL 1200 balance')}${App.kpi('Items', num(S.items.length), 'Stocked SKUs')}${App.kpi('Below reorder point', num(low.length), low.length ? low.map((i) => esc(i.sku)).join(', ') : 'All items above reorder')}${App.kpi('Units on hand', num(units), 'All items')}</div>`;
      const tab = App.tabOf('inventory', 'items');
      const tabs = App.tabs('inventory', [['items', 'Items'], ['moves', `Movements (${S.invTxns.length})`]]);
      let body;
      if (tab === 'items') {
        const sub = U.sum(S.items, (i) => i.onHand * i.avgCost);
        body = App.table([
          { h: 'SKU', f: (i) => App.link('item', i.sku) },
          { h: 'Name', f: (i) => esc(i.name) },
          { h: 'UOM', f: (i) => esc(i.uom) },
          { h: 'On hand', num: true, f: (i) => num(i.onHand) },
          { h: 'Reorder point', num: true, f: (i) => num(i.reorder) },
          { h: 'Avg cost', num: true, f: (i) => fmt(i.avgCost) },
          { h: 'Value', num: true, f: (i) => fmt(i.onHand * i.avgCost) },
          { h: 'List price', num: true, f: (i) => fmt(i.price) },
          { h: 'Margin at list', num: true, f: (i) => pct((i.price - i.avgCost) / i.price) },
          { h: 'Status', f: (i) => belowReorder(i) ? pill('Below reorder', 'warn') : pill('In stock', 'good') },
          { h: '', f: (i) => `<div class="actions">${belowReorder(i) ? App.btn('Replenish', 'req-new', { sku: i.sku, qty: replenishQty(i) }, 'req.create', 'sm primary') : ''}${App.btn('Adjust', 'inv-adjust', { sku: i.sku }, 'inv.adjust', 'sm')}</div>` },
        ], S.items, { empty: 'No items yet. Use New item to add your first SKU.', foot: ['Total', '', '', num(S.items.reduce((a, i) => a + i.onHand, 0)), '', '', fmt(sub), '', '', '', ''] });
      } else {
        const f = App.ui.filter.inventory || '';
        const rows = S.invTxns.filter((t) => !f || t.sku === f);
        const filter = `<div class="pad" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">${App.field('Item', App.select('invFilter', [['', 'All items']].concat(App.itemOptions()), f, 'style="min-width:240px"'))}<span class="hint">${num(rows.length)} movement(s), net ${fmt(U.sum(rows, (t) => t.value))}</span></div>`;
        body = filter + App.table([
          { h: 'Date', f: (t) => fdate(t.date) },
          { h: 'Item', f: (t) => App.link('item', t.sku) },
          { h: 'Type', f: (t) => esc(t.type) },
          { h: 'Reference', f: (t) => App.refLink(t.ref) },
          { h: 'Qty', num: true, f: (t) => (t.qty > 0 ? '+' : '') + num(t.qty) },
          { h: 'Unit cost', num: true, f: (t) => fmt(t.unitCost) },
          { h: 'Value', num: true, f: (t) => fmt(t.value) },
          { h: 'On hand after', num: true, f: (t) => num(t.onHandAfter) },
        ], rows, { empty: f ? `No movements for ${esc(f)} yet.` : 'No inventory movements yet. Receipts, shipments and adjustments appear here.' });
      }
      return head + kpis + tabs + `<div class="card">${body}</div>`;
    },
    after(root) {
      const sel = App.$('#invFilter', root);
      if (sel) sel.addEventListener('change', () => { App.ui.filter.inventory = sel.value; App.render(); });
    },
  });

  // ---------- Sales orders ----------
  const openBooked = (cid) => U.sum(E.S.sos.filter((o) => o.customerId === cid && o.status === 'Booked'), (o) => o.total);

  App.act('so-new', () => {
    const custs = E.S.customers.filter((c) => c.active !== false);
    if (!custs.length) { App.toast('Add a customer before entering a sales order.', 'bad'); return; }
    const html = `<div class="row">${App.field('Customer', App.select('soCust', custs.map((c) => [c.id, c.name])))}${App.field('Customer PO no.', App.input('soPo', '', 'text', 'placeholder="e.g. CB-PO-7781"'))}${App.field('Order date', App.input('soDate', today(), 'date'))}</div>
      <div class="callout" id="soCredit"></div>`
      + App.lines('soLines', lineCols('Unit price', [{ key: 'avail', label: 'On hand', type: 'text', readonly: true, width: '110px' }]), [{}])
      + `<div class="callout" id="soInfo"></div>`;
    App.drawer('New sales order', html, {
      submitLabel: 'Book order',
      oninput: (f) => {
        const c = E.cust(App.val(f, 'soCust'));
        const t = syncLines(f, 'soLines', (x) => x.price, (tr, it, q) => {
          const el = App.$('[data-k="avail"]', tr); if (!el) return;
          el.value = it ? `${num(it.onHand)}${q > it.onHand ? ' (short)' : ''}` : '';
          el.style.color = it && q > it.onHand ? 'var(--bad)' : '';
        });
        const ar = E.openAR(c.id), ob = openBooked(c.id), avail = U.r2(c.creditLimit - ar), headroom = U.r2(c.creditLimit - ar - ob);
        App.$('#soCredit', f).innerHTML = `Credit limit <b class="num">${fmt(c.creditLimit)}</b>, open receivables <b class="num">${fmt(ar)}</b>, available credit <b class="num">${fmt(avail)}</b>.`
          + (ob ? ` Booked orders not yet shipped (<span class="num">${fmt(ob)}</span>) also count, leaving <b class="num">${fmt(headroom)}</b> for this order.` : '');
        const over = t > headroom;
        const box = App.$('#soInfo', f); box.className = 'callout' + (over ? ' warn' : '');
        box.innerHTML = `Order total <b class="num">${fmt(t)}</b>. ` + (over
          ? `This exceeds the customer's available credit by <b class="num">${fmt(t - headroom)}</b>. The order will be saved on Credit Hold until a Controller releases it.`
          : 'Within credit. The order will be booked and can ship as soon as stock is available.');
      },
      onSubmit: (f) => E.createSO({ customerId: App.val(f, 'soCust'), poNumber: App.val(f, 'soPo').trim(), date: App.val(f, 'soDate'), lines: cleanLines(f, 'soLines') }),
      success: (o) => o.status === 'Credit Hold' ? `${o.id} saved on credit hold: ${o.hold}. A Controller can release it.` : `${o.id} booked for ${fmt(o.total)}. Ready to ship.`,
    });
  });

  App.view('orders', {
    title: 'Sales orders',
    render() {
      const S = E.S;
      const booked = S.sos.filter((o) => o.status === 'Booked');
      const held = S.sos.filter((o) => o.status === 'Credit Hold');
      const cur = U.periodOf(today());
      const shipped = S.sos.filter((o) => o.status === 'Invoiced' && o.shipDate && U.periodOf(o.shipDate) === cur);
      const inv = S.sos.filter((o) => o.status === 'Invoiced' && typeof o.margin === 'number');
      const invRev = U.sum(inv, (o) => o.total);
      const head = App.head('Supply chain', 'Sales orders', 'Orders are credit-checked against each customer\'s limit when booked. Shipping relieves inventory at average cost and raises the customer invoice automatically.',
        App.btn('New sales order', 'so-new', {}, 'so.create', 'primary'));
      const flow = `<div class="card pad" style="margin-bottom:16px"><div class="small muted" style="margin-bottom:6px">Order to cash</div>${App.stepFlow(['Booked', 'Credit check (limit vs open AR + open orders)', 'Shipped (Dr 5000 / Cr 1200)', 'Invoiced (Dr 1100 / Cr 4000)', 'Paid (Dr 1000 / Cr 1100)'], -1)}</div>`;
      const kpis = `<div class="kpis">${App.kpi('Booked, not shipped', fmt(U.sum(booked, (o) => o.total)), `${booked.length} order(s)`)}${App.kpi('On credit hold', num(held.length), `${fmt(U.sum(held, (o) => o.total))} waiting for release`)}${App.kpi(`Shipped in ${U.periodLabel(cur)}`, fmt(U.sum(shipped, (o) => o.total)), `${shipped.length} order(s) invoiced`)}${App.kpi('Avg gross margin', inv.length ? pct(U.sum(inv, (o) => o.margin) / invRev) : '-', `Across ${inv.length} invoiced order(s)`)}</div>`;
      const rows = S.sos.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
      const body = App.table([
        { h: 'Order', f: (o) => App.link('so', o.id) },
        { h: 'Customer', f: (o) => App.link('cust', o.customerId, E.cust(o.customerId)?.name) },
        { h: 'Date', f: (o) => fdate(o.date) },
        { h: 'Customer PO', f: (o) => o.poNumber ? esc(o.poNumber) : '<span class="muted">None</span>' },
        { h: 'Total', num: true, f: (o) => fmt(o.total) },
        { h: 'Status', f: (o) => pill(o.status) + (o.status === 'Credit Hold' && o.hold ? `<div class="small muted">${esc(o.hold)}</div>` : '') + (o.invoiceId ? ` ${App.link('arinv', o.invoiceId)}` : '') },
        { h: '', f: (o) => `<div class="actions">${o.status === 'Booked' ? App.btn('Ship', 'so-ship', { id: o.id }, 'so.ship', 'sm primary') : ''}${o.status === 'Credit Hold' ? App.btn('Release', 'so-release', { id: o.id }, 'so.release', 'sm primary') : ''}${['Booked', 'Credit Hold'].includes(o.status) ? App.btn('Cancel', 'so-cancel', { id: o.id }, 'so.create', 'sm danger') : ''}</div>` },
      ], rows, { empty: 'No sales orders yet. Use New sales order to book one.' });
      return head + flow + kpis + `<div class="card">${body}</div>`;
    },
  });
})();
