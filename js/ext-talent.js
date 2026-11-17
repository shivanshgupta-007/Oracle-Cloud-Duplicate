/* Ledgerline Suite: ext-talent.js
 * Talent management rules (no DOM): recruiting (job requisitions, candidates, offers),
 * performance (goals, review cycle, calibration) and compensation (salary change
 * requests, salary history, merit cycle). Talent has no direct GL effect: the only
 * accounting comes from E.hireEmployee (none) and payroll (via the wrapped E.runPayroll).
 * State lives under S.talent.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const { r2, sum, money, periodEnd, periodLabel, isDate, daysBetween } = E.util;
  const fail = (m) => { throw new Error(m); };

  const REQ_STATUSES = ['Draft', 'Pending Approval', 'Open', 'Filled', 'Cancelled'];
  const STAGES = ['Applied', 'Screen', 'Interview', 'Offer', 'Hired'];
  const SOURCES = ['Careers site', 'Referral', 'Job board', 'Agency', 'University', 'LinkedIn-style network', 'Internal'];
  const REQ_REASONS = ['New', 'Backfill'];
  const COMP_REASONS = ['Merit', 'Promotion', 'Market', 'Correction'];
  const GOAL_STATUSES = ['Not started', 'In progress', 'At risk', 'Completed'];
  const REVIEW_STATES = ['Not started', 'Self review', 'Manager review', 'Completed'];
  const COMP_APPROVAL_PCT = 10;           // increases above this % need approval
  const MERIT_EFFECTIVE = '2027-01-01';
  const CYCLE = { id: 'FY27-MY', name: 'FY27 Mid-year', start: '2026-11-01', end: '2026-12-31' };

  const blank = () => ({
    jobReqs: [], candidates: [], goals: [], goalPlans: {}, cycles: [{ ...CYCLE }], reviews: [],
    compChanges: [], salaryHistory: [], merit: { budgetPct: 3.5, effective: MERIT_EFFECTIVE, proposals: {}, status: 'Draft', changeIds: [] },
  });
  E.on('state', (S) => {
    if (!S.talent) S.talent = blank();
    const b = blank(); for (const k in b) if (S.talent[k] === undefined) S.talent[k] = b[k];
  });

  const T = () => E.S.talent;
  const today = () => E.S.today;
  const now = () => E.S._date || E.S.today;   // record date: the seed clock while seeding, else today
  const user = () => E.S.user;
  const jobReq = (id) => T().jobReqs.find((x) => x.id === id);
  const candidate = (id) => T().candidates.find((x) => x.id === id);
  const goal = (id) => T().goals.find((x) => x.id === id);
  const review = (id) => T().reviews.find((x) => x.id === id);
  const compChange = (id) => T().compChanges.find((x) => x.id === id);
  const needPerm = (perm, what) => { if (!E.can(E.S.role, perm)) fail(`Your role (${E.S.role}) cannot ${what}. Switch to HR Specialist or Administrator.`); };
  const txt = (s) => String(s ?? '').trim();
  const rating = (v, what) => { const n = +v; if (!Number.isInteger(n) || n < 1 || n > 5) fail(`${what} must be a whole number from 1 to 5.`); return n; };

  // =================================================================== recruiting
  /** createJobReq({title, dept, hiringManagerId, salaryMin, salaryMax, headcount, reason, date, submit}) */
  function createJobReq({ title, dept, hiringManagerId, salaryMin, salaryMax, headcount = 1, reason = 'New', date, submit = false, notes = '' }) {
    const S = E.S; date = date || now();
    if (!txt(title)) fail('Job title is required.');
    if (!S.departments.includes(dept)) fail('Choose a department.');
    const mgr = E.emp(hiringManagerId); if (!mgr || mgr.status !== 'Active') fail('Choose an active hiring manager.');
    const lo = r2(+salaryMin), hi = r2(+salaryMax);
    if (!(lo > 0) || !(hi > 0)) fail('Enter a salary range (minimum and maximum) greater than zero.');
    if (hi < lo) fail('Salary range maximum must be at least the minimum.');
    const hc = +headcount; if (!Number.isInteger(hc) || hc < 1 || hc > 50) fail('Headcount must be a whole number from 1 to 50.');
    if (!REQ_REASONS.includes(reason)) fail('Reason must be New or Backfill.');
    if (!isDate(date)) fail('Enter a valid date.');
    const r = { id: E.nextId('JR'), title: txt(title), dept, hiringManagerId: mgr.id, salaryMin: lo, salaryMax: hi, headcount: hc, filled: 0, reason, status: 'Draft', date, createdBy: user(), notes: txt(notes), history: [{ status: 'Draft', date, by: user() }] };
    T().jobReqs.push(r); E.log('Created job requisition', r.id, `${r.title}, ${r.dept}`);
    if (submit) submitJobReq(r.id);
    return r;
  }
  const reqStep = (r, status) => { r.status = status; r.history.push({ status, date: now(), by: user() }); };
  function submitJobReq(id) {
    const r = E.need(jobReq(id), 'Job requisition'); if (r.status !== 'Draft') fail(`${id} is ${r.status}; only a draft can be submitted.`);
    reqStep(r, 'Pending Approval'); r.submittedDate = now(); E.log('Submitted job requisition', id, r.title); return r;
  }
  function approveJobReq(id) {
    const r = E.need(jobReq(id), 'Job requisition'); if (r.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`);
    needPerm('hr.recruit.approve', 'approve job requisitions');
    reqStep(r, 'Open'); r.approvedBy = user(); r.openedDate = now(); E.log('Approved job requisition', id, r.title); return r;
  }
  function rejectJobReq(id, reason = '') {
    const r = E.need(jobReq(id), 'Job requisition'); if (r.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`);
    needPerm('hr.recruit.approve', 'reject job requisitions');
    reqStep(r, 'Draft'); r.rejectReason = txt(reason) || 'Returned by approver'; E.log('Returned job requisition', id, r.rejectReason); return r;
  }
  function cancelJobReq(id) {
    const r = E.need(jobReq(id), 'Job requisition'); if (['Filled', 'Cancelled'].includes(r.status)) fail(`${id} is already ${r.status}.`);
    const live = T().candidates.filter((c) => c.reqId === id && !['Hired', 'Rejected'].includes(c.stage));
    reqStep(r, 'Cancelled');
    live.forEach((c) => moveStage(c, 'Rejected', 'Requisition cancelled'));
    E.log('Cancelled job requisition', id, `${live.length} active candidate(s) closed`); return r;
  }
  const openHeadcount = (r) => Math.max(0, r.headcount - r.filled);

  function moveStage(c, stage, note) { c.stage = stage; c.stageDate = now(); c.history.push({ stage, date: now(), by: user(), note: note || '' }); }
  /** addCandidate({reqId, name, email, source, rating, notes, date}) */
  function addCandidate({ reqId, name, email = '', source = 'Careers site', rating: rt, notes = '', date }) {
    const r = E.need(jobReq(reqId), 'Job requisition');
    if (r.status !== 'Open') fail(`${r.id} is ${r.status}. Candidates can be added only to an approved, open requisition.`);
    if (!txt(name)) fail('Candidate name is required.');
    if (!SOURCES.includes(source)) fail('Choose a source.');
    date = date || now();
    const c = { id: E.nextId('CAN'), reqId: r.id, name: txt(name), email: txt(email), source, rating: rt ? rating(rt, 'Rating') : 0, notes: txt(notes), stage: 'Applied', stageDate: date, applied: date, feedback: [], offer: null, history: [{ stage: 'Applied', date, by: user(), note: '' }] };
    T().candidates.push(c); E.log('Added candidate', c.id, `${c.name} for ${r.id} ${r.title}`); return c;
  }
  /** Moves Applied → Screen → Interview. Interview → Offer happens by making an offer. */
  function advanceCandidate(id) {
    const c = E.need(candidate(id), 'Candidate'); const r = jobReq(c.reqId);
    if (r.status !== 'Open') fail(`${r.id} is ${r.status}; the pipeline is closed.`);
    if (c.stage === 'Applied' || c.stage === 'Screen') { moveStage(c, STAGES[STAGES.indexOf(c.stage) + 1]); E.log('Advanced candidate', id, `${c.name} to ${c.stage}`); return c; }
    if (c.stage === 'Interview') fail(`Make an offer to move ${c.name} to the Offer stage.`);
    if (c.stage === 'Offer') fail(`Record the offer outcome (accept or decline) for ${c.name}.`);
    fail(`${c.name} is ${c.stage}; there is no next stage.`);
  }
  function rejectCandidate(id, reason = '') {
    const c = E.need(candidate(id), 'Candidate'); if (['Hired', 'Rejected'].includes(c.stage)) fail(`${c.name} is already ${c.stage}.`);
    if (c.offer && ['Pending Approval', 'Approved'].includes(c.offer.status)) c.offer.status = 'Withdrawn';
    moveStage(c, 'Rejected', txt(reason)); c.rejectReason = txt(reason); E.log('Rejected candidate', id, c.name); return c;
  }
  function updateCandidate(id, { rating: rt, notes, source } = {}) {
    const c = E.need(candidate(id), 'Candidate');
    const nr = rt === undefined || rt === '' ? c.rating : rating(rt, 'Rating');
    if (source !== undefined && !SOURCES.includes(source)) fail('Choose a source.');
    c.rating = nr; if (notes !== undefined) c.notes = txt(notes); if (source !== undefined) c.source = source;
    E.log('Updated candidate', id, c.name); return c;
  }
  /** addFeedback(candId, {interviewer, rating, comment, recommend}) */
  function addFeedback(id, { interviewer, rating: rt, comment = '', recommend = 'Yes', date }) {
    const c = E.need(candidate(id), 'Candidate'); if (['Hired', 'Rejected'].includes(c.stage)) fail(`${c.name} is ${c.stage}; feedback is closed.`);
    if (!txt(interviewer)) fail('Who interviewed? Enter the interviewer.');
    const f = { interviewer: txt(interviewer), rating: rating(rt, 'Interview rating'), comment: txt(comment), recommend: ['Yes', 'No', 'Maybe'].includes(recommend) ? recommend : 'Yes', date: date || now() };
    c.feedback.push(f);
    c.rating = Math.round(c.feedback.reduce((a, x) => a + x.rating, 0) / c.feedback.length);
    E.log('Added interview feedback', id, `${f.interviewer} rated ${c.name} ${f.rating}/5`); return f;
  }
  /** makeOffer(candId, {salary, startDate}). Salary above the requisition max needs approval (kind 'offer'). */
  function makeOffer(id, { salary, startDate }) {
    const c = E.need(candidate(id), 'Candidate'); const r = jobReq(c.reqId);
    if (r.status !== 'Open') fail(`${r.id} is ${r.status}. Offers need an open requisition.`);
    if (!['Interview', 'Offer'].includes(c.stage)) fail(`${c.name} is at ${c.stage}. Offers follow the interview stage.`);
    if (c.offer && c.offer.status === 'Approved') fail(`${c.name} already has an approved offer. Record acceptance or decline.`);
    if (!openHeadcount(r)) fail(`${r.id} has no open headcount left.`);
    const s = r2(+salary); if (!(s > 0)) fail('Offer salary must be greater than zero.');
    if (!isDate(startDate)) fail('Enter a valid start date.');
    if (startDate < today()) fail('Start date cannot be in the past.');
    if (s < r.salaryMin) fail(`Offer ${money(s)} is below the range minimum ${money(r.salaryMin)} for ${r.id}.`);
    const above = s > r.salaryMax;
    c.offer = { salary: s, startDate, status: above ? 'Pending Approval' : 'Approved', date: now(), by: user(), aboveRange: above, why: above ? `${money(s)} is ${money(r2(s - r.salaryMax))} above the ${money(r.salaryMax)} range maximum` : '' };
    if (c.stage !== 'Offer') moveStage(c, 'Offer');
    E.log(above ? 'Submitted offer for approval' : 'Extended offer', id, `${c.name} ${money(s)} start ${startDate}`); return c.offer;
  }
  function approveOffer(id) {
    const c = E.need(candidate(id), 'Candidate'); if (!c.offer || c.offer.status !== 'Pending Approval') fail(`${id} has no offer awaiting approval.`);
    needPerm('hr.recruit.approve', 'approve offers');
    c.offer.status = 'Approved'; c.offer.approvedBy = user(); E.log('Approved offer', id, `${c.name} ${money(c.offer.salary)}`); return c.offer;
  }
  function rejectOffer(id, reason = '') {
    const c = E.need(candidate(id), 'Candidate'); if (!c.offer || c.offer.status !== 'Pending Approval') fail(`${id} has no offer awaiting approval.`);
    needPerm('hr.recruit.approve', 'reject offers');
    c.offer.status = 'Rejected'; c.offer.rejectReason = txt(reason) || 'Revise within range'; E.log('Rejected offer', id, c.offer.rejectReason); return c.offer;
  }
  /** Candidate accepts: hires them (E.hireEmployee), marks Hired, fills headcount. */
  function acceptOffer(id) {
    const c = E.need(candidate(id), 'Candidate'); const r = jobReq(c.reqId);
    if (c.stage === 'Hired') fail(`${c.name} has already been hired (${c.empId}).`);
    if (c.stage !== 'Offer' || !c.offer) fail(`${c.name} has no offer to accept.`);
    if (c.offer.status === 'Pending Approval') fail('The offer is above the salary range and still awaits approval.');
    if (c.offer.status !== 'Approved') fail(`The offer is ${c.offer.status}. Make a new offer first.`);
    if (r.status !== 'Open' || !openHeadcount(r)) fail(`${r.id} has no open headcount left.`);
    const mgr = E.emp(r.hiringManagerId);
    const e = E.hireEmployee({ name: c.name, title: r.title, dept: r.dept, managerId: mgr && mgr.status === 'Active' ? mgr.id : (mgr ? mgr.managerId : ''), salary: c.offer.salary, hireDate: c.offer.startDate });
    const h = T().salaryHistory.find((x) => x.empId === e.id && x.reason === 'Hire'); if (h) h.ref = c.id;
    c.offer.status = 'Accepted'; c.offer.acceptedDate = now(); c.empId = e.id;
    moveStage(c, 'Hired', `Hired as ${e.id}`);
    r.filled += 1; r.hires = [...(r.hires || []), e.id];
    if (r.filled >= r.headcount) {
      reqStep(r, 'Filled'); r.filledDate = now();
      T().candidates.filter((x) => x.reqId === r.id && !['Hired', 'Rejected'].includes(x.stage)).forEach((x) => { if (x.offer && ['Pending Approval', 'Approved'].includes(x.offer.status)) x.offer.status = 'Withdrawn'; moveStage(x, 'Rejected', 'Requisition filled'); });
    }
    E.log('Offer accepted', id, `${c.name} hired as ${e.id}; ${r.id} ${r.filled}/${r.headcount} filled`); return e;
  }
  function declineOffer(id) {
    const c = E.need(candidate(id), 'Candidate'); if (c.stage !== 'Offer' || !c.offer) fail(`${c.name} has no open offer.`);
    c.offer.status = 'Declined'; moveStage(c, 'Rejected', 'Declined offer'); E.log('Offer declined', id, c.name); return c;
  }
  const timeInStage = (c, asOf) => Math.max(0, daysBetween(c.stageDate, asOf || today()));

  // =================================================================== performance
  const plan = (empId) => T().goalPlans[empId] || { status: 'Draft' };
  const goalsOf = (empId) => T().goals.filter((g) => g.empId === empId);
  const goalWeight = (empId) => sum(goalsOf(empId), (g) => g.weight);
  const autoStatus = (g) => { if (g.progress >= 100) return 'Completed'; if (g.status === 'At risk') return 'At risk'; return g.progress > 0 ? 'In progress' : 'Not started'; };
  function checkGoal({ title, weight, targetDate, progress }) {
    if (!txt(title)) fail('Goal title is required.');
    const w = +weight; if (!Number.isFinite(w) || w <= 0 || w > 100 || Math.round(w) !== w) fail('Weight must be a whole percentage from 1 to 100.');
    if (!isDate(targetDate)) fail('Enter a valid target date.');
    const p = +(progress || 0); if (!Number.isFinite(p) || p < 0 || p > 100) fail('Progress must be from 0 to 100%.');
    return { w, p };
  }
  function addGoal({ empId, title, weight, targetDate, progress = 0, status }) {
    const e = E.need(E.emp(empId), 'Employee'); if (e.status !== 'Active') fail(`${e.name} is not active.`);
    const { w, p } = checkGoal({ title, weight, targetDate, progress });
    if (goalsOf(empId).length >= 10) fail('An employee can have at most 10 goals.');
    const g = { id: E.nextId('GOAL'), empId, title: txt(title), weight: w, targetDate, progress: p, status: 'Not started', created: now() };
    if (status && GOAL_STATUSES.includes(status)) g.status = status; g.status = autoStatus(g);
    T().goals.push(g); reopenPlan(empId); E.log('Added goal', g.id, `${e.name}: ${g.title} (${w}%)`); return g;
  }
  function reopenPlan(empId) { if (plan(empId).status === 'Submitted') T().goalPlans[empId] = { status: 'Draft', reopened: now() }; }
  function updateGoal(id, patch = {}) {
    const g = E.need(goal(id), 'Goal');
    const next = { title: patch.title ?? g.title, weight: patch.weight ?? g.weight, targetDate: patch.targetDate ?? g.targetDate, progress: patch.progress ?? g.progress };
    const { w, p } = checkGoal(next);
    if (patch.status !== undefined && !GOAL_STATUSES.includes(patch.status)) fail('Choose a goal status.');
    const weightChanged = w !== g.weight || txt(next.title) !== g.title;
    g.title = txt(next.title); g.weight = w; g.targetDate = next.targetDate; g.progress = p;
    if (patch.status !== undefined) g.status = patch.status;
    g.status = patch.status === 'Completed' ? 'Completed' : autoStatus(g);
    if (g.status === 'Completed') g.progress = 100;
    if (weightChanged) reopenPlan(g.empId);
    E.log('Updated goal', id, `${g.title}: ${g.progress}%`); return g;
  }
  function deleteGoal(id) {
    const g = E.need(goal(id), 'Goal'); T().goals = T().goals.filter((x) => x.id !== id); reopenPlan(g.empId); E.log('Removed goal', id, g.title); return g;
  }
  /** Goal weights must total exactly 100% before the plan can be submitted. */
  function submitGoals(empId) {
    const e = E.need(E.emp(empId), 'Employee'); const gs = goalsOf(empId);
    if (!gs.length) fail(`${e.name} has no goals to submit.`);
    const w = goalWeight(empId); if (Math.abs(w - 100) > 0.001) fail(`Goal weights for ${e.name} total ${w}%. They must add up to exactly 100% to submit.`);
    T().goalPlans[empId] = { status: 'Submitted', date: now(), by: user() }; E.log('Submitted goals', empId, `${e.name}, ${gs.length} goal(s)`); return T().goalPlans[empId];
  }

  const cycle = (id = CYCLE.id) => T().cycles.find((c) => c.id === id);
  /** Creates a 'Not started' review for every active employee who lacks one in the cycle. */
  function launchReviews(cycleId = CYCLE.id) {
    const cy = E.need(cycle(cycleId), 'Review cycle'); let n = 0;
    E.S.employees.filter((e) => e.status === 'Active' && e.hireDate <= cy.end).forEach((e) => {
      if (T().reviews.some((r) => r.cycleId === cy.id && r.empId === e.id)) return;
      T().reviews.push({ id: E.nextId('REV'), cycleId: cy.id, empId: e.id, managerId: e.managerId, state: 'Not started', selfRating: 0, selfComments: '', mgrRating: 0, mgrComments: '' }); n++;
    });
    if (n) E.log('Launched reviews', cy.name, `${n} employee(s)`); return n;
  }
  /** saveSelfReview(id, {rating, comments, submit}) */
  function saveSelfReview(id, { rating: rt, comments = '', submit = false }) {
    const r = E.need(review(id), 'Review'); if (!['Not started', 'Self review'].includes(r.state)) fail(`Self review is closed (review is ${r.state}).`);
    r.selfRating = rating(rt, 'Self rating'); r.selfComments = txt(comments);
    if (submit && !r.selfComments) fail('Add comments before submitting the self review.');
    r.state = submit ? 'Manager review' : 'Self review'; if (submit) r.selfDate = now();
    E.log(submit ? 'Submitted self review' : 'Saved self review', id, E.emp(r.empId)?.name); return r;
  }
  /** saveManagerReview(id, {rating, comments, submit}) */
  function saveManagerReview(id, { rating: rt, comments = '', submit = false }) {
    const r = E.need(review(id), 'Review'); if (r.state !== 'Manager review') fail(r.state === 'Completed' ? 'This review is already completed.' : 'The employee has not submitted a self review yet.');
    r.mgrRating = rating(rt, 'Manager rating'); r.mgrComments = txt(comments);
    if (submit && !r.mgrComments) fail('Add manager comments before completing the review.');
    if (submit) { r.state = 'Completed'; r.completedDate = now(); r.completedBy = user(); }
    E.log(submit ? 'Completed review' : 'Saved manager review', id, E.emp(r.empId)?.name); return r;
  }
  /** Rating distribution of completed reviews, by department: {dept: {1..5 counts, n, avg}} */
  function calibration(cycleId = CYCLE.id) {
    const out = {};
    E.S.departments.forEach((d) => (out[d] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, n: 0, total: 0, avg: 0 }));
    T().reviews.filter((r) => r.cycleId === cycleId).forEach((r) => {
      const e = E.emp(r.empId); if (!e) return; const o = out[e.dept] || (out[e.dept] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, n: 0, total: 0, avg: 0 });
      o.total++; if (r.state === 'Completed' && r.mgrRating) { o[r.mgrRating]++; o.n++; }
    });
    for (const d in out) { const o = out[d]; o.avg = o.n ? r2((1 * o[1] + 2 * o[2] + 3 * o[3] + 4 * o[4] + 5 * o[5]) / o.n) : 0; }
    return out;
  }

  // =================================================================== compensation
  const pctChange = (from, to) => (from > 0 ? r2(((to - from) / from) * 100) : 0);
  function salaryHistory(empId) {
    const e = E.emp(empId); const rows = T().salaryHistory.filter((h) => h.empId === empId).slice();
    if (e && !rows.some((h) => h.reason === 'Hire')) {
      const first = rows.slice().sort((a, b) => a.date.localeCompare(b.date))[0];
      rows.push({ empId, date: e.hireDate, salary: first ? first.prev : e.salary, prev: 0, reason: 'Hire', ref: '', implied: true });
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.reason === 'Hire' ? -1 : 1));
  }
  function applyChange(c) {
    const e = E.emp(c.empId); const prev = e.salary;
    e.salary = r2(c.newSalary); c.status = 'Applied'; c.appliedDate = now(); c.appliedFrom = prev;
    T().salaryHistory.push({ empId: e.id, date: c.effectiveDate, salary: e.salary, prev, reason: c.reason, ref: c.id });
    E.log('Applied salary change', c.id, `${e.name} ${money(prev)} to ${money(e.salary)} effective ${c.effectiveDate}`);
  }
  /** requestSalaryChange({empId, newSalary, reason, effectiveDate, note, source}) */
  function requestSalaryChange({ empId, newSalary, reason, effectiveDate, note = '', source = '' }) {
    const e = E.need(E.emp(empId), 'Employee'); if (e.status !== 'Active') fail(`${e.name} is not active.`);
    const s = r2(+newSalary); if (!(s > 0)) fail('New salary must be greater than zero.');
    if (!COMP_REASONS.includes(reason)) fail('Reason must be Merit, Promotion, Market or Correction.');
    if (!isDate(effectiveDate)) fail('Enter a valid effective date.');
    if (effectiveDate < e.hireDate) fail(`Effective date is before ${e.name}'s hire date.`);
    if (s === e.salary) fail(`${e.name} already earns ${money(s)}.`);
    if (s < e.salary && reason !== 'Correction') fail('A salary decrease must use the Correction reason.');
    const clash = T().compChanges.find((c) => c.empId === empId && ['Pending Approval', 'Approved'].includes(c.status));
    if (clash) fail(`${e.name} already has an open salary change (${clash.id}, ${clash.status}). Decide or cancel it first.`);
    const pct = pctChange(e.salary, s);
    const c = { id: E.nextId('SC'), empId, currentSalary: e.salary, newSalary: s, pct, reason, effectiveDate, note: txt(note), source, status: pct > COMP_APPROVAL_PCT ? 'Pending Approval' : 'Approved', requestedBy: user(), date: now() };
    T().compChanges.push(c);
    E.log(c.status === 'Pending Approval' ? 'Submitted salary change for approval' : 'Recorded salary change', c.id, `${e.name} ${money(c.currentSalary)} to ${money(s)} (${pct}%) effective ${effectiveDate}`);
    if (c.status === 'Approved' && effectiveDate <= today()) applyChange(c);
    return c;
  }
  function approveSalaryChange(id) {
    const c = E.need(compChange(id), 'Salary change'); if (c.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`);
    needPerm('hr.comp.approve', 'approve salary changes');
    const e = E.emp(c.empId); if (!e || e.status !== 'Active') fail(`${e ? e.name : 'The employee'} is no longer active.`);
    c.status = 'Approved'; c.approvedBy = user(); c.approvedDate = now(); E.log('Approved salary change', id, `${e.name} ${c.pct}%`);
    if (c.effectiveDate <= today()) applyChange(c);
    return c;
  }
  function rejectSalaryChange(id, reason = '') {
    const c = E.need(compChange(id), 'Salary change'); if (c.status !== 'Pending Approval') fail(`${id} is not awaiting approval.`);
    needPerm('hr.comp.approve', 'reject salary changes');
    c.status = 'Rejected'; c.rejectReason = txt(reason) || 'Rejected by approver'; E.log('Rejected salary change', id, c.rejectReason); return c;
  }
  function cancelSalaryChange(id) {
    const c = E.need(compChange(id), 'Salary change'); if (!['Pending Approval', 'Approved'].includes(c.status)) fail(`${id} is ${c.status} and cannot be cancelled.`);
    c.status = 'Cancelled'; E.log('Cancelled salary change', id); return c;
  }
  /** Applies approved changes effective on or before asOf (default today). Returns the applied changes. */
  function applyDueChanges(asOf) {
    asOf = asOf || today(); if (!isDate(asOf)) fail('Enter a valid date.');
    const due = T().compChanges.filter((c) => c.status === 'Approved' && c.effectiveDate <= asOf).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id));
    due.forEach((c) => { const e = E.emp(c.empId); if (!e || e.status !== 'Active') { c.status = 'Cancelled'; c.note = (c.note ? c.note + '; ' : '') + 'Employee left before effective date'; return; } applyChange(c); });
    return due.filter((c) => c.status === 'Applied');
  }

  // merit cycle planner
  function setMeritBudget(pct) {
    const m = T().merit; if (m.status !== 'Draft') fail('The merit cycle has been submitted.');
    const p = +pct; if (!Number.isFinite(p) || p < 0 || p > 25) fail('Budget must be from 0% to 25% of payroll.');
    m.budgetPct = r2(p); return m;
  }
  function setMeritProposal(empId, pct) {
    const m = T().merit; if (m.status !== 'Draft') fail('The merit cycle has been submitted.');
    const e = E.need(E.emp(empId), 'Employee'); if (e.status !== 'Active') fail(`${e.name} is not active.`);
    const p = pct === '' || pct === null || pct === undefined ? 0 : +pct; if (!Number.isFinite(p) || p < 0 || p > 30) fail('Merit increase must be from 0% to 30%.');
    if (p) m.proposals[empId] = r2(p); else delete m.proposals[empId]; return m;
  }
  /** {payroll, budget, proposed, remaining, overBudget, rows:[{e, pct, amount, newSalary}]} */
  function meritSummary(proposals) {
    const m = T().merit; const props = proposals || m.proposals;
    const act = E.S.employees.filter((e) => e.status === 'Active');
    const rows = act.map((e) => { const pct = +props[e.id] || 0; const newSalary = r2(e.salary * (1 + pct / 100)); return { e, pct, amount: r2(newSalary - e.salary), newSalary }; });
    const payroll = sum(act, (e) => e.salary), budget = r2(payroll * m.budgetPct / 100), proposed = sum(rows, (r) => r.amount);
    return { payroll, budgetPct: m.budgetPct, budget, proposed, remaining: r2(budget - proposed), overBudget: proposed > budget + 0.005, proposedPct: payroll ? r2(proposed / payroll * 100) : 0, rows, status: m.status, effective: m.effective };
  }
  /** Creates a Merit change request effective 2027-01-01 for every proposal; blocked when over budget. */
  function submitMeritCycle() {
    const m = T().merit; if (m.status !== 'Draft') fail('The merit cycle has already been submitted.');
    const sm = meritSummary(); const rows = sm.rows.filter((r) => r.pct > 0);
    if (!rows.length) fail('Propose at least one merit increase first.');
    if (sm.overBudget) fail(`Proposals total ${money(sm.proposed)}, ${money(r2(sm.proposed - sm.budget))} over the ${money(sm.budget)} budget. Reduce proposals or raise the budget.`);
    const clash = rows.find((r) => T().compChanges.some((c) => c.empId === r.e.id && ['Pending Approval', 'Approved'].includes(c.status)));
    if (clash) fail(`${clash.e.name} already has an open salary change. Decide or cancel it before submitting the merit cycle.`);
    const ids = rows.map((r) => requestSalaryChange({ empId: r.e.id, newSalary: r.newSalary, reason: 'Merit', effectiveDate: m.effective, note: `FY27 merit cycle (${r.pct}%)`, source: 'merit' }).id);
    m.status = 'Submitted'; m.submittedDate = now(); m.submittedBy = user(); m.changeIds = ids; m.totals = { budget: sm.budget, proposed: sm.proposed, payroll: sm.payroll };
    E.log('Submitted merit cycle', 'FY27 merit', `${ids.length} change(s), ${money(sm.proposed)} of ${money(sm.budget)} budget`); return ids;
  }

  // =================================================================== core wrappers
  const origHire = E.hireEmployee;
  /** Records the starting salary in salary history. */
  function hireEmployee(args) {
    const e = origHire(args);
    E.S.talent.salaryHistory.push({ empId: e.id, date: e.hireDate, salary: e.salary, prev: 0, reason: 'Hire', ref: '' });
    return e;
  }
  const origPayroll = E.runPayroll;
  /** Applies approved salary changes effective on/before the period end, then runs payroll. Undone if payroll throws. */
  function runPayroll(p) {
    const S = E.S;
    const due = S.talent && S.periods[p] === 'Open' && !S.payruns.some((r) => r.period === p) ? S.talent.compChanges.filter((c) => c.status === 'Approved' && c.effectiveDate <= periodEnd(p)) : [];
    if (!due.length) return origPayroll(p);
    const before = { emps: due.map((c) => { const e = E.emp(c.empId); return e && [e, e.salary]; }).filter(Boolean), changes: due.map((c) => [c, { ...c }]), hist: S.talent.salaryHistory.length, audit: S.audit.length };
    applyDueChanges(periodEnd(p));
    try { return origPayroll(p); } catch (err) {
      before.emps.forEach(([e, s]) => (e.salary = s));
      before.changes.forEach(([c, copy]) => { Object.keys(c).forEach((k) => delete c[k]); Object.assign(c, copy); });
      S.talent.salaryHistory.length = before.hist; S.audit.splice(0, S.audit.length - before.audit);
      throw err;
    }
  }

  // =================================================================== hooks
  E.on('approvals', () => {
    const t = T(); if (!t) return []; const out = [];
    t.jobReqs.filter((r) => r.status === 'Pending Approval').forEach((r) => out.push({ kind: 'jobreq', id: r.id, title: `Job requisition: ${r.title} (${r.headcount})`, who: E.emp(r.hiringManagerId)?.name || r.createdBy, date: r.submittedDate || r.date, perm: 'hr.recruit.approve', why: `${r.reason} role in ${r.dept}, ${money(r.salaryMin)} to ${money(r.salaryMax)}` }));
    t.candidates.filter((c) => c.offer && c.offer.status === 'Pending Approval').forEach((c) => out.push({ kind: 'candidate', id: c.id, title: `Offer ${money(c.offer.salary)}: ${c.name}`, who: c.offer.by, date: c.offer.date, perm: 'hr.recruit.approve', why: c.offer.why }));
    t.compChanges.filter((c) => c.status === 'Pending Approval').forEach((c) => out.push({ kind: 'comp', id: c.id, title: `Salary change +${c.pct}%: ${E.emp(c.empId)?.name}`, who: c.requestedBy, date: c.date, perm: 'hr.comp.approve', why: `${c.reason}, over ${COMP_APPROVAL_PCT}% increase limit` }));
    return out;
  });
  E.on('search', (q, hit) => {
    const t = T(); if (!t) return []; const out = [];
    t.jobReqs.forEach((r) => hit(r.id, r.title, r.dept) && out.push({ kind: 'jobreq', id: r.id, label: `${r.id} ${r.title}`, sub: `Job requisition, ${r.dept}, ${r.status}` }));
    t.candidates.forEach((c) => hit(c.id, c.name, c.email) && out.push({ kind: 'candidate', id: c.id, label: c.name, sub: `Candidate, ${jobReq(c.reqId)?.title || ''}, ${c.stage}` }));
    t.compChanges.forEach((c) => hit(c.id) && out.push({ kind: 'comp', id: c.id, label: c.id, sub: `Salary change, ${E.emp(c.empId)?.name}, ${c.status}` }));
    return out;
  });

  // =================================================================== seed
  const GOAL_LIB = {
    Executive: [['Deliver FY27 operating plan', 40], ['Close two strategic partnerships', 30], ['Improve employee engagement score to 80', 30]],
    Finance: [['Close books by working day 5', 35], ['Automate supplier invoice matching', 25], ['Reduce DSO to 38 days', 25], ['Complete audit readiness checklist', 15]],
    Operations: [['Hold on-time shipment at 97%', 35], ['Cut inventory shrinkage by 20%', 25], ['Qualify a second cable supplier', 20], ['Zero lost-time safety incidents', 20]],
    Sales: [['Book $2.4M in new orders', 40], ['Grow life sciences pipeline 30%', 30], ['Renew all public-sector contracts', 30]],
    Engineering: [['Ship HX-400 sensor firmware v2', 40], ['Reduce field failure rate below 0.5%', 30], ['Document calibration test suite', 15], ['Mentor one junior engineer', 15]],
    People: [['Fill open requisitions within 45 days', 35], ['Launch FY27 mid-year review cycle', 35], ['Refresh onboarding programme', 30]],
  };
  const COMMENTS = ['Strong delivery against plan; clear communication with partners.', 'Met most goals; needs to delegate more as scope grows.', 'Exceptional quarter; led the work that unblocked the team.', 'Solid and dependable; development focus on cross-team influence.', 'Below expectations on the main goal; recovery plan agreed.'];

  E.on('seedSetup', (ctx) => {
    const { S, at } = ctx; const byName = (n) => S.employees.find((e) => e.name === n);
    // Prior-year merit, effective 1 Jul 2026 (before any FY27 payroll runs)
    at('2026-07-01');
    [['Hana Sato', 4], ['Avery Lin', 3.5], ['Marco Bellini', 3], ['Ines Duarte', 4.5], ['Dana Whitfield', 3], ['Oliver Brandt', 2.5], ['Sam Achebe', 3]].forEach(([n, pct]) => {
      const e = byName(n); if (!e) return;
      ctx.asRole('HR Specialist', 'Nadia Petrova', () => requestSalaryChange({ empId: e.id, newSalary: Math.round(e.salary * (1 + pct / 100) / 100) * 100, reason: 'Merit', effectiveDate: '2026-07-01', note: 'FY26 year-end merit' }));
    });
  });

  E.on('seedFinal', (ctx) => {
    const { S, at, asRole } = ctx; const byName = (n) => S.employees.find((e) => e.name === n);
    const HR = (fn) => asRole('HR Specialist', 'Nadia Petrova', fn);
    // ---------- recruiting ----------
    at('2026-10-05');
    const fw = HR(() => createJobReq({ title: 'Firmware Engineer II', dept: 'Engineering', hiringManagerId: byName('Lena Park').id, salaryMin: 135000, salaryMax: 165000, headcount: 1, reason: 'New', date: '2026-10-05', submit: true, notes: 'Second firmware engineer for the HX-400 programme.' }));
    at('2026-10-07'); asRole('Administrator', 'System Administrator', () => approveJobReq(fw.id));
    at('2026-10-20');
    const fst = HR(() => createJobReq({ title: 'Field Service Technician', dept: 'Operations', hiringManagerId: byName('Priya Raman').id, salaryMin: 62000, salaryMax: 78000, headcount: 2, reason: 'Backfill', date: '2026-10-20', submit: true, notes: 'Install and calibration visits for Meridian and Pinecrest.' }));
    at('2026-10-21'); asRole('Administrator', 'System Administrator', () => approveJobReq(fst.id));
    at('2026-11-15');
    HR(() => createJobReq({ title: 'Inside Sales Representative', dept: 'Sales', hiringManagerId: byName('Jonas Weller').id, salaryMin: 68000, salaryMax: 84000, headcount: 1, reason: 'New', date: '2026-11-15', submit: true, notes: 'Covers inbound leads from the careers-site relaunch.' }));
    const C = (req, d, name, source, stages, extra = {}) => {
      at(d); const c = HR(() => addCandidate({ reqId: req.id, name, email: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@mail.example', source, date: d, notes: extra.notes || '' }));
      stages.forEach(([day]) => { at(day); HR(() => advanceCandidate(c.id)); });
      (extra.fb || []).forEach((f) => { at(f.date); HR(() => addFeedback(c.id, f)); });
      return c;
    };
    C(fw, '2026-10-12', 'Tomasz Novak', 'Job board', []);
    C(fw, '2026-10-09', 'Aisha Karim', 'Referral', [['2026-10-16']]);
    C(fw, '2026-10-08', 'Rafael Ortiz', 'Careers site', [['2026-10-14'], ['2026-10-28']], { fb: [{ interviewer: 'Lena Park', rating: 4, comment: 'Solid RTOS fundamentals, good debugging story.', recommend: 'Yes', date: '2026-11-03' }] });
    const off = C(fw, '2026-10-06', 'Mei Lindqvist', 'Agency', [['2026-10-10'], ['2026-10-20']], { fb: [{ interviewer: 'Lena Park', rating: 5, comment: 'Best candidate this year; shipped similar sensor firmware.', recommend: 'Yes', date: '2026-10-27' }, { interviewer: 'Hana Sato', rating: 5, comment: 'Excellent code review exercise.', recommend: 'Yes', date: '2026-10-28' }] });
    const rj = C(fw, '2026-10-07', 'Brendan Coyle', 'Job board', [['2026-10-13']]);
    at('2026-10-15'); HR(() => rejectCandidate(rj.id, 'Not enough embedded experience'));
    at('2026-11-14'); HR(() => makeOffer(off.id, { salary: 172000, startDate: '2027-01-11' })); // above range: pending approval
    C(fst, '2026-11-09', 'Lucia Ferreira', 'Careers site', []);
    C(fst, '2026-11-11', 'Darnell Hughes', 'Referral', []);
    C(fst, '2026-10-24', 'Yusuf Demir', 'Job board', [['2026-10-30']]);
    C(fst, '2026-10-23', 'Grace Mbeki', 'Internal', [['2026-10-27'], ['2026-11-05']], { fb: [{ interviewer: 'Priya Raman', rating: 4, comment: 'Hands-on calibration background; great with customers.', recommend: 'Yes', date: '2026-11-10' }] });
    C(fst, '2026-10-26', 'Owen Pritchard', 'University', [['2026-11-02'], ['2026-11-09']], { fb: [{ interviewer: 'Marco Bellini', rating: 3, comment: 'Keen, light on field experience.', recommend: 'Maybe', date: '2026-11-12' }] });

    // ---------- performance ----------
    at('2026-11-02');
    const act = S.employees.filter((e) => e.status === 'Active').sort((a, b) => a.id.localeCompare(b.id));
    act.forEach((e, i) => {
      const lib = GOAL_LIB[e.dept] || GOAL_LIB.People;
      lib.forEach(([title, weight], k) => { const prog = [20, 45, 60, 35, 80, 10, 55][(i + k) % 7]; addGoal({ empId: e.id, title, weight, targetDate: k % 2 ? '2027-03-31' : '2027-06-30', progress: prog, status: (i + k) % 9 === 4 ? 'At risk' : undefined }); });
      if (i % 5 !== 3) submitGoals(e.id);
    });
    launchReviews();
    const revs = T().reviews.filter((r) => r.cycleId === CYCLE.id).sort((a, b) => a.empId.localeCompare(b.empId));
    const ratings = [4, 3, 5, 3, 4, 2, 3, 4];
    revs.forEach((r, i) => {
      const mode = i % 4; // 0,1 completed-ish; 2 manager review; 3 self review/not started
      if (mode === 3 && i % 8 === 7) return; // Not started
      at('2026-11-0' + (3 + (i % 6)));
      const sr = Math.min(5, ratings[i % ratings.length] + (i % 3 === 0 ? 1 : 0));
      if (mode === 3) { saveSelfReview(r.id, { rating: sr, comments: 'Draft: progress on goals so far.' }); return; }
      saveSelfReview(r.id, { rating: sr, comments: 'Delivered the main commitments for the half; see goal progress.', submit: true });
      if (mode === 2) return;
      at('2026-11-1' + (i % 6));
      saveManagerReview(r.id, { rating: ratings[i % ratings.length], comments: COMMENTS[i % COMMENTS.length], submit: true });
    });

    // ---------- compensation ----------
    at('2026-11-10');
    HR(() => requestSalaryChange({ empId: byName('Oliver Brandt').id, newSalary: 170000, reason: 'Promotion', effectiveDate: '2027-01-01', note: 'Promotion to Senior Hardware Engineer' })); // > 10%: pending approval
    at('2026-11-12');
    HR(() => requestSalaryChange({ empId: byName('Kwame Asante').id, newSalary: 101000, reason: 'Market', effectiveDate: '2027-01-01', note: 'Market adjustment after benchmark' })); // approved, future-dated
    // draft merit proposals
    const m = T().merit; m.budgetPct = 3.5;
    act.forEach((e, i) => { if (e.name !== 'Oliver Brandt' && e.name !== 'Kwame Asante') m.proposals[e.id] = [3, 3.5, 2.5, 4, 3][i % 5]; });
    while (meritSummary().overBudget) { const k = Object.keys(m.proposals)[0]; m.proposals[k] = r2(m.proposals[k] - 0.5); if (m.proposals[k] <= 0) delete m.proposals[k]; }
  });

  // =================================================================== permissions + exports
  E.addPerms('HR Specialist', ['hr.recruit', 'hr.recruit.approve', 'hr.perf', 'hr.comp', 'hr.comp.approve']);
  Object.keys(E.ROLES).forEach((r) => E.addPerms(r, ['hr.goals']));

  E.extend({
    TALENT: { REQ_STATUSES, STAGES, SOURCES, REQ_REASONS, COMP_REASONS, GOAL_STATUSES, REVIEW_STATES, COMP_APPROVAL_PCT, MERIT_EFFECTIVE, CYCLE },
    jobReq, candidate, goal, review, compChange,
    createJobReq, submitJobReq, approveJobReq, rejectJobReq, cancelJobReq, openHeadcount,
    addCandidate, advanceCandidate, rejectCandidate, updateCandidate, addFeedback, makeOffer, approveOffer, rejectOffer, acceptOffer, declineOffer, timeInStage,
    goalsOf, goalWeight, goalPlan: plan, addGoal, updateGoal, deleteGoal, submitGoals,
    reviewCycle: cycle, launchReviews, saveSelfReview, saveManagerReview, calibration,
    salaryHistory, pctChange, requestSalaryChange, approveSalaryChange, rejectSalaryChange, cancelSalaryChange, applyDueChanges,
    setMeritBudget, setMeritProposal, meritSummary, submitMeritCycle,
    hireEmployee, runPayroll,
  });
  void periodLabel;
})(typeof window !== 'undefined' ? window : globalThis);
