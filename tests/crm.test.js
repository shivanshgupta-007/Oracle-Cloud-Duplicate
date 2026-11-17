// Sales pipeline / CRM: leads, opportunities, quotes with discount approval, quote -> sales order.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E, seed } = require('../js/load-node.js');

const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const rep = () => E.salesReps().find((e) => e.name === 'Ines Duarte') || E.salesReps()[0];
const as = (role, user, fn) => { const r = E.S.role, u = E.S.user; E.S.role = role; E.S.user = user; try { return fn(); } finally { E.S.role = r; E.S.user = u; } };
const healthy = () => { assert.ok(E.reconcile().every((r) => r.ok), JSON.stringify(E.reconcile().filter((r) => !r.ok))); const tb = E.trialBalance(); assert.ok(near(tb.dr, tb.cr), `TB ${tb.dr} vs ${tb.cr}`); };
const openOpp = (custName = 'Pinecrest University') => E.createOpp({ customerId: E.S.customers.find((c) => c.name === custName).id, name: 'Test deal', amount: 10000, closeDate: '2026-12-31', ownerId: rep().id, date: '2026-11-17' });

beforeEach(() => { seed(); });

describe('seed', () => {
  test('leads, opportunities across stages, quotes and activities exist and are consistent', () => {
    assert.ok(E.S.leads.length >= 8); assert.ok(E.S.opps.length >= 12); assert.equal(E.S.quotes.length, 2); assert.ok(E.S.activities.length >= 5);
    const stages = new Set(E.S.opps.map((o) => o.stage));
    ['Qualify', 'Develop', 'Propose', 'Negotiate', 'Won', 'Lost'].forEach((s) => assert.ok(stages.has(s), s));
    E.S.opps.forEach((o) => { assert.equal(E.emp(o.ownerId).dept, 'Sales'); assert.ok(E.cust(o.customerId)); assert.equal(o.history[o.history.length - 1].stage, o.stage); });
    E.S.opps.filter((o) => o.stage === 'Won').forEach((o) => assert.ok(E.so(o.soId), `${o.id} linked to an order`));
    const pend = E.S.quotes.find((q) => q.status === 'Pending Approval');
    assert.equal(pend.date, '2026-11-15'); assert.ok(pend.maxDiscount > E.QUOTE_DISCOUNT_LIMIT);
    assert.ok(E.approvalsInbox().some((i) => i.kind === 'quote' && i.id === pend.id && i.perm === 'crm.discount'));
    healthy();
  });
  test('permissions', () => {
    assert.ok(E.can('Order Manager', 'crm.edit')); assert.ok(E.can('Controller', 'crm.discount')); assert.ok(E.can('Administrator', 'crm.edit'));
    assert.ok(!E.can('Order Manager', 'crm.discount')); assert.ok(!E.can('Buyer', 'crm.edit')); assert.ok(!E.can('Controller', 'crm.edit'));
  });
  test('search finds leads, opportunities and quotes', () => {
    assert.ok(E.search('Northgate').some((r) => r.kind === 'lead'));
    assert.ok(E.search('metering').some((r) => r.kind === 'opp'));
    assert.ok(E.search('QT-1002').some((r) => r.kind === 'quote'));
  });
});

describe('leads', () => {
  test('conversion creates the customer once, with default credit terms', () => {
    const n = E.S.customers.length;
    const a = E.createLead({ name: 'Ana Silva', company: 'Lisbon Marine Lab', source: 'Web', ownerId: rep().id, date: '2026-11-17' });
    const b = E.createLead({ name: 'Rui Costa', company: 'lisbon marine lab', source: 'Referral', ownerId: rep().id, date: '2026-11-17' });
    const r1 = E.convertLead(a.id, { amount: 12000, closeDate: '2027-01-15', date: '2026-11-17' });
    assert.equal(r1.createdCustomer, true); assert.equal(E.S.customers.length, n + 1);
    assert.equal(r1.customer.creditLimit, 50000); assert.equal(r1.customer.terms, 30);
    assert.equal(r1.opp.stage, 'Qualify'); assert.equal(r1.opp.customerId, r1.customer.id); assert.equal(E.lead(a.id).oppId, r1.opp.id);
    const r2 = E.convertLead(b.id, { amount: 5000, closeDate: '2027-01-15', date: '2026-11-17' });
    assert.equal(r2.createdCustomer, false); assert.equal(r2.customer.id, r1.customer.id); assert.equal(E.S.customers.length, n + 1);
    assert.throws(() => E.convertLead(a.id, {}), /already converted/);
    assert.equal(E.S.customers.length, n + 1);
  });
  test('existing customer is reused; disqualified leads cannot convert; validation leaves state untouched', () => {
    const n = E.S.customers.length;
    const l = E.createLead({ name: 'X', company: 'Corran Biolabs', source: 'Outbound', ownerId: rep().id });
    assert.equal(E.convertLead(l.id, { amount: 1 }).createdCustomer, false); assert.equal(E.S.customers.length, n);
    const d = E.createLead({ name: 'Y', company: 'Nowhere Inc', source: 'Web', ownerId: rep().id });
    assert.throws(() => E.setLeadStatus(d.id, 'Disqualified'), /reason/);
    E.setLeadStatus(d.id, 'Disqualified', 'No budget');
    assert.throws(() => E.convertLead(d.id, {}), /disqualified/);
    assert.throws(() => E.createLead({ name: 'Z', company: 'Q', source: 'Fax', ownerId: rep().id }), /Source/);
    const cfo = E.S.employees.find((e) => e.dept === 'Finance');
    assert.throws(() => E.createLead({ name: 'Z', company: 'Q', source: 'Web', ownerId: cfo.id }), /Sales/);
    const w = E.createLead({ name: 'W', company: 'Brand New Co', source: 'Web', ownerId: rep().id });
    assert.throws(() => E.convertLead(w.id, { amount: 'lots' }), /number/);
    assert.ok(!E.S.customers.some((c) => c.name === 'Brand New Co'), 'failed conversion did not create a customer');
  });
});

