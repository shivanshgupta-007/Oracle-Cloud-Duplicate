/* Ledgerline Suite: ext-crm.js
 * Sales pipeline: leads, opportunities (stages with win probability and history),
 * quotes (list price less line discount, discount approval over 15%), activities.
 * Accepting a quote books a real sales order through E.createSO, so the core
 * credit check applies (the order may land on Credit Hold) and the opportunity is Won.
 * No GL effect of its own: revenue posts when the order ships.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { r2, sum, money, periodOf, addDays, isDate } = E.util;

  const STAGES = [['Qualify', 0.1], ['Develop', 0.3], ['Propose', 0.5], ['Negotiate', 0.75], ['Won', 1], ['Lost', 0]];
  const PROB = Object.fromEntries(STAGES);
  const OPEN_STAGES = ['Qualify', 'Develop', 'Propose', 'Negotiate'];
  const LEAD_SOURCES = ['Web', 'Trade show', 'Referral', 'Outbound'];
  const LEAD_STATUSES = ['New', 'Working', 'Qualified', 'Disqualified'];
  const ACTIVITY_TYPES = ['Call', 'Meeting', 'Email'];
  const QUOTE_STATUSES = ['Draft', 'Pending Approval', 'Approved', 'Sent', 'Accepted', 'Expired'];
  const DISCOUNT_LIMIT = 15;           // % on any line; above needs crm.discount approval
  const QUOTE_VALID_DAYS = 30;
  const NEW_CUSTOMER_LIMIT = 50000;
  const NEW_CUSTOMER_TERMS = 30;

  const fail = (m) => { throw new Error(m); };
  const S = () => E.S;
  const today = () => S()._date || S().today;

  E.on('state', (st) => {
    st.leads = st.leads || []; st.opps = st.opps || []; st.quotes = st.quotes || []; st.activities = st.activities || [];
  });

  // ---------- lookups ----------
  const lead = (id) => S().leads.find((x) => x.id === id);
  const opp = (id) => S().opps.find((x) => x.id === id);
  const quote = (id) => S().quotes.find((x) => x.id === id);
  const salesReps = () => S().employees.filter((e) => e.dept === 'Sales' && e.status === 'Active');
  const isOpen = (o) => OPEN_STAGES.includes(o.stage);
  const custByName = (name) => S().customers.find((c) => c.name.toLowerCase() === String(name || '').trim().toLowerCase());
  const assertOwner = (id) => { const e = E.emp(id); if (!e) fail('Choose an owner from the sales team.'); if (e.dept !== 'Sales') fail(`${e.name} is not in the Sales department. Opportunities and leads are owned by sales reps.`); if (e.status !== 'Active') fail(`${e.name} is not active.`); return e; };
  const assertDate = (d, what = 'date') => { if (!isDate(d)) fail(`Enter a valid ${what} (YYYY-MM-DD).`); return d; };
  const amountOf = (x, what = 'Amount') => { const n = +x; if (x === '' || x == null || !Number.isFinite(n)) fail(`${what} must be a number.`); if (n < 0) fail(`${what} cannot be negative.`); if (n > 1e9) fail(`${what} is too large.`); return r2(n); };

  // ---------- leads ----------
  /** createLead({name, company, source, ownerId, email, date, note}) */
  function createLead({ name, company, source = 'Web', ownerId, email = '', date, note = '' }) {
    name = String(name || '').trim(); company = String(company || '').trim();
    if (!name) fail('Enter the contact name.'); if (!company) fail('Enter the company.');
    if (!LEAD_SOURCES.includes(source)) fail(`Source must be one of ${LEAD_SOURCES.join(', ')}.`);
    assertOwner(ownerId); date = assertDate(date || today());
    const l = { id: E.nextId('LEAD'), name, company, email: String(email || '').trim(), source, status: 'New', ownerId, date, note: String(note || ''), createdBy: S().user };
    S().leads.push(l); E.log('Created lead', l.id, `${name}, ${company}`); return l;
  }
  /** setLeadStatus(id, status, reason) — New/Working/Qualified/Disqualified (not after conversion). */
  function setLeadStatus(id, status, reason = '') {
    const l = E.need(lead(id), 'Lead');
    if (!LEAD_STATUSES.includes(status)) fail(`Status must be one of ${LEAD_STATUSES.join(', ')}.`);
    if (l.oppId) fail(`${id} was converted to ${l.oppId} and can no longer change status.`);
    if (l.status === status) fail(`${id} is already ${status}.`);
    if (status === 'Disqualified' && !String(reason || '').trim()) fail('Give a reason for disqualifying the lead.');
    l.status = status; if (status === 'Disqualified') l.reason = String(reason).trim();
    E.log('Changed lead status', id, status + (reason ? `: ${reason}` : '')); return l;
  }
  /** convertLead(id, {name, amount, closeDate, date}) -> {lead, opp, customer, createdCustomer}
   *  Reuses an existing customer with the same name; otherwise creates one (credit limit 50,000, Net 30). */
  function convertLead(id, { name, amount = 0, closeDate, date } = {}) {
    const l = E.need(lead(id), 'Lead');
    if (l.oppId) fail(`${id} was already converted to ${l.oppId}.`);
    if (l.status === 'Disqualified') fail(`${id} is disqualified. Reopen it (set it to Working) before converting.`);
    date = assertDate(date || today()); closeDate = assertDate(closeDate || addDays(date, 90), 'close date');
    if (closeDate < date) fail('The expected close date cannot be before the conversion date.');
    const amt = amountOf(amount, 'Opportunity amount');
    assertOwner(l.ownerId);
    const oppName = String(name || '').trim() || `${l.company}: initial order`;
    let c = custByName(l.company); const created = !c;
    if (!c) c = E.addCustomer({ name: l.company, creditLimit: NEW_CUSTOMER_LIMIT, terms: NEW_CUSTOMER_TERMS, segment: 'Prospect' });
    const o = createOpp({ customerId: c.id, name: oppName, amount: amt, stage: 'Qualify', closeDate, ownerId: l.ownerId, date, leadId: l.id, nextStep: 'Discovery call' });
    l.status = 'Qualified'; l.oppId = o.id; l.customerId = c.id; l.convertedOn = date;
    S().activities.filter((a) => a.refId === l.id).forEach((a) => { a.oppId = o.id; });
    E.log('Converted lead', id, `${o.id} for ${c.name}${created ? ' (new customer ' + c.id + ')' : ''}`);
    return { lead: l, opp: o, customer: c, createdCustomer: created };
  }

  // ---------- opportunities ----------
  /** createOpp({customerId, name, amount, stage, closeDate, ownerId, nextStep, competitor, date, leadId}) */
  function createOpp({ customerId, name, amount = 0, stage = 'Qualify', closeDate, ownerId, nextStep = '', competitor = '', date, leadId = '' }) {
    const c = E.need(E.cust(customerId), 'Customer');
    name = String(name || '').trim(); if (!name) fail('Name the opportunity, e.g. "Water lab refresh, 40 probes".');
    if (!OPEN_STAGES.includes(stage)) fail(`New opportunities start in an open stage (${OPEN_STAGES.join(', ')}).`);
    const amt = amountOf(amount); assertOwner(ownerId);
    date = assertDate(date || today()); closeDate = assertDate(closeDate, 'close date');
    const o = { id: E.nextId('OPP'), customerId: c.id, name, amount: amt, stage, closeDate, ownerId, nextStep: String(nextStep || ''), competitor: String(competitor || ''), created: date, leadId,
      history: [{ date, stage, by: S().user }], soId: '', quoteId: '', createdBy: S().user };
    S().opps.push(o); E.log('Created opportunity', o.id, `${c.name}: ${name} ${money(amt)} (${stage})`); return o;
  }
  /** updateOpp(id, {name, amount, closeDate, ownerId, nextStep, competitor}) — open opportunities only. */
  function updateOpp(id, fields = {}) {
    const o = E.need(opp(id), 'Opportunity'); if (!isOpen(o)) fail(`${id} is ${o.stage} and closed for edits.`);
    const next = {};
    if ('name' in fields) { next.name = String(fields.name || '').trim(); if (!next.name) fail('Name the opportunity.'); }
    if ('amount' in fields) next.amount = amountOf(fields.amount);
    if ('closeDate' in fields) next.closeDate = assertDate(fields.closeDate, 'close date');
    if ('ownerId' in fields) { assertOwner(fields.ownerId); next.ownerId = fields.ownerId; }
    if ('nextStep' in fields) next.nextStep = String(fields.nextStep || '');
    if ('competitor' in fields) next.competitor = String(fields.competitor || '');
    Object.assign(o, next); E.log('Updated opportunity', id, Object.keys(next).join(', ')); return o;
  }
  /** setOppStage(id, stage, {date, reason}) — Won is reached only by accepting a quote. */
  function setOppStage(id, stage, { date, reason = '' } = {}) {
    const o = E.need(opp(id), 'Opportunity');
    if (!(stage in PROB)) fail(`Unknown stage ${stage}.`);
    if (!isOpen(o)) fail(`${id} is already ${o.stage}.`);
    if (stage === o.stage) fail(`${id} is already in ${stage}.`);
    if (stage === 'Won') fail('Accept a quote to win this opportunity. That books the sales order and runs the credit check.');
    if (stage === 'Lost' && !String(reason || '').trim()) fail('Give a reason the opportunity was lost (for win/loss analysis).');
    date = assertDate(date || today());
    o.stage = stage; o.history.push({ date, stage, by: S().user, note: reason || '' });
    if (stage === 'Lost') { o.lostReason = String(reason).trim(); o.closedOn = date; S().quotes.filter((q) => q.oppId === id && !['Accepted', 'Expired'].includes(q.status)).forEach((q) => { q.status = 'Expired'; }); }
    E.log(stage === 'Lost' ? 'Closed opportunity as lost' : 'Moved opportunity stage', id, `${stage} (${Math.round(PROB[stage] * 100)}%)${reason ? ': ' + reason : ''}`);
    return o;
  }
  const nextStage = (stage) => { const i = OPEN_STAGES.indexOf(stage); return i >= 0 && i < OPEN_STAGES.length - 1 ? OPEN_STAGES[i + 1] : null; };
  /** advanceOpp(id) — moves one open stage forward (Qualify > Develop > Propose > Negotiate). */
  function advanceOpp(id, date) {
    const o = E.need(opp(id), 'Opportunity');
    if (!isOpen(o)) fail(`${id} is already ${o.stage}.`);
    const n = nextStage(o.stage);
    if (!n) fail(`${id} is in Negotiate. Accept a quote to win it, or mark it lost.`);
    return setOppStage(id, n, { date });
  }

  // ---------- quotes ----------
  /** createQuote({oppId, date, validUntil, lines:[{sku, qty, discountPct}], note}) — list price less line discount. */
  function createQuote({ oppId, date, validUntil, lines, note = '' }) {
    const o = E.need(opp(oppId), 'Opportunity'); if (!isOpen(o)) fail(`${oppId} is ${o.stage}. Quotes are for open opportunities.`);
    date = assertDate(date || today()); validUntil = assertDate(validUntil || addDays(date, QUOTE_VALID_DAYS), 'valid-until date');
    if (validUntil < date) fail('The quote must be valid on or after its date.');
    const raw = (lines || []).filter((l) => l.sku || +l.qty);
    if (!raw.length) fail('Add at least one item to the quote.');
    const seen = new Set();
    const out = raw.map((l) => {
      const it = E.item(l.sku); if (!it) fail(`Choose an item for every line${l.sku ? ` (${l.sku} not found)` : ''}.`);
      if (seen.has(it.sku)) fail(`${it.sku} is on the quote twice. Combine it into one line.`); seen.add(it.sku);
      const qty = +l.qty; if (!Number.isInteger(qty) || qty <= 0) fail(`${it.sku}: quantity must be a whole number above zero.`);
      const d = l.discountPct === '' || l.discountPct == null ? 0 : +l.discountPct;
      if (!Number.isFinite(d) || d < 0 || d >= 100) fail(`${it.sku}: discount must be between 0% and 99.99%.`);
      const disc = r2(d), price = r2(it.price * (1 - disc / 100));
      if (!(price > 0)) fail(`${it.sku}: net price must be above zero.`);
      return { sku: it.sku, qty, listPrice: it.price, discountPct: disc, price, amount: r2(qty * price) };
    });
    const total = sum(out, (l) => l.amount), listTotal = sum(out, (l) => l.qty * l.listPrice);
    const maxDiscount = Math.max(...out.map((l) => l.discountPct));
    const needsApproval = maxDiscount > DISCOUNT_LIMIT;
    const q = { id: E.nextId('QT'), oppId: o.id, customerId: o.customerId, date, validUntil, lines: out, total, listTotal, discount: r2(listTotal - total), maxDiscount, needsApproval,
      status: needsApproval ? 'Pending Approval' : 'Draft', note: String(note || ''), createdBy: S().user, role: S().role };
    S().quotes.push(q); o.amount = total; o.quoteId = q.id;
    E.log(needsApproval ? 'Submitted quote for discount approval' : 'Created quote', q.id, `${E.cust(o.customerId).name} ${money(total)}${needsApproval ? `, ${maxDiscount}% discount` : ''}`);
    return q;
  }
  /** approveQuote(id) — discount approval; the person who created the quote cannot approve it. */
  function approveQuote(id) {
    const q = E.need(quote(id), 'Quote'); if (q.status !== 'Pending Approval') fail(`${id} is not awaiting approval (it is ${q.status}).`);
    if (q.createdBy === S().user && S().role !== 'Administrator') fail('You cannot approve a discount on a quote you created (segregation of duties).');
    q.status = 'Approved'; q.approvedBy = S().user; q.approvedOn = today(); E.log('Approved quote discount', id, `${q.maxDiscount}% max line discount`); return q;
  }
  /** rejectQuote(id, reason) — back to Draft; it cannot be sent until a new quote with a smaller discount is raised. */
  function rejectQuote(id, reason = '') {
    const q = E.need(quote(id), 'Quote'); if (q.status !== 'Pending Approval') fail(`${id} is not awaiting approval (it is ${q.status}).`);
    q.status = 'Draft'; q.rejected = true; q.rejectReason = String(reason || 'Discount not approved'); q.rejectedBy = S().user;
    E.log('Rejected quote discount', id, q.rejectReason); return q;
  }
  const approvalCleared = (q) => !q.needsApproval || !!q.approvedBy;
  /** sendQuote(id, date) — Draft (within discount limit) or Approved -> Sent. */
  function sendQuote(id, date) {
    const q = E.need(quote(id), 'Quote');
    if (!['Draft', 'Approved'].includes(q.status)) fail(`${id} is ${q.status} and cannot be sent.`);
    if (!approvalCleared(q)) fail(`${id} has a ${q.maxDiscount}% discount that was not approved. Raise a new quote within ${DISCOUNT_LIMIT}% or get approval.`);
    date = assertDate(date || today()); if (date > q.validUntil) fail(`${id} expired on ${q.validUntil}.`);
    q.status = 'Sent'; q.sentOn = date; E.log('Sent quote', id, money(q.total)); return q;
  }
  /** acceptQuote(id, {date, poNumber}) -> {quote, opp, so}. Books a sales order at the discounted prices and wins the opportunity. */
  function acceptQuote(id, { date, poNumber = '' } = {}) {
    const q = E.need(quote(id), 'Quote');
    if (q.status === 'Accepted') fail(`${id} was already accepted (sales order ${q.soId}).`);
    if (q.status === 'Expired') fail(`${id} has expired. Raise a new quote.`);
    if (q.status === 'Pending Approval') fail(`${id} is waiting for discount approval.`);
    if (!approvalCleared(q)) fail(`${id} has a ${q.maxDiscount}% discount that was not approved.`);
    const o = E.need(opp(q.oppId), 'Opportunity'); if (!isOpen(o)) fail(`${o.id} is already ${o.stage}.`);
    date = assertDate(date || today()); if (date > q.validUntil) fail(`${id} expired on ${q.validUntil}. Raise a new quote.`);
    if (date < q.date) fail('The acceptance date cannot be before the quote date.');
    // createSO validates and runs the credit check; it throws before mutating on any problem.
    const so = E.createSO({ customerId: q.customerId, date, poNumber: String(poNumber || '').trim() || q.id, lines: q.lines.map((l) => ({ sku: l.sku, qty: l.qty, price: l.price })) });
    q.status = 'Accepted'; q.soId = so.id; q.acceptedOn = date;
    S().quotes.filter((x) => x.oppId === o.id && x.id !== q.id && !['Accepted', 'Expired'].includes(x.status)).forEach((x) => { x.status = 'Expired'; });
    o.stage = 'Won'; o.amount = q.total; o.soId = so.id; o.quoteId = q.id; o.closedOn = date; o.closeDate = date;
    o.history.push({ date, stage: 'Won', by: S().user, note: `Quote ${q.id} accepted, ${so.id} ${so.status}` });
    E.log('Accepted quote', id, `${so.id} ${so.status} ${money(so.total)}; ${o.id} won`);
    return { quote: q, opp: o, so };
  }
  /** expireQuotes(asOf) — marks open quotes past their validity as Expired. */
  function expireQuotes(asOf = today()) {
    const list = S().quotes.filter((q) => ['Draft', 'Pending Approval', 'Approved', 'Sent'].includes(q.status) && q.validUntil < asOf);
    list.forEach((q) => { q.status = 'Expired'; E.log('Quote expired', q.id); });
    return list.length;
  }

  // ---------- activities ----------
  /** logActivity({refId (LEAD- or OPP-), type, date, note, ownerId}) */
  function logActivity({ refId, type = 'Call', date, note = '', ownerId }) {
    const target = lead(refId) || opp(refId); if (!target) fail('Log the activity against a lead or an opportunity.');
    if (!ACTIVITY_TYPES.includes(type)) fail(`Type must be one of ${ACTIVITY_TYPES.join(', ')}.`);
    date = assertDate(date || today()); note = String(note || '').trim(); if (!note) fail('Add a short note on what happened.');
    assertOwner(ownerId || target.ownerId);
    const a = { id: E.nextId('ACT'), refId, oppId: opp(refId) ? refId : target.oppId || '', type, date, note, ownerId: ownerId || target.ownerId, by: S().user };
    S().activities.push(a); E.log('Logged activity', refId, `${type}: ${note.slice(0, 60)}`); return a;
  }

  // ---------- analytics ----------
  const weighted = (o) => r2(o.amount * PROB[o.stage]);
  function pipelineSummary() {
    const opps = S().opps;
    const byStage = STAGES.map(([stage, p]) => { const l = opps.filter((o) => o.stage === stage); return { stage, prob: p, count: l.length, amount: sum(l, (o) => o.amount), weighted: sum(l, weighted) }; });
    const open = opps.filter(isOpen), won = opps.filter((o) => o.stage === 'Won'), lost = opps.filter((o) => o.stage === 'Lost');
    return {
      byStage, openCount: open.length, openAmount: sum(open, (o) => o.amount), weighted: sum(open, weighted),
      wonCount: won.length, wonAmount: sum(won, (o) => o.amount), lostCount: lost.length,
      winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
      avgDeal: won.length ? r2(sum(won, (o) => o.amount) / won.length) : 0,
    };
  }
  /** Open pipeline by expected close month: [{period, count, amount, weighted}] */
  function forecastByMonth() {
    const m = {};
    S().opps.filter(isOpen).forEach((o) => { const p = periodOf(o.closeDate); const r = (m[p] = m[p] || { period: p, count: 0, amount: 0, weighted: 0 }); r.count++; r.amount = r2(r.amount + o.amount); r.weighted = r2(r.weighted + weighted(o)); });
    return Object.values(m).sort((a, b) => a.period.localeCompare(b.period));
  }
  function repSummary() {
    const ids = new Set([...salesReps().map((e) => e.id), ...S().opps.map((o) => o.ownerId)]);
    return [...ids].map((id) => {
      const mine = S().opps.filter((o) => o.ownerId === id), open = mine.filter(isOpen), won = mine.filter((o) => o.stage === 'Won'), lost = mine.filter((o) => o.stage === 'Lost');
      return { ownerId: id, name: E.emp(id)?.name || id, open: open.length, pipeline: sum(open, (o) => o.amount), weighted: sum(open, weighted), won: won.length, wonAmount: sum(won, (o) => o.amount), lost: lost.length,
        winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null, leads: S().leads.filter((l) => l.ownerId === id && !l.oppId && l.status !== 'Disqualified').length };
    });
  }

  // ---------- seed ----------
  E.on('seedFinal', (ctx) => {
    const st = S();
    const rep = (n) => st.employees.find((e) => e.name === n && e.dept === 'Sales') || salesReps()[0];
    const reps = salesReps(); if (!reps.length) return;
    const ines = rep('Ines Duarte'), kwame = rep('Kwame Asante'), jonas = rep('Jonas Weller');
    const C = (n) => st.customers.find((c) => c.name === n);
    const asOM = (fn) => ctx.asRole('Order Manager', 'Ines Duarte', fn);
    const stageTo = (o, stages) => stages.forEach(([d, s]) => { ctx.at(d); setOppStage(o.id, s, { date: d }); });

    // Won deals linked to orders already booked in the history (no new order is created).
    const linkable = st.sos.filter((o) => o.status === 'Invoiced').sort((a, b) => b.total - a.total).slice(0, 3);
    const wonNames = ['Fermentation suite sensors', 'Network flow monitoring, phase 1', 'Stability chamber loggers'];
    linkable.forEach((so, i) => {
      const owner = [ines, kwame, jonas][i % 3];
      const created = addDays(so.date, -40 - i * 7);
      ctx.at(created < '2026-07-01' ? '2026-07-01' : created);
      const o = createOpp({ customerId: so.customerId, name: wonNames[i], amount: so.total, stage: 'Propose', closeDate: so.date, ownerId: owner.id, date: created < '2026-07-01' ? '2026-07-01' : created, nextStep: 'Closed' });
      ctx.at(so.date);
      o.stage = 'Won'; o.soId = so.id; o.closedOn = so.date; o.history.push({ date: so.date, stage: 'Won', by: owner.name, note: `Order ${so.id} booked` });
      E.log('Closed opportunity as won', o.id, `${so.id} ${money(so.total)}`);
    });

    // Leads
    const L = (d, name, company, source, owner, status, email, note) => { ctx.at(d); const l = createLead({ name, company, source, ownerId: owner.id, date: d, email, note }); if (status !== 'New') setLeadStatus(l.id, status, status === 'Disqualified' ? 'Student project, no budget' : ''); return l; };
    const l1 = L('2026-09-08', 'Dr. Elif Kaya', 'Northgate Clinical Labs', 'Trade show', ines, 'Working', 'e.kaya@northgate-labs.example', 'Met at the regional lab automation expo; replacing legacy thermal probes.');
    const l2 = L('2026-09-21', 'Tomas Lindqvist', 'Halvorsen Aquaculture', 'Referral', kwame, 'Working', 'tomas@halvorsen-aqua.example', 'Referred by Meridian Water; needs dissolved-flow monitoring for 6 tanks.');
    L('2026-10-02', 'Grace Mbeki', 'Riverside Brewing Co.', 'Web', kwame, 'New', 'grace@riversidebrew.example', 'Downloaded the data logger spec sheet.');
    L('2026-10-14', 'Arjun Mehta', 'Calder Polymer Works', 'Outbound', ines, 'Working', 'a.mehta@calderpolymer.example', 'Cold call; interested in pressure transducers for extrusion lines.');
    L('2026-10-27', 'Sofia Ruiz', 'Bayview Hospital Pharmacy', 'Referral', jonas, 'Qualified', 'sruiz@bayview-health.example', 'Cold-chain monitoring for pharmacy fridges; budget approved for Q1.');
    L('2026-11-03', 'Ben Carter', 'Carter Home Lab', 'Web', kwame, 'Disqualified', 'ben@carterhome.example', 'Hobbyist enquiry.');
    L('2026-11-09', 'Mei Chen', 'Sunfield Agritech', 'Trade show', ines, 'New', 'mei.chen@sunfield-agri.example', 'Soil sensor pilot, wants calibration kits.');
    L('2026-11-13', 'Paul Okonkwo', 'Ashgrove Dairy Cooperative', 'Outbound', jonas, 'New', 'p.okonkwo@ashgrove.example', 'Pasteurisation temperature logging.');
    // Two leads already converted to opportunities for new prospect customers.
    ctx.at('2026-10-05'); const c1 = convertLead(l1.id, { name: 'Clinical lab probe replacement', amount: 46500, closeDate: '2027-01-29', date: '2026-10-05' });
    ctx.at('2026-10-19'); const c2 = convertLead(l2.id, { name: 'Tank flow monitoring, 6 tanks', amount: 58200, closeDate: '2027-02-26', date: '2026-10-19' });
    ctx.at('2026-11-02'); setOppStage(c1.opp.id, 'Develop', { date: '2026-11-02' }); updateOpp(c1.opp.id, { nextStep: 'Site survey 24 Nov', competitor: 'Generic import probes' });
    ctx.at('2026-11-06'); updateOpp(c2.opp.id, { nextStep: 'Send flow meter sizing worksheet' });

    // Open opportunities for existing customers
    const O = (d, cust, name, amount, close, owner, stages, nextStep, competitor) => { ctx.at(d); const o = createOpp({ customerId: C(cust).id, name, amount, stage: 'Qualify', closeDate: close, ownerId: owner.id, date: d, nextStep, competitor }); stageTo(o, stages); return o; };
    const meridian = O('2026-08-18', 'Meridian Water Authority', 'District metering upgrade, 60 flow meters', 92000, '2026-12-18', kwame, [['2026-09-02', 'Develop'], ['2026-09-30', 'Propose'], ['2026-10-28', 'Negotiate']], 'Discount approval, then final pricing call', 'Valemont direct');
    const pinecrest = O('2026-09-10', 'Pinecrest University', 'Teaching lab data loggers', 24000, '2026-12-11', jonas, [['2026-09-24', 'Develop'], ['2026-10-20', 'Propose']], 'Chase purchasing for PO', '');
    O('2026-09-15', 'Corran Biolabs', 'Bioreactor pressure monitoring', 64000, '2027-01-22', ines, [['2026-10-06', 'Develop'], ['2026-11-04', 'Propose']], 'Technical review with process engineering', 'Kestrel OEM');
    O('2026-10-01', 'Solace Pharma', 'Cleanroom thermal mapping kits', 38500, '2027-02-12', ines, [['2026-10-22', 'Develop']], 'Validation protocol review', '');
    O('2026-10-12', 'Corran Biolabs', 'Spare probes and cables, 2027 framework', 18000, '2027-03-31', kwame, [], 'Confirm annual volumes', '');
    O('2026-11-05', 'Solace Pharma', 'Second-site logger rollout', 81000, '2027-04-30', jonas, [], 'Intro meeting with site director', 'Incumbent spreadsheets');
    // Lost deals for win-rate history
    const lost1 = O('2026-07-14', 'Ostrava Foods', 'Line temperature probes, plant 2', 27500, '2026-09-30', kwame, [['2026-08-05', 'Develop'], ['2026-08-26', 'Propose']], '', 'Low-cost import');
    ctx.at('2026-09-18'); setOppStage(lost1.id, 'Lost', { date: '2026-09-18', reason: 'Lost on price to a low-cost import' });
    const lost2 = O('2026-08-03', 'Pinecrest University', 'Hydrology field kits', 15600, '2026-10-31', jonas, [['2026-08-25', 'Develop']], '', 'Grant timing');
    ctx.at('2026-10-09'); setOppStage(lost2.id, 'Lost', { date: '2026-10-09', reason: 'Grant funding pushed to next fiscal year' });

    // Quotes: one sent (ready to accept), one waiting for discount approval (dated 15 Nov).
    ctx.at('2026-10-21');
    const qp = asOM(() => createQuote({ oppId: pinecrest.id, date: '2026-10-21', validUntil: '2026-12-20', lines: [{ sku: 'PL-500', qty: 20, discountPct: 10 }, { sku: 'KT-900', qty: 10, discountPct: 5 }], note: 'Education pricing' }));
    ctx.at('2026-10-22'); asOM(() => sendQuote(qp.id, '2026-10-22'));
    ctx.at('2026-11-15');
    asOM(() => createQuote({ oppId: meridian.id, date: '2026-11-15', validUntil: '2026-12-15', lines: [{ sku: 'HX-310', qty: 60, discountPct: 18 }, { sku: 'CB-010', qty: 120, discountPct: 10 }], note: 'Volume pricing to beat the direct-from-manufacturer offer' }));

    // Activities
    const A = (d, refId, type, note, owner) => { ctx.at(d); logActivity({ refId, type, date: d, note, ownerId: owner.id }); };
    A('2026-09-09', l1.id, 'Email', 'Sent thermal probe datasheet and expo follow-up.', ines);
    A('2026-09-24', l2.id, 'Call', 'Intro call; 6 tanks, wants remote readings.', kwame);
    A('2026-10-28', meridian.id, 'Meeting', 'Pricing workshop with procurement; asked for volume discount.', kwame);
    A('2026-11-12', meridian.id, 'Call', 'Competitor quoted 15% under list; agreed to escalate discount.', kwame);
    A('2026-10-21', pinecrest.id, 'Email', 'Quote sent with education pricing.', jonas);
    A('2026-11-10', pinecrest.id, 'Call', 'Purchasing confirms PO is in approval.', jonas);
    A('2026-10-15', st.leads.find((l) => l.company === 'Calder Polymer Works').id, 'Call', 'Discovery call, 3 extrusion lines.', ines);
    A('2026-11-04', c1.opp.id, 'Meeting', 'Lab manager walkthrough; 30 probes to replace.', ines);
  });

  // ---------- hooks ----------
  E.on('approvals', () => S().quotes.filter((q) => q.status === 'Pending Approval').map((q) => ({
    kind: 'quote', id: q.id, title: `Quote ${money(q.total)} for ${E.cust(q.customerId)?.name || q.customerId}`, who: E.emp(opp(q.oppId)?.ownerId)?.name || q.createdBy,
    date: q.date, perm: 'crm.discount', why: `Line discount ${q.maxDiscount}% exceeds the ${DISCOUNT_LIMIT}% limit`,
  })));
  E.on('search', (q, hit) => [
    ...S().leads.filter((l) => hit(l.id, l.name, l.company)).map((l) => ({ kind: 'lead', id: l.id, label: `${l.id} ${l.name}`, sub: `Lead, ${l.company}, ${l.status}` })),
    ...S().opps.filter((o) => hit(o.id, o.name, E.cust(o.customerId)?.name)).map((o) => ({ kind: 'opp', id: o.id, label: `${o.id} ${o.name}`, sub: `Opportunity, ${E.cust(o.customerId)?.name}, ${o.stage}` })),
    ...S().quotes.filter((x) => hit(x.id)).map((x) => ({ kind: 'quote', id: x.id, label: x.id, sub: `Quote, ${E.cust(x.customerId)?.name}, ${x.status}` })),
  ]);
  E.addPerms('Order Manager', ['crm.edit']);
  E.addPerms('Controller', ['crm.discount']);

  E.extend({
    CRM_STAGES: STAGES, CRM_PROB: PROB, CRM_OPEN_STAGES: OPEN_STAGES, LEAD_SOURCES, LEAD_STATUSES, ACTIVITY_TYPES, QUOTE_STATUSES,
    QUOTE_DISCOUNT_LIMIT: DISCOUNT_LIMIT, NEW_CUSTOMER_LIMIT,
    lead, opp, quote, salesReps, oppNextStage: nextStage, oppWeighted: weighted,
    createLead, setLeadStatus, convertLead, createOpp, updateOpp, setOppStage, advanceOpp,
    createQuote, approveQuote, rejectQuote, sendQuote, acceptQuote, expireQuotes, logActivity,
    pipelineSummary, forecastByMonth, repSummary,
  });
})(typeof window !== 'undefined' ? window : globalThis);
