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
- [ ] Publish as artifact; push

## Known decisions
- Today pinned to 2026-11-17 (deterministic demo). Fiscal year starts Jul-26.
- State is per-browser (localStorage key `ledgerline-suite-v1`); "Reset demo" reseeds.
- No vendor branding: original name "Ledgerline", fictional company "Halden Instruments Ltd."
