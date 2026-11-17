/* Ledgerline Suite: ext-reports.js
 * Ad-hoc reporting and data exchange (no DOM):
 *  - datasets: flat, typed views over the live state (journal lines, AP/AR, PO/SO lines, items,
 *    inventory movements, employees, payslips, plus extension collections when present)
 *  - query engine: run({dataset, columns, filters, groupBy, aggregates, sort, limit}) -> {columns, rows, totals}
 *  - saved reports: S.savedReports (RPT-), CRUD, five seeded definitions
 *  - CSV: RFC 4180 writer and parser (quotes, commas, CR/LF, BOM)
 *  - import: journals, suppliers, customers, items, employees; header auto-mapping, whole-batch
 *    validation (dry run against a snapshot) and atomic apply with rollback.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { r2, periodOf, daysBetween, isDate } = E.util;
  const fail = (m) => { throw new Error(m); };
  const S = () => E.S;

  // ---------- datasets ----------
  const F = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
  const RATE = { rate: true }; // per-unit values: not totalled
  const supName = (id) => E.sup(id)?.name || id || '';
  const custName = (id) => E.cust(id)?.name || id || '';
  const empName = (id) => E.emp(id)?.name || id || '';
  const itemName = (sku) => E.item(sku)?.name || '';
  const age = (d) => (isDate(d) ? daysBetween(d, S().today) : 0);

  const DATASETS = [
    { key: 'gl', label: 'Journal lines (posted)', fields: [
      F('date', 'Date', 'date'), F('period', 'Period'), F('journal', 'Journal'), F('source', 'Source'), F('description', 'Description'),
      F('account', 'Account'), F('accountName', 'Account name'), F('type', 'Account type'), F('entity', 'Entity'), F('dept', 'Department'),
      F('debit', 'Debit', 'money'), F('credit', 'Credit', 'money'), F('net', 'Net (Dr - Cr)', 'money'), F('memo', 'Memo')],
    rows: (st) => st.journals.filter((j) => j.status === 'Posted').flatMap((j) => j.lines.map((l) => {
      const a = E.acct(l.acct) || {};
      return { date: j.date, period: j.period, journal: j.id, source: j.source, description: j.desc, account: l.acct, accountName: a.name || '', type: a.type || '',
        entity: l.entity || j.entity || '', dept: l.dept || '', debit: l.dr || 0, credit: l.cr || 0, net: r2((l.dr || 0) - (l.cr || 0)), memo: l.memo || '' };
    })) },
    { key: 'ap', label: 'AP invoices', fields: [
      F('id', 'Invoice'), F('number', 'Supplier invoice no.'), F('date', 'Date', 'date'), F('period', 'Period'), F('due', 'Due', 'date'),
      F('supplierId', 'Supplier ID'), F('supplier', 'Supplier'), F('poId', 'PO'), F('status', 'Status'), F('currency', 'Currency'),
      F('total', 'Total', 'money'), F('paid', 'Paid', 'money'), F('credited', 'Credited', 'money'), F('open', 'Open amount', 'money'), F('age', 'Age (days)', 'number', RATE)],
    rows: (st) => st.apInvoices.map((i) => ({ id: i.id, number: i.number || '', date: i.date, period: periodOf(i.date), due: i.due || '', supplierId: i.supplierId, supplier: supName(i.supplierId),
      poId: i.poId || '', status: i.status, currency: i.currency || 'USD', total: i.total, paid: i.paid || 0, credited: i.credited || 0,
      open: i.status === 'Validated' ? (E.openAmt ? E.openAmt(i) : r2(i.total - (i.paid || 0))) : 0, age: age(i.date) })) },
    { key: 'ar', label: 'AR invoices', fields: [
      F('id', 'Invoice'), F('date', 'Date', 'date'), F('period', 'Period'), F('due', 'Due', 'date'), F('customerId', 'Customer ID'), F('customer', 'Customer'),
      F('segment', 'Segment'), F('soId', 'Sales order'), F('status', 'Status'), F('currency', 'Currency'), F('net', 'Net', 'money'), F('tax', 'Tax', 'money'),
      F('total', 'Total', 'money'), F('paid', 'Paid', 'money'), F('credited', 'Credited', 'money'), F('open', 'Open amount', 'money'),
      F('age', 'Age (days)', 'number', RATE), F('daysOverdue', 'Days overdue', 'number', RATE)],
    rows: (st) => st.arInvoices.map((i) => {
      const open = i.status === 'Paid' ? 0 : (E.openAmt ? E.openAmt(i) : r2(i.total - (i.paid || 0)));
      return { id: i.id, date: i.date, period: periodOf(i.date), due: i.due || '', customerId: i.customerId, customer: custName(i.customerId), segment: E.cust(i.customerId)?.segment || '',
        soId: i.soId || '', status: i.status, currency: i.currency || 'USD', net: i.net != null ? i.net : i.total, tax: i.tax || 0, total: i.total, paid: i.paid || 0, credited: i.credited || 0,
        open, age: age(i.date), daysOverdue: open > 0 && i.due ? Math.max(0, age(i.due)) : 0 };
    }) },
    { key: 'poLines', label: 'Purchase order lines', fields: [
      F('po', 'PO'), F('date', 'Date', 'date'), F('period', 'Period'), F('supplier', 'Supplier'), F('status', 'Status'), F('sku', 'SKU'), F('item', 'Item'),
      F('qty', 'Qty ordered', 'number'), F('price', 'Unit price', 'money', RATE), F('amount', 'Amount', 'money'), F('received', 'Qty received', 'number'),
      F('invoiced', 'Qty invoiced', 'number'), F('openQty', 'Qty to receive', 'number')],
    rows: (st) => st.pos.flatMap((p) => p.lines.map((l) => ({ po: p.id, date: p.date, period: periodOf(p.date), supplier: supName(p.supplierId), status: p.status, sku: l.sku, item: itemName(l.sku),
      qty: l.qty, price: l.price, amount: r2(l.qty * l.price), received: l.received || 0, invoiced: l.invoiced || 0, openQty: l.qty - (l.received || 0) }))) },
    { key: 'soLines', label: 'Sales order lines', fields: [
      F('so', 'Sales order'), F('date', 'Date', 'date'), F('period', 'Period'), F('customer', 'Customer'), F('status', 'Status'), F('sku', 'SKU'), F('item', 'Item'),
      F('qty', 'Qty', 'number'), F('price', 'Unit price', 'money', RATE), F('amount', 'Amount', 'money')],
    rows: (st) => st.sos.flatMap((o) => o.lines.map((l) => ({ so: o.id, date: o.date, period: periodOf(o.date), customer: custName(o.customerId), status: o.status, sku: l.sku, item: itemName(l.sku),
      qty: l.qty, price: l.price, amount: r2(l.qty * l.price) }))) },
    { key: 'items', label: 'Items', fields: [
      F('sku', 'SKU'), F('name', 'Name'), F('uom', 'UOM'), F('price', 'List price', 'money', RATE), F('onHand', 'On hand', 'number'),
      F('avgCost', 'Average cost', 'money', RATE), F('value', 'Inventory value', 'money'), F('reorder', 'Reorder point', 'number', RATE), F('belowReorder', 'Below reorder')],
    rows: (st) => st.items.map((i) => ({ sku: i.sku, name: i.name, uom: i.uom, price: i.price, onHand: i.onHand, avgCost: i.avgCost, value: r2(i.onHand * i.avgCost), reorder: i.reorder || 0,
      belowReorder: i.onHand <= (i.reorder || 0) ? 'Yes' : 'No' })) },
    { key: 'invMoves', label: 'Inventory movements', fields: [
      F('id', 'Movement'), F('date', 'Date', 'date'), F('period', 'Period'), F('sku', 'SKU'), F('item', 'Item'), F('type', 'Type'),
      F('qty', 'Qty', 'number'), F('unitCost', 'Unit cost', 'money', RATE), F('value', 'Value', 'money'), F('ref', 'Reference')],
    rows: (st) => st.invTxns.map((t) => ({ id: t.id, date: t.date, period: periodOf(t.date), sku: t.sku, item: itemName(t.sku), type: t.type, qty: t.qty, unitCost: t.unitCost, value: t.value, ref: t.ref || '' })) },
    { key: 'employees', label: 'Employees', fields: [
      F('id', 'Employee'), F('name', 'Name'), F('title', 'Job title'), F('dept', 'Department'), F('manager', 'Manager'), F('location', 'Location'),
      F('hireDate', 'Hire date', 'date'), F('status', 'Status'), F('salary', 'Annual salary', 'money')],
    rows: (st) => st.employees.map((e) => ({ id: e.id, name: e.name, title: e.title, dept: e.dept, manager: e.managerId ? empName(e.managerId) : '', location: e.location || '', hireDate: e.hireDate, status: e.status, salary: e.salary })) },
    { key: 'payslips', label: 'Payroll slips', fields: [
      F('payrun', 'Pay run'), F('period', 'Period'), F('date', 'Pay date', 'date'), F('empId', 'Employee ID'), F('name', 'Employee'), F('dept', 'Department'),
      F('gross', 'Gross', 'money'), F('tax', 'Withholding', 'money'), F('net', 'Net pay', 'money'), F('employerTax', 'Employer tax', 'money')],
    rows: (st) => st.payruns.flatMap((r) => r.slips.map((s) => ({ payrun: r.id, period: r.period, date: r.date, empId: s.empId, name: s.name, dept: s.dept, gross: s.gross, tax: s.tax, net: s.net, employerTax: s.employerTax || 0 }))) },
    // ----- extension collections (only listed when the module's state exists) -----
    { key: 'assets', label: 'Fixed assets', when: (st) => Array.isArray(st.assets), fields: [
      F('id', 'Asset'), F('tag', 'Tag'), F('name', 'Description'), F('category', 'Category'), F('dept', 'Department'), F('location', 'Location'),
      F('date', 'Capitalized', 'date'), F('status', 'Status'), F('cost', 'Cost', 'money'), F('salvage', 'Salvage', 'money'), F('accumulated', 'Accumulated depreciation', 'money'), F('nbv', 'Net book value', 'money')],
    rows: (st) => st.assets.map((a) => { const acc = r2((a.accumulated || 0)); let nbv; try { nbv = E.assetNBV ? E.assetNBV(a.id) : r2(a.cost - acc); } catch (e) { nbv = r2(a.cost - acc); }
      return { id: a.id, tag: a.tag || '', name: a.name, category: a.category, dept: a.dept || '', location: a.location || '', date: a.date, status: a.status, cost: a.cost, salvage: a.salvage || 0, accumulated: r2(a.cost - nbv), nbv }; }) },
    { key: 'projects', label: 'Projects', when: (st) => Array.isArray(st.projects), fields: [
      F('id', 'Project'), F('name', 'Name'), F('customer', 'Customer'), F('type', 'Contract type'), F('manager', 'Manager'), F('start', 'Start', 'date'), F('end', 'End', 'date'),
      F('status', 'Status'), F('contractValue', 'Contract value', 'money'), F('budget', 'Budget', 'money')],
    rows: (st) => st.projects.map((p) => ({ id: p.id, name: p.name, customer: custName(p.customerId), type: p.type || '', manager: empName(p.managerId), start: p.start || '', end: p.end || '', status: p.status,
      contractValue: p.contractValue || 0, budget: r2(Object.values(p.budget || {}).reduce((a, x) => a + (+x || 0), 0)) })) },
    { key: 'timesheets', label: 'Timesheet lines', when: (st) => Array.isArray(st.timesheets), fields: [
      F('timesheet', 'Timesheet'), F('weekStart', 'Week starting', 'date'), F('period', 'Period'), F('employee', 'Employee'), F('project', 'Project'), F('task', 'Task'),
      F('billable', 'Billable'), F('status', 'Status'), F('hours', 'Hours', 'number'), F('cost', 'Cost', 'money')],
    rows: (st) => st.timesheets.flatMap((t) => (t.lines || []).map((l) => ({ timesheet: t.id, weekStart: t.weekStart, period: periodOf(t.weekStart), employee: empName(t.empId), project: l.projectId || '', task: l.taskId || '',
      billable: l.billable ? 'Yes' : 'No', status: t.status, hours: r2((l.hours || []).reduce((a, x) => a + (+x || 0), 0)), cost: l.cost || 0 }))) },
    { key: 'expenses', label: 'Expense lines', when: (st) => Array.isArray(st.expenseReports), fields: [
      F('report', 'Expense report'), F('employee', 'Employee'), F('purpose', 'Purpose'), F('date', 'Date', 'date'), F('period', 'Period'), F('category', 'Category'),
      F('account', 'Account'), F('project', 'Project'), F('billable', 'Billable'), F('status', 'Status'), F('amount', 'Amount', 'money')],
    rows: (st) => st.expenseReports.flatMap((x) => (x.lines || []).map((l) => ({ report: x.id, employee: empName(x.empId), purpose: x.purpose || '', date: l.date || x.date, period: periodOf(l.date || x.date), category: l.category || '',
      account: l.acct || '', project: l.projectId || '', billable: l.billable ? 'Yes' : 'No', status: x.status, amount: l.amount || 0 }))) },
    { key: 'opps', label: 'Opportunities', when: (st) => Array.isArray(st.opps), fields: [
      F('id', 'Opportunity'), F('name', 'Name'), F('customer', 'Customer'), F('stage', 'Stage'), F('owner', 'Owner'), F('created', 'Created', 'date'),
      F('closeDate', 'Close date', 'date'), F('competitor', 'Competitor'), F('amount', 'Amount', 'money')],
    rows: (st) => st.opps.map((o) => ({ id: o.id, name: o.name, customer: custName(o.customerId), stage: o.stage, owner: empName(o.ownerId), created: o.created || '', closeDate: o.closeDate || '', competitor: o.competitor || '', amount: o.amount || 0 })) },
  ];
  const availableDatasets = () => DATASETS.filter((d) => !d.when || d.when(S()));
  const reportDatasets = () => availableDatasets().map((d) => ({ key: d.key, label: d.label, fields: d.fields.map((f) => ({ ...f })) }));
  function dataset(key) {
    const d = DATASETS.find((x) => x.key === key);
    if (!d) fail(`Unknown dataset "${key}". Choose one of: ${availableDatasets().map((x) => x.key).join(', ')}.`);
    if (d.when && !d.when(S())) fail(`Dataset "${d.label}" is not available (its module has no data).`);
    return d;
  }

  // ---------- query engine ----------
  const OPS = ['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'between', 'in'];
  const FNS = ['sum', 'count', 'avg', 'min', 'max'];
  const FN_LABEL = { sum: 'Sum of', count: 'Count of', avg: 'Average', min: 'Min', max: 'Max' };
  const isNum = (t) => t === 'number' || t === 'money';
  const listOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter((x) => x !== '');
  const aggKey = (a) => (a.fn === 'count' && !a.field ? 'count' : `${a.fn}_${a.field}`);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sortable = (v, type) => (v == null || v === '' ? (isNum(type) ? -Infinity : '') : isNum(type) ? +v : String(v).toLowerCase());

  function coerce(f, v, what) {
    if (isNum(f.type)) { const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, '')); if (String(v).trim() === '' || !Number.isFinite(n)) fail(`Filter on ${f.label}: "${v}" is not a number.`); return n; }
    if (f.type === 'date' && !isDate(v)) fail(`Filter on ${f.label}: "${v}" is not a date (YYYY-MM-DD)${what ? ' ' + what : ''}.`);
    return String(v);
  }
  function makeFilter(d, flt, i) {
    const f = d.fields.find((x) => x.key === flt.field);
    if (!f) fail(`Filter ${i + 1}: unknown field "${flt.field}" in ${d.label}.`);
    const op = flt.op || 'eq'; if (!OPS.includes(op)) fail(`Filter ${i + 1}: unknown operator "${op}". Use one of ${OPS.join(', ')}.`);
    const val = flt.value;
    const norm = (x) => (isNum(f.type) ? +x : String(x ?? '').toLowerCase());
    if (op === 'contains') { const q = String(val ?? '').toLowerCase(); return (r) => String(r[f.key] ?? '').toLowerCase().includes(q); }
    if (op === 'in') { const set = new Set(listOf(val).map((x) => norm(coerce(f, x)))); if (!set.size) fail(`Filter on ${f.label}: list at least one value for "in".`); return (r) => set.has(norm(r[f.key])); }
    if (op === 'between') {
      const pair = Array.isArray(val) ? val : val && typeof val === 'object' ? [val.from, val.to] : listOf(val);
      if (pair.length !== 2) fail(`Filter on ${f.label}: "between" needs two values (from, to).`);
      const lo = norm(coerce(f, pair[0])), hi = norm(coerce(f, pair[1]));
      return (r) => { const x = norm(r[f.key]); return x >= lo && x <= hi; };
    }
    const c = norm(coerce(f, val));
    const test = { eq: (x) => x === c, ne: (x) => x !== c, gt: (x) => x > c, gte: (x) => x >= c, lt: (x) => x < c, lte: (x) => x <= c }[op];
    return (r) => test(norm(r[f.key]));
  }

  /** Validate a definition; returns the normalized form. Throws a readable Error. */
  function normalize(def) {
    if (!def || typeof def !== 'object') fail('A report definition is required.');
    const d = dataset(def.dataset);
    const field = (k, where) => d.fields.find((x) => x.key === k) || fail(`${where}: unknown field "${k}" in ${d.label}. Available: ${d.fields.map((x) => x.key).join(', ')}.`);
    const groupBy = (def.groupBy || []).filter(Boolean); groupBy.forEach((k) => field(k, 'Group by'));
    let aggregates = (def.aggregates || []).filter((a) => a && a.fn).map((a, i) => {
      if (!FNS.includes(a.fn)) fail(`Aggregate ${i + 1}: unknown function "${a.fn}". Use one of ${FNS.join(', ')}.`);
      if (a.fn === 'count') { if (a.field) field(a.field, `Aggregate ${i + 1}`); return { fn: 'count', field: a.field || '' }; }
      const f = field(a.field, `Aggregate ${i + 1}`);
      if (!isNum(f.type) && a.fn !== 'min' && a.fn !== 'max') fail(`Aggregate ${i + 1}: ${a.fn} needs a number or money field; ${f.label} is ${f.type}.`);
      return { fn: a.fn, field: a.field };
    });
    if (groupBy.length && !aggregates.length) aggregates = [{ fn: 'count', field: '' }];
    const grouped = groupBy.length > 0 || aggregates.length > 0;
    const columns = grouped ? groupBy.slice() : (def.columns && def.columns.length ? def.columns.slice() : d.fields.map((f) => f.key));
    if (!grouped) columns.forEach((k) => field(k, 'Columns'));
    const filters = (def.filters || []).filter((x) => x && x.field);
    filters.forEach((x, i) => makeFilter(d, x, i));
    const outKeys = grouped ? [...groupBy, ...aggregates.map(aggKey)] : columns;
    const sort = (def.sort || []).filter((s) => s && s.field).map((s, i) => {
      if (!outKeys.includes(s.field)) fail(`Sort ${i + 1}: "${s.field}" is not a column of this report. Sort by one of: ${outKeys.join(', ')}.`);
      const dir = (s.dir || 'asc').toLowerCase(); if (dir !== 'asc' && dir !== 'desc') fail(`Sort ${i + 1}: direction must be asc or desc.`);
      return { field: s.field, dir };
    });
    let limit = def.limit == null || def.limit === '' ? 0 : +def.limit;
    if (!Number.isInteger(limit) || limit < 0) fail('Limit must be a whole number (0 or blank for no limit).');
    return { d, dataset: d.key, columns, filters, groupBy, aggregates, sort, limit, grouped };
  }

  /** run(definition) -> {dataset, columns:[{key,label,type}], rows:[{key:value}], totals:{key:value}, count, total}
   *  count = source rows after filters; total = result rows before limit. Totals cover all rows (before limit). */
  function run(def) {
    const q = normalize(def); const d = q.d;
    const fld = (k) => d.fields.find((x) => x.key === k);
    const preds = q.filters.map((x, i) => makeFilter(d, x, i));
    const src = d.rows(S()).filter((r) => preds.every((p) => p(r)));
    let columns, rows; const totals = {};
    if (!q.grouped) {
      columns = q.columns.map((k) => { const f = fld(k); return { key: k, label: f.label, type: f.type }; });
      rows = src.map((r) => { const o = {}; q.columns.forEach((k) => (o[k] = r[k] ?? '')); return o; });
      columns.forEach((c) => { const f = fld(c.key); if (isNum(c.type) && !f.rate) totals[c.key] = roundT(c.type, rows.reduce((a, r) => a + (+r[c.key] || 0), 0)); });
    } else {
      const aggCol = (a) => { const f = a.field ? fld(a.field) : null; const type = a.fn === 'count' ? 'number' : f.type;
        return { key: aggKey(a), label: a.fn === 'count' ? (f ? `Count of ${f.label}` : 'Count') : `${FN_LABEL[a.fn]} ${f.label}`, type, agg: a.fn }; };
      columns = [...q.groupBy.map((k) => { const f = fld(k); return { key: k, label: f.label, type: f.type }; }), ...q.aggregates.map(aggCol)];
      const groups = new Map();
      for (const r of src) {
        const gk = JSON.stringify(q.groupBy.map((k) => r[k] ?? ''));
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk).push(r);
      }
      if (!q.groupBy.length && !groups.size) groups.set('[]', []);
      rows = [];
      for (const [gk, list] of groups) {
        const o = {}; const vals = JSON.parse(gk); q.groupBy.forEach((k, i) => (o[k] = vals[i]));
        q.aggregates.forEach((a) => (o[aggKey(a)] = aggregate(a, list, fld)));
        rows.push(o);
      }
      if (!q.sort.length) rows.sort((a, b) => { for (const k of q.groupBy) { const c = cmp(sortable(a[k], fld(k).type), sortable(b[k], fld(k).type)); if (c) return c; } return 0; });
      q.aggregates.forEach((a) => { const k = aggKey(a); totals[k] = a.fn === 'sum' || a.fn === 'count' ? roundT(a.fn === 'count' ? 'number' : fld(a.field).type, rows.reduce((s, r) => s + (+r[k] || 0), 0)) : aggregate(a, src, fld); });
    }
    if (q.sort.length) {
      const typeOf = (k) => columns.find((c) => c.key === k).type;
      rows = rows.map((r, i) => [r, i]).sort((x, y) => { for (const s of q.sort) { const c = cmp(sortable(x[0][s.field], typeOf(s.field)), sortable(y[0][s.field], typeOf(s.field))); if (c) return s.dir === 'desc' ? -c : c; } return x[1] - y[1]; }).map((x) => x[0]);
    }
    const total = rows.length; if (q.limit) rows = rows.slice(0, q.limit);
    return { dataset: d.key, datasetLabel: d.label, columns, rows, totals, count: src.length, total };
  }
  const roundT = (type, n) => (type === 'money' ? r2(n) : Math.round(n * 10000) / 10000) + 0; // + 0 turns -0 into 0
  function aggregate(a, list, fld) {
    if (a.fn === 'count') return a.field ? list.filter((r) => r[a.field] !== '' && r[a.field] != null).length : list.length;
    const f = fld(a.field); const vals = list.map((r) => r[a.field]).filter((v) => v !== '' && v != null);
    if (!vals.length) return a.fn === 'sum' ? 0 : '';
    if (!isNum(f.type)) { const s = vals.map(String).sort(); return a.fn === 'min' ? s[0] : s[s.length - 1]; }
    const ns = vals.map(Number);
    const v = a.fn === 'sum' ? ns.reduce((x, y) => x + y, 0) : a.fn === 'avg' ? ns.reduce((x, y) => x + y, 0) / ns.length : a.fn === 'min' ? Math.min(...ns) : Math.max(...ns);
    return roundT(f.type, v);
  }

  // ---------- saved reports ----------
  const SEED_REPORTS = [
    { name: 'Spend by supplier this FY', definition: { dataset: 'ap', filters: [{ field: 'date', op: 'gte', value: E.FY_START + '-01' }, { field: 'status', op: 'ne', value: 'Cancelled' }], groupBy: ['supplier'], aggregates: [{ fn: 'sum', field: 'total' }, { fn: 'count', field: '' }], sort: [{ field: 'sum_total', dir: 'desc' }] } },
    { name: 'Revenue by customer and month', definition: { dataset: 'ar', filters: [], groupBy: ['customer', 'period'], aggregates: [{ fn: 'sum', field: 'net' }], sort: [] } },
    { name: 'Open AR over 30 days', definition: { dataset: 'ar', columns: ['id', 'customer', 'date', 'due', 'age', 'daysOverdue', 'open'], filters: [{ field: 'open', op: 'gt', value: 0 }, { field: 'age', op: 'gt', value: 30 }], sort: [{ field: 'age', dir: 'desc' }] } },
    { name: 'Headcount and salary by department', definition: { dataset: 'employees', filters: [{ field: 'status', op: 'eq', value: 'Active' }], groupBy: ['dept'], aggregates: [{ fn: 'count', field: '' }, { fn: 'sum', field: 'salary' }, { fn: 'avg', field: 'salary' }], sort: [] } },
    { name: 'Inventory value by item', definition: { dataset: 'items', columns: ['sku', 'name', 'onHand', 'avgCost', 'value'], filters: [], sort: [{ field: 'value', dir: 'desc' }] } },
  ];
  E.on('state', (st) => {
    if (!st.savedReports) {
      st.savedReports = SEED_REPORTS.map((r, i) => ({ id: `RPT-${1001 + i}`, name: r.name, owner: 'System Administrator', definition: JSON.parse(JSON.stringify(r.definition)), created: E.TODAY }));
      st.seq = st.seq || {}; st.seq.RPT = Math.max(st.seq.RPT || 1000, 1000 + SEED_REPORTS.length);
    }
  });
  const report = (id) => (S().savedReports || []).find((r) => r.id === id);
  const cleanDef = (def) => { const q = normalize(def); const out = { dataset: q.dataset, filters: q.filters.map((f) => ({ field: f.field, op: f.op || 'eq', value: f.value })), sort: q.sort };
    if (q.grouped) { out.groupBy = q.groupBy; out.aggregates = q.aggregates; } else out.columns = q.columns; if (q.limit) out.limit = q.limit; return out; };
  const checkName = (name, exceptId) => { name = String(name || '').trim(); if (!name) fail('Give the report a name.');
    if (S().savedReports.some((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase())) fail(`A report named "${name}" already exists.`); return name; };
  /** saveReport({id?, name, definition}) creates, or overwrites the definition of an existing report. */
  function saveReport({ id, name, definition }) {
    const def = cleanDef(definition);
    if (id) { const r = E.need(report(id), 'Report'); r.name = checkName(name ?? r.name, id); r.definition = def; r.updated = S().today; E.log('Updated report', id, r.name); return r; }
    const r = { id: E.nextId('RPT'), name: checkName(name), owner: S().user, definition: def, created: S().today };
    S().savedReports.push(r); E.log('Saved report', r.id, r.name); return r;
  }
  function renameReport(id, name) { const r = E.need(report(id), 'Report'); r.name = checkName(name, id); E.log('Renamed report', id, r.name); return r; }
  function deleteReport(id) { const r = E.need(report(id), 'Report'); S().savedReports.splice(S().savedReports.indexOf(r), 1); E.log('Deleted report', id, r.name); return r; }
  const runReport = (id) => run(E.need(report(id), 'Report').definition);
  Object.keys(E.ROLES).forEach((role) => E.addPerms(role, ['rpt.edit']));
  E.on('search', (q, hit) => (S().savedReports || []).filter((r) => hit(r.id, r.name)).map((r) => ({ kind: 'report', id: r.id, label: r.name, sub: `Saved report ${r.id}` })));

  // ---------- CSV ----------
  const csvCell = (v) => { if (v == null) return ''; const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  /** toCSV(header:[string], rows:[[value]]) -> RFC 4180 text with CRLF line breaks. */
  const toCSV = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  /** CSV of a run() result: labels as header, raw (unformatted) values; opts.totals adds a Total row. */
  function resultCSV(res, opts = {}) {
    const rows = res.rows.map((r) => res.columns.map((c) => r[c.key]));
    if (opts.totals && Object.keys(res.totals).length) rows.push(res.columns.map((c, i) => (c.key in res.totals ? res.totals[c.key] : i === 0 ? 'Total' : '')));
    return toCSV(res.columns.map((c) => c.label), rows);
  }
  /** parseCSV(text) -> [[string]]. Handles quotes, "" escapes, commas and newlines in quoted fields,
   *  CRLF / LF / CR line breaks, a leading BOM, and blank lines (skipped). Throws on an unclosed quote. */
  function parseCSV(text) {
    let s = String(text ?? ''); if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const rows = []; let row = [], cell = '', inQ = false, quoted = false, i = 0, line = 1, qLine = 0;
    const endCell = () => { row.push(cell); cell = ''; quoted = false; };
    const endRow = () => { endCell(); if (!(row.length === 1 && row[0] === '' )) rows.push(row); row = []; };
    while (i < s.length) {
      const ch = s[i];
      if (inQ) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } inQ = false; i++; continue; }
        if (ch === '\n') line++;
        cell += ch; i++; continue;
      }
      if (ch === '"' && cell === '' && !quoted) { inQ = true; quoted = true; qLine = line; i++; continue; }
      if (ch === ',') { endCell(); i++; continue; }
      if (ch === '\r' || ch === '\n') { endRow(); line++; i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1; continue; }
      cell += ch; i++;
    }
    if (inQ) fail(`CSV has an unclosed quote starting on line ${qLine}.`);
    if (cell !== '' || row.length || quoted) endRow();
    return rows;
  }

  // ---------- import ----------
  const T = (key, label, req, type = 'text', aliases = []) => ({ key, label, required: !!req, type, aliases });
  const IMPORT_TARGETS = {
    journals: { label: 'Journals', perm: 'gl.post', fields: [T('journal_ref', 'Journal ref', 1, 'text', ['ref', 'journal', 'je', 'batch']), T('date', 'Date', 1, 'date', ['posting date', 'gl date']),
      T('description', 'Description', 1, 'text', ['desc', 'narrative']), T('account', 'Account', 1, 'text', ['acct', 'account code', 'gl account']), T('debit', 'Debit', 0, 'number', ['dr']),
      T('credit', 'Credit', 0, 'number', ['cr']), T('memo', 'Memo', 0, 'text', ['line memo', 'line description']), T('entity', 'Entity', 0), T('dept', 'Department', 0, 'text', ['department'])],
    example: [['IMP-001', '{today}', 'Office supplies purchase', '6600', '250.00', '', 'Stationery', '', ''], ['IMP-001', '{today}', 'Office supplies purchase', '1000', '', '250.00', '', '', '']] },
    suppliers: { label: 'Suppliers', perm: 'supplier.edit', fields: [T('name', 'Name', 1, 'text', ['supplier', 'supplier name']), T('terms', 'Payment terms (days)', 0, 'number', ['payment terms']),
      T('site', 'Site', 0, 'text', ['address', 'location']), T('email', 'Email', 0), T('currency', 'Currency', 0, 'text', ['ccy'])],
    example: [['Northgate Fasteners', '30', 'Worcester, MA', 'ap@example.com', 'USD']] },
    customers: { label: 'Customers', perm: 'customer.edit', fields: [T('name', 'Name', 1, 'text', ['customer', 'customer name']), T('terms', 'Payment terms (days)', 0, 'number', ['payment terms']),
      T('credit_limit', 'Credit limit', 0, 'number', ['limit', 'creditlimit']), T('segment', 'Segment', 0), T('currency', 'Currency', 0, 'text', ['ccy']), T('tax_code', 'Tax code', 0, 'text', ['tax', 'taxcode'])],
    example: [['Brightwater Labs', '30', '40000', 'Research', 'USD', 'MA']] },
    items: { label: 'Items', perm: 'item.edit', fields: [T('sku', 'SKU', 1, 'text', ['item', 'item code', 'part']), T('name', 'Name', 1, 'text', ['description', 'item name']), T('uom', 'Unit of measure', 0, 'text', ['unit']),
      T('price', 'List price', 1, 'number', ['list price']), T('reorder', 'Reorder point', 0, 'number', ['reorder point', 'min']), T('cost', 'Standard cost', 0, 'number', ['unit cost', 'avg cost'])],
    example: [['TS-210', 'Temperature probe, 210 mm', 'Each', '89.00', '20', '31.50']] },
    employees: { label: 'Employees', perm: 'hr.edit', fields: [T('name', 'Name', 1, 'text', ['employee', 'full name']), T('title', 'Job title', 1, 'text', ['job title', 'position']),
      T('dept', 'Department', 1, 'text', ['department']), T('manager_id', 'Manager ID', 0, 'text', ['manager', 'managerid']), T('salary', 'Annual salary', 1, 'number', ['annual salary', 'pay']),
      T('hire_date', 'Hire date', 1, 'date', ['start date', 'hired']), T('location', 'Location', 0)],
    example: [['Rosa Lindqvist', 'Test Engineer', 'Engineering', 'E-1005', '91000', '{today}', 'Boston, MA']] },
  };
  const importTarget = (k) => IMPORT_TARGETS[k] || fail(`Unknown import target "${k}". Use one of: ${Object.keys(IMPORT_TARGETS).join(', ')}.`);
  const normH = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  /** importTemplate(target) -> CSV text with the header and an example row (dated today). */
  const importTemplate = (target) => { const t = importTarget(target); return toCSV(t.fields.map((f) => f.key), t.example.map((r) => r.map((v) => (v === '{today}' ? S().today : v)))); };
  /** autoMap(target, headers) -> {fieldKey: columnIndex (-1 = not mapped)} matched by key, label or alias. */
  function autoMap(target, headers) {
    const t = importTarget(target); const hs = headers.map(normH); const used = new Set(); const map = {};
    for (const f of t.fields) {
      const names = [f.key, f.label, ...f.aliases].map(normH);
      let idx = hs.findIndex((h, i) => !used.has(i) && names.includes(h));
      if (idx >= 0) used.add(idx); map[f.key] = idx;
    }
    return map;
  }
  /** Turn parsed rows into records ({rowNo, values}) using a mapping; first row is the header. */
  function mapRows(target, rows, mapping) {
    const t = importTarget(target); const body = rows.slice(1);
    return body.map((r, i) => { const v = {}; t.fields.forEach((f) => { const ix = mapping[f.key]; v[f.key] = ix != null && ix >= 0 ? String(r[ix] ?? '').trim() : ''; }); return { rowNo: i + 2, values: v }; });
  }
  const numOf = (s) => Number(String(s).replace(/[$,\s]/g, ''));
  function fieldErrors(t, rec) {
    const errs = [];
    for (const f of t.fields) {
      const v = rec.values[f.key];
      if (f.required && v === '') errs.push(`${f.label} is required.`);
      else if (v !== '' && f.type === 'number' && !Number.isFinite(numOf(v))) errs.push(`${f.label} "${v}" is not a number.`);
      else if (v !== '' && f.type === 'date' && !isDate(v)) errs.push(`${f.label} "${v}" is not a date (YYYY-MM-DD).`);
    }
    return errs;
  }
  /** Build engine calls: [{rows:[rowNo], label, apply()}] */
  function buildOps(target, recs) {
    const n = (v, d) => (v === '' ? d : numOf(v));
    if (target === 'journals') {
      const groups = new Map();
      recs.forEach((r) => { const k = r.values.journal_ref; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
      return [...groups].map(([ref, rs]) => ({ rows: rs.map((r) => r.rowNo), label: `Journal ${ref}`, check() {
        const first = rs[0].values;
        if (rs.some((r) => r.values.date !== first.date)) fail(`All lines of journal ${ref} must have the same date.`);
        rs.forEach((r) => { const dr = n(r.values.debit, 0), cr = n(r.values.credit, 0); if (dr && cr) fail(`Row ${r.rowNo}: a line can have a debit or a credit, not both.`); if (!dr && !cr) fail(`Row ${r.rowNo}: enter a debit or a credit.`); if (dr < 0 || cr < 0) fail(`Row ${r.rowNo}: amounts cannot be negative.`); });
      }, apply() {
        const first = rs[0].values; const desc = first.description;
        const lines = rs.map((r) => { const l = { acct: r.values.account, dr: n(r.values.debit, 0), cr: n(r.values.credit, 0), memo: r.values.memo }; if (r.values.entity) l.entity = r.values.entity; if (r.values.dept) l.dept = r.values.dept; return l; });
        const total = r2(lines.reduce((a, l) => a + l.dr, 0));
        return E.createJournal({ date: first.date, source: 'Import', desc, lines, ref: ref, needsApproval: total > E.JE_APPROVAL_LIMIT });
      } }));
    }
    const call = {
      suppliers: (v) => E.addSupplier({ name: v.name, terms: n(v.terms, 30), site: v.site, email: v.email, currency: v.currency || 'USD' }),
      customers: (v) => E.addCustomer({ name: v.name, terms: n(v.terms, 30), creditLimit: n(v.credit_limit, 50000), segment: v.segment, currency: v.currency || 'USD', taxCode: v.tax_code }),
      items: (v) => E.addItem({ sku: v.sku, name: v.name, uom: v.uom || 'Each', price: n(v.price, 0), reorder: n(v.reorder, 0), cost: n(v.cost, 0) }),
      employees: (v) => E.hireEmployee({ name: v.name, title: v.title, dept: v.dept, managerId: v.manager_id, salary: n(v.salary, 0), hireDate: v.hire_date, location: v.location || undefined }),
    }[target];
    return recs.map((r) => ({ rows: [r.rowNo], label: `Row ${r.rowNo}`, check() {}, apply: () => call(r.values) }));
  }
  /** validateImport(target, rows, mapping?) -> {records, ops, errors:[{row, message}], count}
   *  Field checks, then a dry run of every engine call against a snapshot (state is restored). */
  function validateImport(target, rows, mapping) {
    const t = importTarget(target);
    if (!rows || rows.length < 2) return { records: [], errors: [{ row: 0, message: 'The file needs a header row and at least one data row.' }], count: 0 };
    mapping = mapping || autoMap(target, rows[0]);
    const errors = [];
    t.fields.filter((f) => f.required && !(mapping[f.key] >= 0)).forEach((f) => errors.push({ row: 1, message: `Required column "${f.key}" is not mapped.` }));
    if (errors.length) return { records: [], errors, count: 0 };
    const recs = mapRows(target, rows, mapping);
    recs.forEach((r) => fieldErrors(t, r).forEach((m) => errors.push({ row: r.rowNo, message: m })));
    const bad = new Set(errors.map((e) => e.row));
    const ops = buildOps(target, recs);
    { // dry run of every op without field errors, so all problems are reported at once
      const snap = JSON.stringify(S());
      try {
        for (const op of ops) {
          if (op.rows.some((x) => bad.has(x))) continue;
          try { op.check(); op.apply(); } catch (e) { errors.push({ row: op.rows[0], rows: op.rows, message: (target === 'journals' ? `${op.label} (rows ${op.rows.join(', ')}): ` : '') + e.message }); }
        }
      } finally { E.load(JSON.parse(snap)); }
    }
    errors.sort((a, b) => a.row - b.row);
    return { records: recs, ops, errors, count: ops.length, mapping };
  }
  /** runImport(target, rows, mapping?) -> {count, ids}. All or nothing: throws (state unchanged) if any row is invalid. */
  function runImport(target, rows, mapping) {
    const t = importTarget(target);
    if (!E.can(S().role, t.perm)) fail(`Your role (${S().role}) cannot import ${t.label.toLowerCase()}.`);
    const v = validateImport(target, rows, mapping);
    if (v.errors.length) fail(`Nothing was imported: ${v.errors.length} problem${v.errors.length === 1 ? '' : 's'} found. First: ${v.errors[0].row ? 'row ' + v.errors[0].row + ': ' : ''}${v.errors[0].message}`);
    const snap = JSON.stringify(S()); const ids = [];
    try { for (const op of v.ops) { op.check(); const r = op.apply(); ids.push(r.id || r.sku); } }
    catch (e) { E.load(JSON.parse(snap)); fail(`Import rolled back, nothing was saved: ${e.message}`); }
    E.log('Imported data', t.label, `${ids.length} ${t.label.toLowerCase()}`);
    return { count: ids.length, ids, target };
  }

  E.extend({
    REPORT_OPS: OPS, REPORT_FNS: FNS, IMPORT_TARGETS,
    reportDatasets, reportDataset: (k) => { const d = dataset(k); return { key: d.key, label: d.label, fields: d.fields.map((f) => ({ ...f })) }; },
    runQuery: run, normalizeQuery: (def) => { const q = normalize(def); delete q.d; return q; },
    report, saveReport, renameReport, deleteReport, runReport,
    toCSV, resultCSV, parseCSV, csvCell,
    importTemplate, autoMap, validateImport, runImport,
  });
})(typeof window !== 'undefined' ? window : globalThis);
