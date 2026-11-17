/* Ledgerline Suite — api-client.js: server-mode storage adapter (no-op in local mode).
 * The browser keeps running the engine locally for instant feedback, but records every top-level call to
 * an engine write function (list: js/commands.js, served from server/commands.js) and sends those commands
 * to the server, which re-runs them as the signed-in user and is the source of truth. After each save the
 * client reloads the server's state. Every 15 s it polls for changes made by other users. */
(function () {
  'use strict';
  const cfg = window.LEDGERLINE_CONFIG || {};
  if (cfg.mode !== 'server') return;
  const E = window.Engine, App = window.App;
  const $ = (s, el = document) => el.querySelector(s);
  const POLL_MS = 15000;

  let C = null;            // window.LedgerlineCommands
  let me = null;           // {username, name, role}
  let version = 0;         // server version of the state last loaded
  let pending = [];        // commands recorded since the last save
  const queued = [];       // batches handed to save() but not yet acknowledged by the server
  let depth = 0, suppress = 0, needsRender = false, viewRole = null;
  let chain = Promise.resolve();

  // ---------- HTTP ----------
  async function call(method, url, body) {
    const res = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    if (res.status !== 304) { try { data = await res.json(); } catch (e) { data = null; } }
    return { status: res.status, ok: res.ok, data };
  }
  const errMsg = (r) => (r.data && r.data.error) || `Server error (${r.status}).`;

  // ---------- engine state ----------
  function applyIdentity() {
    E.S.role = viewRole || me.role;
    E.S.user = viewRole ? (E.ROLE_USERS[viewRole] || me.name) : me.name;
  }
  function runLocal(cmd) { const a = cmd.args.slice(); (cmd.undef || []).forEach((k) => { a[k] = undefined; }); return E[cmd.fn](...a); }
  /** Load server state, then re-apply (locally) batches not yet acknowledged so the screen keeps showing them. */
  function adopt(st, v) {
    suppress++;
    try {
      E.load(st); version = v; applyIdentity();
      queued.forEach((b) => b.forEach((c) => { try { runLocal(c); } catch (e) { /* the server will report it */ } }));
      applyIdentity();
    } finally { suppress--; }
  }
  async function refetch() {
    const r = await call('GET', 'api/state');
    if (r.status === 401) { await signIn(); return refetch(); }
    if (!r.ok) throw new Error(errMsg(r));
    adopt(r.data.state, r.data.version);
  }
  const drawerOpen = () => !!$('#drawer');
  function rerender() { if (drawerOpen() || !App.render) needsRender = true; else { needsRender = false; App.render(); } }
  setInterval(() => { if (needsRender && !drawerOpen()) rerender(); }, 700);

  // ---------- recording writes ----------
  function encode(fn, args) {
    const a = Array.from(args); while (a.length && a[a.length - 1] === undefined) a.pop();
    const undef = []; a.forEach((x, i) => { if (x === undefined) undef.push(i); });
    const cmd = { fn, args: JSON.parse(JSON.stringify(a.map((x) => (x === undefined ? null : x)))) };
    if (undef.length) cmd.undef = undef;
    return cmd;
  }
  function wrapEngine() {
    Object.keys(E).forEach((k) => {
      if (typeof E[k] !== 'function' || !C.isWrite(k) || E[k].__llWrapped) return;
      const orig = E[k];
      const w = function () {
        if (depth === 0 && !suppress) pending.push(encode(k, arguments)); // clone before the call can mutate args
        depth++;
        try { return orig.apply(this, arguments); } finally { depth--; }
      };
      w.__llWrapped = true; E[k] = w;
    });
  }

  // ---------- saving ----------
  let sending = 0;
  async function send(batch) {
    sending++;
    try { await sendOnce(batch); } finally { sending--; }
  }
  async function sendOnce(batch) {
    let r = await call('POST', 'api/commands', { baseVersion: version, commands: batch });
    if (r.status === 409) { // someone else saved first: rebase on their state and try once more
      await refetch();
      r = await call('POST', 'api/commands', { baseVersion: version, commands: batch });
    }
    queued.splice(queued.indexOf(batch), 1);
    if (r.status === 401) { await signIn(); }
    else if (!r.ok) App.toast(r.status === 409 ? 'Another user changed the same data. Your last change was not saved; the latest data is shown.' : `Not saved: ${errMsg(r)}`, 'bad');
    await refetch();
    rerender();
  }
  function save() {
    if (!pending.length) return;
    const batch = pending; pending = [];
    queued.push(batch);
    chain = chain.then(() => send(batch)).catch((e) => { App.toast(`Not saved: ${e.message || e}`, 'bad'); return refetch().then(rerender, () => {}); });
  }

  // ---------- polling ----------
  async function poll() {
    if (document.hidden || queued.length || sending || pending.length || !me) return;
    try {
      const r = await call('GET', `api/state?since=${version}`);
      if (r.status === 304 || queued.length || sending || pending.length) return;
      if (r.status === 401) { await signIn(); await refetch(); rerender(); return; }
      if (r.ok && r.data.version !== version) { adopt(r.data.state, r.data.version); if (!drawerOpen()) App.render(); else needsRender = true; }
    } catch (e) { /* offline: try again next time */ }
  }

  // ---------- sign-in overlay ----------
  function signIn() {
    return new Promise((resolve) => {
      if ($('#llLogin')) { $('#llLogin').__waiters.push(resolve); return; }
      const wrap = document.createElement('div');
      wrap.id = 'llLogin'; wrap.__waiters = [resolve];
      wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-labelledby', 'llLoginTitle');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:1000;display:grid;place-items:center;background:var(--bg);padding:16px';
      wrap.innerHTML = `<form style="width:100%;max-width:360px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);padding:24px" novalidate>
        <h1 id="llLoginTitle" style="font-size:20px;margin:0 0 4px">Ledgerline Suite</h1>
        <p style="margin:0 0 16px;color:var(--muted)">Sign in to continue.</p>
        <label style="display:block;margin-bottom:12px">Username<input name="username" autocomplete="username" required style="display:block;width:100%;margin-top:4px;padding:8px;border:1px solid var(--field);border-radius:6px;background:var(--surface);color:var(--ink);font:inherit"></label>
        <label style="display:block;margin-bottom:12px">Password<input name="password" type="password" autocomplete="current-password" required style="display:block;width:100%;margin-top:4px;padding:8px;border:1px solid var(--field);border-radius:6px;background:var(--surface);color:var(--ink);font:inherit"></label>
        <p class="llErr" role="alert" style="color:var(--bad);min-height:1.5em;margin:0 0 8px"></p>
        <button class="btn primary" type="submit" style="width:100%">Sign in</button></form>`;
      const appEl = $('.app'); if (appEl) appEl.inert = true;
      document.body.appendChild(wrap);
      const f = $('form', wrap); f.username.focus();
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = $('button', f); btn.disabled = true; $('.llErr', f).textContent = '';
        try {
          const r = await call('POST', 'api/login', { username: f.username.value.trim(), password: f.password.value });
          if (!r.ok) { $('.llErr', f).textContent = errMsg(r); f.password.select(); return; }
          me = r.data; wrap.remove(); if (appEl) appEl.inert = false;
          decorate(); wrap.__waiters.forEach((w) => w());
        } catch (e) { $('.llErr', f).textContent = 'Could not reach the server.'; }
        finally { btn.disabled = false; }
      });
    });
  }

  // ---------- top bar ----------
  function decorate() {
    const isAdmin = me.role === 'Administrator';
    const sel = $('#roleSel'), reset = $('#resetBtn');
    if (sel && sel.closest('label')) sel.closest('label').style.display = isAdmin ? '' : 'none';
    if (reset) reset.style.display = isAdmin ? '' : 'none';
    if (sel && !sel.__llBound) { sel.__llBound = true; sel.addEventListener('change', () => { viewRole = sel.value === me.role ? null : sel.value; }); }
    let box = $('#llUser');
    if (!box) {
      box = document.createElement('span'); box.id = 'llUser'; box.style.cssText = 'display:inline-flex;gap:8px;align-items:center';
      box.innerHTML = '<span class="chip" id="llUserName"></span><button class="btn sm" type="button" id="llSignOut">Sign out</button>';
      const host = $('.top-right') || $('header.top') || document.body; host.appendChild(box);
      $('#llSignOut', box).addEventListener('click', async () => { try { await call('POST', 'api/logout', {}); } finally { location.reload(); } });
    }
    $('#llUserName', box).textContent = `${me.name} · ${me.role}`;
    $('#llUserName', box).title = `Signed in as ${me.username}`;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`)); document.head.appendChild(s); });
  }

  App.storage = {
    mode: 'server',
    async load() {
      await loadScript('js/commands.js');
      C = window.LedgerlineCommands; wrapEngine();
      const h = await call('GET', 'api/health'); // says whether our cookie is a live session, without a 401 in the console
      const r = h.ok && h.data.signedIn ? await call('GET', 'api/me') : { status: 401 };
      if (r.ok) { me = r.data; decorate(); } else if (r.status === 401) await signIn(); else throw new Error(errMsg(r));
      await refetch();
      setInterval(poll, POLL_MS);
    },
    save,
    discard() { pending = []; },
    reset() {
      pending = [];
      chain = chain.then(async () => {
        const r = await call('POST', 'api/admin/reset', {});
        if (!r.ok) App.toast(`Reset failed: ${errMsg(r)}`, 'bad');
        viewRole = null; await refetch(); rerender();
      });
    },
    /** For diagnostics and tests. */
    status: () => ({ version, user: me, pending: pending.length, queued: queued.length + sending }),
  };
})();
