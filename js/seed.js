/* Ledgerline Suite — seed.js
 * Builds Jul-26..Nov-26 history for Halden Instruments by calling the real engine
 * functions, so every subledger and the GL are consistent by construction.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;

  function rng(seed) { return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function seed() {
    const S = E.reset();
    const rand = rng(20261117);
    const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
    const at = (d) => { S._clock = d + 'T' + String(ri(8, 17)).padStart(2, '0') + ':' + String(ri(0, 59)).padStart(2, '0') + ':00Z'; S._date = d; };
    const asRole = (role, user, fn) => { const r = S.role, u = S.user; S.role = role; S.user = user; try { return fn(); } finally { S.role = r; S.user = u; } };

    [['1000', 'Cash, operating account', 'Asset'], ['1100', 'Accounts receivable', 'Asset'], ['1200', 'Inventory', 'Asset'],
     ['1500', 'Equipment', 'Asset'], ['1510', 'Accumulated depreciation', 'Asset'],
     ['2000', 'Accounts payable', 'Liability'], ['2100', 'Received not invoiced', 'Liability'], ['2200', 'Payroll liabilities', 'Liability'], ['2500', 'Term loan', 'Liability'],
     ['3000', 'Share capital', 'Equity'], ['3100', 'Retained earnings', 'Equity'],
     ['4000', 'Product revenue', 'Revenue'], ['4900', 'Other income', 'Revenue'],
     ['5000', 'Cost of goods sold', 'Expense'], ['5100', 'Purchase price variance', 'Expense'],
     ['6000', 'Salaries and wages', 'Expense'], ['6050', 'Employer payroll taxes', 'Expense'], ['6100', 'Rent', 'Expense'],
     ['6200', 'Utilities', 'Expense'], ['6300', 'Depreciation', 'Expense'], ['6400', 'Software and subscriptions', 'Expense'], ['6500', 'Travel', 'Expense'],
    ].forEach(([code, name, type]) => S.accounts.push({ code, name, type, active: true }));

    ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].forEach((p) => (S.periods[p] = 'Open'));

    S.departments = ['Executive', 'Finance', 'Operations', 'Sales', 'Engineering', 'People'];
    const items = [
      ['HX-100', 'Thermal probe', 'Each', 42, 149, 150, 520], ['HX-220', 'Pressure transducer', 'Each', 118, 420, 120, 380],
      ['HX-310', 'Ultrasonic flow meter', 'Each', 310, 1450, 80, 260], ['CB-010', 'Shielded sensor cable, 5 m', 'Each', 6.5, 29, 1000, 3200],
      ['PL-500', 'Eight-channel data logger', 'Each', 205, 980, 90, 300], ['KT-900', 'Field calibration kit', 'Kit', 74, 310, 60, 210],
    ];
    items.forEach(([sku, name, uom, cost, price, reorder, onHand]) => S.items.push({ sku, name, uom, price, reorder, onHand, avgCost: cost, lastCost: cost }));
    const openingInv = E.util.r2(S.items.reduce((a, i) => a + i.onHand * i.avgCost, 0));

    at('2026-07-01');
    const sups = [['Arden Precision Parts', 30, 'Dayton, OH'], ['Kestrel Electronics', 45, 'San Jose, CA'], ['Brightwire Cable Co.', 30, 'Erie, PA'], ['Valemont Instruments GmbH', 60, 'Stuttgart, DE']]
      .map(([name, terms, site]) => E.addSupplier({ name, terms, site }));
    const custs = [['Corran Biolabs', 30, 600000, 'Life sciences'], ['Meridian Water Authority', 45, 900000, 'Public utility'], ['Ostrava Foods', 30, 120000, 'Food processing'],
      ['Pinecrest University', 60, 300000, 'Education'], ['Solace Pharma', 30, 700000, 'Life sciences']]
      .map(([name, terms, creditLimit, segment]) => E.addCustomer({ name, terms, creditLimit, segment }));

    // Opening balances
    E.createJournal({ date: '2026-07-01', source: 'Opening', desc: 'Opening balances FY2027', lines: [
      { acct: '1000', dr: 1450000 }, { acct: '1200', dr: openingInv }, { acct: '1500', dr: 240000 }, { acct: '1510', cr: 48000 },
      { acct: '2500', cr: 150000 }, { acct: '3000', cr: 400000 }, { acct: '3100', cr: E.util.r2(1450000 + openingInv + 240000 - 48000 - 150000 - 400000) }] });

    // Workforce
    const H = (name, title, dept, mgr, salary, hireDate) => E.hireEmployee({ name, title, dept, managerId: mgr ? mgr.id : '', salary, hireDate });
    const ceo = H('Margit Halden', 'Chief Executive Officer', 'Executive', null, 240000, '2019-03-01');
    const cfo = H('Theo Okafor', 'Chief Financial Officer', 'Finance', ceo, 205000, '2020-01-13');
    const coo = H('Priya Raman', 'VP Operations', 'Operations', ceo, 182000, '2020-06-01');
    const vps = H('Jonas Weller', 'VP Sales', 'Sales', ceo, 176000, '2021-02-15');
    const cto = H('Lena Park', 'Head of Engineering', 'Engineering', ceo, 198000, '2020-09-08');
    const hrd = H('Rosa Medina', 'People Director', 'People', ceo, 142000, '2021-05-03');
    H('Avery Lin', 'Financial Controller', 'Finance', cfo, 138000, '2022-04-11');
    H('Sam Achebe', 'Payables Accountant', 'Finance', cfo, 78000, '2023-08-21');
    const buyer = H('Dana Whitfield', 'Senior Buyer', 'Operations', coo, 92000, '2022-01-10');
    H('Marco Bellini', 'Warehouse Lead', 'Operations', coo, 64000, '2021-11-29');
    H('Ines Duarte', 'Account Executive', 'Sales', vps, 98000, '2023-03-06');
    H('Kwame Asante', 'Account Executive', 'Sales', vps, 96000, '2024-02-19');
    H('Hana Sato', 'Firmware Engineer', 'Engineering', cto, 152000, '2022-07-18');
    H('Oliver Brandt', 'Hardware Engineer', 'Engineering', cto, 146000, '2023-10-02');
    H('Nadia Petrova', 'HR Generalist', 'People', hrd, 82000, '2024-06-10');

    const months = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
    const D = (p, d) => `${p}-${String(d).padStart(2, '0')}`;
    const buyPlan = [
      ['HX-100', 0], ['CB-010', 2], ['HX-220', 1], ['PL-500', 1], ['HX-310', 3], ['KT-900', 0],
    ];
    months.forEach((p, mi) => {
      const last = p === '2026-11';
      // ---------- procure to pay ----------
      for (let k = 0; k < 2; k++) {
        const [sku, sIdx] = buyPlan[(mi * 2 + k) % buyPlan.length];
        const it = E.item(sku); const qty = sku === 'CB-010' ? ri(2500, 4000) : ri(220, 380);
        const price = E.util.r2(it.lastCost * (0.97 + rand() * 0.06));
        at(D(p, 2 + k));
        const r = E.createReq({ date: D(p, 2 + k), requester: buyer.name, justification: 'Replenish to reorder point', lines: [{ sku, qty, price }] });
        if (r.status === 'Pending Approval') asRole('Controller', 'Avery Lin', () => E.approveReq(r.id));
        at(D(p, 3 + k));
        const o = E.createPO({ reqId: r.id, supplierId: sups[sIdx].id, date: D(p, 3 + k), lines: [{ sku, qty, price }] });
        if (last && k === 1) continue;                    // Nov: second PO still open on the dock
        at(D(p, 9 + k)); E.receivePO(o.id, D(p, 9 + k), [qty]);
        if (last) continue;                               // Nov: received, not invoiced yet (sits in 2100)
        at(D(p, 13 + k));
        const variance = p === '2026-10' && k === 0 ? 1.09 : 1;   // Oct: one invoice 9% over PO price -> hold
        const inv = E.enterAPInvoice({ poId: o.id, number: `${sups[sIdx].name.slice(0, 3).toUpperCase()}-${ri(40000, 89999)}`, date: D(p, 13 + k), lines: [{ line: 0, qty, price: E.util.r2(price * variance) }] });
        if (inv.status === 'Validated' && mi < 3) { at(D(p, 27)); E.payInvoices([inv.id], D(p, 27), 'ACH'); }
      }
      // ---------- order to cash ----------
      const nOrders = last ? 7 : 10;
      for (let k = 0; k < nOrders; k++) {
        const c = custs[(mi + k) % custs.length];
        if (c.name === 'Ostrava Foods' && mi > 2) continue;
        const lines = []; const picks = ri(1, 3);
        const pool = ['HX-100', 'HX-220', 'HX-310', 'CB-010', 'PL-500', 'KT-900'];
        for (let x = 0; x < picks; x++) { const sku = pool.splice(ri(0, pool.length - 1), 1)[0]; lines.push({ sku, qty: sku === 'CB-010' ? ri(200, 500) : ri(18, 50) }); }
        lines.forEach((l) => (l.qty = Math.min(l.qty, Math.floor(E.item(l.sku).onHand * 0.35))));
        if (!lines.some((l) => l.qty > 0)) continue;
        const day = 2 + k * 2; at(D(p, day));
        const o = E.createSO({ customerId: c.id, date: D(p, day), lines, poNumber: `PO${ri(10000, 99999)}` });
        if (o.status === 'Credit Hold') asRole('Controller', 'Avery Lin', () => E.releaseCreditHold(o.id));
        if (last && k === nOrders - 1) continue;          // Nov: one order booked, awaiting shipment
        at(D(p, day + 2)); const inv = E.shipSO(o.id, D(p, day + 2));
        // collections: older invoices paid, recent ones open, one partial
        const ageMonths = months.length - 1 - mi;
        if (ageMonths >= 2 || (ageMonths === 1 && k < 2)) {
          if (c.name === 'Ostrava Foods' && mi === 2) continue; // Ostrava lets a Sep invoice go overdue
          const pd = E.util.addDays(inv.date, Math.min(c.terms, 28));
          if (E.util.periodOf(pd) > '2026-11' || pd > E.TODAY) continue;
          at(pd); E.applyReceipt({ invoiceId: inv.id, date: pd, amount: ageMonths === 1 && k === 1 ? E.util.r2(inv.total / 2) : inv.total, reference: `WIRE${ri(100000, 999999)}` });
        }
      }
      // ---------- recurring expenses ----------
      at(D(p, 1)); E.createJournal({ date: D(p, 1), source: 'Payables', desc: `Rent, Fenwick Park unit 4 (${E.util.periodLabel(p)})`, lines: [{ acct: '6100', dr: 14500 }, { acct: '1000', cr: 14500 }] });
      if (!last) {
        at(D(p, 20)); const u = E.util.r2(2100 + rand() * 900); E.createJournal({ date: D(p, 20), source: 'Payables', desc: 'Electricity and water', lines: [{ acct: '6200', dr: u }, { acct: '1000', cr: u }] });
        at(D(p, 6)); E.createJournal({ date: D(p, 6), source: 'Payables', desc: 'ERP, CAD and design software licences', lines: [{ acct: '6400', dr: 4850 }, { acct: '1000', cr: 4850 }] });
        // remit last month's payroll liabilities
        const liab = -E.balance('2200'); if (liab > 0) { at(D(p, 15)); E.createJournal({ date: D(p, 15), source: 'Payroll', desc: 'Remit payroll taxes to tax authority', lines: [{ acct: '2200', dr: liab }, { acct: '1000', cr: liab }] }); }
        at(E.util.periodEnd(p)); E.runPayroll(p);
        E.runDepreciation(p);
        at(D(p, 25)); const t = E.util.r2(1800 + rand() * 2600); E.createJournal({ date: D(p, 25), source: 'Payables', desc: 'Sales travel, customer site visits', lines: [{ acct: '6500', dr: t }, { acct: '1000', cr: t }] });
      }
    });

    // ---------- live demo state for "today" (Nov 17) ----------
    at('2026-11-12');
    E.createReq({ date: '2026-11-12', requester: buyer.name, justification: 'Pinecrest lab build-out, Q1 delivery', lines: [{ sku: 'HX-310', qty: 40, price: 308 }, { sku: 'PL-500', qty: 20, price: 204 }] }); // > $10k, pending
    at('2026-11-14');
    E.createReq({ date: '2026-11-14', requester: 'Marco Bellini', justification: 'Cable stock for Meridian rollout', lines: [{ sku: 'CB-010', qty: 400 }] }); // auto-approved, not ordered
    at('2026-11-16');
    E.createSO({ customerId: custs[2].id, date: '2026-11-16', poNumber: 'OF-7713', lines: [{ sku: 'PL-500', qty: 120 }, { sku: 'HX-100', qty: 300 }] }); // Ostrava: credit hold
    at('2026-11-16');
    asRole('Controller', 'Sam Achebe', () => E.createManualJournal({ date: '2026-11-16', desc: 'Accrue FY27 H1 bonus pool (50%)', lines: [{ acct: '6000', dr: 62000 }, { acct: '2200', cr: 62000 }] }));
    at('2026-11-17');
    E.requestAbsence({ empId: S.employees.find((e) => e.name === 'Hana Sato').id, type: 'Vacation', start: '2026-12-21', end: '2026-12-31', note: 'Year-end travel' });
    E.requestAbsence({ empId: S.employees.find((e) => e.name === 'Kwame Asante').id, type: 'Sick', start: '2026-11-17', end: '2026-11-18', note: '' });

    // Close Jul-Sep
    at('2026-10-08'); asRole('Controller', 'Avery Lin', () => { E.closePeriod('2026-07'); E.closePeriod('2026-08'); E.closePeriod('2026-09'); });
    delete S._clock; delete S._date;
    S.role = 'Administrator'; S.user = 'Avery Lin';
    return S;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = seed; else root.seedDemo = seed;
})(typeof window !== 'undefined' ? window : globalThis);
