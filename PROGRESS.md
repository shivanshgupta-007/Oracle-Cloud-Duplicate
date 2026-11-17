# Progress log (update after every milestone)

Resume procedure for a fresh session: read PLAN.md, then this file, then `git log --oneline`.
Run `node --test tests/` and open index.html (or serve with `python3 -m http.server`) to see current state.

## Done
- [x] PLAN.md: architecture, invariants, engine API contract
- [x] js/engine.js: GL, periods, P2P (req→PO→receipt→AP 3-way match→payment), O2C (SO credit check→ship→AR→receipt), inventory avg cost, HCM, absence, payroll, depreciation, approvals, reconciliation, search, roles (+ role→user map for segregation of duties)
- [x] js/seed.js: Jul–Nov 2026 history (~177 journals); all 4 control accounts reconcile; TB and BS balance
- [x] index.html + js/ui.js: shell, router, drawers, toasts, tables, line editors, atomic App.run with rollback, localStorage persistence, global search, every drill-down detail panel, shared transaction forms (receive, AP invoice, pay, ship, receipt, adjust, absence, terminate)

## Built by parallel agents (one file each), integrated and QA-checked
- [x] js/views-fin.js — journals, accounts, reports (TB/IS/BS/recon), periods + close checklist, payables, receivables
- [x] js/views-scm.js — purchasing (reqs, POs), inventory, sales orders
- [x] js/views-home.js + js/views-hcm.js — home dashboard + chart, approvals, audit, security matrix; workforce/org chart, absence, payroll
- [x] tests/engine.test.js — invariants, rule tests, 300-op fuzz test

## Next
- [x] Integrate agent output, fix reported engine bugs, full browser QA pass (desktop + 400px, light + dark)
- [x] Published: https://claude.ai/artifact/Qhi6dYcipUkiKJZKoeHHsV (republish index.html + js/* with the same path to update)

## Known decisions
- Today pinned to 2026-11-17 (deterministic demo). Fiscal year starts Jul-26.
- State is per-browser (localStorage key `ledgerline-suite-v1`); "Reset demo" reseeds.
- No vendor branding: original name "Ledgerline", fictional company "Halden Instruments Ltd."

