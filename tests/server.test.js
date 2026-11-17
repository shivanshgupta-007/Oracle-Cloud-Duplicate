/* Server back end: auth, sessions, rate limit, command permissions, conflicts, persistence, static files. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server/server.js');
const C = require('../server/commands.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerline-server-'));
const opts = { port: 0, quiet: true, dataDir: path.join(dir, 'data'), usersFile: path.join(dir, 'users.json'), maxFailures: 3, snapshotEvery: 3 };
let app;
const logSpy = console.log;

async function req(method, url, { body, cookie, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(app.url + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null; if (!raw) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  return { status: res.status, data, text, headers: res.headers };
}
async function login(username, password = `${username}-demo`) {
  const r = await req('POST', '/api/login', { body: { username, password } });
  assert.equal(r.status, 200, `login ${username}: ${r.text}`);
  return r.headers.get('set-cookie').split(';')[0];
}
const getState = async (cookie) => (await req('GET', '/api/state', { cookie })).data;

test.before(async () => { console.log = () => {}; try { app = await start(opts); } finally { console.log = logSpy; } });
test.after(async () => { if (app) await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('health is public; other API routes need a session', async () => {
  const h = await req('GET', '/api/health');
  assert.equal(h.status, 200); assert.equal(h.data.ok, true);
  for (const [m, u] of [['GET', '/api/state'], ['GET', '/api/me'], ['POST', '/api/commands'], ['POST', '/api/admin/reset']]) {
    const r = await req(m, u, m === 'POST' ? { body: {} } : {});
    assert.equal(r.status, 401, `${m} ${u}`);
  }
});

test('login sets an httpOnly SameSite=Strict cookie; /api/me and logout', async () => {
  const r = await req('POST', '/api/login', { body: { username: 'controller', password: 'controller-demo' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { username: 'controller', name: 'Avery Lin', role: 'Controller' });
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /ll_session=[a-f0-9]{64}/);
  const cookie = sc.split(';')[0];
  assert.equal((await req('GET', '/api/me', { cookie })).data.role, 'Controller');
  assert.equal((await req('POST', '/api/logout', { cookie, body: {} })).status, 200);
  assert.equal((await req('GET', '/api/me', { cookie })).status, 401);
  assert.ok(!JSON.stringify(fs.readFileSync(opts.usersFile, 'utf8')).includes('controller-demo'), 'passwords are hashed');
});

test('wrong password is refused and failures are rate-limited per IP', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await req('POST', '/api/login', { body: { username: 'admin', password: 'nope' } })).status, 401);
  const r = await req('POST', '/api/login', { body: { username: 'admin', password: 'admin-demo' } });
  assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0);
});

test('command applied with permission; state and audit come from the server', async () => {
  // fresh server so the rate limit from the previous test does not apply
  await app.close(); console.log = () => {}; try { app = await start(opts); } finally { console.log = logSpy; }
  const cookie = await login('buyer');
  const { version, state } = await getState(cookie);
  const item = state.items[0];
  const before = state.reqs.length;
  const r = await req('POST', '/api/commands', { cookie, body: { baseVersion: version, commands: [{ fn: 'createReq', args: [{ date: state.today, requester: 'Dana Whitfield', justification: 'test', lines: [{ sku: item.sku, qty: 1, price: 5 }] }] }] } });
  assert.equal(r.status, 200, r.text); assert.equal(r.data.version, version + 1);
  const after = await getState(cookie);
  assert.equal(after.version, version + 1);
  assert.equal(after.state.reqs.length, before + 1);
  const a = after.state.audit[0];
  assert.equal(a.user, 'Dana Whitfield'); assert.equal(a.role, 'Buyer');
  assert.ok(Math.abs(Date.parse(a.ts) - Date.now()) < 60000, 'audit timestamp is server time');
  // 304 when unchanged
  assert.equal((await req('GET', `/api/state?since=${after.version}`, { cookie, raw: true })).status, 304);
});

test('client cannot spoof role; command without permission is 403 and state is unchanged', async () => {
  const cookie = await login('buyer');
  const before = await getState(cookie);
  const r = await req('POST', '/api/commands', { cookie, body: { baseVersion: before.version, role: 'Administrator', commands: [
    { fn: 'createReq', args: [{ date: before.state.today, requester: 'x', lines: [{ sku: before.state.items[0].sku, qty: 1, price: 1 }] }] },
    { fn: 'createManualJournal', args: [{ date: before.state.today, desc: 'nope', lines: [{ acct: '6100', dr: 10 }, { acct: '1000', cr: 10 }] }] }] } });
  assert.equal(r.status, 403); assert.equal(r.data.fn, 'createManualJournal');
  assert.deepEqual(await getState(cookie), before);
  // read-only and unknown functions are never commands; admin-only fallback for unlisted write verbs
  for (const fn of ['trialBalance', 'reset', 'load', 'constructor', '__proto__']) {
    const x = await req('POST', '/api/commands', { cookie, body: { baseVersion: before.version, commands: [{ fn, args: [] }] } });
    assert.equal(x.status, 400, fn);
  }
  assert.deepEqual(C.permsFor('createWidgetFoo'), ['admin']);
  assert.equal(C.permsFor('trialBalance'), null);
  // a rule violation rolls the whole batch back
  const bad = await req('POST', '/api/commands', { cookie, body: { baseVersion: before.version, commands: [
    { fn: 'createReq', args: [{ date: before.state.today, requester: 'x', lines: [{ sku: before.state.items[0].sku, qty: 1, price: 1 }] }] },
    { fn: 'receivePO', args: ['PO-0000', before.state.today, {}] }] } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await getState(cookie), before);
});

test('every PERMS entry names a real engine function and a permission some role holds', () => {
  const { E } = require('../js/load-node.js');
  const all = new Set(Object.values(E.ROLES).flat());
  for (const [fn, p] of Object.entries(C.PERMS)) {
    assert.equal(typeof E[fn], 'function', fn);
    for (const perm of [].concat(p)) assert.ok(all.has(perm) || perm === 'req.create' || perm === 'hr.absence.create', `${fn}: ${perm}`);
  }
});

test('stale baseVersion gets 409 with the current version', async () => {
  const cookie = await login('controller');
  const { version, state } = await getState(cookie);
  const r = await req('POST', '/api/commands', { cookie, body: { baseVersion: version - 1, commands: [{ fn: 'createReq', args: [{ date: state.today, requester: 'x', lines: [{ sku: state.items[0].sku, qty: 1, price: 1 }] }] }] } });
  assert.equal(r.status, 409); assert.equal(r.data.version, version);
});

test('reset is admin-only', async () => {
  const cookie = await login('controller');
  assert.equal((await req('POST', '/api/admin/reset', { cookie, body: {} })).status, 403);
});

test('restart recovers identical state from snapshot + command log', async () => {
  const cookie = await login('controller');
  let { version, state } = await getState(cookie);
  // several batches so that a snapshot (every 3) happens and later entries live only in the log
  for (let i = 0; i < 4; i++) {
    const r = await req('POST', '/api/commands', { cookie, body: { baseVersion: version, commands: [{ fn: 'createReq', args: [{ date: state.today, requester: 'Avery Lin', justification: `r${i}`, lines: [{ sku: state.items[1].sku, qty: 2, price: 3 }] }] }] } });
    assert.equal(r.status, 200, r.text); version = r.data.version;
  }
  const before = await getState(cookie);
  assert.ok(fs.readFileSync(path.join(opts.dataDir, 'commands.jsonl'), 'utf8').trim().length > 0, 'log has entries after the last snapshot');
  await app.close({ snapshot: false });
  console.log = () => {}; try { app = await start(opts); } finally { console.log = logSpy; }
  const cookie2 = await login('controller');
  assert.deepEqual(await getState(cookie2), before);
});

test('static app, dynamic config.js, shared commands.js and security headers', async () => {
  const idx = await req('GET', '/', { raw: true });
  assert.equal(idx.status, 200); assert.match(idx.headers.get('content-type'), /text\/html/); assert.match(idx.text, /<script src="js\/engine.js">/);
  const csp = idx.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/); assert.match(csp, /fonts\.googleapis\.com/); assert.match(csp, /sha256-/);
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff'); assert.ok(idx.headers.get('referrer-policy'));
  const cfg = await req('GET', '/js/config.js', { raw: true });
  assert.match(cfg.headers.get('content-type'), /javascript/); assert.match(cfg.text, /mode: 'server'/);
  const eng = await req('GET', '/js/engine.js', { raw: true });
  assert.equal(eng.status, 200); assert.match(eng.headers.get('content-type'), /javascript/);
  const cmd = await req('GET', '/js/commands.js', { raw: true });
  assert.match(cmd.text, /LedgerlineCommands/);
  assert.equal((await req('GET', '/js/extensions.json', { raw: true })).status, 200);
  for (const bad of ['/js/../server/users.json', '/js/%2e%2e/server/users.json', '/server/users.json', '/package.json', '/js/']) assert.equal((await req('GET', bad, { raw: true })).status, 404, bad);
});
