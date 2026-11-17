/* Ledgerline Suite — views-home.js
 * Overview and administration pages: Home dashboard, Approvals inbox,
 * Audit trail, and Roles and access.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, fdate = App.fdate, pill = App.pill;

  // ---------- shared helpers ----------
  const latestOpen = () => { const o = App.openPeriods(); return o.length ? o[o.length - 1] : null; };
  const earliestOpen = () => App.openPeriods()[0] || null;
  /** Compact currency for axis labels: $0, $50k, $400k, $1.2M */
  const compact = (n) => {
    const a = Math.abs(n), s = n < 0 ? '-$' : '$';
    if (a >= 1e6) return s + (+(a / 1e6).toFixed(a % 1e6 ? 1 : 0)) + 'M';
    if (a >= 1e3) return s + (+(a / 1e3).toFixed(a % 1e3 >= 100 ? 1 : 0)) + 'k';
    return s + Math.round(a);
  };
  const niceStep = (raw) => {
    if (!(raw > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  };
  const timeOf = (ts) => { const t = String(ts || ''); return t.length >= 16 ? t.slice(11, 16) : ''; };
  // S.audit is newest-first by insertion; order by business date, then insertion (seed closes Jul-Sep last but dated Oct).
  const auditSorted = () => E.S.audit.map((a, i) => ({ a, i })).sort((x, y) => String(y.a.date).localeCompare(String(x.a.date)) || x.i - y.i).map((x) => x.a);
  /** App.refLink plus the document kinds it does not recognise (requisitions, absences, employees). */
  const refLink = (ref) => {
    const r = String(ref || '');
    if (/^REQ-\d+$/.test(r) && E.req(r)) return App.link('req', r);
    if (/^ABS-\d+$/.test(r) && E.S.absences.some((a) => a.id === r)) return App.link('abs', r);
    if (/^E-\d+$/.test(r) && E.emp(r)) return App.link('emp', r);
    return App.refLink(r);
  };
  const when = (a) => `<span class="mono small" style="white-space:nowrap">${esc(fdate(a.date))}${timeOf(a.ts) ? ' ' + esc(timeOf(a.ts)) : ''}</span>`;
  const KIND_LABEL = { req: 'Requisitions', je: 'Journals', apinv: 'Invoice holds', so: 'Credit holds', abs: 'Absence requests' };
  const KIND_ORDER = ['req', 'je', 'apinv', 'so', 'abs'];
  const cap = (k) => String(k).charAt(0).toUpperCase() + String(k).slice(1);
  /** Core kinds first, then any extension kinds in the order they appear. */
  const kindsOf = (inbox) => [...KIND_ORDER, ...[...new Set(inbox.map((i) => i.kind))].filter((k) => !KIND_ORDER.includes(k))];
  const labelOf = (k, inbox) => KIND_LABEL[k] || inbox.find((i) => i.kind === k && i.group)?.group || cap(k);

  /** Buttons for one inbox item, gated by item.perm (plus segregation of duties for journals). */
  function inboxActions(it, small) {
    const sm = small ? ' sm' : '';
    const d = { id: it.id };
    if (it.kind === 'req') return App.btn('Reject', 'req-reject', d, it.perm, 'danger' + sm) + App.btn('Approve', 'req-approve', d, it.perm, 'primary' + sm);
    if (it.kind === 'je') {
      const j = E.je(it.id);
      if (j && j.createdBy === E.S.user && E.S.role !== 'Administrator') return `<span class="muted small">You entered this journal, so another approver must review it.</span>`;
      return App.btn('Reject', 'je-reject', d, it.perm, 'danger' + sm) + App.btn('Approve and post', 'je-approve', d, it.perm, 'primary' + sm);
    }
    if (it.kind === 'apinv') return App.btn('Release hold', 'ap-release', d, it.perm, 'primary' + sm);
    if (it.kind === 'so') return App.btn('Release credit hold', 'so-release', d, it.perm, 'primary' + sm);
    if (it.kind === 'abs') return App.btn('Reject', 'abs-reject', d, it.perm, 'danger' + sm) + App.btn('Approve', 'abs-approve', d, it.perm, 'primary' + sm);
    // extension kinds: use `${kind}-reject` / `${kind}-approve` when the module registered them
    return (App.hasAct(`${it.kind}-reject`) ? App.btn('Reject', `${it.kind}-reject`, d, it.perm, 'danger' + sm) : '')
      + (App.hasAct(`${it.kind}-approve`) ? App.btn('Approve', `${it.kind}-approve`, d, it.perm, 'primary' + sm) : '');
  }

  // ---------- revenue vs costs chart ----------
  function chartData() {
    return E.periods().filter((p) => p.period >= E.FY_START && p.posted > 0).map((p) => {
      const is = E.incomeStatement(p.period, p.period);
      const costs = U.r2(is.totalCogs + is.totalOpex);
      return { period: p.period, label: p.label, revenue: is.totalRevenue, costs, net: U.r2(is.totalRevenue - costs), status: p.status };
    });
  }
  /** Builds the SVG at a given pixel width so text stays legible; viewBox + width:100% keeps it fluid. */
  function chartSvg(data, W) {
    W = Math.max(280, Math.round(W || 640));
    const H = 240, ml = 48, mr = 8, mt = 10, mb = 26;
    const pw = W - ml - mr, ph = H - mt - mb;
    const max = Math.max(1, ...data.map((d) => Math.max(d.revenue, d.costs)));
    let step = niceStep(max / 4); if (Math.ceil(max / step) > 5) step = niceStep(max / 3);
    const top = Math.ceil(max / step) * step;
    const y = (v) => mt + ph - (Math.max(0, v) / top) * ph;
    const gw = pw / data.length;
    const bw = Math.max(6, Math.min(22, gw * 0.24)), gap = 2;
    const bar = (x, v, color) => {
      const yt = y(v), h = mt + ph - yt; if (h <= 0) return '';
      const r = Math.min(4, bw / 2, h);
      return `<path d="M${x},${mt + ph} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bw - r} Q${x + bw},${yt} ${x + bw},${yt + r} V${mt + ph} Z" fill="${color}"/>`;
    };
    let grid = '';
    for (let v = 0; v <= top + 1e-6; v += step) {
      const yy = y(v).toFixed(1);
      grid += `<line x1="${ml}" x2="${W - mr}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1" ${v ? 'stroke-dasharray="2 3"' : ''} fill="none"/>`
        + `<text x="${ml - 8}" y="${yy}" dy="0.32em" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--mono)">${compact(v)}</text>`;
    }
    const groups = data.map((d, i) => {
      const cx = ml + gw * i + gw / 2, x1 = cx - bw - gap / 2, x2 = cx + gap / 2;
      return `<g class="hc-grp" data-i="${i}">`
        + `<rect class="hc-hi" x="${(ml + gw * i + 2).toFixed(1)}" y="${mt}" width="${(gw - 4).toFixed(1)}" height="${ph}" rx="4" fill="var(--surface-2)" opacity="0"/>`
        + bar(x1, d.revenue, 'var(--series-1)') + bar(x2, d.costs, 'var(--series-2)')
        + `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(d.label)}</text>`
        + `<rect class="hc-hit" x="${(ml + gw * i).toFixed(1)}" y="${mt}" width="${gw.toFixed(1)}" height="${ph + mb}" fill="transparent"/></g>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Monthly revenue and operating costs, ${esc(data[0]?.label || '')} to ${esc(data[data.length - 1]?.label || '')}" style="display:block;height:auto">${grid}${groups}</svg>`;
  }
  function chartTable(data) {
    return App.table([
      { h: 'Month', f: (d) => esc(d.label) + (d.status === 'Open' ? ' <span class="muted small">(open)</span>' : '') },
      { h: 'Revenue', num: true, f: (d) => fmt(d.revenue) },
      { h: 'Costs incl. COGS', num: true, f: (d) => fmt(d.costs) },
      { h: 'Net', num: true, f: (d) => fmt(d.net) },
    ], data, { empty: 'No postings yet this fiscal year.', foot: ['Total', fmt(U.sum(data, (d) => d.revenue)), fmt(U.sum(data, (d) => d.costs)), fmt(U.sum(data, (d) => d.net))] });
  }
  function wireChart(root) {
    const wrap = root.querySelector('#homeChart'); if (!wrap) return;
    const data = chartData(); if (!data.length) return;
    const tip = wrap.querySelector('.chart-tip');
    const draw = () => {
      const w = wrap.clientWidth; if (!w) return;
      wrap.dataset.w = w;
      wrap.querySelector('.hc-svg').innerHTML = chartSvg(data, w);
    };
    draw();
    const hide = () => { tip.hidden = true; wrap.querySelectorAll('.hc-hi').forEach((r) => r.setAttribute('opacity', '0')); };
    const show = (g) => {
      const d = data[+g.dataset.i]; if (!d) return;
      wrap.querySelectorAll('.hc-hi').forEach((r) => r.setAttribute('opacity', '0'));
      g.querySelector('.hc-hi').setAttribute('opacity', '1');
      tip.innerHTML = `<b>${esc(d.label)}</b>${d.status === 'Open' ? ' <span class="muted">(open period)</span>' : ''}<br>`
        + `<span style="color:var(--series-1)">&#9632;</span> Revenue <span class="num">${fmt(d.revenue)}</span><br>`
        + `<span style="color:var(--series-2)">&#9632;</span> Costs <span class="num">${fmt(d.costs)}</span><br>`
        + `Net <span class="num" style="color:${d.net < 0 ? 'var(--bad)' : 'var(--good)'}">${fmt(d.net)}</span>`;
      tip.hidden = false;
      const wr = wrap.getBoundingClientRect(), gr = g.querySelector('.hc-hit').getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      // sit beside the hovered month so the tooltip never covers its own bars
      let left = gr.right - wr.left - gr.width * 0.12;
      if (left + tw > wr.width) left = gr.left - wr.left + gr.width * 0.12 - tw;
      left = Math.max(0, Math.min(wr.width - tw, left));
      tip.style.left = left + 'px'; tip.style.top = Math.max(0, Math.min(wr.height - th, 24)) + 'px';
    };
    wrap.addEventListener('mouseover', (ev) => { const g = ev.target.closest('.hc-grp'); if (g) show(g); });
    wrap.addEventListener('mouseleave', hide);
    wrap.addEventListener('click', (ev) => { const g = ev.target.closest('.hc-grp'); if (g) show(g); else hide(); });
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => { if (!document.contains(wrap)) { ro.disconnect(); return; } if (Math.abs(wrap.clientWidth - (+wrap.dataset.w || 0)) > 4) { hide(); draw(); } });
      ro.observe(wrap);
    }
  }
  App.act('home-chart-toggle', () => { App.ui.filter.homeChartTable = !App.ui.filter.homeChartTable; App.render(); });

  // ---------- Home ----------
  App.view('home', {
    title: 'Home',
    render() {
      const S = E.S;
      const lp = latestOpen() || E.periods().filter((p) => p.posted).map((p) => p.period).pop() || E.FY_START;
      const ni = E.incomeStatement(E.FY_START, lp).netIncome;
      const active = S.employees.filter((e) => e.status === 'Active');
      const ar = E.balance('1100'), cash = E.balance('1000'), ap = -E.balance('2000'), inv = E.balance('1200');
      const hour = new Date().getHours();
      const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
      const head = App.head(S.company, `${greet}, ${S.user}`,
        `Signed in as ${esc(S.role)}. Today is ${esc(fdate(S.today))}. Open periods: ${esc(App.openPeriods().map(U.periodLabel).join(', ') || 'none')}.`,
        App.btn('Approvals inbox', 'go', { view: 'approvals' }));

      const kpis = `<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(148px,1fr))">`
        + App.kpi('Cash', App.fmt0(cash), 'GL 1000 operating account')
        + App.kpi('Receivables', App.fmt0(ar), `GL 1100, ${((n) => n + (n === 1 ? ' open invoice' : ' open invoices'))(E.S.arInvoices.filter((i) => i.status !== 'Paid').length)}`)
        + App.kpi('Payables', App.fmt0(ap), `GL 2000, ${((n) => n + (n === 1 ? ' invoice to pay' : ' invoices to pay'))(E.S.apInvoices.filter((i) => i.status === 'Validated').length)}`)
        + App.kpi('Inventory', App.fmt0(inv), `GL 1200, ${E.S.items.length} items at average cost`)
        + App.kpi('Net income FYTD', `<span style="color:${ni < 0 ? 'var(--bad)' : 'inherit'}">${App.fmt0(ni)}</span>`, `${U.periodLabel(E.FY_START)} to ${U.periodLabel(lp)}`)
        + App.kpi('Active headcount', App.num(active.length), `${App.num(S.departments.length)} departments`)
        + `</div>`;

      // (a) chart
      const data = chartData();
      const asTable = !!App.ui.filter.homeChartTable;
      const chartCard = `<section class="card"><div class="card-h"><span>Revenue and operating costs by month</span>
          <button type="button" class="btn sm" data-act="home-chart-toggle" aria-pressed="${asTable}">${asTable ? 'View as chart' : 'View as table'}</button></div>
        <div class="pad">${!data.length ? '<div class="empty">No postings yet this fiscal year.</div>' : asTable ? chartTable(data) : `
          <div class="legend" style="margin-bottom:8px"><span><i style="background:var(--series-1)"></i>Revenue</span><span><i style="background:var(--series-2)"></i>Costs incl. cost of goods sold</span></div>
          <div id="homeChart" style="position:relative"><div class="hc-svg">${chartSvg(data, 640)}</div><div class="chart-tip" hidden></div></div>
          <p class="hint" style="margin:8px 0 0">${esc(U.periodLabel(data[data.length - 1].period))} is ${data[data.length - 1].status === 'Open' ? 'still open, so its costs are partial (payroll and depreciation post at month end)' : 'closed'}. Hover or tap a month for details.</p>`}</div></section>`;

      // (b) attention
      const inbox = E.approvalsInbox();
      const attention = `<section class="card"><div class="card-h"><span>Needs your attention</span><span class="pill ${inbox.length ? 'warn' : 'good'}">${inbox.length} waiting</span></div>
        ${inbox.length ? `<div class="tbl-wrap"><table class="t"><tbody>${inbox.slice(0, 5).map((it) => `<tr><td>${App.link(it.kind, it.id)}<div class="small">${esc(it.title)}</div><div class="small muted">${esc(it.why)}</div></td><td class="small muted" style="white-space:nowrap">${esc(fdate(it.date))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nothing is waiting for you.</div>'}
        <div class="pad" style="padding-top:10px">${App.btn(inbox.length > 5 ? `See all ${inbox.length} in Approvals` : 'Open Approvals', 'go', { view: 'approvals' }, null, 'sm')}</div></section>`;

      // (c) close checklist
      const cp = earliestOpen();
      const close = cp ? (() => {
        const list = E.closeChecklist(cp); const done = list.filter((t) => t.done).length;
        return `<section class="card"><div class="card-h"><span>Month-end close: ${esc(U.periodLabel(cp))}</span><span class="muted small">${done} of ${list.length} done</span></div>
          <div class="tbl-wrap"><table class="t"><tbody>${list.map((t) => `<tr><td>${esc(t.task)}<div class="small muted">${t.done && /^(PR|JE)-/.test(t.detail) ? App.refLink(t.detail) : esc(t.detail)}</div></td><td style="text-align:right">${t.done ? pill('Done', 'good') : t.advisory ? pill('Review', 'info') : pill('To do', 'warn')}</td></tr>`).join('')}</tbody></table></div>
          <div class="pad" style="padding-top:10px">${App.btn('Go to periods', 'go', { view: 'periods' }, null, 'sm')}</div></section>`;
      })() : `<section class="card"><div class="card-h"><span>Month-end close</span></div><div class="empty">No period is open.</div></section>`;

      // (d) reconciliation
      const rec = E.reconcile();
      const recon = `<section class="card"><div class="card-h"><span>Subledger reconciliation</span>${rec.every((r) => r.ok) ? pill('All tie out', 'good') : pill('Differences', 'bad')}</div>
        ${App.table([
          { h: 'Control account', f: (r) => `${App.link('acct', r.acct)} ${esc(r.name)}` },
          { h: 'Subledger', num: true, f: (r) => fmt(r.sub) },
          { h: 'GL', num: true, f: (r) => fmt(r.gl) },
          { h: 'Difference', num: true, f: (r) => r.ok ? '<span class="muted">0.00</span>' : `<span style="color:var(--bad)">${fmt(r.diff)}</span>` },
        ], rec)}</section>`;

      // (e) recent activity
      const recent = auditSorted().slice(0, 8);
      const activity = `<section class="card"><div class="card-h"><span>Recent activity</span>${App.btn('Full audit trail', 'go', { view: 'audit' }, null, 'sm')}</div>
        ${App.table([
          { h: 'When', f: when },
          { h: 'User', f: (a) => esc(a.user) },
          { h: 'Action', f: (a) => esc(a.action) },
          { h: 'Reference', f: (a) => refLink(a.ref) },
        ], recent, { empty: 'No activity recorded yet.' })}</section>`;

      return head + kpis
        + `<div class="grid g-main"><div class="stack">${chartCard}${recon}${activity}</div><div class="stack">${attention}${close}</div></div>`;
    },
    after(root) { wireChart(root); },
  });

  // ---------- Approvals ----------
  App.view('approvals', {
    title: 'Approvals',
    render() {
      const inbox = E.approvalsInbox();
      const head = App.head('Overview', 'Approvals', 'Everything across the suite that is waiting on a decision. Buttons are enabled only for roles that hold the matching permission.');
      const rules = `<div class="callout" style="margin-bottom:16px"><b>How approvals are routed</b><br>
        Requisitions over <span class="num">${fmt(E.REQ_APPROVAL_LIMIT)}</span> need Controller approval before they can become purchase orders.
        Manual journals over <span class="num">${fmt(E.JE_APPROVAL_LIMIT)}</span> post only once approved, and the person who entered a journal cannot approve it (segregation of duties).
        Supplier invoices go on hold when the quantity billed exceeds the quantity received or the price differs from the PO by more than ${Math.round(E.PRICE_TOLERANCE * 100)}%.
        Sales orders go on credit hold when the customer's open receivables plus open orders exceed their credit limit.
        Absence requests are approved by HR.</div>`;
      const kinds = kindsOf(inbox);
      const kpis = `<div class="kpis">${kinds.map((k) => App.kpi(esc(labelOf(k, inbox)), App.num(inbox.filter((i) => i.kind === k).length))).join('')}</div>`;
      if (!inbox.length) return head + kpis + rules + `<section class="card"><div class="empty">Nothing is waiting for you.</div></section>`;
      const groups = kinds.filter((k) => inbox.some((i) => i.kind === k)).map((k) => {
        const items = inbox.filter((i) => i.kind === k);
        return `<section class="card"><div class="card-h"><span>${esc(labelOf(k, inbox))}</span><span class="pill warn">${items.length}</span></div>`
          + App.table([
            { h: 'Item', f: (it) => `${App.link(it.kind, it.id)}<div class="small">${esc(it.title)}</div>` },
            { h: 'Reason', f: (it) => `<span class="small">${esc(it.why)}</span>` },
            { h: 'Requested by', f: (it) => esc(it.who) },
            { h: 'Date', f: (it) => `<span style="white-space:nowrap">${esc(fdate(it.date))}</span>` },
            { h: '', f: (it) => `<div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">${App.btn('View', 'open', { kind: it.kind, id: it.id }, null, 'sm')}${inboxActions(it, true)}</div>` },
          ], items) + `</section>`;
      }).join('');
      return head + kpis + rules + `<div class="stack">${groups}</div>`;
    },
  });

  // ---------- Audit trail ----------
  const auditState = () => (App.ui.filter.audit = App.ui.filter.audit || { q: '', user: '' });
  function auditRows() {
    const st = auditState(), q = st.q.trim().toLowerCase();
    return auditSorted().filter((a) => (!st.user || a.user === st.user)
      && (!q || [a.user, a.role, a.action, a.ref, a.detail, a.date].some((x) => String(x || '').toLowerCase().includes(q))));
  }
  function auditTable() {
    const rows = auditRows(), all = E.S.audit.length, shown = rows.slice(0, 500);
    return `<div class="pad small muted" style="padding-bottom:0">${rows.length === all ? `${App.num(all)} entries` : `${App.num(rows.length)} of ${App.num(all)} entries match`}${rows.length > shown.length ? `, showing the latest ${shown.length}` : ''}.</div>`
      + App.table([
        { h: 'Timestamp', f: when },
        { h: 'User', f: (a) => esc(a.user) },
        { h: 'Role', f: (a) => `<span class="muted">${esc(a.role)}</span>` },
        { h: 'Action', f: (a) => esc(a.action) },
        { h: 'Reference', f: (a) => refLink(a.ref) },
        { h: 'Detail', f: (a) => `<span class="small">${esc(a.detail)}</span>` },
      ], shown, { empty: 'No entries match these filters.' });
  }
  App.view('audit', {
    title: 'Audit trail',
    render() {
      const st = auditState();
      const users = [...new Set(E.S.audit.map((a) => a.user))].sort();
      return App.head('Administration', 'Audit trail', 'Every change made in the suite, with who made it and in which role. Entries cannot be edited or deleted.')
        + `<section class="card"><div class="pad"><div class="row">`
        + App.field('Search', App.input('auditQ', st.q, 'search', 'placeholder="Action, reference, detail" autocomplete="off"'))
        + App.field('User', App.select('auditUser', [['', 'All users'], ...users.map((u) => [u, u])], st.user))
        + `</div></div><div id="auditTbl">${auditTable()}</div></section>`;
    },
    after(root) {
      const st = auditState();
      const redraw = () => { root.querySelector('#auditTbl').innerHTML = auditTable(); };
      root.querySelector('#auditQ').addEventListener('input', (ev) => { st.q = ev.target.value; redraw(); });
      root.querySelector('#auditUser').addEventListener('change', (ev) => { st.user = ev.target.value; redraw(); });
    },
  });

  // ---------- Roles and access ----------
  const PERM_LABEL = {
    'gl.post': 'Post journals', 'gl.approve': 'Approve journals', 'gl.close': 'Open and close periods', 'gl.depr': 'Run depreciation', 'gl.coa': 'Maintain chart of accounts',
    'ap.enter': 'Enter supplier invoices', 'ap.pay': 'Pay suppliers', 'ap.release': 'Release invoice holds',
    'supplier.edit': 'Maintain suppliers', 'po.create': 'Create purchase orders', 'po.receive': 'Receive goods',
    'item.edit': 'Maintain items', 'inv.adjust': 'Adjust inventory',
    'so.create': 'Create sales orders', 'so.ship': 'Ship orders', 'so.release': 'Release credit holds', 'ar.receipt': 'Record customer receipts', 'customer.edit': 'Maintain customers',
    'req.create': 'Create requisitions', 'req.approve': 'Approve requisitions',
    'hr.edit': 'Hire and terminate', 'hr.absence.create': 'Request absence', 'hr.absence.approve': 'Approve absence', 'hr.payroll': 'Run payroll',
  };
  const allPerms = () => {
    const set = new Set();
    Object.values(E.ROLES).forEach((ps) => ps.forEach((p) => p !== '*' && set.add(p)));
    ['req.create', 'hr.absence.create'].forEach((p) => set.add(p));
    return [...set].sort((a, b) => a.localeCompare(b));
  };
  const check = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--good)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-label="Allowed" role="img"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  App.act('role-switch', (ds) => {
    const role = ds.role; if (!E.ROLES[role]) return;
    App.try(() => { E.S.role = role; E.S.user = E.ROLE_USERS[role] || E.S.user; E.log('Switched role', role); const sel = document.getElementById('roleSel'); if (sel) sel.value = role; }, `You are now ${E.ROLE_USERS[role] || E.S.user}, acting as ${role}.`);
  });
  App.view('security', {
    title: 'Roles and access',
    render() {
      const roles = Object.keys(E.ROLES), perms = allPerms();
      const cards = App.table([
        { h: 'Role', f: (r) => `<b>${esc(r)}</b>${r === E.S.role ? ' ' + pill('Current', 'accent') : ''}` },
        { h: 'User', f: (r) => esc(E.ROLE_USERS[r] || '') },
        { h: 'Permissions', num: true, f: (r) => E.ROLES[r].includes('*') ? 'All' : App.num(perms.filter((p) => E.can(r, p)).length) },
        { h: '', f: (r) => r === E.S.role ? '<span class="muted small">Active now</span>' : `<button type="button" class="btn sm" data-act="role-switch" data-role="${esc(r)}">Switch to this role</button>` },
      ], roles);
      const matrix = `<div class="tbl-wrap"><table class="t"><thead><tr><th>Permission</th>${roles.map((r) => `<th style="text-align:center">${esc(r)}</th>`).join('')}</tr></thead><tbody>`
        + perms.map((p) => `<tr><td>${esc(PERM_LABEL[p] || p)}<div class="mono small muted">${esc(p)}</div></td>${roles.map((r) => `<td style="text-align:center;vertical-align:middle">${E.can(r, p) ? check : '<span class="muted" aria-label="Not allowed">&middot;</span>'}</td>`).join('')}</tr>`).join('')
        + `</tbody></table></div>`;
      return App.head('Administration', 'Roles and access', 'Each demo user holds one role. Switching role changes which buttons are enabled across the suite, and the change is recorded in the audit trail.')
        + `<div class="stack"><section class="card"><div class="card-h"><span>Roles and users</span></div>${cards}</section>`
        + `<section class="card"><div class="card-h"><span>Permission matrix</span></div><div class="pad small muted" style="padding-bottom:0">Creating requisitions and requesting absence are open to every role. Administrator holds every permission.</div>${matrix}</section></div>`;
    },
  });
})();
