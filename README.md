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
Then open http://localhost:8000. You can also open `index.html` directly. Data lives in your browser's
localStorage; **Reset demo** in the top bar restores the sample company.

Tests (Node 18+):
```bash
node --test tests/
```

## Modules
| Area | What works |
|---|---|
| General ledger | Chart of accounts, manual journals with approval over $50k, segregation of duties, account drill-down, depreciation, period open/close in order with a close checklist |
| Reports | Trial balance, income statement (period and FYTD), balance sheet, subledger-to-GL reconciliation |
| Payables | Supplier invoices with three-way match (PO, receipt, invoice; 5% price tolerance), holds and release, purchase price variance, payments with cash check |
| Receivables | Auto-invoicing on shipment, receipts and partial payments, aging buckets, credit limits |
| Purchasing | Requisitions with approval over $10k, purchase orders, receiving at weighted average cost |
| Inventory | On hand, average cost, reorder points, movement history, adjustments |
| Order management | Sales orders with credit check and credit hold, shipping with COGS relief |
| Workforce | Directory, org chart, departments, hire and terminate (reports move up) |
| Absence | Requests, overlap and balance checks, manager approval |
| Payroll | Monthly runs with withholding and employer taxes, payslips, tax remittance |
| Platform | Approvals inbox, role-based access (6 roles), audit trail, global search, drill-down from any number to its source document and journal |

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
