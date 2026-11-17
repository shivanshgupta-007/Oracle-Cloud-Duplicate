/* Ledgerline Suite: views-reports.js
 * Administration > Report builder (ad-hoc queries over typed datasets, saved reports, CSV export)
 * and Administration > Import data (CSV paste or file, header mapping, whole-batch validation, atomic import).
 * Also exports App.csv(cols, rows) and App.exportCSV(cols, rows, filename) for other pages.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, num = App.num, fdate = App.fdate;
  const card = (title, inner, right = '') => `<div class="card">${title ? `<div class="card-h"><span>${title}</span>${right}</div>` : ''}${inner}</div>`;

  // ---------- styles (layout only; colors via tokens) ----------
  if (!document.getElementById('rb-style')) {
    const st = document.createElement('style'); st.id = 'rb-style';
    st.textContent = `.rb-grid{display:grid;grid-template-columns:minmax(280px,1fr) minmax(0,2.3fr);gap:16px;align-items:start}
@media (max-width:1180px){.rb-grid{grid-template-columns:minmax(0,1fr)}}
.rb-sec{border:0;margin:0 0 12px;padding:0;min-width:0}
.rb-sec legend,.rb-sec h4{padding:0;margin:0 0 6px;font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.rb-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:4px 10px;max-height:210px;overflow:auto;padding:2px}
.rb-checks label{display:flex;gap:6px;align-items:center;font-size:13px;min-width:0}
.rb-line{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1.2fr) auto;gap:6px;align-items:center;margin-bottom:6px}
.rb-line.two{grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto}
.rb-line select,.rb-line input,textarea.csv{padding:5px 7px;border:1px solid var(--field);border-radius:6px;background:var(--surface);color:var(--ink);min-width:0;width:100%}
textarea.csv{min-height:150px;font-family:var(--mono);font-size:12.5px;padding:8px}
.rb-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}`;
    document.head.appendChild(st);
  }

  // ---------- CSV helpers shared with other pages ----------
  const strip = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  /** App.csv(cols, rows) -> CSV text. cols: [{label|h, key | value(row) | f(row)}]; f() HTML is reduced to text.
   *  Prefer key/value so numbers stay unformatted. */
  App.csv = function (cols, rows) {
    cols = cols.filter((c) => c.label || c.h || c.key);
    const val = (c, r) => (c.value ? c.value(r) : c.key != null ? r[c.key] : c.f ? strip(c.f(r)) : '');
    return E.toCSV(cols.map((c) => strip(c.label ?? c.h ?? c.key)), rows.map((r) => cols.map((c) => val(c, r))));
  };
  /** Copy text to the clipboard from inside a click handler; falls back to a drawer with the text selected. */
  App.copyText = function (text, okMsg = 'Copied to the clipboard.', title = 'Copy CSV') {
    const fallback = () => showCSV(title, text, '', 'Copying is blocked here. The text is selected: press Ctrl+C (Cmd+C on a Mac).');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => App.toast(okMsg), fallback);
      else fallback();
    } catch (e) { fallback(); }
  };
  /** Download text as a file. Embedded viewers may block downloads, so pages keep Copy as the main action. */
  App.downloadText = function (text, filename, type = 'text/csv') {
    try {
      const blob = new Blob(['﻿' + text], { type: type + ';charset=utf-8' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = filename; a.style.display = 'none'; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
      App.toast(`Downloading ${filename}. If nothing happens, use Copy CSV instead.`);
    } catch (e) { App.toast('Download is blocked here. Use Copy CSV instead.', 'bad'); }
  };
  let csvBuf = { text: '', file: 'export.csv' };
  function showCSV(title, text, filename, note) {
    csvBuf = { text, file: filename || csvBuf.file };
    App.drawer(title, `${note ? `<div class="callout warn">${esc(note)}</div>` : ''}<label class="field"><span>CSV</span><textarea id="csvOut" class="csv" rows="14" readonly>${esc(text)}</textarea></label>`,
      { extraButtons: `<button type="button" class="btn" data-act="csv-dl">Download CSV</button><button type="button" class="btn primary" data-act="csv-copy">Copy CSV</button>` });
    const ta = document.getElementById('csvOut'); if (ta) { ta.focus(); ta.select(); }
  }
  App.act('csv-copy', () => { const ta = document.getElementById('csvOut'); if (ta) ta.select(); App.copyText(csvBuf.text); });
  App.act('csv-dl', () => App.downloadText(csvBuf.text, csvBuf.file));
  /** App.exportCSV(cols, rows, filename): opens a drawer with the CSV, Copy (primary) and Download. */
  App.exportCSV = (cols, rows, filename = 'export.csv') => showCSV('Export CSV', App.csv(cols, rows), filename);
  App.showCSV = showCSV;

  // ---------- result rendering ----------
  const cellFmt = (type, v) => (v === '' || v == null ? '' : type === 'money' ? fmt(v) : type === 'number' ? num(v) : type === 'date' ? fdate(String(v)) : esc(v));
  function resultTable(res, key) {
    const cols = res.columns.map((c) => ({ h: esc(c.label), num: c.type === 'money' || c.type === 'number', f: (r) => cellFmt(c.type, r[c.key]), sort: (r) => (c.type === 'money' || c.type === 'number' ? +r[c.key] || 0 : String(r[c.key] ?? '').toLowerCase()) }));
    const hasT = Object.keys(res.totals).length > 0;
    const foot = hasT ? res.columns.map((c, i) => (c.key in res.totals ? cellFmt(c.type, res.totals[c.key]) : i === 0 ? 'Total' : '')) : null;
    return App.table(cols, res.rows, { foot, key, empty: 'No rows match these filters.' });
  }
  const slug = (s) => String(s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';

  // ---------- builder state ----------
  const st = () => {
    const f = App.ui.filter; if (!f.rb) f.rb = { id: '', name: '', def: blankDef('gl') };
    return f.rb;
  };
  function blankDef(ds) {
    const d = E.reportDataset(ds);
    const pick = { gl: ['date', 'journal', 'account', 'accountName', 'debit', 'credit', 'memo'] }[ds];
    return { dataset: ds, columns: pick || d.fields.slice(0, 8).map((f) => f.key), filters: [], groupBy: [], aggregates: [], sort: [], limit: '' };
  }
  const OP_LABEL = { eq: 'equals', ne: 'not equal', contains: 'contains', gt: '>', gte: '>=', lt: '<', lte: '<=', between: 'between (a,b)', in: 'in (a,b,c)' };
  const FN_LABEL = { sum: 'Sum', count: 'Count', avg: 'Average', min: 'Min', max: 'Max' };
  const sel = (id, opts, val, label, extra = '') => `<select id="${id}" aria-label="${esc(label)}" ${extra}>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const outKeys = (def, d) => {
    const lab = (k) => d.fields.find((f) => f.key === k)?.label || k;
    const grouped = def.groupBy.length || def.aggregates.length;
    if (!grouped) return def.columns.map((k) => [k, lab(k)]);
    const aggs = def.aggregates.length ? def.aggregates : [{ fn: 'count', field: '' }];
    return [...def.groupBy.map((k) => [k, lab(k)]), ...aggs.map((a) => [a.fn === 'count' && !a.field ? 'count' : `${a.fn}_${a.field}`, a.fn === 'count' && !a.field ? 'Count' : `${FN_LABEL[a.fn]} of ${lab(a.field)}`])];
  };
  const toRunDef = (def) => ({ ...def, limit: def.limit === '' ? 0 : +def.limit, aggregates: def.aggregates.filter((a) => a.fn && (a.fn === 'count' || a.field)), filters: def.filters.filter((f) => f.field) });

  function builderPanel(s, d) {
    const def = s.def; const fields = d.fields;
    const fOpts = fields.map((f) => [f.key, f.label]);
    const numOpts = fields.filter((f) => f.type === 'money' || f.type === 'number').map((f) => [f.key, f.label]);
    const saved = E.S.savedReports || [];
    const grouped = def.groupBy.length || def.aggregates.length;
    const filters = def.filters.map((f, i) => `<div class="rb-line">${sel(`rbFf${i}`, fOpts, f.field, `Filter ${i + 1} field`)}${sel(`rbFo${i}`, E.REPORT_OPS.map((o) => [o, OP_LABEL[o]]), f.op, `Filter ${i + 1} operator`)}<input id="rbFv${i}" aria-label="Filter ${i + 1} value" value="${esc(Array.isArray(f.value) ? f.value.join(',') : f.value ?? '')}" placeholder="value"><button type="button" class="btn sm" data-act="rb-del" data-list="filters" data-i="${i}" aria-label="Remove filter ${i + 1}">&times;</button></div>`).join('');
    const aggs = def.aggregates.map((a, i) => `<div class="rb-line two">${sel(`rbAf${i}`, E.REPORT_FNS.map((x) => [x, FN_LABEL[x]]), a.fn, `Aggregate ${i + 1} function`)}${sel(`rbAk${i}`, a.fn === 'count' ? [['', 'Rows'], ...fOpts] : a.fn === 'min' || a.fn === 'max' ? fOpts : numOpts, a.field, `Aggregate ${i + 1} field`)}<button type="button" class="btn sm" data-act="rb-del" data-list="aggregates" data-i="${i}" aria-label="Remove aggregate ${i + 1}">&times;</button></div>`).join('');
    const sOpts = outKeys(def, d);
    const sorts = def.sort.map((x, i) => `<div class="rb-line two">${sel(`rbSf${i}`, sOpts, x.field, `Sort ${i + 1} field`)}${sel(`rbSd${i}`, [['asc', 'Ascending'], ['desc', 'Descending']], x.dir, `Sort ${i + 1} direction`)}<button type="button" class="btn sm" data-act="rb-del" data-list="sort" data-i="${i}" aria-label="Remove sort ${i + 1}">&times;</button></div>`).join('');
    return `<div class="pad" id="rbForm">
      <div class="rb-sec">${App.field('Saved report', sel('rbSaved', [['', saved.length ? 'Choose a saved report' : 'No saved reports']].concat(saved.map((r) => [r.id, r.name])), s.id, 'Saved report'))}</div>
      <div class="rb-sec">${App.field('Dataset', sel('rbDs', E.reportDatasets().map((x) => [x.key, x.label]), def.dataset, 'Dataset'))}</div>
      <fieldset class="rb-sec"><legend>Columns${grouped ? ' (replaced by group by + aggregates)' : ''}</legend><div class="rb-checks">${fields.map((f) => `<label><input type="checkbox" id="rbC_${f.key}" data-col="${f.key}" ${def.columns.includes(f.key) ? 'checked' : ''} ${grouped ? 'disabled' : ''}>${esc(f.label)}</label>`).join('')}</div></fieldset>
      <div class="rb-sec"><h4>Filters</h4>${filters}<button type="button" class="btn sm" data-act="rb-add" data-list="filters">Add filter</button></div>
      <fieldset class="rb-sec"><legend>Group by</legend><div class="rb-checks">${fields.filter((f) => f.type !== 'money').map((f) => `<label><input type="checkbox" id="rbG_${f.key}" data-grp="${f.key}" ${def.groupBy.includes(f.key) ? 'checked' : ''}>${esc(f.label)}</label>`).join('')}</div></fieldset>
      <div class="rb-sec"><h4>Aggregates</h4>${aggs}<button type="button" class="btn sm" data-act="rb-add" data-list="aggregates">Add aggregate</button></div>
      <div class="rb-sec"><h4>Sort</h4>${sorts}<button type="button" class="btn sm" data-act="rb-add" data-list="sort">Add sort</button></div>
      <div class="rb-sec">${App.field('Row limit', `<input id="rbLimit" type="number" min="0" step="1" value="${esc(def.limit ?? '')}" placeholder="No limit">`)}</div>
      <div class="rb-bar"><button type="button" class="btn primary" data-act="rb-run">Run report</button><button type="button" class="btn" data-act="rb-new">Clear</button></div>
    </div>`;
  }
  /** Read the builder form into s.def (structure changes re-render; text values are kept). */
  function readForm(root) {
    const s = st(); const g = (id) => root.querySelector('#' + id);
    const ds = g('rbDs')?.value;
    if (ds && ds !== s.def.dataset) { s.def = blankDef(ds); s.id = ''; s.name = ''; return; }
    const def = s.def;
    def.columns = Array.from(root.querySelectorAll('[data-col]')).filter((x) => x.checked).map((x) => x.dataset.col);
    def.groupBy = Array.from(root.querySelectorAll('[data-grp]')).filter((x) => x.checked).map((x) => x.dataset.grp);
    def.filters = def.filters.map((f, i) => ({ field: g(`rbFf${i}`)?.value ?? f.field, op: g(`rbFo${i}`)?.value ?? f.op, value: g(`rbFv${i}`)?.value ?? f.value }));
    def.aggregates = def.aggregates.map((a, i) => ({ fn: g(`rbAf${i}`)?.value ?? a.fn, field: g(`rbAk${i}`)?.value ?? a.field }));
    def.sort = def.sort.map((x, i) => ({ field: g(`rbSf${i}`)?.value ?? x.field, dir: g(`rbSd${i}`)?.value ?? x.dir }));
    def.limit = g('rbLimit')?.value ?? def.limit;
    // keep sort keys valid after structure changes
    const d = E.reportDataset(def.dataset); const keys = outKeys(def, d).map((x) => x[0]);
    def.sort = def.sort.map((x) => (keys.includes(x.field) ? x : { ...x, field: keys[0] }));
    def.aggregates = def.aggregates.map((a) => { const f = d.fields.find((x) => x.key === a.field); const numeric = f && (f.type === 'money' || f.type === 'number');
      if (a.fn === 'count') return a; if ((a.fn === 'sum' || a.fn === 'avg') && !numeric) return { ...a, field: d.fields.find((x) => x.type === 'money' || x.type === 'number')?.key || '' }; if (!f) return { ...a, field: d.fields[0].key }; return a; });
  }
  const loadSaved = (id) => { const r = E.report(id); if (!r) return; const def = r.definition;
    st().id = r.id; st().name = r.name;
    st().def = { dataset: def.dataset, columns: def.columns ? def.columns.slice() : blankDef(def.dataset).columns, filters: (def.filters || []).map((f) => ({ ...f })), groupBy: (def.groupBy || []).slice(), aggregates: (def.aggregates || []).map((a) => ({ ...a })), sort: (def.sort || []).map((x) => ({ ...x })), limit: def.limit || '' }; };
  let focusId = null;
  const rerender = () => { focusId = document.activeElement && document.activeElement.id; App.render(); };

  App.act('rb-add', (ds) => {
    const root = document.getElementById('rbForm'); if (root) readForm(root);
    const def = st().def; const d = E.reportDataset(def.dataset);
    if (ds.list === 'filters') def.filters.push({ field: d.fields[0].key, op: 'eq', value: '' });
    if (ds.list === 'aggregates') { const m = d.fields.find((f) => f.type === 'money' || f.type === 'number'); def.aggregates.push(m ? { fn: 'sum', field: m.key } : { fn: 'count', field: '' }); }
    if (ds.list === 'sort') def.sort.push({ field: outKeys(def, d)[0][0], dir: 'asc' });
    rerender();
  });
  App.act('rb-del', (ds) => { const root = document.getElementById('rbForm'); if (root) readForm(root); st().def[ds.list].splice(+ds.i, 1); rerender(); });
  App.act('rb-run', () => { const root = document.getElementById('rbForm'); if (root) readForm(root); rerender(); });
  App.act('rb-new', () => { const ds = st().def.dataset; App.ui.filter.rb = { id: '', name: '', def: blankDef(ds) }; rerender(); });
  const currentResult = () => E.runQuery(toRunDef(st().def));
  App.act('rb-copy', () => { let res; try { res = currentResult(); } catch (e) { App.toast(e.message, 'bad'); return; } App.copyText(E.resultCSV(res), `Copied ${res.rows.length} rows as CSV.`); });
  App.act('rb-dl', () => { let res; try { res = currentResult(); } catch (e) { App.toast(e.message, 'bad'); return; } App.downloadText(E.resultCSV(res), slug(st().name || res.datasetLabel) + '.csv'); });
  App.act('rb-save', (ds) => {
    const s = st(); const asNew = ds.mode === 'new' || !s.id;
    App.drawer(asNew ? 'Save report' : 'Rename report', App.field('Report name', App.input('rbName', asNew ? (s.name ? s.name + ' (copy)' : '') : s.name, 'text', 'required maxlength="80"')), {
      submitLabel: asNew ? 'Save report' : 'Rename',
      onSubmit: (f) => { const name = App.val(f, 'rbName'); const r = asNew ? E.saveReport({ name, definition: toRunDef(s.def) }) : E.renameReport(s.id, name); s.id = r.id; s.name = r.name; return r; },
      success: (r) => `Saved ${r.id} "${r.name}".`,
    });
  });
  App.act('rb-update', () => { const s = st(); App.try(() => E.saveReport({ id: s.id, name: s.name, definition: toRunDef(s.def) }), (r) => `Updated ${r.id} "${r.name}".`); });
  App.act('rb-delete', () => { const s = st(); const r = E.report(s.id); if (!r) return;
    App.confirm('Delete report', `Delete the saved report <b>${esc(r.name)}</b> (${esc(r.id)})? This cannot be undone.`, 'Delete', () => { E.deleteReport(r.id); s.id = ''; s.name = ''; }, `Deleted ${r.id}.`); });
  App.act('rb-open', (ds) => { App.closeDrawer(); loadSaved(ds.id); App.go('reports-builder'); App.render(); });
  App.act('rpt-copy', (ds) => { try { const res = E.runReport(ds.id); App.copyText(E.resultCSV(res), `Copied ${res.rows.length} rows as CSV.`); } catch (e) { App.toast(e.message, 'bad'); } });

  App.view('reports-builder', {
    title: 'Report builder', group: 'Administration',
    render() {
      const s = st();
      let d; try { d = E.reportDataset(s.def.dataset); } catch (e) { App.ui.filter.rb = null; return this.render(); }
      let res = null, err = '';
      try { res = currentResult(); } catch (e) { err = e.message; }
      const canEdit = App.can('rpt.edit');
      const head = App.head('Administration', 'Report builder', 'Pick a dataset, choose columns or group and aggregate, filter and sort. Save reports to rerun them; export any result as CSV.',
        `${s.id ? App.btn('Save changes', 'rb-update', {}, 'rpt.edit') + App.btn('Rename', 'rb-save', { mode: 'rename' }, 'rpt.edit') + App.btn('Delete', 'rb-delete', {}, 'rpt.edit', 'danger') : ''}${App.btn(s.id ? 'Save as new' : 'Save report', 'rb-save', { mode: 'new' }, 'rpt.edit', s.id ? '' : 'primary')}`);
      const title = s.id ? `${esc(s.name)} <span class="muted mono small">${esc(s.id)}</span>` : 'Result';
      const right = res ? `<span class="rb-bar"><span class="muted small">${num(res.rows.length)}${res.total > res.rows.length ? ` of ${num(res.total)}` : ''} source rows: ${num(res.count)} (${esc(res.datasetLabel)})</span><button type="button" class="btn sm primary" data-act="rb-copy">Copy CSV</button><button type="button" class="btn sm" data-act="rb-dl">Download CSV</button></span>` : '';
      const body = err ? `<div class="pad"><div class="callout warn" role="alert">${esc(err)}</div></div>` : resultTable(res, 'rb:result');
      const note = canEdit ? '' : '<div class="callout" style="margin-bottom:12px">Your role can run reports but not save them.</div>';
      return head + note + `<div class="rb-grid">${card('Definition', builderPanel(s, d))}${card(title, body, right)}</div>`;
    },
    after(el) {
      const root = el.querySelector('#rbForm'); if (!root) return;
      root.addEventListener('change', (ev) => {
        if (ev.target.id === 'rbSaved') { if (ev.target.value) loadSaved(ev.target.value); rerender(); return; }
        readForm(root); rerender();
      });
      root.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox') { ev.preventDefault(); readForm(root); rerender(); } });
      if (focusId) { const f = document.getElementById(focusId); focusId = null; if (f) f.focus(); }
    },
  });

  App.detail('report', (id) => {
    const r = E.report(id); if (!r) return null;
    let res, err = '';
    try { res = E.runReport(id); } catch (e) { err = e.message; }
    const def = r.definition; const d = (() => { try { return E.reportDataset(def.dataset); } catch (e) { return { label: def.dataset, fields: [] }; } })();
    const lab = (k) => d.fields.find((f) => f.key === k)?.label || k;
    const desc = [
      ['Dataset', esc(d.label)], ['Owner', esc(r.owner)], ['Created', fdate(r.created)],
      def.groupBy?.length ? ['Grouped by', esc(def.groupBy.map(lab).join(', '))] : null,
      def.filters?.length ? ['Filters', esc(def.filters.map((f) => `${lab(f.field)} ${OP_LABEL[f.op] || f.op} ${Array.isArray(f.value) ? f.value.join(', ') : f.value}`).join('; '))] : ['Filters', 'None'],
    ];
    return { title: `${r.name}`, html: App.dl(desc) + (err ? `<div class="callout warn">${esc(err)}</div>` : resultTable(res, 'd:report:' + id)),
      buttons: `<button type="button" class="btn" data-act="rb-open" data-id="${esc(id)}">Open in builder</button><button type="button" class="btn primary" data-act="rpt-copy" data-id="${esc(id)}">Copy CSV</button>` };
  });
  App.refKind('RPT-', 'report');

  // ---------- import ----------
  const ist = () => { const f = App.ui.filter; if (!f.imp) f.imp = { target: 'journals', text: '', mapping: null, headerSig: '', check: null, done: null }; return f.imp; };
  const parseNow = (s) => { try { return { rows: s.text.trim() ? E.parseCSV(s.text) : [] }; } catch (e) { return { rows: [], err: e.message }; } };
  App.act('imp-tpl-copy', () => App.copyText(E.importTemplate(ist().target), 'Template copied.', 'Template'));
  App.act('imp-tpl-dl', () => App.downloadText(E.importTemplate(ist().target), `${ist().target}-template.csv`));
  App.act('imp-tpl-use', () => { const s = ist(); s.text = E.importTemplate(s.target); s.mapping = null; s.check = null; s.done = null; App.render(); });
  App.act('imp-clear', () => { const s = ist(); s.text = ''; s.mapping = null; s.check = null; s.done = null; App.render(); });
  App.act('imp-validate', () => { const s = ist(); syncText(); const p = parseNow(s); if (p.err) { s.check = { errors: [{ row: 0, message: p.err }], records: [], count: 0 }; App.render(); return; }
    ensureMapping(s, p.rows); s.check = E.validateImport(s.target, p.rows, s.mapping); s.done = null; App.render(); });
  App.act('imp-run', () => { const s = ist(); const p = parseNow(s); if (p.err) return;
    const res = App.try(() => E.runImport(s.target, p.rows, s.mapping), (r) => `Imported ${r.count} ${E.IMPORT_TARGETS[r.target].label.toLowerCase()}.`);
    if (res) { s.done = res; s.text = ''; s.check = null; s.mapping = null; App.render(); } });
  const syncText = () => { const ta = document.getElementById('impText'); if (ta) ist().text = ta.value; };
  function ensureMapping(s, rows) {
    const sig = s.target + '|' + (rows[0] || []).join('\u0001');
    if (!s.mapping || s.headerSig !== sig) { s.mapping = rows.length ? E.autoMap(s.target, rows[0]) : null; s.headerSig = sig; }
  }
  const kindOf = { journals: 'je', suppliers: 'sup', customers: 'cust', items: 'item', employees: 'emp' };

  App.view('data-import', {
    title: 'Import data', group: 'Administration',
    render() {
      const s = ist(); const t = E.IMPORT_TARGETS[s.target]; const p = parseNow(s); if (!p.err) ensureMapping(s, p.rows);
      const headers = p.rows[0] || [];
      const head = App.head('Administration', 'Import data', 'Paste CSV or choose a .csv file, check the column mapping, validate every row, then import. Imports are all or nothing: one bad row and nothing is saved.');
      const tgt = `<div class="row">${App.field('Import', App.select('impTarget', Object.entries(E.IMPORT_TARGETS).map(([k, x]) => [k, x.label]), s.target))}${App.field('CSV file', '<input id="impFile" type="file" accept=".csv,text/csv,text/plain">', 'Or paste below')}</div>
        <p class="hint" style="margin:8px 0">Columns: ${t.fields.map((f) => `<span class="mono">${esc(f.key)}</span>${f.required ? '' : '<span class="muted">?</span>'}`).join(', ')}. <span class="muted">? = optional.</span>${s.target === 'journals' ? ' Rows sharing a journal_ref become one journal (source Import); each must balance and post to an open period. Over ' + fmt(E.JE_APPROVAL_LIMIT) + ' waits for approval.' : ''}</p>
        <div class="rb-bar" style="margin-bottom:10px"><span class="small muted">Template:</span><button type="button" class="btn sm" data-act="imp-tpl-copy">Copy template</button><button type="button" class="btn sm" data-act="imp-tpl-dl">Download template</button><button type="button" class="btn sm" data-act="imp-tpl-use">Paste template below</button></div>
        <label class="field"><span>CSV data</span><textarea id="impText" class="csv" rows="9" spellcheck="false" placeholder="${esc(t.fields.map((f) => f.key).join(','))}">${esc(s.text)}</textarea></label>
        <div class="rb-bar" style="margin-top:10px"><button type="button" class="btn primary" data-act="imp-validate">Validate</button><button type="button" class="btn" data-act="imp-clear">Clear</button>${p.err ? `<span class="small" style="color:var(--bad)">${esc(p.err)}</span>` : p.rows.length ? `<span class="small muted">${num(Math.max(0, p.rows.length - 1))} data rows, ${headers.length} columns</span>` : ''}</div>`;
      let map = '';
      if (headers.length && s.mapping) {
        const opts = [['-1', '(not mapped)'], ...headers.map((h, i) => [String(i), h || `Column ${i + 1}`])];
        map = card('Column mapping', `<div class="pad"><div class="row">${t.fields.map((f) => App.field(`${esc(f.label)}${f.required ? ' *' : ''}`, App.select('impMap_' + f.key, opts, String(s.mapping[f.key] ?? -1), `data-map="${f.key}"`))).join('')}</div><p class="hint" style="margin:8px 0 0">Matched automatically by header name. * = required.</p></div>`);
      }
      let out = '';
      if (s.done) {
        out = card('Imported', `<div class="pad"><div class="callout good">Imported ${num(s.done.count)} ${esc(t.label.toLowerCase())}: ${s.done.ids.map((id) => App.link(kindOf[s.done.target], id)).join(', ')}</div></div>`);
      } else if (s.check) {
        const c = s.check;
        if (c.errors.length) {
          out = card(`Validation: ${c.errors.length} problem${c.errors.length === 1 ? '' : 's'}`, `<div class="pad"><div class="callout warn" role="alert">Nothing can be imported until every row is valid. Fix the CSV and validate again.</div></div>`
            + App.table([{ h: 'Row', num: true, f: (e) => (e.row ? String(e.rows && e.rows.length > 1 ? e.rows.join(', ') : e.row) : '') }, { h: 'Problem', f: (e) => esc(e.message) }], c.errors, { key: 'imp:errors' }));
        } else {
          const prev = c.records.slice(0, 200);
          const cols = [{ h: 'Row', num: true, f: (r) => String(r.rowNo) }, ...t.fields.filter((f) => s.mapping[f.key] >= 0).map((f) => ({ h: esc(f.key), num: f.type === 'number', f: (r) => esc(r.values[f.key]) }))];
          const n = c.count; const what = s.target === 'journals' ? `journal${n === 1 ? '' : 's'} from ${c.records.length} lines` : t.label.toLowerCase();
          out = card(`Preview: ${num(n)} ${what}`, `<div class="pad"><div class="callout good">All ${c.records.length} rows are valid.</div></div>` + App.table(cols, prev, { key: 'imp:preview' })
            + `<div class="pad rb-bar">${App.btn(`Import ${num(n)} record${n === 1 ? '' : 's'}`, 'imp-run', {}, t.perm, 'primary')}</div>`);
        }
      }
      return head + `<div class="stack">${card('Source', `<div class="pad">${tgt}</div>`)}${map}${out}</div>`;
    },
    after(el) {
      const s = ist();
      el.querySelector('#impTarget')?.addEventListener('change', (ev) => { s.target = ev.target.value; s.mapping = null; s.check = null; s.done = null; syncText(); App.render(); });
      const ta = el.querySelector('#impText');
      ta?.addEventListener('input', () => { s.text = ta.value; s.check = null; });
      ta?.addEventListener('change', () => { s.text = ta.value; s.done = null; });
      el.querySelectorAll('[data-map]').forEach((x) => x.addEventListener('change', () => { s.mapping = { ...s.mapping, [x.dataset.map]: +x.value }; s.check = null; rerender(); }));
      el.querySelector('#impFile')?.addEventListener('change', (ev) => {
        const file = ev.target.files && ev.target.files[0]; if (!file) return;
        const rd = new FileReader();
        rd.onload = () => { s.text = String(rd.result || ''); s.mapping = null; s.check = null; s.done = null; App.render(); App.toast(`Loaded ${file.name}.`); };
        rd.onerror = () => App.toast(`Could not read ${file.name}.`, 'bad');
        rd.readAsText(file);
      });
      if (focusId) { const f = document.getElementById(focusId); focusId = null; if (f) f.focus(); }
    },
  });
})();
