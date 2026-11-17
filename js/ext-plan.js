/* Ledgerline Suite: ext-plan.js
 * Budgeting and planning. Two plan versions for FY2027:
 *   'FY27 Budget'   approved and locked (read-only), the yardstick for variance reporting
 *   'FY27 Forecast' editable working forecast: actuals for elapsed months, plan for the rest
 * Amounts are stored in each account's natural sign (revenue and expense both positive):
 *   S.budgets[version][acct][period] = amount
 * No GL effect: plans never post journals.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { r2, sum, money, periodLabel, periodEnd } = E.util;

  const BUDGET = 'FY27 Budget';
  const FORECAST = 'FY27 Forecast';
  const VERSIONS = [BUDGET, FORECAST];
  const PLAN_TYPES = ['Revenue', 'Expense'];
  const MAX_AMOUNT = 1e9;
  // Revenue seasonality (sums to 1): quieter in Aug and Dec-Jan, strong in spring when lab budgets are spent.
  const SEASON = { '07': 0.085, '08': 0.07, '09': 0.09, '10': 0.085, '11': 0.08, '12': 0.075, '01': 0.07, '02': 0.08, '03': 0.095, '04': 0.085, '05': 0.09, '06': 0.095 };
  const REVENUE_TARGET = 4200000;
  const COGS_RATE = 0.25;

  const fail = (m) => { throw new Error(m); };
  const S = () => E.S;

  E.on('state', (st) => {
    st.budgets = st.budgets || {};
    VERSIONS.forEach((v) => { st.budgets[v] = st.budgets[v] || {}; });
    st.budgetVersions = st.budgetVersions || {};
    if (!st.budgetVersions[BUDGET]) st.budgetVersions[BUDGET] = { name: BUDGET, status: 'Approved', locked: true, desc: 'Board-approved annual operating budget' };
    if (!st.budgetVersions[FORECAST]) st.budgetVersions[FORECAST] = { name: FORECAST, status: 'Working', locked: false, desc: 'Rolling forecast: actuals for elapsed months, plan for the remainder' };
  });

  // ---------- reads ----------
  /** Fiscal periods Jul-26..Jun-27 in order. */
  const planPeriods = () => Object.keys(S().periods).sort();
  /** Accounts that carry a plan: every active revenue and expense account. */
  const planAccounts = () => S().accounts.filter((a) => PLAN_TYPES.includes(a.type) && a.active !== false);
  /** Months whose last day is before today: their actuals are complete enough to replace the plan. */
  const elapsedPeriods = () => planPeriods().filter((p) => periodEnd(p) < S().today);
  const version = (v) => S().budgetVersions[v] || fail(`Plan version ${v} was not found.`);
  const budgetAmount = (v, code, p) => +((S().budgets[v] || {})[code]?.[p] || 0);
  const rowTotal = (v, code, periods) => r2((periods || planPeriods()).reduce((a, p) => a + budgetAmount(v, code, p), 0));
  /** Actual for an account in natural sign over a period range. */
  const actual = (code, fromPeriod, toPeriod) => E.natural(code, E.balance(code, { fromPeriod, toPeriod: toPeriod || fromPeriod }));
  const isRevenue = (code) => E.acct(code)?.type === 'Revenue';
  /** Totals for a version: {revenue, cogs, opex, expense, net} for the given periods (default full year). */
  function versionTotals(v, periods) {
    const acc = planAccounts(); const t = { revenue: 0, cogs: 0, opex: 0 };
    acc.forEach((a) => { const x = rowTotal(v, a.code, periods); if (a.type === 'Revenue') t.revenue += x; else if (a.code < '6000') t.cogs += x; else t.opex += x; });
    const out = { revenue: r2(t.revenue), cogs: r2(t.cogs), opex: r2(t.opex) };
    out.expense = r2(out.cogs + out.opex); out.net = r2(out.revenue - out.expense);
    return out;
  }

  /** Variance helper: variance = actual - budget; favourable depends on account type. */
  function variance(code, act, bud, kind) {
    const rev = kind ? kind === 'Revenue' : isRevenue(code);
    const v = r2(act - bud);
    const pct = bud ? v / Math.abs(bud) : null;
    const favourable = v === 0 ? null : rev ? v > 0 : v < 0;
    return { actual: r2(act), budget: r2(bud), variance: v, pct, favourable };
  }

  /** Budget vs actual for one period and fiscal YTD to that period.
   *  -> {period, version, rows:[{code,name,type,group, period:{actual,budget,variance,pct,favourable}, ytd:{...}}], totals:{revenue,cogs,opex,net} each {period, ytd}} */
  function budgetVsActual(period, ver = BUDGET) {
    version(ver);
    if (!S().periods[period]) fail(`${period} is not a period in this fiscal year.`);
    const ytdP = planPeriods().filter((p) => p <= period);
    const rows = planAccounts().map((a) => {
      const group = a.type === 'Revenue' ? 'revenue' : a.code < '6000' ? 'cogs' : 'opex';
      return { code: a.code, name: a.name, type: a.type, group,
        period: variance(a.code, actual(a.code, period), budgetAmount(ver, a.code, period)),
        ytd: variance(a.code, actual(a.code, ytdP[0], period), rowTotal(ver, a.code, ytdP)) };
    });
    const tot = (g, k) => ({ a: sum(rows.filter((r) => r.group === g), (r) => r[k].actual), b: sum(rows.filter((r) => r.group === g), (r) => r[k].budget) });
    const totals = {};
    ['period', 'ytd'].forEach((k) => {
      const rv = tot('revenue', k), cg = tot('cogs', k), ox = tot('opex', k);
      totals[k] = {
        revenue: variance(null, rv.a, rv.b, 'Revenue'),
        cogs: variance(null, cg.a, cg.b, 'Expense'),
        opex: variance(null, ox.a, ox.b, 'Expense'),
        gross: variance(null, rv.a - cg.a, rv.b - cg.b, 'Revenue'),
        net: variance(null, rv.a - cg.a - ox.a, rv.b - cg.b - ox.b, 'Revenue'),
      };
    });
    return { period, version: ver, ytdFrom: ytdP[0], rows, totals };
  }

  /** Full-year outlook: actual for elapsed months + forecast for the remaining months, vs budget. */
  function outlook() {
    const el = elapsedPeriods(), rest = planPeriods().filter((p) => !el.includes(p));
    const rows = planAccounts().map((a) => {
      const act = el.length ? actual(a.code, el[0], el[el.length - 1]) : 0;
      const fc = rowTotal(FORECAST, a.code, rest);
      const bud = rowTotal(BUDGET, a.code);
      return { code: a.code, name: a.name, type: a.type, group: a.type === 'Revenue' ? 'revenue' : a.code < '6000' ? 'cogs' : 'opex', actualYtd: r2(act), forecastRest: fc, outlook: r2(act + fc), ...variance(a.code, act + fc, bud) };
    });
    const g = (grp, k) => sum(rows.filter((r) => r.group === grp), (r) => r[k]);
    const tot = {};
    ['actualYtd', 'forecastRest', 'outlook', 'budget'].forEach((k) => { tot[k] = { revenue: g('revenue', k), cogs: g('cogs', k), opex: g('opex', k) }; tot[k].net = r2(tot[k].revenue - tot[k].cogs - tot[k].opex); });
    return { elapsed: el, remaining: rest, rows, totals: tot };
  }

  /** Monthly revenue actual (posted) vs plan for charts. */
  function revenueSeries(ver = BUDGET) {
    const rev = planAccounts().filter((a) => a.type === 'Revenue');
    return E.periods().map((p) => ({
      period: p.period, label: p.label, status: p.status, hasActual: p.posted > 0,
      actual: sum(rev, (a) => actual(a.code, p.period)), budget: sum(rev, (a) => budgetAmount(ver, a.code, p.period)),
      forecast: sum(rev, (a) => budgetAmount(FORECAST, a.code, p.period)),
    }));
  }

  /** True when every plan account's forecast for p equals its actual (within a cent). */
  function forecastMatchesActual(p) {
    return planAccounts().every((a) => Math.abs(budgetAmount(FORECAST, a.code, p) - actual(a.code, p)) < 0.01);
  }

  // ---------- writes (validate first, then mutate) ----------
  function assertEditable(v) {
    const meta = version(v);
    if (meta.locked) fail(`${v} is ${meta.status.toLowerCase()} and locked. Edit the forecast instead, or unlock this version first.`);
    return meta;
  }
  function assertPlanAccount(code) {
    const a = E.acct(String(code)); if (!a) fail(`Account ${code} does not exist.`);
    if (!PLAN_TYPES.includes(a.type)) fail(`${a.code} ${a.name} is a ${a.type.toLowerCase()} account. Plans cover revenue and expense accounts.`);
    return a;
  }
  function assertPeriod(p) { if (!S().periods[p]) fail(`${p} is not a period in this fiscal year (${periodLabel(planPeriods()[0])} to ${periodLabel(planPeriods()[11])}).`); }
  /** Parses a user-entered amount strictly: numbers or numeric strings only, commas allowed. */
  function parseAmount(value, label = 'Amount') {
    if (value === null || value === undefined || String(value).trim() === '') fail(`${label}: enter a number (use 0 for none).`);
    const s = String(value).trim().replace(/,/g, '').replace(/^\$/, '');
    if (!/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) fail(`${label}: "${value}" is not a number.`);
    const n = +s;
    if (!Number.isFinite(n)) fail(`${label}: enter a finite number.`);
    if (Math.abs(n) > MAX_AMOUNT) fail(`${label}: ${money(n)} is outside the allowed range (up to ${money(MAX_AMOUNT)}).`);
    return r2(n);
  }
  function put(v, code, p, amt) { const b = S().budgets[v]; (b[code] = b[code] || {})[p] = amt; }
  function stamp(v) { const meta = version(v); meta.updatedBy = S().user; meta.updatedOn = S()._date || S().today; }

  /** setBudgetCell(version, acct, period, value) -> new amount */
  function setBudgetCell(v, code, p, value) {
    assertEditable(v); const a = assertPlanAccount(code); assertPeriod(p);
    const amt = parseAmount(value, `${a.code} ${periodLabel(p)}`);
    const before = budgetAmount(v, a.code, p);
    put(v, a.code, p, amt); stamp(v);
    E.log('Updated plan amount', v, `${a.code} ${periodLabel(p)}: ${money(before)} to ${money(amt)}`);
    return amt;
  }
  /** setBudgetRow(version, acct, {period: value}) — all-or-nothing. */
  function setBudgetRow(v, code, values) {
    assertEditable(v); const a = assertPlanAccount(code);
    const parsed = Object.entries(values || {}).map(([p, x]) => { assertPeriod(p); return [p, parseAmount(x, `${a.code} ${periodLabel(p)}`)]; });
    if (!parsed.length) fail('Nothing to update.');
    parsed.forEach(([p, x]) => put(v, a.code, p, x)); stamp(v);
    E.log('Updated plan row', v, `${a.code} ${a.name}, ${parsed.length} month(s)`);
    return parsed.length;
  }
  /** spreadAnnual(version, acct, annual, {periods}) — even spread, rounding remainder in the last month. */
  function spreadAnnual(v, code, annual, opts = {}) {
    assertEditable(v); const a = assertPlanAccount(code);
    const total = parseAmount(annual, 'Annual amount');
    const ps = opts.periods && opts.periods.length ? opts.periods : planPeriods();
    ps.forEach(assertPeriod);
    const each = r2(Math.floor((total / ps.length) * 100) / 100);
    ps.forEach((p, i) => put(v, a.code, p, i === ps.length - 1 ? r2(total - each * (ps.length - 1)) : each));
    stamp(v); E.log('Spread annual plan amount', v, `${a.code} ${money(total)} over ${ps.length} month(s)`);
    return ps.map((p) => budgetAmount(v, a.code, p));
  }
  /** copyVersion(from, to, {periods}) — copies plan amounts for every plan account. */
  function copyVersion(from, to, opts = {}) {
    version(from); assertEditable(to); if (from === to) fail('Choose a different version to copy from.');
    const ps = opts.periods || planPeriods(); ps.forEach(assertPeriod);
    planAccounts().forEach((a) => ps.forEach((p) => put(to, a.code, p, budgetAmount(from, a.code, p))));
    stamp(to); E.log('Copied plan version', to, `from ${from}, ${ps.length} month(s)`);
    return ps.length;
  }
  /** copyActuals(version, {periods}) — overwrites elapsed months (default) with posted actuals. */
  function copyActuals(v, opts = {}) {
    assertEditable(v);
    const ps = opts.periods || elapsedPeriods(); ps.forEach(assertPeriod);
    if (!ps.length) fail('No months have elapsed yet in this fiscal year.');
    planAccounts().forEach((a) => ps.forEach((p) => put(v, a.code, p, r2(actual(a.code, p)))));
    stamp(v); E.log('Copied actuals into plan', v, ps.map(periodLabel).join(', '));
    return ps.length;
  }
  /** setVersionLock(version, locked) — approve and lock, or reopen for edits. */
  function setVersionLock(v, locked) {
    const meta = version(v);
    if (!!meta.locked === !!locked) fail(`${v} is already ${locked ? 'locked' : 'unlocked'}.`);
    meta.locked = !!locked; meta.status = locked ? 'Approved' : 'Working';
    if (locked) { meta.approvedBy = S().user; meta.approvedOn = S()._date || S().today; }
    E.log(locked ? 'Approved and locked plan version' : 'Unlocked plan version', v);
    return meta;
  }

  // ---------- seed ----------
  /** Deterministic FY27 budget built from the opening workforce and known contracts. */
  function generateBudget() {
    const st = S(); const ps = planPeriods(); const b = st.budgets[BUDGET];
    const set = (code, p, x) => { if (E.acct(code)) (b[code] = b[code] || {})[p] = r2(x); };
    const payroll = st.employees.filter((e) => e.status === 'Active').reduce((a, e) => a + e.salary, 0) / 12;
    ps.forEach((p, i) => {
      const mm = p.slice(5);
      const rev = REVENUE_TARGET * SEASON[mm];
      set('4000', p, rev);
      set('4900', p, 600);                                         // interest on operating cash
      set('5000', p, rev * COGS_RATE);
      set('5100', p, 0);
      const merit = i >= 6 ? 1.03 : 1;                             // 3% merit round from January
      const wages = payroll * 1.05 * merit;                        // +5%: two planned hires part-year, overtime
      set('6000', p, wages);
      set('6050', p, wages * E.EMPLOYER_TAX_RATE);
      set('6100', p, i >= 6 ? 15200 : 14500);                     // lease escalation in January
      set('6200', p, ['12', '01', '02'].includes(mm) ? 3100 : 2450);
      set('6300', p, i >= 6 ? 4400 : 4000);                       // planned test-rig capex from January
      set('6400', p, 5200);
      set('6500', p, ['10', '03', '04'].includes(mm) ? 4600 : 3400); // trade-show months
    });
  }
  E.on('seedSetup', (ctx) => {
    ctx.at('2026-07-01');
    generateBudget();
    const meta = S().budgetVersions[BUDGET];
    meta.locked = true; meta.status = 'Approved'; meta.approvedBy = 'Theo Okafor'; meta.approvedOn = '2026-06-24'; meta.updatedBy = 'Avery Lin'; meta.updatedOn = '2026-06-20';
    E.log('Approved and locked plan version', BUDGET, `Revenue ${money(versionTotals(BUDGET).revenue)}`);
  });
  E.on('seedFinal', (ctx) => {
    ctx.at('2026-11-10');
    const st = S(); const el = elapsedPeriods();
    planAccounts().forEach((a) => planPeriods().forEach((p) => put(FORECAST, a.code, p, el.includes(p) ? r2(actual(a.code, p)) : budgetAmount(BUDGET, a.code, p))));
    // Sales expects the Pinecrest lab build-out to land in Q1: lift Jan-Mar revenue forecast.
    ['2027-01', '2027-02', '2027-03'].forEach((p) => { const x = r2(budgetAmount(FORECAST, '4000', p) * 1.06); put(FORECAST, '4000', p, x); put(FORECAST, '5000', p, r2(x * COGS_RATE)); });
    const meta = st.budgetVersions[FORECAST]; meta.updatedBy = 'Avery Lin'; meta.updatedOn = '2026-11-10';
    E.log('Copied actuals into plan', FORECAST, el.map(periodLabel).join(', '));
  });

  // ---------- hooks ----------
  E.on('checklist', (p) => {
    if (!S().periods[p]) return [];
    const ok = forecastMatchesActual(p);
    return [{ task: `Forecast updated for ${periodLabel(p)}`, done: ok, advisory: true,
      detail: ok ? `${FORECAST} matches ${periodLabel(p)} actuals` : `${FORECAST} differs from ${periodLabel(p)} actuals. Copy actuals on Budgets and forecasts.` }];
  });
  E.on('search', (q, hit) => VERSIONS.filter((v) => hit(v, 'budget', 'forecast')).map((v) => ({ kind: 'planver', id: v, label: v, sub: `Plan version, ${S().budgetVersions[v].status}` })));
  E.addPerms('Controller', ['plan.edit']);

  E.extend({
    PLAN_BUDGET: BUDGET, PLAN_FORECAST: FORECAST, PLAN_VERSIONS: VERSIONS,
    planPeriods, planAccounts, elapsedPeriods, budgetAmount, budgetRowTotal: rowTotal, budgetTotals: versionTotals, planActual: actual,
    budgetVsActual, planOutlook: outlook, revenueSeries, forecastMatchesActual, parseBudgetAmount: parseAmount,
    setBudgetCell, setBudgetRow, spreadAnnual, copyVersion, copyActuals, setVersionLock,
  });
})(typeof window !== 'undefined' ? window : globalThis);
