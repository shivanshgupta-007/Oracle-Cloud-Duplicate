# Ledgerline Suite: build plan and contract

> **Read this first if you are resuming.** Then read `PROGRESS.md` for what is done
> and what is next. These two files are the durable memory of the project.

## Goal
An original, fully working, browser-only ERP suite modelled on the *scope and
architecture* of large cloud ERP suites (financials, procurement, supply chain,
order management, HCM, payroll), with every module posting to one shared general
ledger. Original name, branding and UI: no vendor trademarks or trade dress.

Fictional company: **Halden Instruments Ltd.**, a maker of lab sensors. Fiscal year
FY2027 runs Jul-2026 to Jun-2027. "Today" is pinned to `2026-11-17` so the seeded
demo state is deterministic.

## Architecture (no build step, plain ES2020, no framework)
```
index.html          shell: <title>, CSS tokens, layout, loads scripts in order
js/engine.js        STATE + business rules. No DOM. Runs in Node too (tests).
js/seed.js          builds 5 months of consistent history by CALLING engine functions
js/ui.js            helpers: h(), esc(), fmt(), table(), drawer, toast, router, actions
js/views-home.js    Home dashboard, Approvals inbox, Audit trail, global search
js/views-fin.js     Journals, Chart of accounts, Reports (TB/IS/BS), Periods, Payables, Receivables
js/views-scm.js     Purchasing (requisitions, POs, receiving), Inventory, Sales orders
js/views-hcm.js     Workforce (directory, org chart), Absence, Payroll
tests/engine.test.js  node tests: integrity invariants across modules
```
Script load order: engine → seed → ui → views-* → `App.start()` (in ui.js).

## Core invariants (tests must enforce)
1. Every journal balances (Σdr = Σcr) and posts only into an **Open** period.
2. Trial balance always nets to zero; Assets = Liabilities + Equity (+ current earnings).
3. Subledgers reconcile to GL control accounts:
   - Σ open AP invoices (validated, unpaid) = GL 2000
   - Σ open AR invoices = GL 1100
   - Σ item onHand × avgCost = GL 1200 (to the cent, tolerance 0.05)
   - Σ PO received-not-invoiced at PO price = GL 2100
4. Any action that throws leaves state untouched (UI wraps actions in snapshot/restore).

## Cross-module flows (the point of the product)
| Event | Subledger effect | GL entry |
|---|---|---|
| Requisition > $10k | needs approval (Controller) | none |
| PO receipt | onHand +, weighted avg cost | Dr 1200 Inventory / Cr 2100 Received-not-invoiced |
| AP invoice validated (3-way match, 5% price tol.) | PO line invoiced + | Dr 2100 @PO price, Dr/Cr 5100 PPV, Cr 2000 AP |
| AP invoice fails match | status On Hold with hold reasons | none until released |
| Supplier payment | invoice Paid | Dr 2000 / Cr 1000 (blocked if cash short) |
| Sales order booked | credit check vs limit → Credit Hold | none |
| Ship order | onHand −, auto AR invoice | Dr 5000 COGS / Cr 1200; Dr 1100 / Cr 4000 |
| Customer receipt | AR paid | Dr 1000 / Cr 1100 |
| Payroll run (monthly) | per-employee payslips | Dr 6000 gross, Dr 6050 employer tax, Cr 1000 net, Cr 2200 liabilities |
| Depreciation (monthly) | — | Dr 6300 / Cr 1510 |
| Manual journal > $50k | Pending Approval | posts on approval |
| Period close | blocks if pending journals in period | — |

