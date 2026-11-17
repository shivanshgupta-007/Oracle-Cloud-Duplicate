'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E, seed } = require('../js/load-node.js');
const { r2, sum } = E.util;

beforeEach(() => { seed(); });

const tbOk = () => { const b = E.balances(); return Math.abs(sum(Object.values(b))) < 0.005; };
const reconOk = () => E.reconcile().every((r) => r.ok);

test('datasets: core always present; extension datasets appear when their state exists', () => {
  const keys = E.reportDatasets().map((d) => d.key);
  for (const k of ['gl', 'ap', 'ar', 'poLines', 'soLines', 'items', 'invMoves', 'employees', 'payslips']) assert.ok(keys.includes(k), k);
  for (const d of E.reportDatasets()) for (const f of d.fields) assert.ok(['text', 'number', 'money', 'date'].includes(f.type), `${d.key}.${f.key}`);
  const saved = E.S.assets; delete E.S.assets;
  assert.ok(!E.reportDatasets().some((d) => d.key === 'assets'));
  assert.throws(() => E.runQuery({ dataset: 'assets' }), /not available/);
  E.S.assets = saved;
});

test('query: sum of journal-line net per account equals balances()', () => {
  const res = E.runQuery({ dataset: 'gl', groupBy: ['account'], aggregates: [{ fn: 'sum', field: 'net' }] });
  const b = E.balances();
  for (const r of res.rows) assert.equal(r.sum_net, b[r.account], r.account);
  const withLines = Object.keys(b).filter((k) => b[k] !== 0);
  for (const k of withLines) assert.ok(res.rows.some((r) => r.account === k), k);
  assert.equal(res.totals.sum_net, 0);
  // grouped rows come back sorted by the group key when no sort is given
  const accts = res.rows.map((r) => r.account); assert.deepEqual(accts, accts.slice().sort());
});

test('query: filters by period and account match hand-computed values', () => {
  const p = '2026-10';
  const res = E.runQuery({ dataset: 'gl', filters: [{ field: 'period', op: 'eq', value: p }, { field: 'account', op: 'in', value: '1000,1100' }], aggregates: [{ fn: 'sum', field: 'debit' }, { fn: 'sum', field: 'credit' }, { fn: 'count' }] });
  let dr = 0, cr = 0, n = 0;
  for (const j of E.S.journals) if (j.status === 'Posted' && j.period === p) for (const l of j.lines) if (l.acct === '1000' || l.acct === '1100') { dr += l.dr; cr += l.cr; n++; }
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].sum_debit, r2(dr)); assert.equal(res.rows[0].sum_credit, r2(cr)); assert.equal(res.rows[0].count, n);
  const between = E.runQuery({ dataset: 'gl', columns: ['date', 'net'], filters: [{ field: 'date', op: 'between', value: ['2026-10-01', '2026-10-31'] }] });
  assert.ok(between.rows.length > 0 && between.rows.every((r) => r.date >= '2026-10-01' && r.date <= '2026-10-31'));
  assert.equal(between.count, between.rows.length);
});

test('query: grouping, avg/min/max, sort and limit on employees', () => {
  const act = E.S.employees.filter((e) => e.status === 'Active');
  const res = E.runQuery({ dataset: 'employees', filters: [{ field: 'status', op: 'eq', value: 'Active' }], groupBy: ['dept'], aggregates: [{ fn: 'count' }, { fn: 'sum', field: 'salary' }, { fn: 'avg', field: 'salary' }, { fn: 'max', field: 'salary' }, { fn: 'min', field: 'name' }], sort: [{ field: 'sum_salary', dir: 'desc' }] });
  for (const r of res.rows) {
    const g = act.filter((e) => e.dept === r.dept);
    assert.equal(r.count, g.length); assert.equal(r.sum_salary, sum(g, (e) => e.salary));
    assert.equal(r.avg_salary, r2(sum(g, (e) => e.salary) / g.length)); assert.equal(r.max_salary, Math.max(...g.map((e) => e.salary)));
    assert.equal(r.min_name, g.map((e) => e.name).sort()[0]);
  }
  for (let i = 1; i < res.rows.length; i++) assert.ok(res.rows[i - 1].sum_salary >= res.rows[i].sum_salary);
  assert.equal(res.totals.count, act.length); assert.equal(res.totals.sum_salary, sum(act, (e) => e.salary));
  const lim = E.runQuery({ dataset: 'items', columns: ['sku', 'value'], sort: [{ field: 'value', dir: 'desc' }], limit: 3 });
  assert.equal(lim.rows.length, 3); assert.equal(lim.total, E.S.items.length);
  assert.equal(lim.totals.value, sum(E.S.items, (i) => r2(i.onHand * i.avgCost)), 'totals cover all rows, not just the limited page');
  // contains is case-insensitive; ungrouped rows keep only the chosen columns
  const c = E.runQuery({ dataset: 'items', columns: ['sku'], filters: [{ field: 'name', op: 'contains', value: 'CALIBRATION' }] });
  assert.ok(c.rows.length > 0 && c.rows.every((r) => Object.keys(r).join() === 'sku'));
});

