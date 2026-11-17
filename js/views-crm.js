/* Ledgerline Suite — views-crm.js
 * Sales pipeline: Pipeline board with KPIs and forecast, Opportunities, Leads,
 * and the opportunity / lead / quote detail drawers (quote discount approval, accept -> sales order).
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, fmt0 = App.fmt0, num = App.num, fdate = App.fdate, pill = App.pill;
  const F = App.ui.filter;
  const today = () => E.S.today;
  const cname = (id) => E.cust(id)?.name || id;
  const ename = (id) => E.emp(id)?.name || id;
  const pctTxt = (x) => (x == null ? 'n/a' : Math.round(x * 100) + '%');
  const STAGE_TONE = { Qualify: '', Develop: 'info', Propose: 'info', Negotiate: 'warn', Won: 'good', Lost: 'bad' };
  const LEAD_TONE = { New: 'info', Working: 'warn', Qualified: 'good', Disqualified: '' };
  const QUOTE_TONE = { Draft: '', 'Pending Approval': 'warn', Approved: 'good', Sent: 'info', Accepted: 'good', Expired: '' };
  const stagePill = (s) => pill(`${s} ${Math.round(E.CRM_PROB[s] * 100)}%`, STAGE_TONE[s]);
  const repOpts = () => E.salesReps().map((e) => [e.id, `${e.name}, ${e.title}`]);
  const defaultRep = () => (E.S.employees.find((e) => e.name === E.S.user && e.dept === 'Sales') || E.salesReps()[0] || {}).id;

  App.refKind('OPP-', 'opp'); App.refKind('LEAD-', 'lead'); App.refKind('QT-', 'quote');
  App.navCount('leads', () => E.S.leads.filter((l) => l.status === 'New').length);

  // ---------- drawers ----------
  function oppDrawer(prefill = {}) {
    const custs = E.S.customers.filter((c) => c.active !== false);
    App.drawer('New opportunity', `<div class="row">${App.field('Customer', App.select('opCust', custs.map((c) => [c.id, c.name]), prefill.customerId))}${App.field('Owner', App.select('opOwner', repOpts(), defaultRep()))}</div>`
      + App.field('Opportunity name', App.input('opName', '', 'text', 'placeholder="e.g. Water lab refresh, 40 probes"'))
      + `<div class="row">${App.field('Amount', App.input('opAmt', '', 'number', 'step="0.01" min="0"'))}${App.field('Stage', App.select('opStage', E.CRM_OPEN_STAGES.map((s) => [s, `${s} (${Math.round(E.CRM_PROB[s] * 100)}%)`])))}${App.field('Expected close', App.input('opClose', U.addDays(today(), 60), 'date'))}</div>`
      + `<div class="row">${App.field('Next step', App.input('opNext'))}${App.field('Competitor', App.input('opComp'))}</div><div class="callout" id="opInfo"></div>`, {
      submitLabel: 'Create opportunity',
      oninput: (f) => { const a = +App.val(f, 'opAmt') || 0, s = App.val(f, 'opStage'); App.$('#opInfo', f).innerHTML = `Weighted value <b class="num">${fmt(a * E.CRM_PROB[s])}</b> (${fmt(a)} at ${Math.round(E.CRM_PROB[s] * 100)}%). Opportunities are won by accepting a quote, which books the sales order.`; },
      onSubmit: (f) => E.createOpp({ customerId: App.val(f, 'opCust'), ownerId: App.val(f, 'opOwner'), name: App.val(f, 'opName'), amount: App.val(f, 'opAmt'), stage: App.val(f, 'opStage'), closeDate: App.val(f, 'opClose'), nextStep: App.val(f, 'opNext'), competitor: App.val(f, 'opComp'), date: today() }),
      success: (o) => `${o.id} created for ${cname(o.customerId)}.`,
    });
  }
  App.act('opp-new', (ds) => oppDrawer({ customerId: ds.cust }));

  App.act('lead-new', () => {
    App.drawer('New lead', `<div class="row">${App.field('Contact name', App.input('ldName'))}${App.field('Company', App.input('ldCo'))}</div>`
      + `<div class="row">${App.field('Email', App.input('ldEmail', '', 'email'))}${App.field('Source', App.select('ldSrc', E.LEAD_SOURCES))}${App.field('Owner', App.select('ldOwner', repOpts(), defaultRep()))}</div>`
      + App.field('Notes', App.input('ldNote')), {
      submitLabel: 'Create lead',
      onSubmit: (f) => E.createLead({ name: App.val(f, 'ldName'), company: App.val(f, 'ldCo'), email: App.val(f, 'ldEmail'), source: App.val(f, 'ldSrc'), ownerId: App.val(f, 'ldOwner'), note: App.val(f, 'ldNote'), date: today() }),
      success: (l) => `${l.id} created for ${l.company}.`,
    });
  });

  App.act('lead-convert', (ds) => {
    const l = E.lead(ds.id); const existing = E.S.customers.find((c) => c.name.toLowerCase() === l.company.toLowerCase());
    App.drawer(`Convert ${l.id} to an opportunity`, App.stepFlow(['Lead', 'Qualified', 'Opportunity', 'Quote', 'Sales order'], 2)
      + `<div class="callout ${existing ? '' : 'warn'}">${existing ? `${esc(l.company)} is already customer ${App.link('cust', existing.id, existing.id)}; the opportunity will be linked to it.` : `${esc(l.company)} is not a customer yet. Converting creates the customer with a credit limit of <b class="num">${fmt(E.NEW_CUSTOMER_LIMIT)}</b> and Net 30 terms.`}</div>`
      + App.field('Opportunity name', App.input('cvName', `${l.company}: initial order`))
      + `<div class="row">${App.field('Estimated amount', App.input('cvAmt', '0', 'number', 'step="0.01" min="0"'))}${App.field('Expected close', App.input('cvClose', U.addDays(today(), 90), 'date'))}</div>`, {
      submitLabel: 'Convert lead',
      onSubmit: (f) => E.convertLead(l.id, { name: App.val(f, 'cvName'), amount: App.val(f, 'cvAmt'), closeDate: App.val(f, 'cvClose'), date: today() }),
      success: (r) => `${r.lead.id} converted to ${r.opp.id}${r.createdCustomer ? `; customer ${r.customer.id} created` : ''}.`,
    });
  });
  App.act('lead-status', (ds) => {
    if (ds.status !== 'Disqualified') { App.try(() => E.setLeadStatus(ds.id, ds.status), `${ds.id} is now ${ds.status}.`); return; }
    App.drawer(`Disqualify ${ds.id}`, App.field('Reason', App.input('dqWhy', '', 'text', 'placeholder="e.g. No budget this year"')), { submitLabel: 'Disqualify', onSubmit: (f) => E.setLeadStatus(ds.id, 'Disqualified', App.val(f, 'dqWhy')), success: `${ds.id} disqualified.` });
  });

  App.act('opp-next', (ds) => App.try(() => E.advanceOpp(ds.id, today()), (o) => `${o.id} moved to ${o.stage} (${Math.round(E.CRM_PROB[o.stage] * 100)}%).`));
  App.act('opp-lost', (ds) => App.drawer(`Mark ${ds.id} lost`, App.field('Reason', App.input('lostWhy', '', 'text', 'placeholder="e.g. Lost on price to competitor"')) + App.field('Competitor', App.input('lostComp', E.opp(ds.id).competitor)), {
    submitLabel: 'Mark lost', onSubmit: (f) => { if (App.val(f, 'lostComp') !== E.opp(ds.id).competitor) E.updateOpp(ds.id, { competitor: App.val(f, 'lostComp') }); return E.setOppStage(ds.id, 'Lost', { reason: App.val(f, 'lostWhy'), date: today() }); }, success: `${ds.id} closed as lost.` }));
  App.act('opp-edit', (ds) => { const o = E.opp(ds.id);
    App.drawer(`Edit ${o.id}`, App.field('Name', App.input('oeName', o.name)) + `<div class="row">${App.field('Amount', App.input('oeAmt', o.amount, 'number', 'step="0.01" min="0"'))}${App.field('Expected close', App.input('oeClose', o.closeDate, 'date'))}${App.field('Owner', App.select('oeOwner', repOpts(), o.ownerId))}</div>`
      + `<div class="row">${App.field('Next step', App.input('oeNext', o.nextStep))}${App.field('Competitor', App.input('oeComp', o.competitor))}</div>`,
    { submitLabel: 'Save', onSubmit: (f) => E.updateOpp(o.id, { name: App.val(f, 'oeName'), amount: App.val(f, 'oeAmt'), closeDate: App.val(f, 'oeClose'), ownerId: App.val(f, 'oeOwner'), nextStep: App.val(f, 'oeNext'), competitor: App.val(f, 'oeComp') }), success: `${o.id} updated.` });
  });
  App.act('act-new', (ds) => { const t = E.lead(ds.id) || E.opp(ds.id);
    App.drawer(`Log activity on ${ds.id}`, `<div class="row">${App.field('Type', App.select('acType', E.ACTIVITY_TYPES))}${App.field('Date', App.input('acDate', today(), 'date'))}${App.field('Owner', App.select('acOwner', repOpts(), t.ownerId))}</div>${App.field('Note', App.input('acNote', '', 'text', 'placeholder="What happened, what was agreed"'))}`,
      { submitLabel: 'Log activity', onSubmit: (f) => E.logActivity({ refId: ds.id, type: App.val(f, 'acType'), date: App.val(f, 'acDate'), ownerId: App.val(f, 'acOwner'), note: App.val(f, 'acNote') }), success: 'Activity logged.' });
  });

  // ---------- quote drawer ----------
  function syncQuote(f) {
    let total = 0, list = 0, maxD = 0;
    App.$$('#qtLines tbody tr', f).forEach((tr) => {
      const it = E.item(App.$('[data-k="sku"]', tr).value), q = +App.$('[data-k="qty"]', tr).value || 0, d = +App.$('[data-k="discountPct"]', tr).value || 0;
      const lp = App.$('[data-k="listPrice"]', tr), np = App.$('[data-k="price"]', tr), am = App.$('[data-k="amount"]', tr);
      const net = it ? U.r2(it.price * (1 - d / 100)) : 0;
      lp.value = it ? fmt(it.price) : ''; np.value = it ? fmt(net) : ''; am.value = it && q ? fmt(net * q) : '';
      if (it) { total += net * q; list += it.price * q; maxD = Math.max(maxD, d); }
    });
    const over = maxD > E.QUOTE_DISCOUNT_LIMIT; const box = App.$('#qtInfo', f); box.className = 'callout' + (over ? ' warn' : '');
    box.innerHTML = `Quote total <b class="num">${fmt(total)}</b> (list ${fmt(list)}, discount ${fmt(list - total)}). ` + (over
      ? `A line discount of ${maxD}% is above the ${E.QUOTE_DISCOUNT_LIMIT}% limit, so the quote goes to a Controller for discount approval before it can be sent or accepted.`
      : `All discounts are within ${E.QUOTE_DISCOUNT_LIMIT}%, so the quote can be sent straight away.`);
  }
  App.act('quote-new', (ds) => { const o = E.opp(ds.opp);
    const cols = [{ key: 'sku', label: 'Item', type: 'select', options: [['', 'Choose an item']].concat(App.itemOptions()) }, { key: 'qty', label: 'Qty', type: 'number', width: '80px' },
      { key: 'listPrice', label: 'List price', type: 'text', readonly: true, width: '110px' }, { key: 'discountPct', label: 'Disc. %', type: 'number', width: '80px' },
      { key: 'price', label: 'Net price', type: 'text', readonly: true, width: '110px' }, { key: 'amount', label: 'Amount', type: 'text', readonly: true, width: '120px' }];
    App.drawer(`New quote for ${o.id}`, `<p>${esc(cname(o.customerId))}: ${esc(o.name)}</p><div class="row">${App.field('Quote date', App.input('qtDate', today(), 'date'))}${App.field('Valid until', App.input('qtValid', U.addDays(today(), 30), 'date'))}</div>`
      + App.lines('qtLines', cols, [{ discountPct: 0 }]) + App.field('Note', App.input('qtNote')) + `<div class="callout" id="qtInfo"></div>`, {
      submitLabel: 'Create quote', oninput: syncQuote,
      onSubmit: (f) => E.createQuote({ oppId: o.id, date: App.val(f, 'qtDate'), validUntil: App.val(f, 'qtValid'), note: App.val(f, 'qtNote'), lines: App.readLines(f, 'qtLines').filter((l) => l.sku || l.qty).map((l) => ({ sku: l.sku, qty: l.qty, discountPct: l.discountPct })) }),
      success: (q) => q.status === 'Pending Approval' ? `${q.id} sent for discount approval (${q.maxDiscount}% line discount).` : `${q.id} created for ${fmt(q.total)}.`,
    });
  });
  App.act('quote-approve', (ds) => App.try(() => E.approveQuote(ds.id), `${ds.id} discount approved.`));
  App.act('quote-reject', (ds) => App.drawer(`Reject discount on ${ds.id}`, App.field('Reason', App.input('qrWhy', 'Discount above policy; requote within 15%')), { submitLabel: 'Reject', onSubmit: (f) => E.rejectQuote(ds.id, App.val(f, 'qrWhy')), success: `${ds.id} returned to Draft.` }));
  App.act('quote-send', (ds) => App.try(() => E.sendQuote(ds.id, today()), `${ds.id} sent to the customer.`));
  App.act('quote-accept', (ds) => { const q = E.quote(ds.id); const c = E.cust(q.customerId); const ar = E.openAR(c.id);
    const gross = (o) => (E.soGross ? E.soGross(o) : o.total);
    const booked = U.sum(E.S.sos.filter((o) => o.customerId === c.id && o.status === 'Booked'), gross);
    const qGross = U.r2(q.total * (1 + (E.taxRate ? E.taxRate(c.taxCode) : 0)));
    const over = U.r2(ar + booked + qGross) > c.creditLimit;
    App.drawer(`Accept ${q.id}`, App.stepFlow(['Quote', 'Accepted', 'Sales order', 'Credit check', 'Ship'], 1)
      + `<p>Books a sales order for ${esc(c.name)} at the quoted net prices (<b class="num">${fmt(q.total)}</b>) and marks ${App.link('opp', q.oppId)} Won.</p>`
      + `<div class="row">${App.field('Acceptance date', App.input('qaDate', today(), 'date'))}${App.field('Customer PO no.', App.input('qaPo', '', 'text', `placeholder="defaults to ${esc(q.id)}"`))}</div>`
      + `<div class="callout ${over ? 'warn' : ''}">Credit limit <span class="num">${fmt(c.creditLimit)}</span>, open receivables <span class="num">${fmt(ar)}</span>, booked orders <span class="num">${fmt(booked)}</span>, this order incl. tax <span class="num">${fmt(qGross)}</span>. ${over ? 'This order takes the customer over its limit, so it will be saved on <b>Credit Hold</b> until a Controller releases it.' : 'Within credit: the order will be booked and ready to ship.'}</div>`, {
      submitLabel: 'Accept and book order',
      onSubmit: (f) => E.acceptQuote(q.id, { date: App.val(f, 'qaDate'), poNumber: App.val(f, 'qaPo') }),
      success: (r) => r.so.status === 'Credit Hold' ? `${r.quote.id} accepted. ${r.so.id} is on Credit Hold: ${r.so.hold}. ${r.opp.id} won.` : `${r.quote.id} accepted. ${r.so.id} booked for ${fmt(r.so.total)}. ${r.opp.id} won.`,
    });
  });

  // ---------- detail drawers ----------
  const actTable = (list) => App.table([{ h: 'Date', f: (a) => `<span style="white-space:nowrap">${fdate(a.date)}</span>` }, { h: 'Type', f: (a) => esc(a.type) }, { h: 'Owner', f: (a) => esc(ename(a.ownerId)) }, { h: 'Note', f: (a) => esc(a.note) }],
    list.slice().sort((a, b) => b.date.localeCompare(a.date)), { empty: 'No activities logged yet.' });
  const quoteTable = (list) => App.table([{ h: 'Quote', f: (q) => App.link('quote', q.id) }, { h: 'Date', f: (q) => fdate(q.date) }, { h: 'Valid until', f: (q) => fdate(q.validUntil) }, { h: 'Total', num: true, f: (q) => fmt(q.total) }, { h: 'Max disc.', num: true, f: (q) => q.maxDiscount + '%' }, { h: 'Status', f: (q) => pill(q.status, QUOTE_TONE[q.status]) + (q.soId ? ' ' + App.link('so', q.soId) : '') }], list, { empty: 'No quotes yet.' });
  const isOpenOpp = (o) => E.CRM_OPEN_STAGES.includes(o.stage);
  const oppButtons = (o, sm = '') => {
    if (!isOpenOpp(o)) return '';
    const n = E.oppNextStage(o.stage);
    return (n ? App.btn(`Move to ${n}`, 'opp-next', { id: o.id }, 'crm.edit', 'primary' + sm) : '')
      + App.btn('New quote', 'quote-new', { opp: o.id }, 'crm.edit', sm.trim())
      + App.btn('Log activity', 'act-new', { id: o.id }, 'crm.edit', sm.trim());
  };

  App.detail('opp', (id) => { const o = E.opp(id); if (!o) return null;
    const idx = o.stage === 'Lost' ? -1 : ['Qualify', 'Develop', 'Propose', 'Negotiate', 'Won'].indexOf(o.stage);
    const quotes = E.S.quotes.filter((q) => q.oppId === id);
    return { title: `${o.id} ${o.name}`, html: App.stepFlow(['Qualify 10%', 'Develop 30%', 'Propose 50%', 'Negotiate 75%', 'Won 100%'], o.stage === 'Won' ? 5 : idx)
      + (o.stage === 'Lost' ? `<div class="callout bad">${pill('Lost', 'bad')} ${esc(o.lostReason || '')}</div>` : '')
      + App.dl([['Customer', App.link('cust', o.customerId, cname(o.customerId))], ['Stage', stagePill(o.stage)], ['Amount', `<span class="num">${fmt(o.amount)}</span>`], ['Weighted', `<span class="num">${fmt(E.oppWeighted(o))}</span>`], ['Expected close', fdate(o.closeDate)], ['Owner', App.link('emp', o.ownerId, ename(o.ownerId))],
        ['Next step', esc(o.nextStep) || '<span class="muted">None</span>'], ['Competitor', esc(o.competitor) || '<span class="muted">None known</span>'], o.leadId && ['Source lead', App.link('lead', o.leadId)], o.soId && ['Sales order', App.link('so', o.soId) + ' ' + pill(E.so(o.soId)?.status || '')]])
      + '<h3 style="margin:0;font-size:14px">Quotes</h3>' + quoteTable(quotes)
      + '<h3 style="margin:0;font-size:14px">Stage history</h3>' + App.table([{ h: 'Date', f: (x) => fdate(x.date) }, { h: 'Stage', f: (x) => stagePill(x.stage) }, { h: 'By', f: (x) => esc(x.by) }, { h: 'Note', f: (x) => esc(x.note || '') }], o.history.slice().reverse())
      + '<h3 style="margin:0;font-size:14px">Activities</h3>' + actTable(E.S.activities.filter((a) => a.refId === id || a.oppId === id)),
      buttons: isOpenOpp(o) ? App.btn('Mark lost', 'opp-lost', { id }, 'crm.edit', 'danger') + App.btn('Edit', 'opp-edit', { id }, 'crm.edit') + oppButtons(o) : '' };
  });

  App.detail('lead', (id) => { const l = E.lead(id); if (!l) return null;
    const open = !l.oppId;
    return { title: `${l.id} ${l.name}`, html: App.dl([['Company', esc(l.company)], ['Status', pill(l.status, LEAD_TONE[l.status])], ['Source', esc(l.source)], ['Owner', App.link('emp', l.ownerId, ename(l.ownerId))], ['Created', fdate(l.date)], ['Email', esc(l.email) || '<span class="muted">None</span>'],
      l.oppId && ['Opportunity', App.link('opp', l.oppId)], l.customerId && ['Customer', App.link('cust', l.customerId, cname(l.customerId))], l.reason && ['Disqualified because', esc(l.reason)]])
      + (l.note ? `<p>${esc(l.note)}</p>` : '') + '<h3 style="margin:0;font-size:14px">Activities</h3>' + actTable(E.S.activities.filter((a) => a.refId === id)),
      buttons: open ? (l.status === 'Disqualified' ? App.btn('Reopen', 'lead-status', { id, status: 'Working' }, 'crm.edit')
        : App.btn('Disqualify', 'lead-status', { id, status: 'Disqualified' }, 'crm.edit', 'danger') + (l.status === 'New' ? App.btn('Start working', 'lead-status', { id, status: 'Working' }, 'crm.edit') : '') + App.btn('Log activity', 'act-new', { id }, 'crm.edit') + App.btn('Convert to opportunity', 'lead-convert', { id }, 'crm.edit', 'primary')) : '' };
  });

  App.detail('quote', (id) => { const q = E.quote(id); if (!q) return null; const o = E.opp(q.oppId);
    const cur = { Draft: 0, 'Pending Approval': 1, Approved: 2, Sent: 3, Accepted: 5, Expired: -1 }[q.status];
    const cleared = !q.needsApproval || q.approvedBy;
    const openOpp = o && isOpenOpp(o);
    const sod = q.status === 'Pending Approval' && q.createdBy === E.S.user && E.S.role !== 'Administrator';
    let buttons = '';
    if (q.status === 'Pending Approval') buttons = sod ? '<span class="muted small">You created this quote, so another approver must review the discount.</span>' : App.btn('Reject', 'quote-reject', { id }, 'crm.discount', 'danger') + App.btn('Approve discount', 'quote-approve', { id }, 'crm.discount', 'primary');
    else if (openOpp && ['Draft', 'Approved', 'Sent'].includes(q.status) && cleared) buttons = (q.status !== 'Sent' ? App.btn('Mark sent', 'quote-send', { id }, 'crm.edit') : '') + App.btn('Accept quote', 'quote-accept', { id }, 'crm.edit', 'primary');
    return { title: `Quote ${q.id}`, html: App.stepFlow(['Draft', 'Discount approval', 'Approved', 'Sent', 'Accepted'], cur)
      + App.dl([['Status', pill(q.status, QUOTE_TONE[q.status])], ['Customer', App.link('cust', q.customerId, cname(q.customerId))], ['Opportunity', App.link('opp', q.oppId)], ['Quote date', fdate(q.date)], ['Valid until', fdate(q.validUntil)], ['Total', `<span class="num">${fmt(q.total)}</span>`], ['List value', `<span class="num">${fmt(q.listTotal)}</span>`], ['Discount', `<span class="num">${fmt(q.discount)}</span>`], ['Prepared by', esc(q.createdBy)], q.approvedBy && ['Discount approved by', esc(q.approvedBy)], q.soId && ['Sales order', App.link('so', q.soId) + ' ' + pill(E.so(q.soId)?.status || '')]])
      + (q.status === 'Pending Approval' ? `<div class="callout warn">Line discount of ${q.maxDiscount}% is above the ${E.QUOTE_DISCOUNT_LIMIT}% limit. A Controller must approve it before the quote can be sent or accepted.</div>` : '')
      + (q.rejected && q.status === 'Draft' ? `<div class="callout bad">Discount rejected by ${esc(q.rejectedBy)}: ${esc(q.rejectReason)}. Raise a new quote within ${E.QUOTE_DISCOUNT_LIMIT}%.</div>` : '')
      + (q.soId && E.so(q.soId)?.status === 'Credit Hold' ? `<div class="callout bad">${App.link('so', q.soId)} is on Credit Hold: ${esc(E.so(q.soId).hold)}</div>` : '')
      + App.table([{ h: 'Item', f: (l) => App.link('item', l.sku) + ' ' + esc(E.item(l.sku)?.name) }, { h: 'Qty', num: true, f: (l) => num(l.qty) }, { h: 'List', num: true, f: (l) => fmt(l.listPrice) }, { h: 'Disc.', num: true, f: (l) => `${l.discountPct}%${l.discountPct > E.QUOTE_DISCOUNT_LIMIT ? ' ' + pill('Over limit', 'warn') : ''}` }, { h: 'Net price', num: true, f: (l) => fmt(l.price) }, { h: 'Amount', num: true, f: (l) => fmt(l.amount) }], q.lines, { foot: ['Total', '', '', '', '', fmt(q.total)] })
      + (q.note ? `<p class="muted">${esc(q.note)}</p>` : ''),
      buttons };
  });

  // ---------- Pipeline ----------
  const card = (o) => `<div class="card pad" style="padding:10px 12px;display:flex;flex-direction:column;gap:4px">
      <div>${App.link('opp', o.id)} <span class="small muted">${esc(o.name)}</span></div>
      <div class="small"><b>${esc(cname(o.customerId))}</b></div>
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><span class="num">${fmt0(o.amount)}</span><span class="small muted">close ${fdate(o.closeDate)}</span></div>
      <div class="small muted">${esc(ename(o.ownerId))}${o.soId ? ' · ' + App.link('so', o.soId) : ''}</div>
      ${isOpenOpp(o) ? `<div class="actions" style="margin-top:4px">${E.oppNextStage(o.stage) ? App.btn('Move to next stage', 'opp-next', { id: o.id }, 'crm.edit', 'sm') : App.btn('Quote', 'quote-new', { opp: o.id }, 'crm.edit', 'sm')}</div>` : ''}</div>`;

  App.view('pipeline', {
    title: 'Pipeline', group: 'Sales',
    render() {
      const s = E.pipelineSummary();
      const head = App.head('Sales', 'Pipeline', 'Opportunities by stage. Weighted value is amount times the stage probability. Accepting a quote books a sales order (with the usual credit check) and wins the deal.',
        App.btn('New opportunity', 'opp-new', {}, 'crm.edit', 'primary'));
      const kpis = `<div class="kpis">${App.kpi('Open pipeline', fmt0(s.openAmount), `${s.openCount} open opportunities`)}${App.kpi('Weighted pipeline', fmt0(s.weighted), 'Amount x stage probability')}${App.kpi('Win rate', pctTxt(s.winRate), `${s.wonCount} won, ${s.lostCount} lost`)}${App.kpi('Average deal size', fmt0(s.avgDeal), `Won deals, ${fmt0(s.wonAmount)} total`)}</div>`;
      const showClosed = !!F.pipeClosed;
      const stages = E.CRM_STAGES.map(([st]) => st).filter((st) => showClosed || E.CRM_OPEN_STAGES.includes(st));
      const board = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:16px">${stages.map((st) => {
        const list = E.S.opps.filter((o) => o.stage === st).sort((a, b) => a.closeDate.localeCompare(b.closeDate)); const sm = s.byStage.find((x) => x.stage === st);
        return `<section class="card" style="background:var(--surface-2)" aria-label="${esc(st)} stage"><div class="card-h"><span>${stagePill(st)} <span class="muted small">${list.length}</span></span><span class="num small">${fmt0(sm.amount)}</span></div>
          <div class="pad" style="display:flex;flex-direction:column;gap:8px;padding:10px">${list.map(card).join('') || '<div class="empty" style="padding:12px">No deals</div>'}</div></section>`;
      }).join('')}</div>`;
      const toggle = `<div style="margin-bottom:10px"><button type="button" class="btn sm" data-act="pipe-closed" aria-pressed="${showClosed}">${showClosed ? 'Hide won and lost' : 'Show won and lost'}</button></div>`;
      const fc = E.forecastByMonth();
      const fcCard = `<section class="card"><div class="card-h"><span>Forecast by expected close month</span></div>${App.table([{ h: 'Month', f: (r) => esc(U.periodLabel(r.period)) }, { h: 'Deals', num: true, f: (r) => r.count }, { h: 'Pipeline', num: true, f: (r) => fmt(r.amount) }, { h: 'Weighted forecast', num: true, f: (r) => fmt(r.weighted) }], fc, { empty: 'No open opportunities.', foot: ['Total', U.sum(fc, (r) => r.count), fmt(U.sum(fc, (r) => r.amount)), fmt(U.sum(fc, (r) => r.weighted))] })}</section>`;
      const reps = E.repSummary();
      const repCard = `<section class="card"><div class="card-h"><span>By sales rep</span></div>${App.table([{ h: 'Rep', f: (r) => App.link('emp', r.ownerId, r.name) }, { h: 'Open', num: true, f: (r) => r.open }, { h: 'Pipeline', num: true, f: (r) => fmt0(r.pipeline) }, { h: 'Weighted', num: true, f: (r) => fmt0(r.weighted) }, { h: 'Won', num: true, f: (r) => `${r.won} (${fmt0(r.wonAmount)})` }, { h: 'Win rate', num: true, f: (r) => pctTxt(r.winRate) }, { h: 'Open leads', num: true, f: (r) => r.leads }], reps)}</section>`;
      return head + kpis + toggle + board + `<div class="grid g2">${fcCard}${repCard}</div>`;
    },
  });
  App.act('pipe-closed', () => { F.pipeClosed = !F.pipeClosed; App.render(); });

  // ---------- Opportunities ----------
  App.view('opportunities', {
    title: 'Opportunities', group: 'Sales',
    render() {
      const f = F.oppStage || 'open';
      const rows = E.S.opps.filter((o) => f === 'all' || (f === 'open' ? isOpenOpp(o) : o.stage === f)).sort((a, b) => a.closeDate.localeCompare(b.closeDate));
      const head = App.head('Sales', 'Opportunities', 'Every deal in the pipeline with its stage, probability and next step. Quotes over a 15% line discount need a Controller\'s approval.', App.btn('New opportunity', 'opp-new', {}, 'crm.edit', 'primary'));
      const filter = `<div class="pad" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">${App.field('Show', App.select('oppStage', [['open', 'Open opportunities'], ['all', 'All'], ...E.CRM_STAGES.map(([s]) => [s, s])], f))}<span class="hint">${rows.length} opportunity(ies), ${fmt0(U.sum(rows, (o) => o.amount))}, weighted ${fmt0(U.sum(rows, E.oppWeighted))}</span></div>`;
      const body = App.table([
        { h: 'Opportunity', f: (o) => App.link('opp', o.id) + `<div class="small">${esc(o.name)}</div>` },
        { h: 'Customer', f: (o) => App.link('cust', o.customerId, cname(o.customerId)) },
        { h: 'Owner', f: (o) => esc(ename(o.ownerId)) },
        { h: 'Stage', f: (o) => stagePill(o.stage) },
        { h: 'Amount', num: true, f: (o) => fmt(o.amount) },
        { h: 'Weighted', num: true, f: (o) => fmt(E.oppWeighted(o)) },
        { h: 'Close', f: (o) => `<span style="white-space:nowrap">${fdate(o.closeDate)}</span>` },
        { h: 'Next step', f: (o) => esc(o.nextStep) + (o.competitor ? `<div class="small muted">vs ${esc(o.competitor)}</div>` : '') + (o.soId ? `<div>${App.link('so', o.soId)}</div>` : '') },
        { h: '', f: (o) => `<div class="actions">${oppButtons(o, ' sm')}</div>` },
      ], rows, { empty: 'No opportunities match this filter.', foot: ['Total', '', '', '', fmt(U.sum(rows, (o) => o.amount)), fmt(U.sum(rows, E.oppWeighted)), '', '', ''] });
      const quotes = E.S.quotes.slice().sort((a, b) => b.date.localeCompare(a.date));
      const qCard = `<section class="card" style="margin-top:16px"><div class="card-h"><span>Quotes</span></div>${App.table([{ h: 'Quote', f: (q) => App.link('quote', q.id) }, { h: 'Opportunity', f: (q) => App.link('opp', q.oppId) }, { h: 'Customer', f: (q) => esc(cname(q.customerId)) }, { h: 'Date', f: (q) => fdate(q.date) }, { h: 'Total', num: true, f: (q) => fmt(q.total) }, { h: 'Max disc.', num: true, f: (q) => q.maxDiscount + '%' }, { h: 'Status', f: (q) => pill(q.status, QUOTE_TONE[q.status]) + (q.soId ? ' ' + App.link('so', q.soId) : '') }], quotes, { empty: 'No quotes yet. Open an opportunity and use New quote.' })}</section>`;
      return head + `<section class="card">${filter}${body}</section>` + qCard;
    },
    after(root) { const s = root.querySelector('#oppStage'); if (s) s.addEventListener('change', () => { F.oppStage = s.value; App.render(); }); },
  });

  // ---------- Leads ----------
  App.view('leads', {
    title: 'Leads', group: 'Sales',
    render() {
      const f = F.leadStatus || 'active';
      const rows = E.S.leads.filter((l) => f === 'all' || (f === 'active' ? !l.oppId && l.status !== 'Disqualified' : l.status === f)).sort((a, b) => b.date.localeCompare(a.date));
      const head = App.head('Sales', 'Leads', `Prospects not yet qualified into opportunities. Converting a lead creates the opportunity and, for a new company, the customer record (credit limit ${fmt0(E.NEW_CUSTOMER_LIMIT)}, Net 30).`, App.btn('New lead', 'lead-new', {}, 'crm.edit', 'primary'));
      const kpis = `<div class="kpis">${['New', 'Working', 'Qualified', 'Disqualified'].map((s) => App.kpi(s, num(E.S.leads.filter((l) => l.status === s).length), s === 'Qualified' ? `${E.S.leads.filter((l) => l.oppId).length} converted` : '')).join('')}</div>`;
      const filter = `<div class="pad" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">${App.field('Show', App.select('leadStatus', [['active', 'Open leads (not converted)'], ['all', 'All'], ...E.LEAD_STATUSES.map((s) => [s, s])], f))}<span class="hint">${rows.length} lead(s)</span></div>`;
      const body = App.table([
        { h: 'Lead', f: (l) => App.link('lead', l.id) + `<div class="small">${esc(l.name)}</div>` },
        { h: 'Company', f: (l) => esc(l.company) + (l.customerId ? `<div>${App.link('cust', l.customerId)}</div>` : '') },
        { h: 'Source', f: (l) => esc(l.source) },
        { h: 'Owner', f: (l) => esc(ename(l.ownerId)) },
        { h: 'Created', f: (l) => `<span style="white-space:nowrap">${fdate(l.date)}</span>` },
        { h: 'Status', f: (l) => pill(l.status, LEAD_TONE[l.status]) + (l.oppId ? ` ${App.link('opp', l.oppId)}` : '') },
        { h: '', f: (l) => l.oppId || l.status === 'Disqualified' ? '' : `<div class="actions">${App.btn('Convert', 'lead-convert', { id: l.id }, 'crm.edit', 'sm primary')}${App.btn('Disqualify', 'lead-status', { id: l.id, status: 'Disqualified' }, 'crm.edit', 'sm danger')}</div>` },
      ], rows, { empty: 'No leads match this filter.' });
      return head + kpis + `<section class="card">${filter}${body}</section>`;
    },
    after(root) { const s = root.querySelector('#leadStatus'); if (s) s.addEventListener('change', () => { F.leadStatus = s.value; App.render(); }); },
  });
})();
