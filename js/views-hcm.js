/* Ledgerline Suite — views-hcm.js
 * People module: Workforce (directory, org chart, departments), Absence, Payroll.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, fdate = App.fdate, pill = App.pill;

  const active = () => E.S.employees.filter((e) => e.status === 'Active');
  const tenureYears = (e) => Math.max(0, U.daysBetween(e.hireDate, E.S.today) / 365.25);
  const empLink = (id) => { const e = E.emp(id); return e ? App.link('emp', e.id, e.name) : '<span class="muted">None</span>'; };

  // ---------- Workforce ----------
  App.act('emp-hire', () => {
    const act = active();
    App.drawer('Hire employee', `<div class="row">${App.field('Full name', App.input('hName', '', 'text', 'placeholder="e.g. Jordan Reyes" autocomplete="off"'))}${App.field('Job title', App.input('hTitle', '', 'text', 'placeholder="e.g. Test Engineer"'))}</div>`
      + `<div class="row">${App.field('Department', App.select('hDept', E.S.departments))}${App.field('Manager', App.select('hMgr', [['', 'No manager'], ...act.map((e) => [e.id, `${e.name}, ${e.title}`])], act[0]?.id || ''))}</div>`
      + `<div class="row">${App.field('Annual salary (USD)', App.input('hSal', '', 'number', 'min="0" step="1000" placeholder="e.g. 95000"'))}${App.field('Hire date', App.input('hDate', E.S.today, 'date'))}${App.field('Location', App.input('hLoc', 'Boston, MA'))}</div>`
      + `<div class="callout" id="hInfo">New hires start with 15 vacation days and join the first payroll run for a period that ends on or after their hire date.</div>`,
      { submitLabel: 'Hire',
        oninput: (f) => { const s = +App.val(f, 'hSal') || 0; App.$('#hInfo', f).innerHTML = s > 0 ? `Monthly gross <b class="num">${fmt(s / 12)}</b>, employer tax <b class="num">${fmt(U.r2(s / 12) * E.EMPLOYER_TAX_RATE)}</b> per month. New hires start with 15 vacation days.` : 'New hires start with 15 vacation days and join the first payroll run for a period that ends on or after their hire date.'; },
        onSubmit: (f) => E.hireEmployee({ name: App.val(f, 'hName'), title: App.val(f, 'hTitle'), dept: App.val(f, 'hDept'), managerId: App.val(f, 'hMgr'), salary: App.val(f, 'hSal'), hireDate: App.val(f, 'hDate'), location: App.val(f, 'hLoc') }),
        success: (e) => `${e.name} hired as ${e.title} (${e.id}).` });
  });

  function orgTree() {
    const act = active(), ids = new Set(act.map((e) => e.id));
    const kids = (id) => act.filter((e) => e.managerId === id).sort((a, b) => b.salary - a.salary || a.name.localeCompare(b.name));
    const roots = act.filter((e) => !e.managerId || !ids.has(e.managerId));
    const node = (e, depth) => {
      const ks = depth < 12 ? kids(e.id) : [];
      return `<li><div class="node">${App.link('emp', e.id, e.name)}<small>${esc(e.title)}</small><small>${esc(e.dept)}${ks.length ? ` &middot; ${ks.length} direct report${ks.length === 1 ? '' : 's'}` : ''}</small></div>${ks.length ? `<ul class="tree">${ks.map((k) => node(k, depth + 1)).join('')}</ul>` : ''}</li>`;
    };
    if (!roots.length) return '<div class="empty">No active employees.</div>';
    return `<div class="pad" style="overflow-x:auto"><ul class="tree root">${roots.map((r) => node(r, 0)).join('')}</ul></div>`;
  }

  App.view('workforce', {
    title: 'Workforce',
    render() {
      const S = E.S, act = active();
      const cost = U.sum(act, (e) => e.salary);
      const avgTen = act.length ? act.reduce((a, e) => a + tenureYears(e), 0) / act.length : 0;
      const tab = App.tabOf('workforce', 'dir');
      const head = App.head('People', 'Workforce', 'Employees, reporting lines and department cost for Halden Instruments.', App.btn('Hire employee', 'emp-hire', {}, 'hr.edit', 'primary'));
      const kpis = `<div class="kpis">`
        + App.kpi('Active headcount', App.num(act.length), `${S.employees.length - act.length} former employee(s)`)
        + App.kpi('Annual payroll cost', App.fmt0(cost), `Salaries of active staff, ${App.fmt0(cost * (1 + E.EMPLOYER_TAX_RATE))} with employer tax`)
        + App.kpi('Departments', App.num(S.departments.length), `${S.departments.filter((d) => act.some((e) => e.dept === d)).length} staffed`)
        + App.kpi('Average tenure', `${avgTen.toFixed(1)} yrs`, `As of ${fdate(S.today)}`)
        + `</div>`;
      const tabs = App.tabs('workforce', [['dir', 'Directory'], ['org', 'Org chart'], ['dept', 'Departments']]);
      let body = '';
      if (tab === 'dir') {
        const dept = App.ui.filter.workforce || '';
        const rows = S.employees.filter((e) => !dept || e.dept === dept)
          .sort((a, b) => (a.status === 'Active' ? 0 : 1) - (b.status === 'Active' ? 0 : 1) || a.name.localeCompare(b.name));
        body = `<section class="card"><div class="card-h"><span>Directory</span><label class="small muted" style="display:flex;gap:6px;align-items:center;font-weight:400">Department ${App.select('wfDept', [['', 'All departments'], ...S.departments.map((d) => [d, d])], dept, 'class="cell-in" style="width:auto"')}</label></div>`
          + App.table([
            { h: 'Name', f: (e) => App.link('emp', e.id, e.name) + `<div class="mono small muted">${esc(e.id)}</div>` },
            { h: 'Title', f: (e) => esc(e.title) },
            { h: 'Department', f: (e) => esc(e.dept) },
            { h: 'Manager', f: (e) => empLink(e.managerId) },
            { h: 'Hire date', f: (e) => `<span style="white-space:nowrap">${esc(fdate(e.hireDate))}</span>` },
            { h: 'Salary', num: true, f: (e) => fmt(e.salary) },
            { h: 'Status', f: (e) => pill(e.status) },
            { h: '', f: (e) => e.status === 'Active' ? App.btn('Terminate', 'emp-terminate', { id: e.id }, 'hr.edit', 'sm danger') : (e.termDate ? `<span class="small muted">Left ${esc(fdate(e.termDate))}</span>` : '') },
          ], rows, { empty: dept ? `No employees in ${esc(dept)}.` : 'No employees yet. Use Hire employee to add the first one.', foot: ['', '', '', '', `${rows.length} shown`, fmt(U.sum(rows.filter((e) => e.status === 'Active'), (e) => e.salary)), '', ''] })
          + `</section>`;
      } else if (tab === 'org') {
        body = `<section class="card"><div class="card-h"><span>Org chart</span><span class="muted small">Active employees by reporting line</span></div>${orgTree()}</section>`;
      } else {
        const rows = S.departments.map((d) => {
          const staff = act.filter((e) => e.dept === d);
          const headE = staff.slice().sort((a, b) => b.salary - a.salary || a.hireDate.localeCompare(b.hireDate))[0];
          return { d, n: staff.length, cost: U.sum(staff, (e) => e.salary), avg: staff.length ? U.r2(U.sum(staff, (e) => e.salary) / staff.length) : 0, head: headE };
        });
        body = `<section class="card"><div class="card-h"><span>Departments</span></div>` + App.table([
          { h: 'Department', f: (r) => esc(r.d) },
          { h: 'Head', f: (r) => r.head ? App.link('emp', r.head.id, r.head.name) + `<div class="small muted">${esc(r.head.title)}</div>` : '<span class="muted">Vacant</span>' },
          { h: 'Headcount', num: true, f: (r) => App.num(r.n) },
          { h: 'Annual salary cost', num: true, f: (r) => fmt(r.cost) },
          { h: 'Average salary', num: true, f: (r) => r.n ? fmt(r.avg) : '' },
          { h: 'Share of cost', num: true, f: (r) => cost ? `${Math.round((r.cost / cost) * 100)}%` : '' },
        ], rows, { empty: 'No departments set up.', foot: ['Total', '', App.num(act.length), fmt(cost), act.length ? fmt(cost / act.length) : '', '100%'] }) + `</section>`;
      }
      return head + kpis + tabs + body;
    },
    after(root) {
      const sel = root.querySelector('#wfDept');
      if (sel) sel.addEventListener('change', () => { App.ui.filter.workforce = sel.value; App.render(); });
    },
  });

  // ---------- Absence ----------
  App.view('absence', {
    title: 'Absence',
    render() {
      const S = E.S, today = S.today, abs = S.absences;
      const pending = abs.filter((a) => a.status === 'Pending');
      const upcoming = abs.filter((a) => a.status === 'Approved' && a.end >= today);
      const upDays = upcoming.reduce((n, a) => n + (a.start >= today ? a.days : U.businessDays(today, a.end)), 0);
      const outToday = abs.filter((a) => a.status === 'Approved' && a.start <= today && a.end >= today);
      const head = App.head('People', 'Absence', 'Vacation, sick and other leave. Requests go to the employee\'s manager, and HR approves them here.', App.btn('Request absence', 'abs-new', {}, 'hr.absence.create', 'primary'));
      const kpis = `<div class="kpis">`
        + App.kpi('Pending requests', App.num(pending.length), pending.length ? `${pending.reduce((n, a) => n + a.days, 0)} working days requested` : 'Nothing to review')
        + App.kpi('Approved days upcoming', App.num(upDays), `${upcoming.length} approved request(s) from today`)
        + App.kpi('Out today', App.num(new Set(outToday.map((a) => a.empId)).size), outToday.length ? outToday.map((a) => esc(E.emp(a.empId)?.name)).join(', ') : 'Everyone is in')
        + `</div>`;
      const rows = abs.slice().sort((a, b) => b.start.localeCompare(a.start) || b.id.localeCompare(a.id));
      const reqs = `<section class="card"><div class="card-h"><span>Requests</span><span class="muted small">Newest first</span></div>` + App.table([
        { h: 'Request', f: (a) => App.link('abs', a.id) },
        { h: 'Employee', f: (a) => empLink(a.empId) },
        { h: 'Type', f: (a) => esc(a.type) },
        { h: 'Dates', f: (a) => `<span style="white-space:nowrap">${esc(fdate(a.start))}</span>${a.end !== a.start ? ` to <span style="white-space:nowrap">${esc(fdate(a.end))}</span>` : ''}` },
        { h: 'Days', num: true, f: (a) => App.num(a.days) },
        { h: 'Status', f: (a) => pill(a.status) },
        { h: 'Approver', f: (a) => esc(E.emp(a.approverId)?.name || 'HR') + (a.decidedBy ? `<div class="small muted">Decided by ${esc(a.decidedBy)}</div>` : '') },
        { h: '', f: (a) => a.status === 'Pending' ? `<div class="actions" style="flex-wrap:nowrap;justify-content:flex-end">${App.btn('Reject', 'abs-reject', { id: a.id }, 'hr.absence.approve', 'sm danger')}${App.btn('Approve', 'abs-approve', { id: a.id }, 'hr.absence.approve', 'sm primary')}</div>` : '' },
      ], rows, { empty: 'No absence requests yet. Use Request absence to submit one.' }) + `</section>`;
      const bal = active().slice().sort((a, b) => a.name.localeCompare(b.name)).map((e) => {
        const mine = abs.filter((a) => a.empId === e.id && a.type === 'Vacation');
        return { e, pend: mine.filter((a) => a.status === 'Pending').reduce((n, a) => n + a.days, 0), booked: mine.filter((a) => a.status === 'Approved' && a.end >= today).reduce((n, a) => n + a.days, 0) };
      });
      const balances = `<section class="card"><div class="card-h"><span>Vacation balances</span><span class="muted small">Approved vacation is deducted when approved</span></div>` + App.table([
        { h: 'Employee', f: (r) => App.link('emp', r.e.id, r.e.name) },
        { h: 'Department', f: (r) => esc(r.e.dept) },
        { h: 'Booked, upcoming', num: true, f: (r) => r.booked ? App.num(r.booked) : '<span class="muted">0</span>' },
        { h: 'Pending', num: true, f: (r) => r.pend ? App.num(r.pend) : '<span class="muted">0</span>' },
        { h: 'Balance (days)', num: true, f: (r) => `<span style="color:${r.e.ptoBalance - r.pend < 0 ? 'var(--bad)' : r.e.ptoBalance <= 3 ? 'var(--warn)' : 'inherit'}">${App.num(r.e.ptoBalance)}</span>` },
        { h: '', f: (r) => App.btn('Request', 'abs-new', { emp: r.e.id }, 'hr.absence.create', 'sm') },
      ], bal, { empty: 'No active employees.' }) + `</section>`;
      return head + kpis + `<div class="stack">${reqs}${balances}</div>`;
    },
  });

  // ---------- Payroll ----------
  /** Mirrors E.runPayroll eligibility and rounding so the preview matches what will post. */
  function payPreview(p) {
    const end = U.periodEnd(p), start = p + '-01';
    const staff = E.S.employees.filter((e) => e.hireDate <= end && (e.status === 'Active' || (e.termDate && e.termDate >= start)));
    const slips = staff.map((e) => { const gross = U.r2(e.salary / 12), tax = U.r2(gross * E.WITHHOLDING_RATE), er = U.r2(gross * E.EMPLOYER_TAX_RATE); return { e, gross, tax, net: U.r2(gross - tax), er }; });
    return { slips, gross: U.sum(slips, (s) => s.gross), tax: U.sum(slips, (s) => s.tax), net: U.sum(slips, (s) => s.net), er: U.sum(slips, (s) => s.er) };
  }
  const runnable = () => App.openPeriods().filter((p) => !E.S.payruns.some((r) => r.period === p));
  App.act('pay-run', () => {
    const list = runnable();
    if (!list.length) { App.toast('Every open period already has a payroll run. Open the next period first.', 'bad'); return; }
    const body = (p) => {
      const pv = payPreview(p);
      return App.table([
        { h: 'Employee', f: (s) => esc(s.e.name) + (s.e.status !== 'Active' ? ' <span class="small muted">(final pay)</span>' : '') },
        { h: 'Department', f: (s) => esc(s.e.dept) },
        { h: 'Gross', num: true, f: (s) => fmt(s.gross) },
        { h: 'Withheld', num: true, f: (s) => fmt(s.tax) },
        { h: 'Net', num: true, f: (s) => fmt(s.net) },
        { h: 'Employer tax', num: true, f: (s) => fmt(s.er) },
      ], pv.slips, { empty: 'No employees are eligible for this period.', foot: [`${pv.slips.length} employees`, '', fmt(pv.gross), fmt(pv.tax), fmt(pv.net), fmt(pv.er)] })
        + `<div class="callout">Posts one journal dated ${esc(fdate(U.periodEnd(p)))}: Dr 6000 Salaries and wages <b class="num">${fmt(pv.gross)}</b>, Dr 6050 Employer payroll taxes <b class="num">${fmt(pv.er)}</b>, Cr 1000 Cash <b class="num">${fmt(pv.net)}</b> (net pay), Cr 2200 Payroll liabilities <b class="num">${fmt(U.r2(pv.tax + pv.er))}</b> (withholding at ${(E.WITHHOLDING_RATE * 100).toFixed(0)}% plus employer tax at ${(E.EMPLOYER_TAX_RATE * 100).toFixed(2)}%). Operating cash available: <b class="num">${fmt(E.balance('1000'))}</b>.</div>`;
    };
    App.drawer('Run payroll', App.field('Pay period', App.select('payPeriod', list.map((p) => [p, `${U.periodLabel(p)} (pay date ${fdate(U.periodEnd(p))})`]), list[0]), 'Only open periods without a payroll run are listed.') + `<div id="payPrev" class="stack">${body(list[0])}</div>`,
      { submitLabel: 'Run payroll', wide: true,
        oninput: (f) => { const p = App.val(f, 'payPeriod'); if (f.dataset.p !== p) { f.dataset.p = p; App.$('#payPrev', f).innerHTML = body(p); } },
        onSubmit: (f) => E.runPayroll(App.val(f, 'payPeriod')),
        success: (r) => `${r.id} posted for ${U.periodLabel(r.period)}: net pay ${fmt(r.net)} to ${r.slips.length} employees.` });
  });
  App.act('pay-remit', () => {
    const amt = U.r2(-E.balance('2200'));
    if (!(amt > 0)) { App.toast('There are no payroll liabilities to remit.', 'bad'); return; }
    App.confirm('Remit payroll taxes', `Pay <b class="num">${fmt(amt)}</b> of withheld and employer payroll taxes to the tax authority? This posts Dr 2200 Payroll liabilities and Cr 1000 Cash dated ${esc(fdate(E.S.today))}.`, 'Remit taxes', () => {
      const cash = E.balance('1000'); if (amt > cash) throw new Error(`Remittance of ${fmt(amt)} exceeds operating cash of ${fmt(cash)}.`);
      return E.createJournal({ date: E.S.today, source: 'Payroll', desc: 'Remit payroll taxes to tax authority', lines: [{ acct: '2200', dr: amt }, { acct: '1000', cr: amt }] });
    }, `Payroll taxes of ${fmt(amt)} remitted.`);
  });

  App.view('payroll', {
    title: 'Payroll',
    render() {
      const S = E.S, runs = S.payruns.slice().sort((a, b) => b.period.localeCompare(a.period));
      const last = runs[0], liab = U.r2(-E.balance('2200')), next = runnable()[0];
      const ytd = U.sum(S.payruns.filter((r) => r.period >= E.FY_START), (r) => r.gross);
      const remitBtn = liab > 0 ? App.btn('Remit payroll taxes', 'pay-remit', {}, 'hr.payroll') : `<button type="button" class="btn" disabled title="Payroll liabilities are zero">Remit payroll taxes</button>`;
      const head = App.head('People', 'Payroll', 'Monthly payroll for salaried staff. Each run posts gross pay, employer taxes, net pay and tax liabilities to the general ledger.', remitBtn + App.btn('Run payroll', 'pay-run', {}, 'hr.payroll', 'primary'));
      const kpis = `<div class="kpis">`
        + App.kpi('Last run net pay', last ? App.fmt0(last.net) : '$0', last ? `${U.periodLabel(last.period)}, ${last.slips.length} employees` : 'No runs yet')
        + App.kpi('Gross pay FYTD', App.fmt0(ytd), `${S.payruns.filter((r) => r.period >= E.FY_START).length} run(s) since ${U.periodLabel(E.FY_START)}`)
        + App.kpi('Payroll liabilities', App.fmt0(liab), 'GL 2200, owed to tax authority')
        + App.kpi('Next period to run', next ? U.periodLabel(next) : 'None open', next ? `Pay date ${fdate(U.periodEnd(next))}` : 'Open the next period first')
        + `</div>`;
      const table = `<section class="card"><div class="card-h"><span>Payroll runs</span></div>` + App.table([
        { h: 'Run', f: (r) => App.link('payrun', r.id) },
        { h: 'Period', f: (r) => esc(U.periodLabel(r.period)) },
        { h: 'Pay date', f: (r) => `<span style="white-space:nowrap">${esc(fdate(r.date))}</span>` },
        { h: 'Employees', num: true, f: (r) => App.num(r.slips.length) },
        { h: 'Gross', num: true, f: (r) => fmt(r.gross) },
        { h: 'Withholding', num: true, f: (r) => fmt(r.tax) },
        { h: 'Employer tax', num: true, f: (r) => fmt(r.employerTax) },
        { h: 'Net pay', num: true, f: (r) => fmt(r.net) },
        { h: 'Journal', f: (r) => App.link('je', r.journal) },
      ], runs, { empty: 'No payroll has been run yet. Use Run payroll to pay the first period.', foot: ['Total', '', '', '', fmt(U.sum(runs, (r) => r.gross)), fmt(U.sum(runs, (r) => r.tax)), fmt(U.sum(runs, (r) => r.employerTax)), fmt(U.sum(runs, (r) => r.net)), ''] }) + `</section>`;
      const note = `<div class="callout" style="margin-top:16px">Rates: employee withholding ${(E.WITHHOLDING_RATE * 100).toFixed(0)}% of gross, employer payroll tax ${(E.EMPLOYER_TAX_RATE * 100).toFixed(2)}% of gross. Monthly gross is annual salary divided by 12. Withholding and employer tax accrue to 2200 Payroll liabilities until remitted.</div>`;
      return head + kpis + table + note;
    },
  });
})();
