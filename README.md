# Ledgerline Suite

An original, browser-only ERP suite built to explore how far a single coding session can take an
enterprise system. It covers the core of what large cloud ERP suites do (financials, procurement,
supply chain, order management, HR and payroll) on **one shared data model and one general ledger**.
Every operational event posts balanced double-entry journals, and the subledgers always reconcile
to their GL control accounts.

It is not a copy of any vendor's product: the name, design and code are original.

## Run it
No build step and no dependencies.

```bash
python3 -m http.server 8000
```
Then open http://localhost:8000. A hosted copy (private to the owner) is at https://claude.ai/artifact/Qhi6dYcipUkiKJZKoeHHsV. You can also open `index.html` directly. Data lives in your browser's
localStorage; **Reset demo** in the top bar restores the sample company.

Tests (Node 18+):
```bash
node --test tests/
```

## Modules
| Area | What works |
|---|---|
| General ledger | Chart of accounts, manual journals with approval over $50k and segregation of duties, reversals, auto-reversing accruals, recurring journals, period open/close in order with a close checklist |
| Reports | Trial balance, income statement (period and FYTD), balance sheet, subledger-to-GL reconciliation, sales tax liability |
| Payables | PO invoices with three-way match (5% price tolerance) and holds, direct invoices, supplier credit memos, payments with cash check, EUR suppliers with realized FX gain/loss |
| Receivables | Auto-invoicing on shipment with sales tax, manual invoices, credit memos with return to stock, receipts, aging, credit limits, GBP customers |
| Cash management | Bank statements, auto and manual matching, accounting for bank-only items, reconciliation report, 13-week cash forecast |
| Fixed assets | Asset register by category, straight-line depreciation per asset, additions with approval over $25k, disposals with gain/loss, transfers, roll-forward |
| Budgets and forecasts | Locked budget and editable forecast by account and month, entry grid, budget vs actual with favourable/unfavourable variance, full-year outlook |
| Purchasing | Requisitions with approval over $10k, purchase orders limited to the approved requisition, receiving at weighted average cost |
| Inventory | On hand, average cost, reorder points, movements, adjustments, ABC cycle counting |
| Manufacturing | Bills of material with cost roll-up, work orders with WIP accounting, labor/overhead absorption, production variance |
| Supply planning | Net requirements from demand, supply and reorder points; creates requisitions and work orders |
| Sales | Leads, opportunities by stage, pipeline board and weighted forecast, quotes with discount approval, quote to sales order, credit check and credit hold, shipping with COGS relief |
| Projects | Time and materials, fixed price and internal projects, budgets, timesheets with labor cost, expense reports with policy checks and reimbursement, project billing, project P&L |
| Workforce and payroll | Directory, org chart, hire and terminate, absence with balances, monthly payroll with taxes, payslips, tax remittance |
| Talent | Job requisitions, candidate pipeline, offers with approval, goals and mid-year reviews, calibration, salary changes and merit planning that feed payroll |
| Platform | One approvals inbox for every module, 6 roles, audit trail, Ctrl+K search across pages and records, sortable and paged tables, drill-down from any number to its source document and journal |

## How the pieces connect
```
Requisition ─approve─▶ PO ─receive─▶ Inventory ↑   (Dr Inventory / Cr Received-not-invoiced)
                                │
                     Supplier invoice ─3-way match─▶ AP   (Dr RNI, ±PPV / Cr AP)
                                │
                             Payment                    (Dr AP / Cr Cash)

Sales order ─credit check─▶ Ship ─▶ Inventory ↓        (Dr COGS / Cr Inventory)
                                └─▶ AR invoice          (Dr AR / Cr Revenue)
                                        └─ Receipt      (Dr Cash / Cr AR)

Employees ─▶ Payroll run                                (Dr Wages, Dr Employer tax / Cr Cash, Cr Payroll liabilities)
```

## Code layout
See [PLAN.md](PLAN.md) for the architecture, the invariants the tests enforce and the engine API.
[PROGRESS.md](PROGRESS.md) tracks status so work can resume in a new session.