describe('opportunities', () => {
  test('stage probabilities and weighted pipeline', () => {
    assert.deepEqual(E.CRM_PROB, { Qualify: 0.1, Develop: 0.3, Propose: 0.5, Negotiate: 0.75, Won: 1, Lost: 0 });
    const o = openOpp();
    assert.equal(E.oppWeighted(o), 1000);
    E.advanceOpp(o.id); assert.equal(o.stage, 'Develop'); assert.equal(E.oppWeighted(o), 3000);
    E.advanceOpp(o.id); E.advanceOpp(o.id); assert.equal(o.stage, 'Negotiate'); assert.equal(E.oppWeighted(o), 7500);
    assert.throws(() => E.advanceOpp(o.id), /Accept a quote/);
    assert.throws(() => E.setOppStage(o.id, 'Won'), /Accept a quote/);
    assert.deepEqual(o.history.map((h) => h.stage), ['Qualify', 'Develop', 'Propose', 'Negotiate']);
    const s = E.pipelineSummary();
    assert.ok(near(s.weighted, E.S.opps.filter((x) => E.CRM_OPEN_STAGES.includes(x.stage)).reduce((a, x) => a + x.amount * E.CRM_PROB[x.stage], 0)));
    assert.ok(near(s.winRate, s.wonCount / (s.wonCount + s.lostCount)));
    assert.ok(near(E.forecastByMonth().reduce((a, r) => a + r.weighted, 0), s.weighted));
  });
  test('lost needs a reason and closes the opportunity', () => {
    const o = openOpp();
    assert.throws(() => E.setOppStage(o.id, 'Lost'), /reason/);
    E.setOppStage(o.id, 'Lost', { reason: 'Budget cut' });
    assert.throws(() => E.advanceOpp(o.id), /already Lost/);
    assert.throws(() => E.createQuote({ oppId: o.id, lines: [{ sku: 'HX-100', qty: 1 }] }), /Lost/);
  });
});

describe('quotes', () => {
  test('list price less line discount; discount over 15% needs approval', () => {
    const o = openOpp();
    const q = E.createQuote({ oppId: o.id, date: '2026-11-17', lines: [{ sku: 'HX-220', qty: 10, discountPct: 15 }] });
    assert.equal(q.status, 'Draft'); assert.equal(q.lines[0].price, E.util.r2(420 * 0.85)); assert.equal(q.total, E.util.r2(10 * 420 * 0.85));
    assert.equal(o.amount, q.total);
    const q2 = E.createQuote({ oppId: o.id, date: '2026-11-17', lines: [{ sku: 'HX-220', qty: 10, discountPct: 5 }, { sku: 'HX-100', qty: 4, discountPct: 15.5 }] });
    assert.equal(q2.status, 'Pending Approval');
    assert.throws(() => E.sendQuote(q2.id), /cannot be sent/);
    assert.throws(() => E.acceptQuote(q2.id), /waiting for discount approval/);
    as('Controller', 'Avery Lin', () => E.approveQuote(q2.id));
    assert.equal(q2.status, 'Approved'); assert.equal(q2.approvedBy, 'Avery Lin');
    assert.ok(!E.approvalsInbox().some((i) => i.id === q2.id));
  });
  test('creator cannot approve their own discount; rejection blocks sending', () => {
    const o = openOpp();
    const q = as('Order Manager', 'Ines Duarte', () => E.createQuote({ oppId: o.id, lines: [{ sku: 'KT-900', qty: 5, discountPct: 30 }] }));
    assert.throws(() => as('Controller', 'Ines Duarte', () => E.approveQuote(q.id)), /segregation/);
    as('Controller', 'Avery Lin', () => E.rejectQuote(q.id, 'Too deep'));
    assert.equal(q.status, 'Draft');
    assert.throws(() => E.sendQuote(q.id), /not approved/);
    assert.throws(() => E.acceptQuote(q.id), /not approved/);
  });
  test('quote validation', () => {
    const o = openOpp();
    assert.throws(() => E.createQuote({ oppId: o.id, lines: [] }), /at least one/);
    assert.throws(() => E.createQuote({ oppId: o.id, lines: [{ sku: 'HX-100', qty: 1.5 }] }), /whole number/);
    assert.throws(() => E.createQuote({ oppId: o.id, lines: [{ sku: 'HX-100', qty: 1, discountPct: 100 }] }), /discount/);
    assert.throws(() => E.createQuote({ oppId: o.id, lines: [{ sku: 'HX-100', qty: 1, discountPct: -1 }] }), /discount/);
    assert.throws(() => E.createQuote({ oppId: o.id, lines: [{ sku: 'HX-100', qty: 1 }, { sku: 'HX-100', qty: 2 }] }), /twice/);
    assert.throws(() => E.createQuote({ oppId: o.id, lines: [{ sku: 'NOPE', qty: 1 }] }), /not found/);
  });
});

