// Budgeting and planning: plan versions, budget vs actual, forecast, grid edit validation.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E, seed } = require('../js/load-node.js');

const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
beforeEach(() => { seed(); });

describe('plan versions', () => {
  test('budget has every fiscal month and plausible totals', () => {
    const ps = E.planPeriods();
    assert.equal(ps.length, 12); assert.equal(ps[0], '2026-07'); assert.equal(ps[11], '2027-06');
    const t = E.budgetTotals(E.PLAN_BUDGET);
    const product = E.budgetRowTotal(E.PLAN_BUDGET, '4000');
    assert.ok(product > 4.1e6 && product < 4.3e6, `product revenue ${product}`);
    assert.ok(t.revenue >= product);
    assert.ok(near(E.budgetRowTotal(E.PLAN_BUDGET, '5000'), product * 0.25, 1), 'COGS is 25% of product revenue');
    assert.ok(near(t.net, t.revenue - t.cogs - t.opex));
    // totals equal the sum of the cells
    const cells = E.planAccounts().reduce((a, x) => a + ps.reduce((b, p) => b + E.budgetAmount(E.PLAN_BUDGET, x.code, p), 0) * (x.type === 'Revenue' ? 1 : -1), 0);
    assert.ok(near(cells, t.net, 0.05));
    // seasonal: months differ
    assert.ok(new Set(ps.map((p) => E.budgetAmount(E.PLAN_BUDGET, '4000', p))).size > 3);
  });
  test('budget is deterministic across reseeds', () => {
    const a = JSON.stringify(E.S.budgets); seed(); assert.equal(JSON.stringify(E.S.budgets), a);
  });
  test('forecast totals differ from budget and each version totals independently', () => {
    const b = E.budgetTotals(E.PLAN_BUDGET), f = E.budgetTotals(E.PLAN_FORECAST);
    assert.notEqual(b.revenue, f.revenue);
    const p = '2027-05';
    assert.equal(E.budgetAmount(E.PLAN_FORECAST, '6400', p), E.budgetAmount(E.PLAN_BUDGET, '6400', p), 'future months start from budget');
  });
  test('budget is locked; forecast is editable', () => {
    assert.equal(E.S.budgetVersions[E.PLAN_BUDGET].locked, true);
    assert.throws(() => E.setBudgetCell(E.PLAN_BUDGET, '4000', '2027-01', 1), /locked/);
    assert.equal(E.setBudgetCell(E.PLAN_FORECAST, '4000', '2027-01', '350000'), 350000);
    assert.equal(E.budgetAmount(E.PLAN_FORECAST, '4000', '2027-01'), 350000);
  });
  test('Controller has plan.edit, AP Specialist does not', () => {
    assert.ok(E.can('Controller', 'plan.edit')); assert.ok(!E.can('AP Specialist', 'plan.edit')); assert.ok(E.can('Administrator', 'plan.edit'));
  });
});

describe('forecast = actuals for elapsed months', () => {
  test('closed and elapsed months equal GL actuals; later months equal plan', () => {
    const el = E.elapsedPeriods();
    assert.deepEqual(el, ['2026-07', '2026-08', '2026-09', '2026-10']);
    for (const p of el) for (const a of E.planAccounts()) assert.ok(near(E.budgetAmount(E.PLAN_FORECAST, a.code, p), E.planActual(a.code, p)), `${a.code} ${p}`);
    for (const p of ['2026-07', '2026-08', '2026-09']) { assert.equal(E.S.periods[p], 'Closed'); assert.ok(E.forecastMatchesActual(p)); }
  });
  test('checklist advisory flips when the forecast drifts, and copy actuals fixes it', () => {
    const item = () => E.closeChecklist('2026-10').find((t) => /^Forecast updated for Oct-26/.test(t.task));
    assert.ok(item()); assert.equal(item().advisory, true); assert.equal(item().done, true);
    E.setBudgetCell(E.PLAN_FORECAST, '6500', '2026-10', 1);
    assert.equal(item().done, false);
    E.copyActuals(E.PLAN_FORECAST);
    assert.equal(item().done, true);
  });
  test('copy from budget and spread annual', () => {
    E.copyVersion(E.PLAN_BUDGET, E.PLAN_FORECAST);
    assert.equal(E.budgetTotals(E.PLAN_FORECAST).net, E.budgetTotals(E.PLAN_BUDGET).net);
    const cells = E.spreadAnnual(E.PLAN_FORECAST, '6400', 70000.01);
    assert.equal(cells.length, 12); assert.ok(near(cells.reduce((a, b) => a + b, 0), 70000.01, 0.001));
    assert.equal(cells[0], 5833.33);
    assert.throws(() => E.copyVersion(E.PLAN_FORECAST, E.PLAN_BUDGET), /locked/);
  });
  test('outlook = actual YTD + forecast remaining', () => {
    const o = E.planOutlook(); const r = o.rows.find((x) => x.code === '4000');
    assert.ok(near(r.outlook, r.actualYtd + r.forecastRest));
    assert.ok(near(r.actualYtd, E.planActual('4000', '2026-07', '2026-10')));
    assert.ok(near(r.budget, E.budgetRowTotal(E.PLAN_BUDGET, '4000')));
  });
});