test('query: open AR dataset uses open amounts and ties to GL 1100', () => {
  const res = E.runQuery({ dataset: 'ar', aggregates: [{ fn: 'sum', field: 'open' }] });
  assert.equal(res.rows[0].sum_open, r2(E.balance('1100')));
  const ap = E.runQuery({ dataset: 'ap', aggregates: [{ fn: 'sum', field: 'open' }] });
  assert.equal(ap.rows[0].sum_open, r2(-E.balance('2000')));
});

test('query: validation gives readable errors', () => {
  assert.throws(() => E.runQuery({ dataset: 'nope' }), /Unknown dataset "nope"/);
  assert.throws(() => E.runQuery({ dataset: 'gl', columns: ['bogus'] }), /unknown field "bogus"/);
  assert.throws(() => E.runQuery({ dataset: 'gl', filters: [{ field: 'net', op: 'like', value: 1 }] }), /unknown operator "like"/);
  assert.throws(() => E.runQuery({ dataset: 'gl', filters: [{ field: 'net', op: 'gt', value: 'abc' }] }), /not a number/);
  assert.throws(() => E.runQuery({ dataset: 'gl', filters: [{ field: 'date', op: 'gte', value: '10/01/2026' }] }), /not a date/);
  assert.throws(() => E.runQuery({ dataset: 'gl', groupBy: ['account'], aggregates: [{ fn: 'sum', field: 'memo' }] }), /needs a number or money field/);
  assert.throws(() => E.runQuery({ dataset: 'gl', groupBy: ['account'], aggregates: [{ fn: 'median', field: 'net' }] }), /unknown function "median"/);
  assert.throws(() => E.runQuery({ dataset: 'gl', columns: ['date'], sort: [{ field: 'net' }] }), /not a column/);
  assert.throws(() => E.runQuery({ dataset: 'gl', filters: [{ field: 'net', op: 'between', value: '1' }] }), /two values/);
});

test('query: deterministic output', () => {
  const def = { dataset: 'soLines', groupBy: ['customer', 'sku'], aggregates: [{ fn: 'sum', field: 'amount' }, { fn: 'sum', field: 'qty' }], sort: [{ field: 'sum_qty', dir: 'desc' }] };
  assert.deepEqual(E.runQuery(def), E.runQuery(def));
});

test('saved reports: seeded, run, CRUD and validation', () => {
  assert.equal(E.S.savedReports.length, 5);
  for (const r of E.S.savedReports) { assert.match(r.id, /^RPT-\d+$/); const res = E.runReport(r.id); assert.ok(res.rows.length > 0, r.name); }
  const hc = E.runReport(E.S.savedReports.find((r) => r.name === 'Headcount and salary by department').id);
  assert.equal(hc.totals.count, E.S.employees.filter((e) => e.status === 'Active').length);
  const r = E.saveReport({ name: 'GL by source', definition: { dataset: 'gl', groupBy: ['source'], aggregates: [{ fn: 'sum', field: 'debit' }] } });
  assert.match(r.id, /^RPT-1006$/); assert.equal(r.owner, E.S.user);
  assert.throws(() => E.saveReport({ name: 'gl BY source', definition: { dataset: 'gl' } }), /already exists/);
  assert.throws(() => E.saveReport({ name: 'Broken', definition: { dataset: 'gl', columns: ['x'] } }), /unknown field/);
  assert.throws(() => E.saveReport({ name: '  ', definition: { dataset: 'gl' } }), /name/);
  E.renameReport(r.id, 'Debits by source'); assert.equal(E.report(r.id).name, 'Debits by source');
  E.saveReport({ id: r.id, name: 'Debits by source', definition: { dataset: 'gl', groupBy: ['source'], aggregates: [{ fn: 'sum', field: 'credit' }] } });
  assert.ok('sum_credit' in E.runReport(r.id).rows[0]);
  E.deleteReport(r.id); assert.equal(E.report(r.id), undefined);
  assert.throws(() => E.deleteReport(r.id), /not found/);
  for (const role of Object.keys(E.ROLES)) assert.ok(E.can(role, 'rpt.edit'), role);
  assert.ok(E.search('headcount').some((h) => h.kind === 'report'));
});