## Phase 2 / core finance
- [x] Sales tax: `S.taxCodes` (MA 6.25%, NY 8.875%, NJ 6.625%, EXEMPT, EU-EXPORT), customer `taxCode`; shipSO posts Dr 1100 gross / Cr 4000 net / Cr 2300 tax; invoices store `net/tax/total`; credit exposure counts tax (`E.soGross`). `salesTaxReport()`, `remitSalesTax({period,date})` (Dr 2300 / Cr 1000, once per period, after it ends). Seed remits Jul-Oct; Nov tax sits in 2300. Reports > Sales tax tab.
- [x] Credit memos (`S.creditMemos`, ARCM-/APCM-): `createARCreditMemo` (optional return to stock at original unit cost, Dr 1200 / Cr 5000) and `createAPCreditMemo` (Cr 5100 for PO invoices, original accounts pro rata for direct ones). Invoices carry `credited`; open balance = `E.openAmt(inv)` = total - paid - credited. Fully credited status `Credited`.
- [x] Journals: `reverseJournal(id,date)` (once, linked both ways, subledger journals touching control accounts refused), accruals `createManualJournal({..., autoReverse:true})` reverse on day 1 of next period (now or on openPeriod/approval), recurring templates `S.recurring` (`createRecurring`, `recurringFromJournal`, `generateRecurring`, perm `gl.recurring`). Seed: rent and licences are templates linked to history; Sep/Oct accruals auto-reversed; Nov accrual waits for Dec.
- [x] Multi-currency: USD functional, EUR, GBP; `S.fxRates[period][ccy]` month averages. Direct AP and manual AR invoices take `currency` (default USD, NOT the partner's currency), store `fxTotal`/`rate`, book USD; payments/receipts at payment-date rate with realized FX to 7100. Valemont = EUR, Harrow Analytical Ltd = GBP / EU-EXPORT. PO and SO flows stay USD.
- [x] UI: Enter direct invoice, AP/AR credit memo drawers, New receivables invoice, Credit memo tabs, Reverse / Make recurring in journal detail, Accrual checkbox, Journals > Recurring tab, generic approvals for extension kinds (`App.hasAct`).
- [x] Tests: tax, memos (return to stock), reversal, accruals, recurring idempotency, FX AP/AR by hand; fuzz extended with these ops. Full suite 179/179; Playwright sweep (31 views, 80 view/tab states at 1366 and 400 px) clean, every new flow driven through the UI with reconcile ok and TB balanced.
- State version is now 2 (`E.STATE_VERSION`); older saved browser state is reseeded.

## Phase 2 status (all modules integrated)
- [x] Platform: extension hooks, memoized ledger, generic AP/AR invoices, module loader, dynamic nav
- [x] Modules: cash, fixed assets, projects/time/expenses, budgets, CRM, manufacturing/supply planning/cycle counts, talent, core finance (tax, memos, reversals, recurring, FX)
- [x] Research (docs/RESEARCH.md) applied: contrast, labels, modal drawer (inert), sortable + paged tables, collapsible nav, Ctrl+K page search, action-column headers
- [x] 179 tests green; 31 views clean at 1366px and 400px, light and dark
- Remaining research backlog (P2/P3 in docs/RESEARCH.md): density toggle, favorites/recent in nav, tab arrow-key navigation, non-blocking font load, saved table views

## Phase 3 / entities
- [x] Legal entities `S.entities`: US01 Halden Instruments Inc. (default) and US02 Halden Field Services LLC (USD functional, no translation). Journal lines take optional `entity`, `dept`, and for intercompany `ic: true` + `partner`; lines without them keep their old shape (missing entity = US01, missing dept = Unassigned). `createJournal` rejects a journal that is out of balance in any entity; lines on 1800/2800 must come through intercompany.
- [x] Ledger: `balances({fromPeriod,toPeriod,entity,dept,partner,ic})` (all in the cache key); `trialBalance(toP,{entity})`, `incomeStatement(fromP,toP,{entity,dept})`, `balanceSheet(toP,{entity})`. Without an entity, IS/BS are consolidated (ic lines eliminated); TB stays raw. `reverseJournal` keeps line dimensions.
- [x] Intercompany: accounts 1800/1850/2800/4950/6850 (`ic` accounts, left out of plans). `createIntercompany({date,fromEntity,toEntity,amount,desc,fromAcct,toAcct,fromDept,toDept})` (recharge P&L/P&L eliminated; cash paid on behalf keeps the cost in the charged entity), `settleIntercompany({date,payer,payee,amount?})`, `icBalances(a,b)`, `S.intercompany`. Reconcile adds one row per entity pair (acct 1800, `ic: true`).
- [x] Consolidation `consolidation(toP,{fromPeriod})` (columns US01 | US02 | elim | cons, cons = sum + elim on every line) and `deptPL(fromP,toP,{entity})`. Payroll posts 6000/6050 per department.
- [x] Seed: US02 capitalised by US01 on 1 Jul (1850 vs 3000, eliminated), with monthly contractors and fuel paid by US01 on its behalf, US02 field-service recharges to US01, a US01 support fee, and cash settlements Jul–Oct (Nov left open). Software lines are tagged Engineering and travel lines Sales. STATE_VERSION 3.
- [x] Plans: department layer `S.deptBudgets[ver][dept][acct][period]`, split by salary share (6000/6050) or headcount (other opex), with purchases (1200) going to Operations. `budgetVsActual(p, ver, {dept})`, `deptBudgetSummary`, `setDeptBudgetCell`. Budgetary control: wrapped `E.createReq` sets an advisory `req.budgetWarning` that shows in Approvals `why` and on the requisition.
- [x] UI: entity selector in the top bar (`App.ui.entity`, `App.entity()`) drives Home KPIs and the Reports default. Reports gets an entity filter plus Consolidation and By department tabs. Journals gets entity and department filters, an Intercompany tab and drawer (settle in cash), and entity and department columns in the line editor with a per-entity balance hint. Budgets gets a department filter and a department budget card.
- [x] Tests: per-entity enforcement, IC elimination exactness, entity BS balance, dept P&L ties, payroll split, cache isolation, budget warnings; fuzz has IC ops and per-entity/consolidation checks.