describe('budget vs actual', () => {
  test('variance = actual - budget for period and YTD', () => {
    const r = E.budgetVsActual('2026-09');
    const rev = r.rows.find((x) => x.code === '4000');
    assert.ok(near(rev.period.actual, E.planActual('4000', '2026-09')));
    assert.ok(near(rev.period.budget, E.budgetAmount(E.PLAN_BUDGET, '4000', '2026-09')));
    assert.ok(near(rev.period.variance, rev.period.actual - rev.period.budget));
    assert.ok(near(rev.ytd.budget, ['2026-07', '2026-08', '2026-09'].reduce((a, p) => a + E.budgetAmount(E.PLAN_BUDGET, '4000', p), 0)));
    assert.ok(near(r.totals.ytd.net.actual, E.incomeStatement('2026-07', '2026-09').netIncome));
  });
  test('favourable sign respects account type', () => {
    // revenue over budget = favourable; expense over budget = unfavourable
    E.S.budgetVersions[E.PLAN_BUDGET].locked = false;
    const act4000 = E.planActual('4000', '2026-09'), act6100 = E.planActual('6100', '2026-09');
    E.setBudgetCell(E.PLAN_BUDGET, '4000', '2026-09', act4000 - 1000);
    E.setBudgetCell(E.PLAN_BUDGET, '6100', '2026-09', act6100 - 1000);
    let r = E.budgetVsActual('2026-09');
    const rev = r.rows.find((x) => x.code === '4000').period, exp = r.rows.find((x) => x.code === '6100').period;
    assert.ok(rev.variance > 0); assert.equal(rev.favourable, true);
    assert.ok(exp.variance > 0); assert.equal(exp.favourable, false);
    E.setBudgetCell(E.PLAN_BUDGET, '4000', '2026-09', act4000 + 1000);
    E.setBudgetCell(E.PLAN_BUDGET, '6100', '2026-09', act6100 + 1000);
    r = E.budgetVsActual('2026-09');
    assert.equal(r.rows.find((x) => x.code === '4000').period.favourable, false);
    assert.equal(r.rows.find((x) => x.code === '6100').period.favourable, true);
    assert.ok(near(r.rows.find((x) => x.code === '6100').period.pct, -1000 / (act6100 + 1000), 1e-9));
  });
  test('comparing to the forecast in an elapsed month shows zero variance', () => {
    const r = E.budgetVsActual('2026-08', E.PLAN_FORECAST);
    r.rows.forEach((x) => assert.ok(near(x.period.variance, 0), x.code));
  });
});

describe('grid edit validation', () => {
  const V = () => E.PLAN_FORECAST;
  test('rejects non-numbers, blanks, infinities and out-of-range amounts without changing state', () => {
    const before = JSON.stringify(E.S.budgets);
    for (const bad of ['abc', '', '  ', null, undefined, 'NaN', 'Infinity', '12..5', '1e12', '5,00x']) assert.throws(() => E.setBudgetCell(V(), '6500', '2027-02', bad), Error, String(bad));
    assert.throws(() => E.setBudgetCell(V(), '1000', '2027-02', 5), /revenue and expense/);
    assert.throws(() => E.setBudgetCell(V(), '9999', '2027-02', 5), /does not exist/);
    assert.throws(() => E.setBudgetCell(V(), '6500', '2028-02', 5), /not a period/);
    assert.throws(() => E.setBudgetCell('FY99', '6500', '2027-02', 5), /not found/);
    assert.equal(JSON.stringify(E.S.budgets), before);
  });
  test('accepts formatted numbers and rounds to cents', () => {
    assert.equal(E.setBudgetCell(V(), '6500', '2027-02', '1,234.567'), 1234.57);
    assert.equal(E.setBudgetCell(V(), '6500', '2027-02', '$99'), 99);
    assert.equal(E.setBudgetCell(V(), '5100', '2027-02', -12.5), -12.5);
  });
  test('row update is all-or-nothing', () => {
    const before = E.budgetAmount(V(), '6200', '2027-01');
    assert.throws(() => E.setBudgetRow(V(), '6200', { '2027-01': 100, '2027-02': 'oops' }));
    assert.equal(E.budgetAmount(V(), '6200', '2027-01'), before);
    assert.equal(E.setBudgetRow(V(), '6200', { '2027-01': 100, '2027-02': 200 }), 2);
  });
  test('plans never touch the ledger', () => {
    const n = E.S.journals.length; E.copyVersion(E.PLAN_BUDGET, V()); E.spreadAnnual(V(), '4000', 4e6);
    assert.equal(E.S.journals.length, n);
    assert.ok(E.reconcile().every((r) => r.ok)); const tb = E.trialBalance(); assert.ok(near(tb.dr, tb.cr));
  });
});
