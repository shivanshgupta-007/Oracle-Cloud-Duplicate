/* Ledgerline Suite — commands.js: the single source of truth for which engine functions are writes
 * (commands a client may send) and which permission each needs. Loaded by server/server.js and served
 * to the browser at /js/commands.js (sets window.LedgerlineCommands). No DOM, no dependencies.
 *
 * PERMS: fn -> perm string or array of perms (any one suffices, checked with Engine.can(role, perm)).
 * A function that is not listed but whose name starts with a write verb (WRITE_VERB) is still treated
 * as a command, but needs ADMIN_ONLY (Administrator). Everything else is read-only and never accepted. */
(function (root) {
  'use strict';
  const PERMS = {
    // general ledger
    createManualJournal: 'gl.post', createJournal: ['gl.post', 'hr.payroll'], reverseJournal: 'gl.post', remitSalesTax: 'gl.post',
    processAutoReversals: 'gl.post', setFxRate: 'gl.post',
    approveJournal: 'gl.approve', rejectJournal: 'gl.approve',
    closePeriod: 'gl.close', reopenPeriod: 'gl.close', openPeriod: 'gl.close',
    runDepreciation: 'gl.depr', addAccount: 'gl.coa',
    createRecurring: 'gl.recurring', recurringFromJournal: 'gl.recurring', generateRecurring: 'gl.recurring', setRecurringActive: 'gl.recurring',
    // procure to pay
    createReq: 'req.create', approveReq: 'req.approve', rejectReq: 'req.approve',
    createPO: 'po.create', receivePO: 'po.receive',
    enterAPInvoice: 'ap.enter', cancelAPInvoice: 'ap.enter', createAPInvoice: 'ap.enter', createAPCreditMemo: 'ap.enter',
    releaseHold: 'ap.release', payInvoices: 'ap.pay', addSupplier: 'supplier.edit',
    // order to cash
    createSO: 'so.create', cancelSO: 'so.create', releaseCreditHold: 'so.release', shipSO: 'so.ship',
    applyReceipt: 'ar.receipt', createARInvoice: 'ar.receipt', createARCreditMemo: 'ar.receipt', addCustomer: 'customer.edit',
    // inventory
    addItem: 'item.edit', adjustInventory: 'inv.adjust',
    createCount: 'inv.adjust', enterCounts: 'inv.adjust', postCount: 'inv.adjust', cancelCount: 'inv.adjust',
    // HCM
    hireEmployee: 'hr.edit', terminateEmployee: 'hr.edit',
    requestAbsence: 'hr.absence.create', approveAbsence: 'hr.absence.approve', rejectAbsence: 'hr.absence.approve',
    runPayroll: 'hr.payroll',
    // fixed assets
    addAsset: 'fa.edit', transferAsset: 'fa.edit', retireAsset: 'fa.edit', approveAsset: 'fa.approve', rejectAsset: 'fa.approve',
    // projects, time, expenses
    createProject: 'prj.edit', closeProject: 'prj.edit',
    createTimesheet: 'prj.time', submitTimesheet: 'prj.time', approveTimesheet: 'prj.approve', rejectTimesheet: 'prj.approve',
    createExpenseReport: 'exp.submit', submitExpenseReport: 'exp.submit', approveExpenseReport: 'prj.approve', rejectExpenseReport: 'prj.approve',
    reimburseExpenses: 'exp.reimburse', generateProjectInvoice: 'prj.bill', billFixedPrice: 'prj.bill',
    // planning and budgets
    setBudgetCell: 'plan.edit', setBudgetRow: 'plan.edit', spreadAnnual: 'plan.edit', copyVersion: 'plan.edit', copyActuals: 'plan.edit', setVersionLock: 'plan.edit',
    // CRM
    createLead: 'crm.edit', setLeadStatus: 'crm.edit', convertLead: 'crm.edit', createOpp: 'crm.edit', updateOpp: 'crm.edit', setOppStage: 'crm.edit',
    advanceOpp: 'crm.edit', createQuote: 'crm.edit', sendQuote: 'crm.edit', acceptQuote: 'crm.edit', expireQuotes: 'crm.edit', logActivity: 'crm.edit',
    approveQuote: 'crm.discount', rejectQuote: 'crm.discount',
    // manufacturing and supply planning
    saveBOM: 'mfg.edit', createWO: 'mfg.edit', releaseWO: 'mfg.edit', issueComponents: 'mfg.edit', reportCompletion: 'mfg.edit', closeWO: 'mfg.edit', cancelWO: 'mfg.edit',
    createPlannedReqs: 'mfg.plan', createPlannedWOs: 'mfg.plan',
    // talent
    createJobReq: 'hr.recruit', submitJobReq: 'hr.recruit', cancelJobReq: 'hr.recruit', approveJobReq: 'hr.recruit.approve', rejectJobReq: 'hr.recruit.approve',
    addCandidate: 'hr.recruit', advanceCandidate: 'hr.recruit', rejectCandidate: 'hr.recruit', updateCandidate: 'hr.recruit', addFeedback: 'hr.recruit',
    makeOffer: 'hr.recruit', acceptOffer: 'hr.recruit', declineOffer: 'hr.recruit', approveOffer: 'hr.recruit.approve', rejectOffer: 'hr.recruit.approve',
    addGoal: 'hr.goals', updateGoal: 'hr.goals', deleteGoal: 'hr.goals', submitGoals: 'hr.goals', saveSelfReview: 'hr.goals',
    launchReviews: 'hr.perf', saveManagerReview: 'hr.perf',
    requestSalaryChange: 'hr.comp', cancelSalaryChange: 'hr.comp', applyDueChanges: 'hr.comp', setMeritBudget: 'hr.comp', setMeritProposal: 'hr.comp', submitMeritCycle: 'hr.comp',
    approveSalaryChange: 'hr.comp.approve', rejectSalaryChange: 'hr.comp.approve',
    // cash management
    autoMatchStatement: 'cash.reconcile', matchBankLine: 'cash.reconcile', unmatchBankLine: 'cash.reconcile', createBankAccounting: 'cash.reconcile',
    markStatementReconciled: 'cash.reconcile', reopenBankStatement: 'cash.reconcile',
  };
  const ADMIN_ONLY = 'admin';
  /** Engine plumbing and known reads that look like writes by name: never commands. */
  const NEVER = new Set(['reset', 'load', 'log', 'nextId', 'on', 'addPerms', 'touch', 'need', 'fail', 'extend', 'can', 'assertOpen', 'ensureAccount',
    'openAR', 'openAmt', 'openHeadcount', 'closeChecklist', 'setup']);
  const WRITE_VERB = /^(create|approve|reject|post|run|close|reopen|open|add|update|set|save|delete|remove|cancel|receive|pay|ship|apply|release|hire|terminate|request|import|transfer|generate|reverse|remit|enter|submit|launch|retire|convert|advance|send|accept|decline|make|issue|copy|spread|mark|match|unmatch|reimburse|bill|expire|recognize|allocate|pick|pack|assign|lock|unlock|confirm|complete|void|refund|adjust|consolidate|eliminate|archive|restore|defer|amortize)[A-Z]/;
  /** True if `fn` is a state-changing engine function (a command). */
  function isWrite(fn) { return typeof fn === 'string' && !NEVER.has(fn) && (Object.prototype.hasOwnProperty.call(PERMS, fn) || WRITE_VERB.test(fn)); }
  /** Perms that allow fn (array), or null if fn is not a command. */
  function permsFor(fn) { if (!isWrite(fn)) return null; const p = Object.prototype.hasOwnProperty.call(PERMS, fn) ? PERMS[fn] : ADMIN_ONLY; return Array.isArray(p) ? p : [p]; }
  /** Can a user with `role` run fn? Uses Engine.can; 'admin' means Administrator only. */
  function allowed(E, role, fn) {
    const ps = permsFor(fn); if (!ps) return false;
    return ps.some((p) => (p === ADMIN_ONLY ? role === 'Administrator' : E.can(role, p)));
  }
  const api = { PERMS, ADMIN_ONLY, NEVER, WRITE_VERB, isWrite, permsFor, allowed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LedgerlineCommands = api;
})(typeof window !== 'undefined' ? window : globalThis);