test('CSV: RFC 4180 quoting and round trip', () => {
  const header = ['name', 'note', 'amount'];
  const rows = [['Plain', 'a, b', 1234.5], ['Quote "x"', 'line1\nline2', -0.01], ['CRLF', 'x\r\ny', 0], [' lead', '', null]];
  const csv = E.toCSV(header, rows);
  assert.ok(csv.includes('"a, b"') && csv.includes('"Quote ""x"""') && csv.includes('1234.5') && csv.endsWith('\r\n'));
  assert.ok(!csv.includes('$') && !csv.includes('1,234'));
  const back = E.parseCSV(csv);
  assert.deepEqual(back, [header, ...rows.map((r) => r.map((v) => (v == null ? '' : String(v))))]);
  const res = E.runQuery({ dataset: 'employees', groupBy: ['dept'], aggregates: [{ fn: 'sum', field: 'salary' }] });
  const parsed = E.parseCSV(E.resultCSV(res, { totals: true }));
  assert.deepEqual(parsed[0], ['Department', 'Sum of Annual salary']);
  assert.equal(parsed.length, res.rows.length + 2);
  assert.equal(+parsed[parsed.length - 1][1], res.totals.sum_salary);
});

test('CSV parser: BOM, CRLF, lone CR, empty trailing line, unclosed quote', () => {
  assert.deepEqual(E.parseCSV('﻿a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(E.parseCSV('a,b\n1,2\n\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(E.parseCSV('a,b\r1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(E.parseCSV('a,,c\n,,\n'), [['a', '', 'c'], ['', '', '']]);
  assert.deepEqual(E.parseCSV('"x\r\ny",2'), [['x\r\ny', '2']]);
  assert.deepEqual(E.parseCSV(''), []);
  assert.throws(() => E.parseCSV('a,"b\n1,2'), /unclosed quote/);
});

const JE_HDR = 'journal_ref,date,description,account,debit,credit,memo';
const goodJournals = () => [JE_HDR,
  'IMP-1,2026-11-10,Office supplies,6600,250.00,,Stationery',
  'IMP-1,2026-11-10,Office supplies,1000,,250.00,',
  'IMP-2,2026-11-12,"Reclass, consulting",6600,"1,000.00",,"Moved from ""misc"""',
  'IMP-2,2026-11-12,"Reclass, consulting",1000,,1000,'].join('\r\n') + '\r\n';

test('import: journals grouped by ref, balanced, reconcile and TB hold', () => {
  const rows = E.parseCSV('﻿' + goodJournals());
  const v = E.validateImport('journals', rows);
  assert.deepEqual(v.errors, []); assert.equal(v.count, 2);
  const n0 = E.S.journals.length, cash0 = E.balance('1000'), sup0 = E.balance('6600');
  const res = E.runImport('journals', rows);
  assert.equal(res.count, 2); assert.equal(E.S.journals.length, n0 + 2);
  const js = res.ids.map((id) => E.je(id));
  assert.ok(js.every((j) => j.source === 'Import' && j.status === 'Posted'));
  assert.equal(js[0].ref, 'IMP-1'); assert.equal(js[1].desc, 'Reclass, consulting'); assert.equal(js[1].lines[0].memo, 'Moved from "misc"');
  assert.equal(E.balance('1000'), r2(cash0 - 1250)); assert.equal(E.balance('6600'), r2(sup0 + 1250));
  assert.ok(tbOk()); assert.ok(reconOk());
});

test('import: unbalanced journal rejects the whole batch (atomic, row numbers reported)', () => {
  const bad = goodJournals().replace('1000,,1000,', '1000,,900,');
  const rows = E.parseCSV(bad);
  const before = JSON.stringify(E.S);
  const v = E.validateImport('journals', rows);
  assert.equal(v.errors.length, 1); assert.match(v.errors[0].message, /out of balance/); assert.deepEqual(v.errors[0].rows, [4, 5]);
  assert.equal(JSON.stringify(E.S), before, 'validation dry run leaves state untouched');
  assert.throws(() => E.runImport('journals', rows), /Nothing was imported/);
  assert.equal(JSON.stringify(E.S), before, 'good journal IMP-1 was not imported either');
  // closed period, unknown account and field-level errors
  const v2 = E.validateImport('journals', E.parseCSV([JE_HDR, 'A,2026-08-10,x,6600,5,,', 'A,2026-08-10,x,1000,,5,', 'B,2026-11-10,y,9999,5,,', 'B,2026-11-10,y,1000,,5,', 'C,bad-date,z,6600,abc,,'].join('\n')));
  const msgs = v2.errors.map((e) => `${e.row}:${e.message}`).join(' | ');
  assert.match(msgs, /2:.*Aug-26 is Closed/); assert.match(msgs, /4:.*Account 9999 does not exist/); assert.match(msgs, /6:Date "bad-date"/); assert.match(msgs, /6:Debit "abc" is not a number/);
});

test('import: if an engine call throws while applying, state is restored', () => {
  const rows = E.parseCSV(goodJournals());
  const before = JSON.stringify(E.S);
  const orig = E.createJournal; let calls = 0;
  E.extend({ createJournal: (o) => { calls++; if (calls === 4) throw new Error('disk full'); return orig(o); } }); // 2 dry-run calls, then 2 real
  try { assert.throws(() => E.runImport('journals', rows), /rolled back.*disk full/); } finally { E.extend({ createJournal: orig }); }
  assert.equal(JSON.stringify(E.S), before);
});

test('import: master data targets, header auto-mapping and duplicates', () => {
  const sup = E.parseCSV('Supplier Name,Payment Terms,Site,Email,Currency\nNorthgate Fasteners,45,"Worcester, MA",ap@example.com,USD\n');
  const m = E.autoMap('suppliers', sup[0]); assert.equal(m.name, 0); assert.equal(m.terms, 1); assert.equal(m.currency, 4);
  const r = E.runImport('suppliers', sup); const s = E.sup(r.ids[0]); assert.equal(s.terms, 45); assert.equal(s.site, 'Worcester, MA');
  const dup = E.validateImport('suppliers', sup); assert.match(dup.errors[0].message, /already exists/); assert.equal(dup.errors[0].row, 2);
  const cus = E.runImport('customers', E.parseCSV(E.importTemplate('customers'))); assert.equal(E.cust(cus.ids[0]).creditLimit, 40000);
  const it = E.runImport('items', E.parseCSV(E.importTemplate('items'))); assert.equal(E.item(it.ids[0]).price, 89);
  const emp = E.runImport('employees', E.parseCSV(E.importTemplate('employees'))); assert.equal(E.emp(emp.ids[0]).dept, 'Engineering');
  const missing = E.validateImport('employees', E.parseCSV('name,title\nA,B\n'));
  assert.ok(missing.errors.some((e) => /Required column "dept"/.test(e.message)));
  // within one batch the second duplicate is caught too, and nothing is saved
  const n = E.S.items.length;
  assert.throws(() => E.runImport('items', E.parseCSV('sku,name,price\nZZ-1,One,5\nZZ-1,Two,6\n')), /row 3: Item ZZ-1 already exists/);
  assert.equal(E.S.items.length, n);
  // manual mapping override
  const rows = E.parseCSV('code,label,list\nZZ-9,Nine,9\n');
  assert.ok(E.validateImport('items', rows).errors.length);
  assert.equal(E.runImport('items', rows, { sku: 0, name: 1, price: 2, uom: -1, reorder: -1, cost: -1 }).count, 1);
  assert.ok(tbOk()); assert.ok(reconOk());
});

test('import: role without permission cannot import', () => {
  E.S.role = 'Buyer';
  assert.throws(() => E.runImport('journals', E.parseCSV(goodJournals())), /cannot import journals/);
});
