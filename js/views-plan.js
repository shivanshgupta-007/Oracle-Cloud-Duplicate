/* Ledgerline Suite — views-plan.js
 * Budgets and forecasts: budget vs actual (period and YTD, favourable/unfavourable by account type),
 * the budget entry grid (accounts x months), and the full-year outlook.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, fmt0 = App.fmt0, pill = App.pill;
  const F = App.ui.filter;
  const canEdit = () => App.can('plan.edit');
  const pct = (x) => (x == null || !isFinite(x) ? '<span class="muted">n/a</span>' : (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
  const signed = (v) => (v > 0 ? '+' : v < 0 ? '-' : '') + fmt0(Math.abs(v)).replace('-', '');
  const compact = (n) => { const a = Math.abs(n), s = n < 0 ? '-$' : '$'; if (a >= 1e6) return s + (+(a / 1e6).toFixed(1)) + 'M'; if (a >= 1e3) return s + Math.round(a / 1e3) + 'k'; return s + Math.round(a); };
  const niceStep = (raw) => { if (!(raw > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };

  /** Variance cell: signed amount plus a pill that names the direction (never colour alone). */
  const varCell = (v) => `<span class="num">${signed(v.variance)}</span>`;
  const favPill = (v) => v.favourable == null ? pill('On plan', '') : v.favourable ? pill('Favourable', 'good') : pill('Unfavourable', 'bad');

  const defaultPeriod = () => { const el = E.elapsedPeriods(); return el.length ? el[el.length - 1] : E.planPeriods()[0]; };

  // ---------- chart: monthly revenue actual vs budget ----------
  function chartSvg(data, W) {
    W = Math.max(280, Math.round(W || 640));
    const H = 230, ml = 50, mr = 10, mt = 10, mb = 26, pw = W - ml - mr, ph = H - mt - mb;
    const max = Math.max(1, ...data.map((d) => Math.max(d.actual, d.budget)));
    let step = niceStep(max / 4); if (Math.ceil(max / step) > 5) step = niceStep(max / 3);
    const top = Math.ceil(max / step) * step;
    const y = (v) => mt + ph - (Math.max(0, v) / top) * ph;
    const gw = pw / data.length, bw = Math.max(6, Math.min(24, gw * 0.42));
    let grid = '';
    for (let v = 0; v <= top + 1e-6; v += step) {
      const yy = y(v).toFixed(1);
      grid += `<line x1="${ml}" x2="${W - mr}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1" ${v ? 'stroke-dasharray="2 3"' : ''}/>`
        + `<text x="${ml - 8}" y="${yy}" dy="0.32em" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--mono)">${compact(v)}</text>`;
    }
    const cx = (i) => ml + gw * i + gw / 2;
    const pts = data.map((d, i) => `${cx(i).toFixed(1)},${y(d.budget).toFixed(1)}`).join(' ');
    const groups = data.map((d, i) => {
      const x = cx(i) - bw / 2, yt = y(d.actual), h = mt + ph - yt;
      const r = Math.min(4, bw / 2, h);
      const bar = d.hasActual && h > 0 ? `<path d="M${x.toFixed(1)},${mt + ph} V${(yt + r).toFixed(1)} Q${x.toFixed(1)},${yt.toFixed(1)} ${(x + r).toFixed(1)},${yt.toFixed(1)} H${(x + bw - r).toFixed(1)} Q${(x + bw).toFixed(1)},${yt.toFixed(1)} ${(x + bw).toFixed(1)},${(yt + r).toFixed(1)} V${mt + ph} Z" fill="var(--series-1)"/>` : '';
      const lbl = (data.length > 8 && W < 480 && i % 2) ? '' : `<text x="${cx(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(d.label)}</text>`;
      return `<g class="pc-grp" data-i="${i}"><rect class="pc-hi" x="${(ml + gw * i + 2).toFixed(1)}" y="${mt}" width="${(gw - 4).toFixed(1)}" height="${ph}" rx="4" fill="var(--surface-2)" opacity="0"/>${bar}${lbl}`
        + `<rect class="pc-hit" x="${(ml + gw * i).toFixed(1)}" y="${mt}" width="${gw.toFixed(1)}" height="${ph + mb}" fill="transparent"/></g>`;
    }).join('');
    const dots = data.map((d, i) => `<circle cx="${cx(i).toFixed(1)}" cy="${y(d.budget).toFixed(1)}" r="3" fill="var(--surface)" stroke="var(--series-2)" stroke-width="2" pointer-events="none"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Monthly revenue, actual versus budget, ${esc(data[0].label)} to ${esc(data[data.length - 1].label)}" style="display:block;height:auto">${grid}${groups}<polyline points="${pts}" fill="none" stroke="var(--series-2)" stroke-width="2" pointer-events="none"/>${dots}</svg>`;
  }
  function chartTable(data) {
    return App.table([
      { h: 'Month', f: (d) => esc(d.label) + (d.hasActual ? '' : ' <span class="muted small">(no actuals)</span>') },
      { h: 'Actual', num: true, f: (d) => d.hasActual ? fmt(d.actual) : '' },
      { h: 'Budget', num: true, f: (d) => fmt(d.budget) },
      { h: 'Variance', num: true, f: (d) => d.hasActual ? signed(d.actual - d.budget) : '' },
    ], data, { foot: ['Total', fmt(U.sum(data, (d) => d.actual)), fmt(U.sum(data, (d) => d.budget)), ''] });
  }
  function wireChart(root) {
    const wrap = root.querySelector('#planChart'); if (!wrap) return;
    const data = E.revenueSeries(E.PLAN_BUDGET); const tip = wrap.querySelector('.chart-tip');
    const draw = () => { const w = wrap.clientWidth; if (!w) return; wrap.dataset.w = w; wrap.querySelector('.pc-svg').innerHTML = chartSvg(data, w); };
    draw();
    const hide = () => { tip.hidden = true; wrap.querySelectorAll('.pc-hi').forEach((r) => r.setAttribute('opacity', '0')); };
    const show = (g) => {
      const d = data[+g.dataset.i]; if (!d) return;
      wrap.querySelectorAll('.pc-hi').forEach((r) => r.setAttribute('opacity', '0')); g.querySelector('.pc-hi').setAttribute('opacity', '1');
      const v = U.r2(d.actual - d.budget);
      tip.innerHTML = `<b>${esc(d.label)}</b>${d.status === 'Open' ? ' <span class="muted">(open)</span>' : ''}<br>`
        + `<span style="color:var(--series-1)">&#9632;</span> Actual <span class="num">${d.hasActual ? fmt(d.actual) : 'none yet'}</span><br>`
        + `<span style="color:var(--series-2)">&#9679;</span> Budget <span class="num">${fmt(d.budget)}</span>`
        + (d.hasActual ? `<br>Variance <span class="num">${signed(v)}</span> ${v >= 0 ? '(favourable)' : '(unfavourable)'}` : '');
      tip.hidden = false;
      const wr = wrap.getBoundingClientRect(), gr = g.querySelector('.pc-hit').getBoundingClientRect(), tw = tip.offsetWidth;
      let left = gr.right - wr.left; if (left + tw > wr.width) left = gr.left - wr.left - tw;
      tip.style.left = Math.max(0, Math.min(wr.width - tw, left)) + 'px'; tip.style.top = '16px';
    };
    wrap.addEventListener('mouseover', (ev) => { const g = ev.target.closest('.pc-grp'); if (g) show(g); });
    wrap.addEventListener('mouseleave', hide);
    wrap.addEventListener('click', (ev) => { const g = ev.target.closest('.pc-grp'); if (g) show(g); else hide(); });
    if (window.ResizeObserver) { const ro = new ResizeObserver(() => { if (!document.contains(wrap)) { ro.disconnect(); return; } if (Math.abs(wrap.clientWidth - (+wrap.dataset.w || 0)) > 4) { hide(); draw(); } }); ro.observe(wrap); }
  }
  App.act('plan-chart-toggle', () => { F.planChartTable = !F.planChartTable; App.render(); });

  // ---------- tab: budget vs actual ----------
  function bvaTab() {
    const period = F.planPeriod && E.S.periods[F.planPeriod] ? F.planPeriod : defaultPeriod();
    const ver = E.PLAN_VERSIONS.includes(F.planCompare) ? F.planCompare : E.PLAN_BUDGET;
    const dept = F.planDept && (E.S.departments.includes(F.planDept) || F.planDept === E.UNASSIGNED) ? F.planDept : 'All';
    const r = E.budgetVsActual(period, ver, { dept });
    const controls = `<div class="pad" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
      ${App.field('Period', App.select('planPeriod', E.planPeriods().map((p) => [p, U.periodLabel(p) + ` (${E.S.periods[p]})`]), period))}
      ${App.field('Compare actuals to', App.select('planCompare', E.PLAN_VERSIONS, ver))}
      ${App.field('Department', App.select('planDept', [['All', 'All departments (company)'], ...E.S.departments.map((d) => [d, d]), [E.UNASSIGNED, 'Unassigned']], dept))}
      ${dept !== 'All' ? `<span class="hint">${esc(dept)}: actuals are journal lines tagged with this department; plan is its share of the company budget (wages by salary, other operating costs by headcount).</span>` : ''}
      <span class="hint">Variance is actual minus plan. Revenue above plan is favourable; costs above plan are unfavourable. YTD runs ${esc(U.periodLabel(r.ytdFrom))} to ${esc(U.periodLabel(period))}.</span></div>`;
    const row = (x, label, cls = '') => `<tr class="${cls === 'indent-row' ? '' : cls}"><td class="${cls === 'indent-row' ? 'indent' : ''}" style="white-space:nowrap">${label}</td>`
      + ['period', 'ytd'].map((k) => `<td class="num">${fmt(x[k].actual)}</td><td class="num">${fmt(x[k].budget)}</td><td class="num">${varCell(x[k])}</td><td class="num">${pct(x[k].pct)}</td><td>${favPill(x[k])}</td>`).join('') + '</tr>';
    const acctRow = (a) => row({ period: a.period, ytd: a.ytd }, `${App.link('acct', a.code)} ${esc(a.name)}`, 'indent-row');
    const tot = (key, label) => row({ period: r.totals.period[key], ytd: r.totals.ytd[key] }, `<b>${label}</b>`, 'grp');
    const grp = (g) => r.rows.filter((a) => a.group === g && (a.period.actual || a.period.budget || a.ytd.actual || a.ytd.budget)).map(acctRow).join('');
    const th = `<thead><tr><th rowspan="2">Account</th><th colspan="5" style="text-align:center">${esc(U.periodLabel(period))}</th><th colspan="5" style="text-align:center">Year to date</th></tr>
      <tr>${['', ''].map(() => '<th class="num">Actual</th><th class="num">Plan</th><th class="num">Variance</th><th class="num">Var %</th><th>Status</th>').join('')}</tr></thead>`;
    const table = `<div class="tbl-wrap"><table class="t" id="bvaTable">${th}<tbody>
      ${grp('revenue')}${tot('revenue', 'Total revenue')}${grp('cogs')}${tot('cogs', 'Total cost of sales')}${tot('gross', 'Gross margin')}
      ${grp('opex')}${tot('opex', 'Total operating expenses')}${tot('net', 'Net income')}</tbody></table></div>`;
    const data = E.revenueSeries(E.PLAN_BUDGET); const asTable = !!F.planChartTable;
    const chart = `<section class="card"><div class="card-h"><span>Monthly revenue: actual vs ${esc(E.PLAN_BUDGET)}</span>
        <button type="button" class="btn sm" data-act="plan-chart-toggle" aria-pressed="${asTable}">${asTable ? 'View as chart' : 'View as table'}</button></div>
      <div class="pad">${asTable ? chartTable(data) : `<div class="legend" style="margin-bottom:8px"><span><i style="background:var(--series-1)"></i>Actual revenue</span><span><i style="background:var(--series-2);height:3px;vertical-align:3px"></i>Budget</span></div>
        <div id="planChart" style="position:relative"><div class="pc-svg">${chartSvg(data, 640)}</div><div class="chart-tip" hidden></div></div><p class="hint" style="margin:8px 0 0">Hover or tap a month for the figures.</p>`}</div></section>`;
    return `<div class="stack"><section class="card">${controls}${table}</section>${deptCard(period, ver)}${chart}</div>`;
  }
  /** Operating expense and purchasing budgets by department for the period and YTD. */
  function deptCard(period, ver) {
    const rows = E.deptBudgetSummary(period, ver);
    const tbl = App.table([
      { h: 'Department', f: (x) => (x.dept === E.UNASSIGNED ? '<span class="muted">Unassigned</span>' : `<button type="button" class="btn sm" data-act="plan-dept" data-dept="${esc(x.dept)}">${esc(x.dept)}</button>`) },
      { h: `Opex actual ${esc(U.periodLabel(period))}`, num: true, f: (x) => fmt(x.period.actual) },
      { h: 'Opex plan', num: true, f: (x) => fmt(x.period.budget) },
      { h: 'Variance', num: true, f: (x) => varCell(x.period) },
      { h: 'YTD actual', num: true, f: (x) => fmt(x.ytd.actual) },
      { h: 'YTD plan', num: true, f: (x) => fmt(x.ytd.budget) },
      { h: 'YTD status', f: (x) => favPill(x.ytd) },
      { h: 'Purchasing budget', num: true, f: (x) => (x.purchases.budget ? fmt(x.purchases.budget) : '<span class="muted">-</span>') },
      { h: 'Requisitions committed', num: true, f: (x) => (x.purchases.committed ? fmt(x.purchases.committed) : '<span class="muted">-</span>') },
      { h: 'Remaining', num: true, f: (x) => (x.purchases.budget || x.purchases.committed ? (x.purchases.remaining < 0 ? `<span style="color:var(--bad)">${fmt(x.purchases.remaining)}</span>` : fmt(x.purchases.remaining)) : '') },
    ], rows);
    return `<section class="card"><div class="card-h"><span>Department budgets, ${esc(ver)}</span><span class="muted small">Select a department to filter the table above</span></div>${tbl}
      <div class="pad"><p class="hint" style="margin:0">Budgetary control: a requisition is checked against its requester's department purchasing budget (account 1200) for the month. Requisitions that exceed it are flagged in Approvals and on the requisition (advisory; they are not blocked).</p></div></section>`;
  }
  App.act('plan-dept', (ds) => { F.planDept = ds.dept; App.render(); });

  // ---------- tab: budget entry grid ----------
  function entryTab() {
    const ver = E.PLAN_VERSIONS.includes(F.planVersion) ? F.planVersion : E.PLAN_FORECAST;
    const meta = E.S.budgetVersions[ver]; const ps = E.planPeriods(); const el = E.elapsedPeriods();
    const editable = !meta.locked && canEdit();
    const accts = E.planAccounts();
    const tbtn = (label, act) => meta.locked ? `<button type="button" class="btn sm" disabled title="${esc(ver)} is locked">${label}</button>` : App.btn(label, act, { ver }, 'plan.edit', 'sm');
    const status = meta.locked
      ? `<div class="callout">${pill('Locked', 'good')} <b>${esc(ver)}</b> is ${esc(meta.status.toLowerCase())}${meta.approvedBy ? ` by ${esc(meta.approvedBy)}${meta.approvedOn ? ' on ' + esc(App.fdate(meta.approvedOn)) : ''}` : ''}. It is read-only; change the forecast instead.</div>`
      : `<div class="callout ${canEdit() ? '' : 'warn'}">${pill('Editable', 'info')} <b>${esc(ver)}</b> is a working version${meta.updatedBy ? `, last updated by ${esc(meta.updatedBy)} on ${esc(App.fdate(meta.updatedOn))}` : ''}. ${canEdit() ? 'Type in a cell and press Tab or Enter to save it. Columns marked A are elapsed months.' : `Your role (${esc(E.S.role)}) can view but not edit plans.`}</div>`;
    const tools = `<div class="pad" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">${App.field('Version', App.select('planVersion', E.PLAN_VERSIONS, ver))}
      <div class="actions">${ver === E.PLAN_FORECAST ? tbtn('Copy from Budget', 'plan-copy') : ''}${tbtn('Copy actuals into elapsed months', 'plan-actuals')}</div></div>`;
    const cell = (a, p) => { const v = E.budgetAmount(ver, a.code, p);
      return `<td class="num" style="padding:3px 4px"><input class="cell-in num plan-cell" type="number" step="0.01" inputmode="decimal" style="width:104px" id="pc-${a.code}-${p}" data-acct="${a.code}" data-p="${p}" value="${v ? U.r2(v) : 0}" aria-label="${esc(a.code + ' ' + a.name + ', ' + U.periodLabel(p))}" ${editable ? '' : 'readonly'}></td>`; };
    const head = `<thead><tr><th>Account</th>${ps.map((p) => `<th class="num">${esc(U.periodLabel(p))}${el.includes(p) ? ' <span title="Elapsed month: actuals available">A</span>' : ''}</th>`).join('')}<th class="num">Full year</th><th></th></tr></thead>`;
    const body = accts.map((a) => `<tr><td style="white-space:nowrap">${App.link('acct', a.code)} ${esc(a.name)}<div class="small muted">${esc(a.type)}</div></td>${ps.map((p) => cell(a, p)).join('')}<td class="num"><b>${fmt(E.budgetRowTotal(ver, a.code))}</b></td>
      <td>${editable ? App.btn('Spread', 'plan-spread', { ver, acct: a.code }, 'plan.edit', 'sm') : ''}</td></tr>`).join('');
    const tot = (fn) => ps.map((p) => `<td class="num">${fmt(fn([p]))}</td>`).join('') + `<td class="num">${fmt(fn(ps))}</td><td></td>`;
    const foot = `<tfoot><tr><td>Total revenue</td>${tot((x) => E.budgetTotals(ver, x).revenue)}</tr><tr><td>Total expenses</td>${tot((x) => E.budgetTotals(ver, x).expense)}</tr><tr><td>Net income</td>${tot((x) => E.budgetTotals(ver, x).net)}</tr></tfoot>`;
    return `<section class="card">${tools}<div class="pad" style="padding-top:0">${status}<div class="err small" id="planErr" role="alert" style="color:var(--bad);margin-top:8px"></div></div>
      <div class="tbl-wrap"><table class="t" id="planGrid">${head}<tbody>${body}</tbody>${foot}</table></div></section>`;
  }

  function wireGrid(root) {
    const grid = root.querySelector('#planGrid'); if (!grid) return;
    const ver = E.PLAN_VERSIONS.includes(F.planVersion) ? F.planVersion : E.PLAN_FORECAST;
    if (F.planFocus) { const el = document.getElementById(F.planFocus); F.planFocus = null; if (el) { el.focus(); if (el.select) el.select(); } }
    grid.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.classList.contains('plan-cell')) { ev.preventDefault(); ev.target.blur(); } });
    grid.addEventListener('change', (ev) => {
      const el = ev.target; if (!el.classList.contains('plan-cell') || el.readOnly) return;
      const err = root.querySelector('#planErr');
      if (el.validity && el.validity.badInput) { el.setAttribute('aria-invalid', 'true'); el.style.borderColor = 'var(--bad)'; err.textContent = `${el.getAttribute('aria-label')}: enter a number.`; return; }
      try { E.parseBudgetAmount(el.value, el.getAttribute('aria-label')); } catch (e) { el.setAttribute('aria-invalid', 'true'); el.style.borderColor = 'var(--bad)'; err.textContent = e.message; return; }
      const acct = el.dataset.acct, p = el.dataset.p, value = el.value;
      // Commit after focus has moved so the next cell keeps focus across the re-render.
      setTimeout(() => {
        const nxt = document.activeElement && document.activeElement.classList.contains('plan-cell') ? document.activeElement.id : null;
        F.planFocus = nxt;
        if (App.try(() => E.setBudgetCell(ver, acct, p, value)) === undefined) F.planFocus = null;
      }, 0);
    });
  }

  App.act('plan-copy', (ds) => App.confirm('Copy from Budget', `Replace every month of ${esc(ds.ver)} with the approved ${esc(E.PLAN_BUDGET)}? Actuals copied into elapsed months will be overwritten too.`, 'Copy budget', () => E.copyVersion(E.PLAN_BUDGET, ds.ver), `${ds.ver} now matches ${E.PLAN_BUDGET}.`));
  App.act('plan-actuals', (ds) => { const el = E.elapsedPeriods();
    App.confirm('Copy actuals into elapsed months', `Overwrite ${esc(ds.ver)} for ${esc(el.map(U.periodLabel).join(', ') || 'no months')} with posted actuals from the general ledger?`, 'Copy actuals', () => E.copyActuals(ds.ver), `Actuals copied into ${ds.ver} for ${el.length} month(s).`); });
  App.act('plan-spread', (ds) => { const a = E.acct(ds.acct);
    App.drawer(`Spread annual amount: ${a.code} ${a.name}`, App.field('Annual amount', App.input('spreadAmt', E.budgetRowTotal(ds.ver, a.code), 'number', 'step="0.01"'), 'Divided evenly across the 12 months; rounding goes into Jun-27.')
      + `<div class="callout" id="spreadInfo"></div>`, {
      submitLabel: 'Spread evenly',
      oninput: (f) => { const v = App.val(f, 'spreadAmt'); App.$('#spreadInfo', f).textContent = v !== '' && isFinite(+v) ? `About ${fmt(+v / 12)} per month in ${ds.ver}.` : 'Enter a number.'; },
      onSubmit: (f) => E.spreadAnnual(ds.ver, a.code, App.val(f, 'spreadAmt')),
      success: `${a.code} spread evenly across the year.`,
    });
  });

  // ---------- tab: outlook ----------
  function outlookTab() {
    const o = E.planOutlook(); const t = o.totals;
    const fav = (act, bud, rev) => ({ variance: U.r2(act - bud), favourable: act === bud ? null : rev ? act > bud : act < bud, pct: bud ? (act - bud) / Math.abs(bud) : null });
    const line = (label, k, rev, cls) => { const v = fav(t.outlook[k], t.budget[k], rev); return `<tr class="${cls || 'grp'}"><td><b>${label}</b></td><td class="num">${fmt(t.actualYtd[k])}</td><td class="num">${fmt(t.forecastRest[k])}</td><td class="num">${fmt(t.outlook[k])}</td><td class="num">${fmt(t.budget[k])}</td><td class="num">${varCell(v)}</td><td class="num">${pct(v.pct)}</td><td>${favPill(v)}</td></tr>`; };
    const rows = (g) => o.rows.filter((r) => r.group === g && (r.outlook || r.budget)).map((r) => `<tr><td>${App.link('acct', r.code)} ${esc(r.name)}</td><td class="num">${fmt(r.actualYtd)}</td><td class="num">${fmt(r.forecastRest)}</td><td class="num">${fmt(r.outlook)}</td><td class="num">${fmt(r.budget)}</td><td class="num">${varCell(r)}</td><td class="num">${pct(r.pct)}</td><td>${favPill(r)}</td></tr>`).join('');
    const span = o.elapsed.length ? `${U.periodLabel(o.elapsed[0])} to ${U.periodLabel(o.elapsed[o.elapsed.length - 1])}` : 'none';
    const rest = o.remaining.length ? `${U.periodLabel(o.remaining[0])} to ${U.periodLabel(o.remaining[o.remaining.length - 1])}` : 'none';
    return `<section class="card"><div class="pad"><span class="hint">Outlook = actuals for elapsed months (${esc(span)}) + ${esc(E.PLAN_FORECAST)} for the remaining months (${esc(rest)}), compared with the full-year ${esc(E.PLAN_BUDGET)}.</span></div>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>Account</th><th class="num">Actual YTD</th><th class="num">Forecast remaining</th><th class="num">Full-year outlook</th><th class="num">FY budget</th><th class="num">Variance</th><th class="num">Var %</th><th>Status</th></tr></thead><tbody>
      ${rows('revenue')}${line('Total revenue', 'revenue', true)}${rows('cogs')}${line('Total cost of sales', 'cogs', false)}${rows('opex')}${line('Total operating expenses', 'opex', false)}${line('Net income', 'net', true)}</tbody></table></div></section>`;
  }

  App.view('planning', {
    title: 'Budgets and forecasts', group: 'Financials',
    render() {
      const bud = E.budgetTotals(E.PLAN_BUDGET), o = E.planOutlook().totals;
      const el = E.elapsedPeriods(); const ytdB = el.length ? E.budgetTotals(E.PLAN_BUDGET, el) : { revenue: 0 };
      const ytdA = o.actualYtd.revenue; const dv = U.r2(ytdA - ytdB.revenue);
      const head = App.head('Financials', 'Budgets and forecasts', `Plan versions for FY2027. ${esc(E.PLAN_BUDGET)} is approved and locked; ${esc(E.PLAN_FORECAST)} is the working forecast (actuals for elapsed months, plan for the rest). Plans never post to the ledger.`);
      const kpis = `<div class="kpis">${App.kpi('FY budget revenue', fmt0(bud.revenue), `Net income ${fmt0(bud.net)}`)}${App.kpi('Revenue YTD vs budget', `${signed(dv)}`, `${fmt0(ytdA)} actual vs ${fmt0(ytdB.revenue)}, ${dv >= 0 ? 'favourable' : 'unfavourable'}`)}${App.kpi('Full-year revenue outlook', fmt0(o.outlook.revenue), `${signed(o.outlook.revenue - o.budget.revenue)} vs budget`)}${App.kpi('Net income outlook', fmt0(o.outlook.net), `${signed(o.outlook.net - o.budget.net)} vs budget, ${o.outlook.net >= o.budget.net ? 'favourable' : 'unfavourable'}`)}</div>`;
      const tab = App.tabOf('planning', 'bva');
      const tabs = App.tabs('planning', [['bva', 'Budget vs actual'], ['entry', 'Budget entry'], ['outlook', 'Outlook']]);
      const body = tab === 'entry' ? entryTab() : tab === 'outlook' ? outlookTab() : bvaTab();
      return head + kpis + tabs + body;
    },
    after(root) {
      const on = (id, key) => { const el = root.querySelector('#' + id); if (el) el.addEventListener('change', () => { F[key] = el.value; App.render(); }); };
      on('planPeriod', 'planPeriod'); on('planCompare', 'planCompare'); on('planDept', 'planDept'); on('planVersion', 'planVersion');
      wireChart(root); wireGrid(root);
    },
  });

  App.detail('planver', (v) => { const m = E.S.budgetVersions[v]; if (!m) return null; const t = E.budgetTotals(v);
    return { title: v, html: App.dl([['Status', pill(m.locked ? 'Locked' : 'Editable', m.locked ? 'good' : 'info')], ['Approval', esc(m.status)], ['Revenue', `<span class="num">${fmt(t.revenue)}</span>`], ['Expenses', `<span class="num">${fmt(t.expense)}</span>`], ['Net income', `<span class="num">${fmt(t.net)}</span>`], m.updatedBy && ['Last updated', `${esc(m.updatedBy)}, ${esc(App.fdate(m.updatedOn))}`]]) + `<p>${esc(m.desc || '')}</p>`,
      buttons: App.btn('Open in budget entry', 'plan-open', { ver: v }, null, 'primary') };
  });
  App.act('plan-open', (ds) => { F.planVersion = ds.ver; App.ui.tab.planning = 'entry'; App.closeDrawer(); App.go('planning'); App.render(); });
})();