## Engine API (window.Engine / module.exports) — the contract for views
State lives in `Engine.S` (plain JSON). Lookups: `item(sku) sup(id) cust(id) emp(id) acct(code) je(id)`.
Read: `balance(code,{toPeriod,fromPeriod})`, `balances(opts)`, `natural(code,v)`,
`trialBalance(toPeriod)`, `incomeStatement(fromP,toP)`, `balanceSheet(toP)`,
`arAging()`, `openAR(custId)`, `approvalsInbox()`, `closeChecklist(period)`,
`reconcile()`, `periods()`.
Write (throw `Error` with a user-readable message on rule violation):
`createJournal, approveJournal, rejectJournal, runDepreciation, closePeriod, reopenPeriod, openPeriod, addAccount,
createReq, approveReq, rejectReq, createPO, receivePO,
enterAPInvoice, releaseHold, cancelAPInvoice, payInvoices, addSupplier,
createSO, releaseCreditHold, cancelSO, shipSO, applyReceipt, addCustomer,
addItem, adjustInventory,
hireEmployee, terminateEmployee, requestAbsence, approveAbsence, rejectAbsence, runPayroll`.
Security: `Engine.ROLES`, `Engine.can(role, perm)`.
Audit: every write calls `log(action, ref)` → `S.audit`.

See the JSDoc at the top of each function in `js/engine.js` for exact arguments.

## UI conventions (ui.js)
- Views register: `App.view('journals', {title, group, render(){ return html }})`.
- Actions are delegated: `<button data-act="name" data-id="X">`; register with
  `App.act('name', (ds, el) => {...})`. Mutations go through `App.run(fn, okMsg)` which
  snapshots state, runs fn, saves to localStorage, re-renders, toasts; on throw restores.
- Drawers: `App.drawer(title, html, {submitLabel, onSubmit(form) })`.
- Permission-gated buttons: `App.btn(label, act, data, perm, cls)`.
- Doc links: `App.link(kind, id)` → opens detail drawer (`je`, `po`, `emp`, `acct`, `apinv`, `arinv`, `so`, `item`, `payrun`).
- Colors only via CSS tokens in index.html; numbers use `.num` (tabular, mono).

## Extending the engine (phase 2 modules)
Each module is three files that only its owner edits: `js/ext-<m>.js` (rules, no DOM),
`js/views-<m>.js` (screens), `tests/<m>.test.js`. Load order is `js/extensions.json`
(Node, via `js/load-node.js`) and the matching `<script>` tags in index.html.

ext file skeleton:
```js
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { r2, sum, money, periodOf, periodLabel, addDays } = E.util;
  E.on('state', (S) => { S.assets = S.assets || []; });           // idempotent: fill missing keys only
  E.on('seedSetup', (ctx) => { E.ensureAccount('1520', 'Vehicles', 'Asset'); });
  E.on('seedMonthly', (p, ctx) => { /* history for month p, dated within p */ });
  E.on('seedFinal', (ctx) => { /* live demo state for 2026-11-17 */ });
  E.on('reconcile', (b) => [{ name: 'Fixed assets', acct: '1500', sub: X, gl: b['1500'] }]); // b = dr-cr balances
  E.on('approvals', () => [{ kind, id, title, who, date, perm, why }]);
  E.on('checklist', (p) => [{ task, done, detail, advisory }]);
  E.on('search', (q, hit) => [{ kind, id, label, sub }]);
  E.addPerms('Controller', ['fa.edit']);
  E.extend({ addAsset, ... });                                     // call as E.addAsset from anywhere
})(typeof window !== 'undefined' ? window : globalThis);
```
Rules: every GL effect goes through `E.createJournal` (or `E.createAPInvoice` / `E.createARInvoice`
for non-PO payables and non-order receivables). Validate first and mutate after, so a throw leaves state
unchanged. Everything posted in seed hooks must land in Jul–Nov 2026, never leave a Pending journal in
Jul–Sep (they get closed), and keep `S._clock` via `ctx.at(date)` before writes so the audit trail is dated.
If you change a journal's lines or status directly, call `E.touch()` (ledger cache).

views file: `App.view('assets', { title, group: 'Financials', render, after })` (group places it in the nav),
`App.detail('asset', id => ({title, html, buttons}))`, `App.refKind('FA-', 'asset')`, `App.navCount(view, fn)`.