describe('accept quote -> sales order', () => {
  test('creates the SO at discounted prices and wins the opportunity; cannot accept twice; ledger healthy', () => {
    const o = openOpp('Corran Biolabs');
    const q = E.createQuote({ oppId: o.id, date: '2026-11-17', lines: [{ sku: 'HX-310', qty: 3, discountPct: 10 }, { sku: 'CB-010', qty: 20, discountPct: 0 }] });
    E.sendQuote(q.id, '2026-11-17');
    const nSO = E.S.sos.length, nJE = E.S.journals.length;
    const r = E.acceptQuote(q.id, { date: '2026-11-17', poNumber: 'CB-PO-1' });
    assert.equal(E.S.sos.length, nSO + 1); assert.equal(E.S.journals.length, nJE, 'booking an order posts nothing');
    assert.equal(r.so.customerId, o.customerId); assert.equal(r.so.poNumber, 'CB-PO-1');
    assert.deepEqual(r.so.lines.map((l) => [l.sku, l.qty, l.price]), [['HX-310', 3, E.util.r2(1450 * 0.9)], ['CB-010', 20, 29]]);
    assert.equal(r.so.total, q.total);
    assert.equal(q.status, 'Accepted'); assert.equal(q.soId, r.so.id);
    assert.equal(o.stage, 'Won'); assert.equal(o.soId, r.so.id); assert.equal(o.amount, q.total); assert.equal(o.history[o.history.length - 1].stage, 'Won');
    assert.throws(() => E.acceptQuote(q.id, { date: '2026-11-17' }), /already accepted/);
    assert.equal(E.S.sos.length, nSO + 1);
    healthy();
    // the order flows on through the core: ship it and the ledger still ties out
    if (r.so.status === 'Booked') { E.shipSO(r.so.id, '2026-11-17'); healthy(); }
  });
  test('seeded pending quote: approve then accept; large order for a new prospect lands on credit hold', () => {
    const pend = E.S.quotes.find((q) => q.status === 'Pending Approval');
    as('Controller', 'Avery Lin', () => E.approveQuote(pend.id));
    const r = E.acceptQuote(pend.id, { date: '2026-11-17' });
    assert.equal(E.opp(pend.oppId).stage, 'Won'); assert.ok(['Booked', 'Credit Hold'].includes(r.so.status));
    const prospect = E.S.customers.find((c) => c.name === 'Northgate Clinical Labs');
    const o = E.S.opps.find((x) => x.customerId === prospect.id);
    const q = E.createQuote({ oppId: o.id, date: '2026-11-17', lines: [{ sku: 'HX-310', qty: 40 }] }); // 58,000 > 50,000 limit
    const r2 = E.acceptQuote(q.id, { date: '2026-11-17' });
    assert.equal(r2.so.status, 'Credit Hold'); assert.equal(o.stage, 'Won');
    assert.ok(E.approvalsInbox().some((i) => i.kind === 'so' && i.id === r2.so.id));
    healthy();
  });
  test('a failed acceptance leaves quote and opportunity untouched', () => {
    const o = openOpp();
    const q = E.createQuote({ oppId: o.id, date: '2026-11-17', validUntil: '2026-11-20', lines: [{ sku: 'HX-100', qty: 2 }] });
    const snap = JSON.stringify(E.S);
    assert.throws(() => E.acceptQuote(q.id, { date: '2026-12-01' }), /expired/);
    assert.throws(() => E.acceptQuote(q.id, { date: 'bad' }), /valid/);
    assert.equal(JSON.stringify(E.S), snap);
  });
  test('activities attach to leads and opportunities', () => {
    const o = openOpp();
    const a = E.logActivity({ refId: o.id, type: 'Meeting', date: '2026-11-17', note: 'Demo', ownerId: rep().id });
    assert.equal(a.oppId, o.id);
    assert.throws(() => E.logActivity({ refId: o.id, type: 'Fax', note: 'x' }), /Type/);
    assert.throws(() => E.logActivity({ refId: 'OPP-9', type: 'Call', note: 'x' }), /lead or an opportunity/);
    assert.throws(() => E.logActivity({ refId: o.id, type: 'Call', note: '' }), /note/);
  });
});
