/* Ledgerline Suite — views-projects.js
 * Projects module: project list and financials, weekly timesheets, expense reports
 * and reimbursement, project billing (time and materials, fixed price).
 * Rules live in ext-projects.js; every mutation goes through App.try / drawers.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, fmt0 = App.fmt0, num = App.num, fdate = App.fdate, pill = App.pill;
  const today = () => E.S.today;
  const pct = (n) => (Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '-');
  const hrs = (n) => (+n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' h';
  const empLink = (id) => { const e = E.emp(id); return e ? App.link('emp', e.id, e.name) : '<span class="muted">None</span>'; };
  const custLink = (id) => { const c = E.cust(id); return c ? App.link('cust', c.id, c.name) : '<span class="muted">Internal</span>'; };
  const prjLink = (id) => { const p = E.project(id); return p ? App.link('project', p.id) + `<div class="small">${esc(p.name)}</div>` : esc(id); };
  const activeEmps = () => E.S.employees.filter((e) => e.status === 'Active');
  const activeProjects = () => E.S.projects.filter((p) => p.status === 'Active');
  const lineHours = (l) => U.sum(l.hours);
  const TYPE_TONE = { 'Time and materials': 'info', 'Fixed price': 'accent', Internal: '' };
  const nowrap = (s) => `<span style="white-space:nowrap">${s}</span>`;
  const meter = (f) => `<div style="height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden;margin-top:4px;min-width:60px"><div style="height:100%;width:${Math.round(Math.min(1, f) * 100)}%;background:${f >= 0.9 ? 'var(--warn)' : 'var(--accent)'}"></div></div>`;

  App.refKind('PRJ-', 'project');
  App.refKind('TS-', 'timesheet');
  App.refKind('EXP-', 'expense');
  App.refKind('REIMB-', 'reimb');
  App.navCount('timesheets', () => E.pendingTimesheets().length);
  App.navCount('expenses', () => E.pendingExpenses().length);

  // ================= Projects =================
  App.act('prj-new', () => {
    const custs = E.S.customers.map((c) => [c.id, c.name]);
    const mgrs = activeEmps().map((e) => [e.id, `${e.name}, ${e.title}`]);
    const R = E.PROJECT_DEFAULT_RATES;
    const html = `${App.field('Project name', App.input('pjName', '', 'text', 'placeholder="e.g. Corran bioreactor sensor retrofit"'))}`
      + `<div class="row">${App.field('Type', App.select('pjType', E.PROJECT_TYPES))}${App.field('Customer', App.select('pjCust', [['', 'None (internal)'], ...custs], custs[0]?.[0] || ''))}${App.field('Project manager', App.select('pjMgr', mgrs))}</div>`
      + `<div class="row">${App.field('Start', App.input('pjStart', today(), 'date'))}${App.field('End', App.input('pjEnd', U.addDays(today(), 180), 'date'))}${App.field('Contract value (fixed price)', App.input('pjCv', '', 'number', 'min="0" step="1000"'))}</div>`
      + `<h3 class="small" style="margin:12px 0 6px">Budget by cost type</h3><div class="row">${App.field('Labor', App.input('pjBL', '', 'number', 'min="0" step="1000"'))}${App.field('Expenses', App.input('pjBE', '', 'number', 'min="0" step="500"'))}${App.field('Materials', App.input('pjBM', '', 'number', 'min="0" step="500"'))}</div>`
      + `<h3 class="small" style="margin:12px 0 6px">Bill rates per hour</h3><div class="row">${App.field('Engineering', App.input('pjRE', R.Engineering, 'number', 'min="0"'))}${App.field('Operations', App.input('pjRO', R.Operations, 'number', 'min="0"'))}${App.field('Other departments', App.input('pjRD', R.default, 'number', 'min="0"'))}</div>`
      + `<h3 class="small" style="margin:12px 0 6px">Tasks</h3>` + App.lines('pjTasks', [{ key: 'name', label: 'Task', type: 'text' }, { key: 'billable', label: 'Billable', type: 'select', options: ['Yes', 'No'], width: '110px' }], [{ name: 'Design', billable: 'Yes' }, { name: 'Delivery', billable: 'Yes' }, { name: 'Project management', billable: 'No' }])
      + `<h3 class="small" style="margin:12px 0 6px">Billing milestones (fixed price only)</h3>` + App.lines('pjMs', [{ key: 'name', label: 'Milestone', type: 'text' }, { key: 'pct', label: '% of contract', type: 'number', width: '130px' }], [{}])
      + `<div class="callout" id="pjInfo"></div>`;
    App.drawer('New project', html, {
      submitLabel: 'Create project', wide: true,
      oninput: (f) => {
        const t = App.val(f, 'pjType'); const b = (+App.val(f, 'pjBL') || 0) + (+App.val(f, 'pjBE') || 0) + (+App.val(f, 'pjBM') || 0);
        const cv = +App.val(f, 'pjCv') || 0;
        App.$('#pjInfo', f).innerHTML = t === 'Time and materials' ? `Time and materials: approved billable hours are invoiced at the department bill rate, billable expenses at cost plus ${E.EXPENSE_MARKUP * 100}%. Budget <b class="num">${fmt(b)}</b>.`
          : t === 'Fixed price' ? `Fixed price: billed by percent complete (cost to date / budget) or by milestone, never above the contract value. Planned margin <b class="num">${fmt(cv - b)}</b>${cv ? ` (${pct((cv - b) / cv)})` : ''}.`
          : `Internal: no customer and no billing. Approved time is reclassed to 6700 R&D labor. Budget <b class="num">${fmt(b)}</b>.`;
      },
      onSubmit: (f) => E.createProject({ name: App.val(f, 'pjName'), type: App.val(f, 'pjType'), customerId: App.val(f, 'pjCust'), managerId: App.val(f, 'pjMgr'), start: App.val(f, 'pjStart'), end: App.val(f, 'pjEnd'),
        contractValue: App.val(f, 'pjCv'), budget: { Labor: App.val(f, 'pjBL'), Expenses: App.val(f, 'pjBE'), Materials: App.val(f, 'pjBM') },
        rates: { Engineering: App.val(f, 'pjRE'), Operations: App.val(f, 'pjRO'), default: App.val(f, 'pjRD') },
        tasks: App.readLines(f, 'pjTasks').map((t) => ({ name: t.name, billable: t.billable === 'Yes' })), milestones: App.readLines(f, 'pjMs') }),
      success: (p) => `${p.id} ${p.name} created.`,
    });
  });

  function tmPreview(p, through) {
    const u = E.projectUnbilled(p.id, through);
    if (!u.total) return `<div class="empty">No unbilled approved time or billable expenses${through ? ' up to ' + esc(fdate(through)) : ''}.</div>`;
    const g = new Map(); u.labor.forEach((x) => { const k = x.emp.id + '|' + x.rate; const r = g.get(k) || { emp: x.emp, rate: x.rate, hours: 0, amount: 0 }; r.hours = U.r2(r.hours + x.hours); r.amount = U.r2(r.amount + x.amount); g.set(k, r); });
    const rows = [...[...g.values()].map((r) => ({ what: `Labor: ${esc(r.emp.name)} <span class="muted small">${esc(r.emp.dept)}</span>`, basis: `${hrs(r.hours)} @ ${fmt(r.rate)}`, amount: r.amount })),
      ...u.expenses.map((x) => ({ what: `${esc(x.line.category)} ${App.link('expense', x.rep.id)}`, basis: `${fmt(x.cost)} + ${E.EXPENSE_MARKUP * 100}%`, amount: x.amount }))];
    return App.table([{ h: 'Line', f: (r) => r.what }, { h: 'Basis', f: (r) => nowrap(r.basis) }, { h: 'Amount', num: true, f: (r) => fmt(r.amount) }], rows, { foot: ['Invoice total', '', fmt(u.total)] });
  }
  App.act('prj-bill', (ds) => {
    const p = E.project(ds.id); if (!p) return;
    if (p.type === 'Time and materials') {
      App.drawer(`Generate invoice for ${p.id}`, `<p>${esc(p.name)} for ${esc(E.cust(p.customerId)?.name)}.</p><div class="row">${App.field('Invoice date', App.input('bDate', today(), 'date'))}${App.field('Bill work up to', App.input('bThru', today(), 'date'))}</div><div id="bPrev"></div>`
        + `<div class="callout">Raises a receivables invoice (Dr 1100 Receivables, Cr 4100 Service revenue) and marks each timesheet and expense line as billed, so the same hours cannot be invoiced twice.</div>`,
      { submitLabel: 'Generate invoice', oninput: (f) => { App.$('#bPrev', f).innerHTML = tmPreview(p, App.val(f, 'bThru')); },
        onSubmit: (f) => E.generateProjectInvoice(p.id, { date: App.val(f, 'bDate'), through: App.val(f, 'bThru') }), success: (inv) => `${inv.id} raised for ${fmt(inv.total)}.` });
      return;
    }
    if (p.type !== 'Fixed price') { App.toast('Internal projects are not billed.', 'bad'); return; }
    const fin = E.projectFinancials(p.id);
    const open = p.milestones.filter((m) => !m.invoiceId);
    const opts = [['percent', `Percent complete (${pct(fin.pctComplete)})`], ...open.map((m) => [m.id, `Milestone: ${m.name} (${m.pct}%)`])];
    App.drawer(`Bill ${p.id}`, `<p>${esc(p.name)}: contract <b class="num">${fmt(p.contractValue)}</b>, billed <b class="num">${fmt(fin.billed)}</b>, remaining <b class="num">${fmt(fin.remainingContract)}</b>.</p>`
      + `<div class="row">${App.field('Invoice date', App.input('bDate', today(), 'date'))}${App.field('Billing basis', App.select('bMethod', opts))}</div><div class="callout" id="bPrev"></div>`,
    { submitLabel: 'Raise invoice',
      oninput: (f) => {
        const m = App.val(f, 'bMethod'); const ms = p.milestones.find((x) => x.id === m);
        const amt = Math.max(0, Math.min(fin.remainingContract, ms ? U.r2(p.contractValue * ms.pct / 100) : U.r2(p.contractValue * fin.pctComplete - fin.billed)));
        App.$('#bPrev', f).innerHTML = ms ? `Milestone "${esc(ms.name)}" bills ${ms.pct}% of the contract: <b class="num">${fmt(amt)}</b>.`
          : `Cost to date <b class="num">${fmt(fin.cost)}</b> of budget <b class="num">${fmt(fin.budget.total)}</b> is ${pct(fin.pctComplete)} complete. Earned ${fmt(p.contractValue * fin.pctComplete)} less ${fmt(fin.billed)} billed: <b class="num">${fmt(amt)}</b>.`;
        App.$('#bPrev', f).innerHTML += ' Billing is capped at the contract value.';
      },
      onSubmit: (f) => { const m = App.val(f, 'bMethod'); return E.billFixedPrice(p.id, m === 'percent' ? { date: App.val(f, 'bDate'), method: 'percent' } : { date: App.val(f, 'bDate'), method: 'milestone', milestoneId: m }); },
      success: (inv) => `${inv.id} raised for ${fmt(inv.total)}.` });
  });
  App.act('prj-close', (ds) => App.confirm('Close project', `Close ${esc(ds.id)}? No further time or expenses can be charged to it.`, 'Close project', () => E.closeProject(ds.id), `${ds.id} closed.`));
  const billBtn = (p, sm = ' sm') => p.status === 'Active' && p.type !== 'Internal' ? App.btn(p.type === 'Fixed price' ? 'Bill progress' : 'Generate invoice', 'prj-bill', { id: p.id }, 'prj.bill', (sm ? 'sm' : '') + (sm ? '' : ' primary')) : '';

  App.view('projects', {
    title: 'Projects', group: 'Projects',
    render() {
      const pf = E.projectPortfolio();
      const rows = E.S.projects.map((p) => ({ p, f: E.projectFinancials(p.id) }));
      const head = App.head('Projects', 'Projects', 'Customer and internal projects: budgets, labor and expense cost from approved timesheets and expense reports, billing and margin.', App.btn('New project', 'prj-new', {}, 'prj.edit', 'primary'));
      const kpis = `<div class="kpis">`
        + App.kpi('Active projects', num(pf.active), `${pf.count} in total, budget ${fmt0(pf.budget)}`)
        + App.kpi('Cost to date', fmt0(pf.cost), 'Approved labor, expenses and materials')
        + App.kpi('Revenue billed', fmt0(pf.billed), `Margin ${fmt0(pf.margin)}${pf.customerBilled ? ` (${pct(pf.margin / pf.customerBilled)})` : ''} on customer work`)
        + App.kpi('Unbilled WIP', fmt0(pf.wip), 'Approved work not yet invoiced')
        + `</div>`;
      const tbl = `<section class="card"><div class="card-h"><span>Project list</span><span class="muted small">Click a project for budget vs actual</span></div>` + App.table([
        { h: 'Project', f: (r) => prjLink(r.p.id) },
        { h: 'Customer', f: (r) => custLink(r.p.customerId) },
        { h: 'Type', f: (r) => pill(r.p.type, TYPE_TONE[r.p.type]) },
        { h: 'Manager', f: (r) => empLink(r.p.managerId) },
        { h: 'Budget', num: true, f: (r) => fmt0(r.f.budget.total) },
        { h: 'Cost to date', num: true, f: (r) => fmt0(r.f.cost) },
        { h: '% complete', num: true, f: (r) => pct(r.f.pctComplete) + meter(r.f.pctComplete) },
        { h: 'Billed', num: true, f: (r) => r.p.type === 'Internal' ? '<span class="muted">n/a</span>' : fmt0(r.f.billed) },
        { h: 'Margin', num: true, f: (r) => r.p.type === 'Internal' ? '<span class="muted">n/a</span>' : fmt0(r.f.margin) + (r.f.billed ? `<div class="small muted">${pct(r.f.marginPct)}</div>` : '') },
        { h: 'Unbilled WIP', num: true, f: (r) => r.p.type === 'Internal' ? '' : fmt0(r.f.unbilledWip) },
        { h: 'Status', f: (r) => pill(r.p.status) },
        { h: '', f: (r) => `<div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">${billBtn(r.p)}</div>` },
      ], rows, { empty: 'No projects yet. Use New project to set one up.', foot: ['Total', '', '', '', fmt0(U.sum(rows, (r) => r.f.budget.total)), fmt0(pf.cost), '', fmt0(pf.billed), fmt0(pf.margin), fmt0(pf.wip), '', ''] }) + `</section>`;
      const how = `<div class="callout" style="margin-top:16px"><b>How project costing works</b><br>Payroll expenses wages to 6000. When a manager approves a timesheet, the hours are costed at salary / ${E.STANDARD_HOURS} &times; (1 + ${(E.EMPLOYER_TAX_RATE * 100).toFixed(2)}% employer tax) and reclassed: Dr 5200 Cost of services (customer projects) or Dr 6700 R&D labor (internal), Cr 6000. Approved expense reports post Dr the expense account, Cr 2150 Employee reimbursements payable, cleared by the reimbursement batch. Time and materials work is billed at the department bill rate, expenses at cost + ${E.EXPENSE_MARKUP * 100}%; fixed price projects bill by percent complete or milestone up to the contract value.</div>`;
      return head + kpis + tbl + how;
    },
  });

  App.detail('project', (id) => {
    const p = E.project(id); if (!p) return null;
    const f = E.projectFinancials(id);
    const bva = App.table([
      { h: 'Cost type', f: (r) => esc(r.k) }, { h: 'Budget', num: true, f: (r) => fmt(r.b) }, { h: 'Actual', num: true, f: (r) => fmt(r.a) },
      { h: 'Remaining', num: true, f: (r) => `<span style="${r.b - r.a < 0 ? 'color:var(--bad)' : ''}">${fmt(r.b - r.a)}</span>` }, { h: 'Used', num: true, f: (r) => (r.b ? pct(r.a / r.b) : '-') + meter(r.b ? r.a / r.b : 0) },
    ], E.COST_TYPES.map((k) => ({ k, b: p.budget[k] || 0, a: f.actual[k] })), { foot: ['Total', fmt(f.budget.total), fmt(f.cost), fmt(f.budget.total - f.cost), pct(f.pctComplete)] });
    const taskRows = p.tasks.map((t) => {
      let h = 0, c = 0; E.S.timesheets.filter((x) => x.status === 'Approved').forEach((x) => x.lines.forEach((l) => { if (l.projectId === id && l.taskId === t.id) { h += lineHours(l); c += l.cost; } }));
      return { t, h: U.r2(h), c: U.r2(c) };
    });
    const tsLines = E.S.timesheets.flatMap((t) => t.lines.filter((l) => l.projectId === id).map((l) => ({ t, l }))).sort((a, b) => b.t.weekStart.localeCompare(a.t.weekStart));
    const exLines = E.S.expenseReports.flatMap((x) => x.lines.filter((l) => l.projectId === id).map((l) => ({ x, l }))).sort((a, b) => b.l.date.localeCompare(a.l.date));
    const refs = new Set([id, ...f.invoices.map((i) => i.id), ...tsLines.map((r) => r.t.id), ...exLines.map((r) => r.x.id), ...E.S.apInvoices.filter((i) => (i.lines || []).some((l) => l.project === id)).map((i) => i.id)]);
    const jes = E.S.journals.filter((j) => refs.has(j.ref)).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    const html = App.dl([['Project', `<b>${esc(p.name)}</b>`], ['Type', pill(p.type, TYPE_TONE[p.type])], ['Status', pill(p.status)], ['Customer', custLink(p.customerId)], ['Manager', empLink(p.managerId)],
        ['Dates', `${fdate(p.start)} to ${fdate(p.end)}`], p.type === 'Fixed price' && ['Contract value', `<span class="num">${fmt(p.contractValue)}</span>`],
        p.type !== 'Internal' && ['Bill rates', esc(Object.entries(p.rates).map(([k, v]) => `${k === 'default' ? 'Other' : k} ${fmt(v)}/h`).join(', '))]])
      + `<div class="kpis" style="margin-top:12px">${App.kpi('% complete', pct(f.pctComplete), `${hrs(f.hours)} approved${f.pendingHours ? `, ${hrs(f.pendingHours)} pending` : ''}`)}${App.kpi('Estimate at completion', fmt0(f.eac), f.variance < 0 ? `<span style="color:var(--bad)">${fmt0(-f.variance)} over budget</span>` : 'Within budget')}`
      + (p.type === 'Internal' ? '' : `${App.kpi('Revenue billed', fmt0(f.billed), `Margin ${fmt0(f.margin)}${f.billed ? ` (${pct(f.marginPct)})` : ''}`)}${App.kpi('Unbilled WIP', fmt0(f.unbilledWip), p.type === 'Fixed price' ? `${fmt0(f.remainingContract)} of contract left to bill` : 'Approved, not yet invoiced')}`) + `</div>`
      + `<h3 class="small" style="margin:14px 0 6px">Budget vs actual</h3>` + bva
      + `<h3 class="small" style="margin:14px 0 6px">Tasks</h3>` + App.table([{ h: 'Task', f: (r) => `${esc(r.t.id)} ${esc(r.t.name)}` }, { h: 'Billable', f: (r) => (r.t.billable ? 'Yes' : 'No') }, { h: 'Hours', num: true, f: (r) => hrs(r.h) }, { h: 'Labor cost', num: true, f: (r) => fmt(r.c) }], taskRows)
      + (p.milestones.length ? `<h3 class="small" style="margin:14px 0 6px">Milestones</h3>` + App.table([{ h: 'Milestone', f: (m) => esc(m.name) }, { h: 'Share', num: true, f: (m) => m.pct + '%' }, { h: 'Amount', num: true, f: (m) => fmt(p.contractValue * m.pct / 100) }, { h: 'Invoice', f: (m) => (m.invoiceId ? App.link('arinv', m.invoiceId) : '<span class="muted">Not billed</span>') }], p.milestones) : '')
      + `<h3 class="small" style="margin:14px 0 6px">Timesheet lines</h3>` + App.table([
        { h: 'Timesheet', f: (r) => App.link('timesheet', r.t.id) }, { h: 'Employee', f: (r) => esc(E.emp(r.t.empId)?.name) }, { h: 'Week', f: (r) => nowrap(fdate(r.t.weekStart)) },
        { h: 'Task', f: (r) => esc(p.tasks.find((x) => x.id === r.l.taskId)?.name) }, { h: 'Hours', num: true, f: (r) => hrs(lineHours(r.l)) }, { h: 'Cost', num: true, f: (r) => (r.t.status === 'Approved' ? fmt(r.l.cost) : '') },
        { h: 'Status', f: (r) => pill(r.t.status) + (r.l.invoiceId ? ` ${App.link('arinv', r.l.invoiceId)}` : r.l.billable && r.t.status === 'Approved' ? ' <span class="pill warn">Unbilled</span>' : '') },
      ], tsLines.slice(0, 40), { empty: 'No time charged yet.' }) + (tsLines.length > 40 ? `<p class="small muted">Showing the latest 40 of ${tsLines.length} lines.</p>` : '')
      + `<h3 class="small" style="margin:14px 0 6px">Expense lines</h3>` + App.table([
        { h: 'Report', f: (r) => App.link('expense', r.x.id) }, { h: 'Date', f: (r) => nowrap(fdate(r.l.date)) }, { h: 'Employee', f: (r) => esc(E.emp(r.x.empId)?.name) }, { h: 'Category', f: (r) => esc(r.l.category) },
        { h: 'Amount', num: true, f: (r) => fmt(r.l.amount) }, { h: 'Status', f: (r) => pill(r.x.status) + (r.l.invoiceId ? ` ${App.link('arinv', r.l.invoiceId)}` : r.l.billable ? ' <span class="pill info">Billable</span>' : '') },
      ], exLines, { empty: 'No expenses charged yet.' })
      + `<h3 class="small" style="margin:14px 0 6px">Invoices</h3>` + App.table([
        { h: 'Invoice', f: (i) => App.link('arinv', i.id) }, { h: 'Date', f: (i) => nowrap(fdate(i.date)) }, { h: 'Due', f: (i) => nowrap(fdate(i.due)) }, { h: 'Amount', num: true, f: (i) => fmt(i.total) }, { h: 'Open', num: true, f: (i) => fmt(i.total - i.paid) }, { h: 'Status', f: (i) => pill(i.status) },
      ], f.invoices.slice().sort((a, b) => b.date.localeCompare(a.date)), { empty: p.type === 'Internal' ? 'Internal projects are not billed.' : 'Not billed yet.' })
      + `<h3 class="small" style="margin:14px 0 6px">Journals</h3>` + App.jeList(jes.slice(0, 30));
    return { title: `${p.id} ${p.name}`, html, buttons: (p.status === 'Active' ? App.btn('Close project', 'prj-close', { id }, 'prj.edit', 'danger') : '') + billBtn(p, '') };
  });

  // ================= Timesheets =================
  const taskOptions = () => [['', 'Choose project and task'], ...activeProjects().flatMap((p) => p.tasks.map((t) => [`${p.id}|${t.id}`, `${p.id} ${p.name.length > 28 ? p.name.slice(0, 27) + '…' : p.name} / ${t.name}${p.type === 'Time and materials' && t.billable ? ' (billable)' : ''}`]))];
  const weekOptions = () => { const m = E.mondayOf(today()); const out = []; for (let i = 0; i < 10; i++) { const d = U.addDays(m, -7 * i); if (E.S.periods[U.periodOf(d)] === 'Open' || i < 2) out.push([d, `Week of ${fdate(d)}${i === 0 ? ' (this week)' : ''}`]); } return out; };
  App.act('ts-new', (ds) => {
    const emps = activeEmps(); const cols = [{ key: 'task', label: 'Project / task', type: 'select', options: taskOptions() }, ...E.TS_DAYS.map((d) => ({ key: d, label: d, type: 'number', width: '62px' })), { key: 'total', label: 'Total', type: 'text', readonly: true, width: '70px' }];
    const html = `<div class="row">${App.field('Employee', App.select('tsEmp', emps.map((e) => [e.id, `${e.name} (${e.dept})`]), ds.emp || emps.find((e) => e.name === E.S.user)?.id || emps[0]?.id))}${App.field('Week', App.select('tsWeek', weekOptions(), U.addDays(E.mondayOf(today()), -7)))}</div>`
      + App.lines('tsLines', cols, [{}, {}]) + `<div class="callout" id="tsInfo"></div>`;
    App.drawer('Enter timesheet', html, {
      submitLabel: 'Submit for approval', wide: true,
      oninput: (f) => {
        let total = 0, bill = 0;
        App.$$('#tsLines tbody tr', f).forEach((tr) => {
          const h = E.TS_DAYS.reduce((a, d) => a + (+App.$(`[data-k="${d}"]`, tr).value || 0), 0); App.$('[data-k="total"]', tr).value = h ? String(U.r2(h)) : '';
          total += h; const [pid, tid] = App.$('[data-k="task"]', tr).value.split('|'); const p = E.project(pid); const t = p?.tasks.find((x) => x.id === tid);
          if (p && t && p.type === 'Time and materials' && t.billable) bill += h;
        });
        const e = E.emp(App.val(f, 'tsEmp')); const rate = e ? E.laborCostRate(e) : 0;
        App.$('#tsInfo', f).innerHTML = `<b class="num">${hrs(total)}</b> this week, ${hrs(bill)} billable. Cost rate for ${esc(e?.name)}: <b class="num">${fmt(rate)}</b>/h (salary / ${E.STANDARD_HOURS} plus employer tax), so approval reclasses about <b class="num">${fmt(total * rate)}</b> from 6000 to project cost. ${esc(E.emp(e?.managerId)?.name || 'A Controller')} approves.`;
      },
      onSubmit: (f) => E.createTimesheet({ empId: App.val(f, 'tsEmp'), weekStart: App.val(f, 'tsWeek'),
        lines: App.readLines(f, 'tsLines').filter((l) => l.task).map((l) => { const [projectId, taskId] = l.task.split('|'); return { projectId, taskId, hours: E.TS_DAYS.map((d) => l[d]) }; }) }),
      success: (t) => `${t.id} submitted: ${hrs(t.hours)} for approval.`,
    });
  });
  App.act('ts-approve', (ds) => App.try(() => E.approveTimesheet(ds.id), (t) => `${t.id} approved. ${fmt(t.cost)} labor cost posted (${t.journal}).`));
  App.act('ts-reject', (ds) => App.drawer(`Reject ${ds.id}`, App.field('Reason', App.input('rjWhy', '', 'text', 'placeholder="e.g. Hours on wrong task, please correct"')), { submitLabel: 'Reject timesheet', onSubmit: (f) => E.rejectTimesheet(ds.id, App.val(f, 'rjWhy') || 'Returned for correction'), success: `${ds.id} rejected.` }));
  App.act('ts-submit', (ds) => App.try(() => E.submitTimesheet(ds.id), `${ds.id} submitted.`));
  const tsButtons = (t, sm) => t.status === 'Submitted' ? App.btn('Reject', 'ts-reject', { id: t.id }, 'prj.approve', 'danger' + sm) + App.btn('Approve', 'ts-approve', { id: t.id }, 'prj.approve', 'primary' + sm)
    : t.status === 'Draft' ? App.btn('Submit', 'ts-submit', { id: t.id }, 'prj.time', 'primary' + sm) : '';

  App.view('timesheets', {
    title: 'Timesheets', group: 'Projects',
    render() {
      const all = E.S.timesheets; const pend = E.pendingTimesheets();
      const month = U.periodOf(today());
      const inMonth = all.filter((t) => t.status === 'Approved' && U.periodOf(t.weekStart) === month);
      const mh = U.sum(inMonth, (t) => t.hours), mb = U.sum(inMonth.flatMap((t) => t.lines.filter((l) => l.billable)), lineHours);
      const head = App.head('Projects', 'Timesheets', 'Weekly project time by employee and task. Managers approve; approval costs the hours and reclasses wages to project cost.', App.btn('Enter timesheet', 'ts-new', {}, 'prj.time', 'primary'));
      const kpis = `<div class="kpis">`
        + App.kpi('Awaiting approval', num(pend.length), pend.length ? hrs(U.sum(pend, (t) => t.hours)) : 'Nothing to review')
        + App.kpi(`Approved hours, ${U.periodLabel(month)}`, hrs(mh), `${mh ? pct(mb / mh) : '0%'} billable`)
        + App.kpi('Labor cost reclassed', fmt0(U.sum(all.filter((t) => t.status === 'Approved'), (t) => t.cost || 0)), 'To 5200 and 6700, fiscal year to date')
        + App.kpi('Timesheets', num(all.length), `${all.filter((t) => t.status === 'Rejected').length} rejected`)
        + `</div>`;
      const tab = App.tabOf('timesheets', pend.length ? 'pending' : 'all');
      const tabs = App.tabs('timesheets', [['pending', `Awaiting approval (${pend.length})`], ['all', 'All timesheets']]);
      const rows = (tab === 'pending' ? pend : all).slice().sort((a, b) => b.weekStart.localeCompare(a.weekStart) || b.id.localeCompare(a.id));
      const tbl = `<section class="card">` + App.table([
        { h: 'Timesheet', f: (t) => App.link('timesheet', t.id) },
        { h: 'Employee', f: (t) => empLink(t.empId) },
        { h: 'Week of', f: (t) => nowrap(fdate(t.weekStart)) },
        { h: 'Projects', f: (t) => [...new Set(t.lines.map((l) => l.projectId))].map((id) => App.link('project', id)).join(' ') },
        { h: 'Hours', num: true, f: (t) => hrs(t.hours) },
        { h: 'Cost', num: true, f: (t) => (t.status === 'Approved' ? fmt(t.cost) : `<span class="muted">${fmt(t.hours * E.laborCostRate(E.emp(t.empId)))}</span>`) },
        { h: 'Status', f: (t) => pill(t.status) },
        { h: '', f: (t) => `<div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">${tsButtons(t, ' sm')}</div>` },
      ], rows.slice(0, 120), { empty: tab === 'pending' ? 'No timesheets are waiting for approval.' : 'No timesheets yet.' }) + (rows.length > 120 ? `<div class="pad small muted">Showing 120 of ${rows.length}. Search by ID to find older ones.</div>` : '') + `</section>`;
      return head + kpis + tabs + tbl;
    },
  });

  App.detail('timesheet', (id) => {
    const t = E.timesheet(id); if (!t) return null; const e = E.emp(t.empId);
    const rate = t.status === 'Approved' ? t.lines[0]?.costRate : E.laborCostRate(e);
    const grid = App.table([
      { h: 'Project / task', f: (l) => `${App.link('project', l.projectId)} <span class="small">${esc(E.project(l.projectId)?.tasks.find((x) => x.id === l.taskId)?.name)}</span>${l.billable ? ' <span class="pill info">Billable</span>' : ''}` },
      ...E.TS_DAYS.map((d, i) => ({ h: d, num: true, f: (l) => (l.hours[i] ? num(l.hours[i]) : '') })),
      { h: 'Total', num: true, f: (l) => num(lineHours(l)) },
      { h: 'Cost', num: true, f: (l) => (t.status === 'Approved' ? fmt(l.cost) : '') },
      { h: 'Billed', f: (l) => (l.invoiceId ? App.link('arinv', l.invoiceId) : '') },
    ], t.lines, { foot: ['Total', ...E.TS_DAYS.map((d, i) => num(U.sum(t.lines, (l) => l.hours[i]))), num(t.hours), t.status === 'Approved' ? fmt(t.cost) : '', ''] });
    const html = App.dl([['Employee', empLink(t.empId)], ['Week', `${fdate(t.weekStart)} to ${fdate(U.addDays(t.weekStart, 4))}`], ['Status', pill(t.status)], ['Approver', empLink(t.approverId)],
        ['Cost rate', `<span class="num">${fmt(rate)}</span>/h`], t.approvedBy && ['Approved by', esc(t.approvedBy)], t.journal && ['Journal', App.link('je', t.journal)], t.rejectReason && ['Rejection reason', esc(t.rejectReason)]])
      + grid + (t.status === 'Submitted' ? `<div class="callout">Approving posts the labor reclass: about <b class="num">${fmt(t.hours * rate)}</b> Dr 5200 Cost of services / 6700 R&D labor, Cr 6000 Salaries and wages.</div>` : '')
      + (t.journal ? App.journalLines(E.je(t.journal)) : '');
    return { title: `Timesheet ${t.id}`, html, buttons: tsButtons(t, '') };
  });

  // ================= Expenses =================
  const projectOptions = () => [['', 'No project'], ...activeProjects().map((p) => [p.id, `${p.id} ${p.name.length > 26 ? p.name.slice(0, 25) + '…' : p.name}`])];
  const flagHtml = (n) => (n ? `<span class="pill bad">${n} policy flag${n === 1 ? '' : 's'}</span>` : '<span class="pill good">In policy</span>');
  App.act('exp-new', (ds) => {
    const emps = activeEmps();
    const cols = [{ key: 'date', label: 'Date', type: 'text', width: '112px' }, { key: 'category', label: 'Category', type: 'select', options: Object.keys(E.EXPENSE_CATEGORIES) },
      { key: 'amount', label: 'Amount', type: 'number', width: '96px' }, { key: 'projectId', label: 'Project', type: 'select', options: projectOptions() },
      { key: 'billable', label: 'Billable', type: 'select', options: ['No', 'Yes'], width: '80px' }, { key: 'receipt', label: 'Receipt', type: 'select', options: ['Yes', 'No'], width: '80px' }, { key: 'desc', label: 'Note', type: 'text' }];
    const html = `<div class="row">${App.field('Employee', App.select('exEmp', emps.map((e) => [e.id, `${e.name} (${e.dept})`]), ds.emp || emps.find((e) => e.name === E.S.user)?.id || emps[0]?.id))}${App.field('Report date', App.input('exDate', today(), 'date'))}</div>`
      + App.field('Business purpose', App.input('exPurpose', '', 'text', 'placeholder="e.g. Meridian site visit, north district"'))
      + App.lines('exLines', cols, [{ date: today(), category: 'Travel', receipt: 'Yes' }]) + `<div class="callout" id="exInfo"></div>`;
    App.drawer('New expense report', html, {
      submitLabel: 'Submit for approval', wide: true,
      oninput: (f) => {
        const lines = App.readLines(f, 'exLines').map((l) => ({ ...l, receipt: l.receipt === 'Yes' }));
        const flags = E.expensePolicyCheck(lines);
        App.$$('#exLines tbody tr', f).forEach((tr, i) => { tr.style.background = flags[i]?.length ? 'var(--bad-soft)' : ''; tr.title = (flags[i] || []).join('; '); });
        const all = [...new Set(flags.flat())]; const tot = lines.reduce((a, l) => a + (+l.amount || 0), 0);
        const box = App.$('#exInfo', f); box.className = 'callout' + (all.length ? ' warn' : '');
        box.innerHTML = `Total <b class="num">${fmt(tot)}</b>. ` + (all.length ? `<b>Policy flags</b> (the approver will see these): ${all.map(esc).join('; ')}.` : `In policy: meals up to ${fmt(E.MEALS_DAILY_LIMIT)} per day, receipts attached for anything over ${fmt(E.RECEIPT_THRESHOLD)}.`)
          + ` Billable lines on time and materials projects are re-invoiced at cost + ${E.EXPENSE_MARKUP * 100}%.`;
      },
      onSubmit: (f) => E.createExpenseReport({ empId: App.val(f, 'exEmp'), date: App.val(f, 'exDate'), purpose: App.val(f, 'exPurpose'), lines: App.readLines(f, 'exLines').filter((l) => l.amount || l.date !== today()) }),
      success: (x) => `${x.id} submitted for ${fmt(x.total)}${x.violations ? ` with ${x.violations} policy flag(s)` : ''}.`,
    });
  });
  App.act('exp-approve', (ds) => App.try(() => E.approveExpenseReport(ds.id), (x) => `${x.id} approved. ${fmt(x.total)} owed to ${E.emp(x.empId)?.name} (2150).`));
  App.act('exp-reject', (ds) => App.drawer(`Reject ${ds.id}`, App.field('Reason', App.input('rjWhy', '', 'text', 'placeholder="e.g. Attach the missing receipts"')), { submitLabel: 'Reject report', onSubmit: (f) => E.rejectExpenseReport(ds.id, App.val(f, 'rjWhy') || 'Returned for correction'), success: `${ds.id} rejected.` }));
  App.act('exp-submit', (ds) => App.try(() => E.submitExpenseReport(ds.id), `${ds.id} submitted.`));
  App.act('exp-reimburse', () => {
    const list = E.reimbursableExpenses(); if (!list.length) { App.toast('There are no approved expense reports waiting for reimbursement.', 'bad'); return; }
    App.drawer('Reimburse approved expenses', App.field('Payment date', App.input('rbDate', today(), 'date'))
      + App.table([{ h: 'Report', f: (x) => App.link('expense', x.id) }, { h: 'Employee', f: (x) => esc(E.emp(x.empId)?.name) }, { h: 'Purpose', f: (x) => esc(x.purpose) }, { h: 'Amount', num: true, f: (x) => fmt(x.total) }], list, { foot: ['Total', '', '', fmt(U.sum(list, (x) => x.total))] })
      + `<div class="callout">Pays employees by ACH: Dr 2150 Employee reimbursements payable, Cr 1000 Cash. Operating cash available: <b class="num">${fmt(E.balance('1000'))}</b>.</div>`,
    { submitLabel: 'Release reimbursement', onSubmit: (f) => E.reimburseExpenses(null, App.val(f, 'rbDate')), success: (b) => `${b.id} paid ${fmt(b.total)} to employees.` });
  });
  const expButtons = (x, sm) => x.status === 'Submitted' ? App.btn('Reject', 'exp-reject', { id: x.id }, 'prj.approve', 'danger' + sm) + App.btn('Approve', 'exp-approve', { id: x.id }, 'prj.approve', 'primary' + sm)
    : x.status === 'Draft' ? App.btn('Submit', 'exp-submit', { id: x.id }, 'exp.submit', 'primary' + sm) : '';

  App.view('expenses', {
    title: 'Expenses', group: 'Projects',
    render() {
      const all = E.S.expenseReports, pend = E.pendingExpenses(), owed = E.reimbursableExpenses();
      const flagged = all.filter((x) => x.violations && ['Submitted', 'Approved'].includes(x.status));
      const fy = all.filter((x) => ['Approved', 'Reimbursed'].includes(x.status));
      const head = App.head('Projects', 'Expenses', 'Employee expense reports with policy checks, manager approval and reimbursement. Project expenses roll into project cost; billable ones are re-invoiced.',
        App.btn('Reimburse approved', 'exp-reimburse', {}, 'exp.reimburse') + App.btn('New expense report', 'exp-new', {}, 'exp.submit', 'primary'));
      const kpis = `<div class="kpis">`
        + App.kpi('Awaiting approval', num(pend.length), pend.length ? fmt(U.sum(pend, (x) => x.total)) : 'Nothing to review')
        + App.kpi('Owed to employees', fmt(U.sum(owed, (x) => x.total)), `${owed.length} approved report(s), GL 2150 ${fmt(-E.balance('2150'))}`)
        + App.kpi('Policy flags', num(flagged.length), 'Open reports outside policy')
        + App.kpi('Approved this year', fmt0(U.sum(fy, (x) => x.total)), `${fy.length} report(s)`)
        + `</div>`;
      const tab = App.tabOf('expenses', 'all');
      const tabs = App.tabs('expenses', [['all', 'All reports'], ['pending', `Awaiting approval (${pend.length})`], ['owed', `To reimburse (${owed.length})`]]);
      const rows = (tab === 'pending' ? pend : tab === 'owed' ? owed : all).slice().sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
      const tbl = `<section class="card">` + App.table([
        { h: 'Report', f: (x) => App.link('expense', x.id) },
        { h: 'Employee', f: (x) => empLink(x.empId) },
        { h: 'Purpose', f: (x) => esc(x.purpose) },
        { h: 'Date', f: (x) => nowrap(fdate(x.date)) },
        { h: 'Amount', num: true, f: (x) => fmt(x.total) },
        { h: 'Policy', f: (x) => flagHtml(x.violations) },
        { h: 'Status', f: (x) => pill(x.status) + (x.reimbursement ? `<div class="small">${App.link('reimb', x.reimbursement)}</div>` : '') },
        { h: '', f: (x) => `<div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">${expButtons(x, ' sm')}</div>` },
      ], rows, { empty: 'No expense reports here.' }) + `</section>`;
      const rb = E.S.reimbursements.slice().reverse().slice(0, 8);
      const batches = `<section class="card" style="margin-top:16px"><div class="card-h"><span>Reimbursement batches</span></div>` + App.table([
        { h: 'Batch', f: (b) => App.link('reimb', b.id) }, { h: 'Date', f: (b) => nowrap(fdate(b.date)) }, { h: 'Reports', num: true, f: (b) => num(b.reports.length) }, { h: 'Amount', num: true, f: (b) => fmt(b.total) }, { h: 'Journal', f: (b) => App.link('je', b.journal) },
      ], rb, { empty: 'No reimbursements yet.' }) + `</section>`;
      return head + kpis + tabs + tbl + batches;
    },
  });

  App.detail('expense', (id) => {
    const x = E.expenseReport(id); if (!x) return null;
    const html = App.dl([['Employee', empLink(x.empId)], ['Purpose', esc(x.purpose)], ['Report date', fdate(x.date)], ['Status', pill(x.status)], ['Policy', flagHtml(x.violations)], ['Approver', empLink(x.approverId)],
        x.approvedBy && ['Approved by', esc(x.approvedBy)], x.journal && ['Journal', App.link('je', x.journal)], x.reimbursement && ['Reimbursed', `${App.link('reimb', x.reimbursement)} on ${fdate(x.reimbursed)}`], x.rejectReason && ['Rejection reason', esc(x.rejectReason)]])
      + App.table([
        { h: 'Date', f: (l) => nowrap(fdate(l.date)) }, { h: 'Category', f: (l) => `${esc(l.category)}<div class="small muted">${App.link('acct', l.acct)}</div>` },
        { h: 'Project', f: (l) => (l.projectId ? App.link('project', l.projectId) : '<span class="muted">None</span>') + (l.billable ? ' <span class="pill info">Billable</span>' : '') + (l.invoiceId ? ` ${App.link('arinv', l.invoiceId)}` : '') },
        { h: 'Receipt', f: (l) => (l.receipt ? 'Yes' : '<span class="muted">No</span>') },
        { h: 'Amount', num: true, f: (l) => fmt(l.amount) },
        { h: 'Policy', f: (l) => (l.flags?.length ? l.flags.map((m) => `<div class="small" style="color:var(--bad)">${esc(m)}</div>`).join('') : '<span class="small muted">OK</span>') + (l.desc ? `<div class="small muted">${esc(l.desc)}</div>` : '') },
      ], x.lines, { foot: ['Total', '', '', '', fmt(x.total), ''] })
      + (x.violations && x.status === 'Submitted' ? `<div class="callout warn">This report has ${x.violations} policy flag(s). Review them before approving.</div>` : '')
      + (x.status === 'Submitted' ? `<div class="callout">Approving posts Dr each expense account, Cr 2150 Employee reimbursements payable <b class="num">${fmt(x.total)}</b>.</div>` : '')
      + (x.journal ? App.journalLines(E.je(x.journal)) : '');
    return { title: `Expense report ${x.id}`, html, buttons: expButtons(x, '') };
  });

  App.detail('reimb', (id) => {
    const b = E.reimbursement(id); if (!b) return null;
    return { title: `Reimbursement ${b.id}`, html: App.dl([['Date', fdate(b.date)], ['Amount', `<span class="num">${fmt(b.total)}</span>`], ['Released by', esc(b.by)], ['Journal', App.link('je', b.journal)]])
      + App.table([{ h: 'Report', f: (rid) => App.link('expense', rid) }, { h: 'Employee', f: (rid) => esc(E.emp(E.expenseReport(rid)?.empId)?.name) }, { h: 'Amount', num: true, f: (rid) => fmt(E.expenseReport(rid)?.total) }], b.reports) };
  });
})();
