/* Ledgerline Suite: views-talent.js
 * Talent screens (group People): Recruiting (requisitions + pipeline board), Performance
 * (goals, reviews, calibration) and Compensation (salary changes, history, merit planner).
 * Rules live in js/ext-talent.js.
 */
(function () {
  'use strict';
  const App = window.App, E = App.E, U = App.U;
  const esc = App.esc, fmt = App.fmt, fmt0 = App.fmt0, fdate = App.fdate, pill = App.pill;
  const TT = E.TALENT;
  const T = () => E.S.talent;
  const active = () => E.S.employees.filter((e) => e.status === 'Active').sort((a, b) => a.name.localeCompare(b.name));
  const empLink = (id) => { const e = E.emp(id); return e ? App.link('emp', e.id, e.name) : '<span class="muted">None</span>'; };
  const nowrap = (s) => `<span style="white-space:nowrap">${s}</span>`;
  const TONE = { Draft: '', 'Pending Approval': 'warn', Open: 'info', Filled: 'good', Cancelled: '', Applied: '', Screen: 'info', Interview: 'accent', Offer: 'warn', Hired: 'good', Rejected: 'bad',
    Approved: 'accent', Applied_: 'good', Accepted: 'good', Declined: 'bad', Withdrawn: '', 'Not started': '', 'Self review': 'info', 'Manager review': 'warn', Completed: 'good', 'In progress': 'info', 'At risk': 'bad', Submitted: 'good' };
  const tpill = (s, kind) => pill(s, kind === 'comp' && s === 'Applied' ? 'good' : (TONE[s] ?? ''));
  const stars = (n) => n ? `<span aria-label="Rating ${n} of 5" title="${n} of 5">${'&#9733;'.repeat(n)}<span class="muted">${'&#9733;'.repeat(5 - n)}</span></span>` : '<span class="muted small">Not rated</span>';
  const range = (r) => `${fmt0(r.salaryMin)} to ${fmt0(r.salaryMax)}`;
  const bar = (pct, label, tone = 'var(--accent)') => `<div role="img" aria-label="${esc(label)}" style="height:8px;border-radius:4px;background:var(--line-2);min-width:60px;overflow:hidden"><div style="height:100%;width:${Math.max(0, Math.min(100, pct))}%;background:${tone}"></div></div>`;
  const textarea = (id, value = '', rows = 3) => `<textarea id="${id}" name="${id}" rows="${rows}">${esc(value)}</textarea>`;
  const ratingOpts = [['1', '1 - Below expectations'], ['2', '2 - Partially meets'], ['3', '3 - Meets expectations'], ['4', '4 - Exceeds'], ['5', '5 - Outstanding']];
  const pendingRecruit = () => T().jobReqs.filter((r) => r.status === 'Pending Approval').length + T().candidates.filter((c) => c.offer && c.offer.status === 'Pending Approval').length;
  const pendingComp = () => T().compChanges.filter((c) => c.status === 'Pending Approval').length;
  App.navCount('recruiting', pendingRecruit);
  App.navCount('compensation', pendingComp);
  App.refKind('JR-', 'jobreq'); App.refKind('CAN-', 'candidate'); App.refKind('SC-', 'comp');

  // =================================================================== recruiting actions
  App.act('jr-new', () => {
    const act = active();
    App.drawer('New job requisition', `<div class="row">${App.field('Job title', App.input('jrTitle', '', 'text', 'placeholder="e.g. Test Engineer" autocomplete="off"'))}${App.field('Department', App.select('jrDept', E.S.departments))}</div>`
      + `<div class="row">${App.field('Hiring manager', App.select('jrMgr', act.map((e) => [e.id, `${e.name}, ${e.title}`])))}${App.field('Reason', App.select('jrReason', TT.REQ_REASONS))}${App.field('Headcount', App.input('jrHc', '1', 'number', 'min="1" step="1"'))}</div>`
      + `<div class="row">${App.field('Salary range minimum', App.input('jrMin', '', 'number', 'min="0" step="1000" placeholder="e.g. 80000"'))}${App.field('Salary range maximum', App.input('jrMax', '', 'number', 'min="0" step="1000" placeholder="e.g. 100000"'))}</div>`
      + App.field('Notes', textarea('jrNotes'))
      + App.field('Save as', App.select('jrSubmit', [['1', 'Submit for approval'], ['0', 'Draft']]), 'HR or an Administrator approves requisitions before candidates can be added.'),
      { submitLabel: 'Create requisition',
        onSubmit: (f) => E.createJobReq({ title: App.val(f, 'jrTitle'), dept: App.val(f, 'jrDept'), hiringManagerId: App.val(f, 'jrMgr'), reason: App.val(f, 'jrReason'), headcount: App.val(f, 'jrHc'), salaryMin: App.val(f, 'jrMin'), salaryMax: App.val(f, 'jrMax'), notes: App.val(f, 'jrNotes'), submit: App.val(f, 'jrSubmit') === '1' }),
        success: (r) => `${r.id} ${r.status === 'Draft' ? 'saved as draft' : 'submitted for approval'}.` });
  });
  App.act('jr-submit', (ds) => App.try(() => E.submitJobReq(ds.id), `${ds.id} submitted for approval.`));
  App.act('jr-approve', (ds) => App.try(() => E.approveJobReq(ds.id), `${ds.id} approved and open for candidates.`));
  App.act('jr-reject', (ds) => App.try(() => E.rejectJobReq(ds.id, 'Returned for changes'), `${ds.id} returned to draft.`));
  App.act('jr-cancel', (ds) => App.confirm(`Cancel ${ds.id}`, 'Cancel this requisition? Active candidates are closed as rejected.', 'Cancel requisition', () => E.cancelJobReq(ds.id), `${ds.id} cancelled.`));
  App.act('cand-new', (ds) => {
    const reqs = T().jobReqs.filter((r) => r.status === 'Open');
    if (!reqs.length) { App.toast('There is no open requisition. Approve a requisition first.', 'bad'); return; }
    App.drawer('Add candidate', `${App.field('Requisition', App.select('cnReq', reqs.map((r) => [r.id, `${r.id} ${r.title} (${E.openHeadcount(r)} open)`]), ds.req || reqs[0].id))}`
      + `<div class="row">${App.field('Full name', App.input('cnName', '', 'text', 'autocomplete="off"'))}${App.field('Email', App.input('cnEmail', '', 'email', 'autocomplete="off"'))}${App.field('Source', App.select('cnSrc', TT.SOURCES))}</div>`
      + App.field('Notes', textarea('cnNotes')),
      { submitLabel: 'Add candidate', onSubmit: (f) => E.addCandidate({ reqId: App.val(f, 'cnReq'), name: App.val(f, 'cnName'), email: App.val(f, 'cnEmail'), source: App.val(f, 'cnSrc'), notes: App.val(f, 'cnNotes') }), success: (c) => `${c.name} added as ${c.id}.` });
  });
  App.act('cand-advance', (ds) => App.try(() => E.advanceCandidate(ds.id), (c) => `${c.name} moved to ${c.stage}.`));
  App.act('cand-reject', (ds) => { const c = E.candidate(ds.id);
    App.drawer(`Reject ${c.name}`, App.field('Reason', App.input('crReason', '', 'text', 'placeholder="e.g. Chose a stronger candidate"')), { submitLabel: 'Reject candidate', onSubmit: (f) => E.rejectCandidate(c.id, App.val(f, 'crReason')), success: `${c.name} rejected.` });
  });
  App.act('cand-offer', (ds) => { const c = E.candidate(ds.id), r = E.jobReq(c.reqId);
    const mid = Math.round((r.salaryMin + r.salaryMax) / 2 / 1000) * 1000;
    App.drawer(`Offer for ${c.name}`, `<p>${esc(r.id)} ${esc(r.title)}, range <b class="num">${range(r)}</b>.</p><div class="row">${App.field('Annual salary (USD)', App.input('ofSal', c.offer ? c.offer.salary : mid, 'number', 'min="0" step="500"'))}${App.field('Start date', App.input('ofStart', c.offer ? c.offer.startDate : U.addDays(E.S.today, 28), 'date'))}</div><div class="callout" id="ofInfo"></div>`,
      { submitLabel: 'Make offer',
        oninput: (f) => { const s = +App.val(f, 'ofSal') || 0; const el = App.$('#ofInfo', f); el.className = 'callout' + (s > r.salaryMax ? ' warn' : ''); el.textContent = s > r.salaryMax ? `Above the range maximum by ${fmt(s - r.salaryMax)}: the offer goes to HR for approval before the candidate can accept.` : s < r.salaryMin ? `Below the range minimum ${fmt(r.salaryMin)}.` : 'Within range: the offer is approved immediately.'; },
        onSubmit: (f) => E.makeOffer(c.id, { salary: App.val(f, 'ofSal'), startDate: App.val(f, 'ofStart') }),
        success: (o) => o.status === 'Approved' ? `Offer to ${c.name} approved. Record acceptance when they sign.` : `Offer to ${c.name} sent for approval.` });
  });
  App.act('offer-approve', (ds) => App.try(() => E.approveOffer(ds.id), 'Offer approved.'));
  App.act('offer-reject', (ds) => App.try(() => E.rejectOffer(ds.id, 'Revise within range'), 'Offer rejected; revise and resubmit.'));
  App.act('offer-accept', (ds) => { const c = E.candidate(ds.id), r = E.jobReq(c.reqId);
    App.confirm(`Hire ${c.name}`, `Record that ${esc(c.name)} accepted. This hires them as ${esc(r.title)} in ${esc(r.dept)} reporting to ${esc(E.emp(r.hiringManagerId)?.name || 'no manager')}, at <b class="num">${fmt(c.offer.salary)}</b>, starting ${esc(fdate(c.offer.startDate))}.`, 'Accept and hire', () => E.acceptOffer(c.id), (e) => `${e.name} hired as ${e.id}.`);
  });
  App.act('offer-decline', (ds) => App.try(() => E.declineOffer(ds.id), 'Offer declined; candidate closed.'));
  App.act('cand-feedback', (ds) => { const c = E.candidate(ds.id);
    App.drawer(`Interview feedback: ${c.name}`, `<div class="row">${App.field('Interviewer', App.input('fbWho', E.S.user))}${App.field('Rating', App.select('fbRate', ratingOpts, '3'))}${App.field('Recommend hire', App.select('fbRec', ['Yes', 'Maybe', 'No']))}</div>${App.field('Comments', textarea('fbText'))}`,
      { submitLabel: 'Add feedback', onSubmit: (f) => E.addFeedback(c.id, { interviewer: App.val(f, 'fbWho'), rating: App.val(f, 'fbRate'), recommend: App.val(f, 'fbRec'), comment: App.val(f, 'fbText') }), success: 'Feedback added.' });
  });
  App.act('cand-edit', (ds) => { const c = E.candidate(ds.id);
    App.drawer(`Edit ${c.name}`, `<div class="row">${App.field('Rating', App.select('ceRate', [['', 'Not rated'], ...ratingOpts], c.rating || ''))}${App.field('Source', App.select('ceSrc', TT.SOURCES, c.source))}</div>${App.field('Notes', textarea('ceNotes', c.notes))}`,
      { submitLabel: 'Save', onSubmit: (f) => E.updateCandidate(c.id, { rating: App.val(f, 'ceRate'), source: App.val(f, 'ceSrc'), notes: App.val(f, 'ceNotes') }), success: 'Candidate updated.' });
  });

  /** Buttons for a candidate card / drawer. */
  function candButtons(c, sm = ' sm') {
    const r = E.jobReq(c.reqId); const open = r && r.status === 'Open'; const out = [];
    if (open && (c.stage === 'Applied' || c.stage === 'Screen')) out.push(App.btn('Advance', 'cand-advance', { id: c.id }, 'hr.recruit', 'primary' + sm));
    if (open && c.stage === 'Interview') out.push(App.btn('Advance', 'cand-offer', { id: c.id }, 'hr.recruit', 'primary' + sm));
    if (c.stage === 'Offer' && c.offer) {
      if (c.offer.status === 'Pending Approval') out.push(App.btn('Approve offer', 'offer-approve', { id: c.id }, 'hr.recruit.approve', 'primary' + sm), App.btn('Reject offer', 'offer-reject', { id: c.id }, 'hr.recruit.approve', 'danger' + sm));
      if (c.offer.status === 'Approved') out.push(App.btn('Accept and hire', 'offer-accept', { id: c.id }, 'hr.recruit', 'primary' + sm), App.btn('Declined', 'offer-decline', { id: c.id }, 'hr.recruit', sm));
      if (c.offer.status === 'Rejected' && open) out.push(App.btn('Revise offer', 'cand-offer', { id: c.id }, 'hr.recruit', sm));
    }
    if (!['Hired', 'Rejected'].includes(c.stage)) out.push(App.btn('Reject', 'cand-reject', { id: c.id }, 'hr.recruit', 'danger' + sm));
    return out.join('');
  }
  const reqButtons = (r, sm = ' sm') => [
    r.status === 'Draft' && App.btn('Submit', 'jr-submit', { id: r.id }, 'hr.recruit', sm),
    r.status === 'Pending Approval' && App.btn('Reject', 'jr-reject', { id: r.id }, 'hr.recruit.approve', 'danger' + sm),
    r.status === 'Pending Approval' && App.btn('Approve', 'jr-approve', { id: r.id }, 'hr.recruit.approve', 'primary' + sm),
    r.status === 'Open' && App.btn('Add candidate', 'cand-new', { req: r.id }, 'hr.recruit', sm),
  ].filter(Boolean).join('');

  function board(reqFilter) {
    const cands = T().candidates.filter((c) => (reqFilter ? c.reqId === reqFilter : ['Open', 'Filled'].includes(E.jobReq(c.reqId)?.status)));
    const cols = TT.STAGES.map((st) => {
      const list = cands.filter((c) => c.stage === st).sort((a, b) => a.stageDate.localeCompare(b.stageDate));
      const cards = list.map((c) => {
        const r = E.jobReq(c.reqId); const days = E.timeInStage(c);
        return `<li style="list-style:none;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--surface);display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;justify-content:space-between;gap:6px;align-items:baseline">${App.link('candidate', c.id, c.name)}<span class="small muted mono">${esc(c.id)}</span></div>
          <div class="small muted">${esc(r?.title || '')}</div>
          <div class="small" style="display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap">${stars(c.rating)}<span class="${days > 14 && st !== 'Hired' ? '' : 'muted'}" style="${days > 14 && st !== 'Hired' ? 'color:var(--warn)' : ''}">${days} day${days === 1 ? '' : 's'} in stage</span></div>
          ${c.offer && st === 'Offer' ? `<div class="small">${fmt0(c.offer.salary)} ${tpill(c.offer.status)}</div>` : ''}
          ${st === 'Hired' && c.empId ? `<div class="small">Employee ${App.link('emp', c.empId)}</div>` : ''}
          <div class="actions" style="gap:4px">${candButtons(c)}</div></li>`;
      }).join('');
      return `<section aria-label="${esc(st)}: ${list.length} candidate(s)" style="background:var(--surface-2);border:1px solid var(--line-2);border-radius:10px;padding:10px;min-width:0">
        <h3 style="margin:0 0 8px;font-size:13px;display:flex;justify-content:space-between">${esc(st)} <span class="pill">${list.length}</span></h3>
        <ul style="margin:0;padding:0;display:flex;flex-direction:column;gap:8px">${cards || '<li style="list-style:none" class="small muted">None</li>'}</ul></section>`;
    }).join('');
    const rej = cands.filter((c) => c.stage === 'Rejected');
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px">${cols}</div>`
      + `<div class="small muted" style="margin-top:10px">${rej.length} rejected or withdrawn: ${rej.map((c) => App.link('candidate', c.id, c.name)).join(', ') || 'none'}</div>`;
  }

  App.view('recruiting', {
    title: 'Recruiting', group: 'People',
    render() {
      const t = T(); const tab = App.tabOf('recruiting', 'reqs');
      const open = t.jobReqs.filter((r) => r.status === 'Open');
      const activeCands = t.candidates.filter((c) => !['Hired', 'Rejected'].includes(c.stage) && E.jobReq(c.reqId)?.status === 'Open');
      const head = App.head('People', 'Recruiting', 'Job requisitions, approvals and the candidate pipeline. Accepted offers hire the candidate into Workforce.',
        App.btn('Add candidate', 'cand-new', {}, 'hr.recruit') + App.btn('New requisition', 'jr-new', {}, 'hr.recruit', 'primary'));
      const kpis = `<div class="kpis">` + App.kpi('Open requisitions', App.num(open.length), `${App.num(open.reduce((a, r) => a + E.openHeadcount(r), 0))} open headcount`)
        + App.kpi('Active candidates', App.num(activeCands.length), `${activeCands.filter((c) => c.stage === 'Interview').length} interviewing`)
        + App.kpi('Offers out', App.num(t.candidates.filter((c) => c.stage === 'Offer').length), `${t.candidates.filter((c) => c.offer && c.offer.status === 'Pending Approval').length} awaiting approval`)
        + App.kpi('Awaiting approval', App.num(pendingRecruit()), 'Requisitions and above-range offers') + `</div>`;
      const tabs = App.tabs('recruiting', [['reqs', 'Requisitions'], ['pipeline', 'Pipeline']]);
      let body;
      if (tab === 'reqs') {
        const rows = t.jobReqs.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
        body = `<section class="card"><div class="card-h"><span>Job requisitions</span><span class="small muted">Draft, approval, open, filled</span></div>` + App.table([
          { h: 'Requisition', f: (r) => App.link('jobreq', r.id) + `<div class="small">${esc(r.title)}</div>` },
          { h: 'Department', f: (r) => esc(r.dept) },
          { h: 'Hiring manager', f: (r) => empLink(r.hiringManagerId) },
          { h: 'Salary range', num: true, f: (r) => range(r) },
          { h: 'Filled', num: true, f: (r) => `${r.filled} of ${r.headcount}` },
          { h: 'Reason', f: (r) => esc(r.reason) },
          { h: 'Candidates', num: true, f: (r) => App.num(t.candidates.filter((c) => c.reqId === r.id).length) },
          { h: 'Status', f: (r) => tpill(r.status) + `<div class="small muted">${nowrap(esc(fdate(r.date)))}</div>` },
          { h: '', f: (r) => `<div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">${reqButtons(r)}</div>` },
        ], rows, { empty: 'No requisitions yet. Use New requisition to open one.' }) + `</section>`;
      } else {
        const f = App.ui.filter.recruiting || '';
        body = `<section class="card"><div class="card-h" style="flex-wrap:wrap"><span>Candidate pipeline</span><label class="small muted" style="display:flex;gap:6px;align-items:center;font-weight:400;min-width:0;max-width:100%">Requisition ${App.select('rcReq', [['', 'All open and filled'], ...t.jobReqs.filter((r) => ['Open', 'Filled'].includes(r.status)).map((r) => [r.id, `${r.id} ${r.title}`])], f, 'class="cell-in" style="width:auto;max-width:min(220px,100%)"')}</label></div><div class="pad">${board(f)}</div></section>`;
      }
      return head + kpis + tabs + body;
    },
    after(root) { const s = root.querySelector('#rcReq'); if (s) s.addEventListener('change', () => { App.ui.filter.recruiting = s.value; App.render(); }); },
  });

  App.detail('jobreq', (id) => { const r = E.jobReq(id); if (!r) return null;
    const cur = { Draft: 0, 'Pending Approval': 1, Open: 2, Filled: 3, Cancelled: 0 }[r.status];
    const cands = T().candidates.filter((c) => c.reqId === id);
    return { title: `Job requisition ${r.id}`,
      html: App.stepFlow(['Draft', 'Approval', 'Open', 'Filled'], cur) + App.dl([['Title', esc(r.title)], ['Status', tpill(r.status)], ['Department', esc(r.dept)], ['Hiring manager', empLink(r.hiringManagerId)], ['Salary range', `<span class="num">${range(r)}</span>`], ['Headcount', `${r.filled} of ${r.headcount} filled`], ['Reason', esc(r.reason)], ['Raised', `${esc(fdate(r.date))} by ${esc(r.createdBy)}`], r.approvedBy && ['Approved by', esc(r.approvedBy)], r.rejectReason && r.status === 'Draft' && ['Returned', esc(r.rejectReason)]])
        + (r.notes ? `<p>${esc(r.notes)}</p>` : '')
        + (r.status === 'Pending Approval' ? `<div class="callout warn">Waiting for HR approval. Candidates can be added once the requisition is open.</div>` : '')
        + `<h3 style="margin:0;font-size:14px">Candidates</h3>` + App.table([
          { h: 'Candidate', f: (c) => App.link('candidate', c.id, c.name) }, { h: 'Source', f: (c) => esc(c.source) }, { h: 'Stage', f: (c) => tpill(c.stage) }, { h: 'Rating', f: (c) => stars(c.rating) }, { h: 'In stage', num: true, f: (c) => `${E.timeInStage(c)}d` },
        ], cands, { empty: 'No candidates yet.' })
        + `<h3 style="margin:0;font-size:14px">History</h3>` + App.table([{ h: 'Date', f: (x) => nowrap(esc(fdate(x.date))) }, { h: 'Status', f: (x) => tpill(x.status) }, { h: 'By', f: (x) => esc(x.by) }], r.history.slice().reverse()),
      buttons: reqButtons(r, '') + (['Draft', 'Pending Approval', 'Open'].includes(r.status) ? App.btn('Cancel requisition', 'jr-cancel', { id: r.id }, 'hr.recruit', 'danger') : '') };
  });

  App.detail('candidate', (id) => { const c = E.candidate(id); if (!c) return null; const r = E.jobReq(c.reqId);
    const idx = c.stage === 'Rejected' ? Math.max(0, TT.STAGES.indexOf((c.history[c.history.length - 2] || {}).stage)) : TT.STAGES.indexOf(c.stage);
    const o = c.offer;
    return { title: `Candidate ${c.name}`,
      html: App.stepFlow(TT.STAGES, idx) + App.dl([['Candidate', `${esc(c.name)}<div class="small muted mono">${esc(c.id)}</div>`], ['Requisition', App.link('jobreq', r.id) + `<div class="small">${esc(r.title)}</div>`], ['Stage', tpill(c.stage)], ['Time in stage', `${E.timeInStage(c)} day(s)`], ['Source', esc(c.source)], ['Applied', esc(fdate(c.applied))], ['Rating', stars(c.rating)], c.email && ['Email', esc(c.email)], c.empId && ['Employee', App.link('emp', c.empId)]])
        + (c.notes ? `<p>${esc(c.notes)}</p>` : '')
        + (o ? `<section class="card"><div class="card-h"><span>Offer</span>${tpill(o.status)}</div><div class="pad">${App.dl([['Salary', `<span class="num">${fmt(o.salary)}</span>`], ['Start date', esc(fdate(o.startDate))], ['Range', `<span class="num">${range(r)}</span>`], ['Made by', `${esc(o.by)}, ${esc(fdate(o.date))}`], o.approvedBy && ['Approved by', esc(o.approvedBy)], o.rejectReason && ['Rejected', esc(o.rejectReason)]])}${o.status === 'Pending Approval' ? `<div class="callout warn" style="margin-top:10px">${esc(o.why)}. HR must approve before the candidate can accept.</div>` : ''}</div></section>` : '')
        + `<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0;font-size:14px">Interview feedback</h3>${['Hired', 'Rejected'].includes(c.stage) ? '' : App.btn('Add feedback', 'cand-feedback', { id: c.id }, 'hr.recruit', 'sm')}</div>`
        + App.table([{ h: 'Interviewer', f: (f) => esc(f.interviewer) + `<div class="small muted">${esc(fdate(f.date))}</div>` }, { h: 'Rating', f: (f) => stars(f.rating) }, { h: 'Hire?', f: (f) => esc(f.recommend) }, { h: 'Comments', f: (f) => esc(f.comment) }], c.feedback, { empty: 'No interview feedback yet.' })
        + `<h3 style="margin:0;font-size:14px">Stage history</h3>` + App.table([{ h: 'Date', f: (x) => nowrap(esc(fdate(x.date))) }, { h: 'Stage', f: (x) => tpill(x.stage) }, { h: 'By', f: (x) => esc(x.by) }, { h: 'Note', f: (x) => esc(x.note) }], c.history.slice().reverse()),
      buttons: App.btn('Edit', 'cand-edit', { id: c.id }, 'hr.recruit') + candButtons(c, '') };
  });

  // =================================================================== performance
  const perfEmp = () => { const id = App.ui.filter.perfEmp; return E.emp(id) && E.emp(id).status === 'Active' ? id : (active()[0] || {}).id; };
  App.act('goal-new', (ds) => {
    const empId = ds.emp || perfEmp(); const left = Math.max(0, 100 - E.goalWeight(empId));
    App.drawer(`Add goal for ${E.emp(empId).name}`, goalForm({ weight: left || 10, targetDate: '2027-06-30', progress: 0 }) + `<div class="hint">Current weights total ${E.goalWeight(empId)}%.</div>`,
      { submitLabel: 'Add goal', onSubmit: (f) => E.addGoal({ empId, ...readGoal(f) }), success: 'Goal added.' });
  });
  App.act('goal-edit', (ds) => { const g = E.goal(ds.id);
    App.drawer('Edit goal', goalForm(g), { submitLabel: 'Save goal', onSubmit: (f) => E.updateGoal(g.id, readGoal(f)), success: 'Goal saved.' });
  });
  App.act('goal-del', (ds) => App.try(() => E.deleteGoal(ds.id), 'Goal removed.'));
  App.act('goal-submit', (ds) => App.try(() => E.submitGoals(ds.emp), 'Goals submitted.'));
  App.act('perf-pick', (ds) => { App.ui.filter.perfEmp = ds.emp; App.ui.tab.performance = 'goals'; App.render(); });
  const goalForm = (g) => `${App.field('Goal', App.input('gTitle', g.title || '', 'text', 'autocomplete="off"'))}<div class="row">${App.field('Weight (%)', App.input('gWeight', g.weight, 'number', 'min="1" max="100" step="1"'))}${App.field('Target date', App.input('gDate', g.targetDate, 'date'))}${App.field('Progress (%)', App.input('gProg', g.progress, 'number', 'min="0" max="100" step="5"'))}${App.field('Status', App.select('gStatus', TT.GOAL_STATUSES, g.status || 'Not started'))}</div>`;
  const readGoal = (f) => ({ title: App.val(f, 'gTitle'), weight: App.val(f, 'gWeight'), targetDate: App.val(f, 'gDate'), progress: App.val(f, 'gProg'), status: App.val(f, 'gStatus') });

  App.act('rev-self', (ds) => { const r = E.review(ds.id);
    App.drawer(`Self review: ${E.emp(r.empId).name}`, `${App.field('Self rating', App.select('rvRate', ratingOpts, r.selfRating || '3'))}${App.field('Comments', textarea('rvText', r.selfComments, 4))}${App.field('Action', App.select('rvSubmit', [['1', 'Submit to manager'], ['0', 'Save draft']]))}`,
      { submitLabel: 'Save', onSubmit: (f) => E.saveSelfReview(r.id, { rating: App.val(f, 'rvRate'), comments: App.val(f, 'rvText'), submit: App.val(f, 'rvSubmit') === '1' }), success: (x) => x.state === 'Manager review' ? 'Self review submitted to the manager.' : 'Draft saved.' });
  });
  App.act('rev-mgr', (ds) => { const r = E.review(ds.id); const e = E.emp(r.empId);
    App.drawer(`Manager review: ${e.name}`, `<div class="callout">Self rating <b>${r.selfRating}</b> of 5: ${esc(r.selfComments)}</div>${App.field('Manager rating', App.select('rvRate', ratingOpts, r.mgrRating || r.selfRating || '3'))}${App.field('Comments', textarea('rvText', r.mgrComments, 4))}${App.field('Action', App.select('rvSubmit', [['1', 'Complete review'], ['0', 'Save draft']]))}`,
      { submitLabel: 'Save', onSubmit: (f) => E.saveManagerReview(r.id, { rating: App.val(f, 'rvRate'), comments: App.val(f, 'rvText'), submit: App.val(f, 'rvSubmit') === '1' }), success: (x) => x.state === 'Completed' ? `Review for ${e.name} completed.` : 'Draft saved.' });
  });
  App.act('rev-launch', () => App.try(() => E.launchReviews(), (n) => n ? `${n} review(s) added to the cycle.` : 'Everyone already has a review in this cycle.'));

  function goalsTab() {
    const empId = perfEmp(); if (!empId) return '<section class="card"><div class="empty">No active employees.</div></section>';
    const e = E.emp(empId); const gs = E.goalsOf(empId); const w = E.goalWeight(empId); const pl = E.goalPlan(empId);
    const avg = gs.length ? Math.round(gs.reduce((a, g) => a + g.progress * g.weight, 0) / Math.max(1, w)) : 0;
    const list = `<section class="card"><div class="card-h"><span>Goals: ${esc(e.name)}</span><span class="actions">${tpill(pl.status)}</span></div>`
      + `<div class="pad" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between"><label class="small muted" style="display:flex;gap:6px;align-items:center">Employee ${App.select('pfEmp', active().map((x) => [x.id, x.name]), empId, 'class="cell-in" style="width:auto"')}</label>`
      + `<span class="small ${w === 100 ? '' : 'muted'}" style="${w === 100 ? 'color:var(--good)' : 'color:var(--warn)'}">Weights total ${w}%${w === 100 ? '' : ' (must be 100% to submit)'}</span>`
      + `<span class="actions">${App.btn('Add goal', 'goal-new', { emp: empId }, 'hr.goals', 'sm')}${App.btn('Submit goals', 'goal-submit', { emp: empId }, 'hr.goals', 'sm primary')}</span></div>`
      + App.table([
        { h: 'Goal', f: (g) => esc(g.title) },
        { h: 'Weight', num: true, f: (g) => `${g.weight}%` },
        { h: 'Target', f: (g) => nowrap(esc(fdate(g.targetDate))) },
        { h: 'Progress', f: (g) => `<div style="display:flex;gap:8px;align-items:center;min-width:120px">${bar(g.progress, `${g.title}: ${g.progress}% complete`, g.status === 'At risk' ? 'var(--bad)' : 'var(--accent)')}<span class="num">${g.progress}%</span></div>` },
        { h: 'Status', f: (g) => tpill(g.status) },
        { h: '', f: (g) => `<div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">${App.btn('Edit', 'goal-edit', { id: g.id }, 'hr.goals', 'sm')}${App.btn('Remove', 'goal-del', { id: g.id }, 'hr.goals', 'sm danger')}</div>` },
      ], gs, { empty: 'No goals yet. Use Add goal.', foot: ['Total', `${w}%`, '', `${avg}% weighted`, '', ''] }) + `</section>`;
    const rows = active().map((x) => ({ e: x, n: E.goalsOf(x.id).length, w: E.goalWeight(x.id), st: E.goalPlan(x.id).status, prog: (() => { const g = E.goalsOf(x.id), tw = E.goalWeight(x.id); return g.length ? Math.round(g.reduce((a, y) => a + y.progress * y.weight, 0) / Math.max(1, tw)) : 0; })() }));
    const overview = `<section class="card"><div class="card-h"><span>All employees</span><span class="small muted">${rows.filter((r) => r.st === 'Submitted').length} of ${rows.length} submitted</span></div>` + App.table([
      { h: 'Employee', f: (r) => App.link('emp', r.e.id, r.e.name) + `<div class="small muted">${esc(r.e.dept)}</div>` },
      { h: 'Goals', num: true, f: (r) => App.num(r.n) },
      { h: 'Weight', num: true, f: (r) => `<span style="${r.w === 100 ? '' : 'color:var(--warn)'}">${r.w}%</span>` },
      { h: 'Progress', f: (r) => `<div style="display:flex;gap:8px;align-items:center;min-width:100px">${bar(r.prog, `${r.e.name}: ${r.prog}% weighted progress`)}<span class="num">${r.prog}%</span></div>` },
      { h: 'Plan', f: (r) => tpill(r.st) },
      { h: '', f: (r) => App.btn('Open', 'perf-pick', { emp: r.e.id }, null, 'sm') },
    ], rows) + `</section>`;
    return `<div class="stack">${list}${overview}</div>`;
  }
  function reviewsTab() {
    const cy = E.reviewCycle(); const revs = T().reviews.filter((r) => r.cycleId === cy.id).map((r) => ({ r, e: E.emp(r.empId) })).filter((x) => x.e).sort((a, b) => a.e.name.localeCompare(b.e.name));
    const counts = TT.REVIEW_STATES.map((s) => [s, revs.filter((x) => x.r.state === s).length]);
    return `<div class="kpis">${counts.map(([s, n]) => App.kpi(s, App.num(n), revs.length ? `${Math.round(n / revs.length * 100)}% of ${revs.length}` : '')).join('')}</div>`
      + `<section class="card"><div class="card-h"><span>${esc(cy.name)} reviews</span><span class="actions"><span class="small muted">${esc(fdate(cy.start))} to ${esc(fdate(cy.end))}</span>${App.btn('Add missing reviews', 'rev-launch', {}, 'hr.perf', 'sm')}</span></div>` + App.table([
        { h: 'Employee', f: (x) => App.link('emp', x.e.id, x.e.name) + `<div class="small muted">${esc(x.e.dept)}</div>` },
        { h: 'Manager', f: (x) => empLink(x.e.managerId) },
        { h: 'State', f: (x) => tpill(x.r.state) },
        { h: 'Self', f: (x) => x.r.selfRating ? stars(x.r.selfRating) : '<span class="muted small">None</span>' },
        { h: 'Manager', f: (x) => x.r.mgrRating ? stars(x.r.mgrRating) : '<span class="muted small">None</span>' },
        { h: 'Comments', f: (x) => `<span class="small">${esc(x.r.mgrComments || x.r.selfComments)}</span>` },
        { h: '', f: (x) => `<div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">${['Not started', 'Self review'].includes(x.r.state) ? App.btn('Self review', 'rev-self', { id: x.r.id }, 'hr.goals', 'sm') : ''}${x.r.state === 'Manager review' ? App.btn('Manager review', 'rev-mgr', { id: x.r.id }, 'hr.perf', 'sm primary') : ''}</div>` },
      ], revs, { empty: 'No reviews in this cycle.' }) + `</section>`;
  }
  function calibrationTab() {
    const cal = E.calibration(); const depts = Object.keys(cal).filter((d) => cal[d].total);
    const all = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, n: 0 }; depts.forEach((d) => { [1, 2, 3, 4, 5].forEach((k) => (all[k] += cal[d][k])); all.n += cal[d].n; });
    const maxN = Math.max(1, ...depts.flatMap((d) => [1, 2, 3, 4, 5].map((k) => cal[d][k])));
    const block = (title, o, max) => `<div style="border:1px solid var(--line-2);border-radius:8px;padding:10px 12px"><div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px"><b style="font-size:13px">${esc(title)}</b><span class="small muted">${o.n} rated${o.n ? `, avg ${(o.avg || (o.n ? ([1, 2, 3, 4, 5].reduce((a, k) => a + k * o[k], 0) / o.n) : 0)).toFixed(1)}` : ''}</span></div>`
      + [5, 4, 3, 2, 1].map((k) => `<div style="display:grid;grid-template-columns:24px minmax(0,1fr) 24px;gap:8px;align-items:center;margin:3px 0"><span class="small muted mono">${k}</span>${bar(o[k] / max * 100, `${title}: ${o[k]} employee(s) rated ${k}`, k >= 4 ? 'var(--good)' : k === 3 ? 'var(--accent)' : 'var(--warn)')}<span class="num small">${o[k]}</span></div>`).join('') + `</div>`;
    const blocks = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${block('All departments', all, Math.max(1, all[1], all[2], all[3], all[4], all[5]))}${depts.map((d) => block(d, cal[d], maxN)).join('')}</div>`;
    const tbl = App.table([
      { h: 'Department', f: (d) => esc(d) }, ...[1, 2, 3, 4, 5].map((k) => ({ h: `Rated ${k}`, num: true, f: (d) => App.num(cal[d][k]) })),
      { h: 'Completed', num: true, f: (d) => `${cal[d].n} of ${cal[d].total}` }, { h: 'Average', num: true, f: (d) => cal[d].n ? cal[d].avg.toFixed(2) : '' },
    ], depts, { foot: ['All', ...[1, 2, 3, 4, 5].map((k) => App.num(all[k])), `${all.n} of ${depts.reduce((a, d) => a + cal[d].total, 0)}`, all.n ? ([1, 2, 3, 4, 5].reduce((a, k) => a + k * all[k], 0) / all.n).toFixed(2) : ''] });
    return `<div class="stack"><section class="card"><div class="card-h"><span>Rating distribution</span><span class="small muted">Completed manager ratings, ${esc(E.reviewCycle().name)}</span></div><div class="pad">${blocks}<div class="legend" style="margin-top:10px"><span><i style="background:var(--good)"></i>Exceeds (4 to 5)</span><span><i style="background:var(--accent)"></i>Meets (3)</span><span><i style="background:var(--warn)"></i>Below (1 to 2)</span></div></div></section>`
      + `<section class="card"><div class="card-h"><span>Calibration by department</span></div>${tbl}</section></div>`;
  }
  App.view('performance', {
    title: 'Performance', group: 'People',
    render() {
      const tab = App.tabOf('performance', 'goals');
      const head = App.head('People', 'Performance', 'Weighted goals for every employee, the FY27 mid-year review cycle and rating calibration across departments.');
      const tabs = App.tabs('performance', [['goals', 'Goals'], ['reviews', 'Reviews'], ['calibration', 'Calibration']]);
      return head + tabs + (tab === 'goals' ? goalsTab() : tab === 'reviews' ? reviewsTab() : calibrationTab());
    },
    after(root) { const s = root.querySelector('#pfEmp'); if (s) s.addEventListener('change', () => { App.ui.filter.perfEmp = s.value; App.render(); }); },
  });

  // =================================================================== compensation
  App.act('sc-new', (ds) => { const act = active();
    const first = ds.emp || (act[0] || {}).id;
    App.drawer('New salary change', `<div class="row">${App.field('Employee', App.select('scEmp', act.map((e) => [e.id, `${e.name}, ${e.title}`]), first))}${App.field('Reason', App.select('scReason', TT.COMP_REASONS))}</div>`
      + `<div class="row">${App.field('New annual salary (USD)', App.input('scSal', '', 'number', 'min="0" step="500"'))}${App.field('Effective date', App.input('scDate', E.S.today, 'date'))}</div>${App.field('Note', App.input('scNote'))}<div class="callout" id="scInfo"></div>`,
      { submitLabel: 'Submit change',
        oninput: (f) => { const e = E.emp(App.val(f, 'scEmp')); const s = +App.val(f, 'scSal') || 0; const pct = s ? E.pctChange(e.salary, s) : 0; const el = App.$('#scInfo', f);
          el.className = 'callout' + (pct > TT.COMP_APPROVAL_PCT ? ' warn' : '');
          el.textContent = `Current salary ${fmt(e.salary)}. ` + (s ? `Change ${pct > 0 ? '+' : ''}${pct}% (${fmt(s - e.salary)} a year). ` + (pct > TT.COMP_APPROVAL_PCT ? `Over ${TT.COMP_APPROVAL_PCT}%: needs HR approval.` : 'Within the approval limit.') + (App.val(f, 'scDate') > E.S.today ? ' Future-dated: applied on the effective date or by the first payroll that covers it.' : ' Applied immediately once approved.') : ''); },
        onSubmit: (f) => E.requestSalaryChange({ empId: App.val(f, 'scEmp'), newSalary: App.val(f, 'scSal'), reason: App.val(f, 'scReason'), effectiveDate: App.val(f, 'scDate'), note: App.val(f, 'scNote') }),
        success: (c) => `${c.id} ${c.status === 'Pending Approval' ? 'sent for approval' : c.status === 'Applied' ? 'applied' : 'scheduled for ' + fdate(c.effectiveDate)}.` });
  });
  App.act('sc-approve', (ds) => App.try(() => E.approveSalaryChange(ds.id), (c) => `${c.id} approved${c.status === 'Applied' ? ' and applied' : `; takes effect ${fdate(c.effectiveDate)}`}.`));
  App.act('sc-reject', (ds) => App.try(() => E.rejectSalaryChange(ds.id, 'Rejected by approver'), `${ds.id} rejected.`));
  App.act('sc-cancel', (ds) => App.try(() => E.cancelSalaryChange(ds.id), `${ds.id} cancelled.`));
  App.act('sc-apply', () => App.try(() => E.applyDueChanges(), (l) => l.length ? `${l.length} due change(s) applied.` : 'No approved changes are due yet.'));
  App.act('ch-pick', (ds) => { App.ui.filter.compEmp = ds.emp; App.ui.tab.compensation = 'history'; App.closeDrawer(); if (App.current === 'compensation') App.render(); else App.go('compensation'); });
  const scButtons = (c, sm = ' sm') => [
    c.status === 'Pending Approval' && App.btn('Reject', 'sc-reject', { id: c.id }, 'hr.comp.approve', 'danger' + sm),
    c.status === 'Pending Approval' && App.btn('Approve', 'sc-approve', { id: c.id }, 'hr.comp.approve', 'primary' + sm),
    ['Pending Approval', 'Approved'].includes(c.status) && App.btn('Cancel', 'sc-cancel', { id: c.id }, 'hr.comp', sm),
  ].filter(Boolean).join('');
  const pctCell = (p) => `<span style="${p > TT.COMP_APPROVAL_PCT ? 'color:var(--warn)' : p < 0 ? 'color:var(--bad)' : ''}">${p > 0 ? '+' : ''}${p}%</span>`;
  const statusText = (c) => c.status === 'Approved' ? 'Scheduled' : c.status;
  const scPill = (c) => pill(statusText(c), { 'Pending Approval': 'warn', Scheduled: 'accent', Applied: 'good', Rejected: 'bad', Cancelled: '' }[statusText(c)] ?? '');

  function requestsTab() {
    const rows = T().compChanges.slice().sort((a, b) => (a.status === 'Pending Approval' ? 0 : 1) - (b.status === 'Pending Approval' ? 0 : 1) || b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    const due = T().compChanges.filter((c) => c.status === 'Approved' && c.effectiveDate <= E.S.today).length;
    return `<section class="card"><div class="card-h"><span>Salary change requests</span><span class="actions">${App.btn(`Apply due changes${due ? ` (${due})` : ''}`, 'sc-apply', {}, 'hr.comp', 'sm')}</span></div>`
      + `<div class="pad small muted" style="padding-bottom:0">Increases over ${TT.COMP_APPROVAL_PCT}% need HR approval. Future-dated changes are applied automatically before the first payroll whose period end is on or after the effective date.</div>`
      + App.table([
        { h: 'Change', f: (c) => App.link('comp', c.id) },
        { h: 'Employee', f: (c) => empLink(c.empId) },
        { h: 'Current', num: true, f: (c) => fmt(c.currentSalary) },
        { h: 'New', num: true, f: (c) => fmt(c.newSalary) },
        { h: 'Change', num: true, f: (c) => pctCell(c.pct) },
        { h: 'Reason', f: (c) => esc(c.reason) },
        { h: 'Effective', f: (c) => nowrap(esc(fdate(c.effectiveDate))) },
        { h: 'Status', f: (c) => scPill(c) },
        { h: '', f: (c) => `<div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">${scButtons(c)}</div>` },
      ], rows, { empty: 'No salary changes yet.' }) + `</section>`;
  }
  function historyTab() {
    const act = active(); const id = E.emp(App.ui.filter.compEmp) ? App.ui.filter.compEmp : (act[0] || {}).id; if (!id) return '<section class="card"><div class="empty">No employees.</div></section>';
    const e = E.emp(id); const h = E.salaryHistory(id);
    const sched = T().compChanges.filter((c) => c.empId === id && ['Pending Approval', 'Approved'].includes(c.status));
    const opts = E.S.employees.slice().sort((a, b) => a.name.localeCompare(b.name)).map((x) => [x.id, x.name + (x.status === 'Active' ? '' : ' (former)')]);
    return `<section class="card"><div class="card-h"><span>Salary history: ${esc(e.name)}</span><span class="actions">${App.btn('New change', 'sc-new', { emp: id }, 'hr.comp', 'sm')}</span></div>`
      + `<div class="pad" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between"><label class="small muted" style="display:flex;gap:6px;align-items:center">Employee ${App.select('chEmp', opts, id, 'class="cell-in" style="width:auto"')}</label><span class="small">${esc(e.title)}, ${esc(e.dept)}. Current <b class="num">${fmt(e.salary)}</b></span></div>`
      + App.table([
        { h: 'Effective', f: (x) => nowrap(esc(fdate(x.date))) },
        { h: 'Reason', f: (x) => esc(x.reason) },
        { h: 'From', num: true, f: (x) => x.prev ? fmt(x.prev) : '' },
        { h: 'Salary', num: true, f: (x) => fmt(x.salary) },
        { h: 'Change', num: true, f: (x) => x.prev ? pctCell(E.pctChange(x.prev, x.salary)) : '' },
        { h: 'Source', f: (x) => x.ref ? App.refLink(x.ref) : '<span class="muted small">Hire record</span>' },
      ], h.slice().reverse(), { empty: 'No salary history.' })
      + (sched.length ? `<div class="pad"><b class="small">Upcoming</b>${App.table([{ h: 'Change', f: (c) => App.link('comp', c.id) }, { h: 'New', num: true, f: (c) => fmt(c.newSalary) }, { h: 'Effective', f: (c) => esc(fdate(c.effectiveDate)) }, { h: 'Status', f: scPill }], sched)}</div>` : '') + `</section>`;
  }
  function meritTab() {
    const sm = E.meritSummary(); const m = T().merit; const draft = m.status === 'Draft';
    const lastRating = (empId) => { const r = T().reviews.find((x) => x.empId === empId && x.state === 'Completed'); return r ? r.mgrRating : 0; };
    const kp = `<div class="kpis" id="meritKpis">${meritKpis(sm)}</div>`;
    const ctl = `<div class="pad" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;justify-content:space-between">${App.field('Budget, % of payroll', App.input('mBudget', sm.budgetPct, 'number', `min="0" max="25" step="0.1" style="width:140px" ${draft ? '' : 'disabled'}`))}<span class="small muted">Effective ${esc(fdate(sm.effective))}. Increases over ${TT.COMP_APPROVAL_PCT}% route for approval.</span>`
      + `<span class="actions">${draft ? App.btn('Save proposals', 'merit-save', {}, 'hr.comp', 'sm') + App.btn('Submit merit cycle', 'merit-submit', {}, 'hr.comp', 'sm primary') : `<span class="pill good">Submitted ${esc(fdate(m.submittedDate))}</span>`}</span></div>`;
    const tbl = App.table([
      { h: 'Employee', f: (r) => App.link('emp', r.e.id, r.e.name) + `<div class="small muted">${esc(r.e.dept)}</div>` },
      { h: 'Rating', f: (r) => stars(lastRating(r.e.id)) },
      { h: 'Salary', num: true, f: (r) => fmt(r.e.salary) },
      { h: 'Proposed %', num: true, f: (r) => `<input class="cell-in num" type="number" min="0" max="30" step="0.5" data-merit="${esc(r.e.id)}" value="${r.pct || ''}" placeholder="0" aria-label="Proposed merit percent for ${esc(r.e.name)}" style="width:80px" ${draft ? '' : 'disabled'}>` },
      { h: 'Increase', num: true, f: (r) => `<span data-merit-amt="${esc(r.e.id)}">${fmt(r.amount)}</span>` },
      { h: 'New salary', num: true, f: (r) => `<span data-merit-new="${esc(r.e.id)}">${fmt(r.newSalary)}</span>` },
    ], sm.rows.slice().sort((a, b) => a.e.name.localeCompare(b.e.name)), { foot: ['Total', '', fmt(sm.payroll), `<span id="meritPct">${sm.proposedPct}%</span>`, `<span id="meritTot">${fmt(sm.proposed)}</span>`, ''] });
    return kp + `<section class="card"><div class="card-h"><span>FY27 merit cycle planner</span>${draft ? '<span class="pill">Draft</span>' : ''}</div>${ctl}${tbl}</section>`;
  }
  const meritKpis = (sm) => App.kpi('Annual payroll', fmt0(sm.payroll), 'Active salaries')
    + App.kpi('Budget', fmt0(sm.budget), `${sm.budgetPct}% of payroll`)
    + App.kpi('Proposed', fmt0(sm.proposed), `${sm.proposedPct}% of payroll`)
    + App.kpi('Remaining', `<span style="color:${sm.overBudget ? 'var(--bad)' : 'var(--good)'}">${fmt0(sm.remaining)}</span>`, sm.overBudget ? 'Over budget: reduce proposals to submit' : 'Within budget');
  const readMerit = (root) => { const p = {}; root.querySelectorAll('[data-merit]').forEach((el) => { const v = +el.value; if (v > 0) p[el.dataset.merit] = v; }); return p; };
  function meritLive(root) {
    const bEl = root.querySelector('#mBudget'); const m = T().merit; const keep = m.budgetPct;
    const b = +bEl.value; if (Number.isFinite(b) && b >= 0 && b <= 25) m.budgetPct = b;   // preview only; restored below
    const sm = E.meritSummary(readMerit(root)); m.budgetPct = keep;
    root.querySelector('#meritKpis').innerHTML = meritKpis(sm);
    sm.rows.forEach((r) => { const a = root.querySelector(`[data-merit-amt="${r.e.id}"]`), n = root.querySelector(`[data-merit-new="${r.e.id}"]`); if (a) a.textContent = fmt(r.amount); if (n) n.textContent = fmt(r.newSalary); });
    root.querySelector('#meritTot').textContent = fmt(sm.proposed); root.querySelector('#meritPct').textContent = sm.proposedPct + '%';
  }
  const saveMerit = (root) => { E.setMeritBudget(root.querySelector('#mBudget').value); const p = readMerit(root); active().forEach((e) => E.setMeritProposal(e.id, p[e.id] || 0)); };
  App.act('merit-save', () => App.try(() => saveMerit(App.$('#content')), 'Merit proposals saved.'));
  App.act('merit-submit', () => { const root = App.$('#content');
    App.try(() => { saveMerit(root); return E.submitMeritCycle(); }, (ids) => `Merit cycle submitted: ${ids.length} salary change(s) effective ${fdate(TT.MERIT_EFFECTIVE)}.`);
  });

  App.view('compensation', {
    title: 'Compensation', group: 'People',
    render() {
      const tab = App.tabOf('compensation', 'requests'); const t = T();
      const head = App.head('People', 'Compensation', 'Salary changes with approval over the limit, salary history, and the annual merit cycle.', App.btn('New salary change', 'sc-new', {}, 'hr.comp', 'primary'));
      const sched = t.compChanges.filter((c) => c.status === 'Approved');
      const kpis = `<div class="kpis">` + App.kpi('Awaiting approval', App.num(pendingComp()), `Increases over ${TT.COMP_APPROVAL_PCT}%`)
        + App.kpi('Scheduled', App.num(sched.length), sched.length ? `${fmt0(U.sum(sched, (c) => c.newSalary - c.currentSalary))} a year` : 'None future-dated')
        + App.kpi('Applied this FY', App.num(t.compChanges.filter((c) => c.status === 'Applied' && c.effectiveDate >= '2026-07-01').length), 'Since 1 Jul 2026')
        + App.kpi('Merit cycle', esc(t.merit.status), `Budget ${t.merit.budgetPct}% of payroll`) + `</div>`;
      const tabs = App.tabs('compensation', [['requests', 'Change requests'], ['history', 'Salary history'], ['merit', 'Merit planner']]);
      return head + kpis + tabs + (tab === 'requests' ? requestsTab() : tab === 'history' ? historyTab() : meritTab());
    },
    after(root) {
      const s = root.querySelector('#chEmp'); if (s) s.addEventListener('change', () => { App.ui.filter.compEmp = s.value; App.render(); });
      if (root.querySelector('#meritKpis')) { const h = (ev) => { if (ev.target.matches('[data-merit], #mBudget')) meritLive(root); }; root.addEventListener('input', h); }
    },
  });

  App.detail('comp', (id) => { const c = E.compChange(id); if (!c) return null; const e = E.emp(c.empId);
    const cur = { 'Pending Approval': 1, Approved: 2, Applied: 3, Rejected: 1, Cancelled: 0 }[c.status];
    return { title: `Salary change ${c.id}`,
      html: App.stepFlow(['Requested', 'Approval', 'Scheduled', 'Applied'], cur) + App.dl([['Employee', empLink(c.empId) + `<div class="small muted">${esc(e?.title || '')}</div>`], ['Status', scPill(c)], ['Current salary', `<span class="num">${fmt(c.currentSalary)}</span>`], ['New salary', `<span class="num">${fmt(c.newSalary)}</span>`], ['Change', pctCell(c.pct)], ['Reason', esc(c.reason)], ['Effective', esc(fdate(c.effectiveDate))], ['Requested', `${esc(fdate(c.date))} by ${esc(c.requestedBy)}`], c.approvedBy && ['Approved by', esc(c.approvedBy)], c.appliedDate && ['Applied', esc(fdate(c.appliedDate))], c.rejectReason && ['Rejection reason', esc(c.rejectReason)]])
        + (c.note ? `<p>${esc(c.note)}</p>` : '')
        + (c.status === 'Pending Approval' ? `<div class="callout warn">Increase of ${c.pct}% is over the ${TT.COMP_APPROVAL_PCT}% limit, so HR must approve it.</div>` : c.status === 'Approved' ? `<div class="callout">Scheduled. It is applied on ${esc(fdate(c.effectiveDate))} by Apply due changes, or automatically before the payroll run whose period covers that date.</div>` : '')
        + `<div>${App.btn('Salary history', 'ch-pick', { emp: c.empId }, null, 'sm')}</div>`,
      buttons: scButtons(c, '') };
  });
})();
