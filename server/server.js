#!/usr/bin/env node
/* Ledgerline Suite — server.js: multi-user back end with zero dependencies (Node built-ins only).
 * Serves the static app, a JSON API under /api, and keeps the authoritative engine state.
 * Clients send commands ({fn, args}), never state; see server/README.md. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore, CommandError } = require('./store.js');
const { loadUsers, createAuth } = require('./auth.js');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const COOKIE = 'll_session';
const MAX_BODY = 2 * 1024 * 1024;

function inlineScriptHashes(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
}

async function start(opts = {}) {
  const quiet = !!opts.quiet;
  const say = (m) => { if (!quiet) console.log(m); };
  const dataDir = opts.dataDir || process.env.LEDGERLINE_DATA || path.join(__dirname, 'data');
  const usersFile = opts.usersFile || process.env.LEDGERLINE_USERS || path.join(__dirname, 'users.json');
  const users = await loadUsers(usersFile, (m) => console.log(m)); // credentials are always printed on first run
  const auth = createAuth({ users, maxFailures: opts.maxFailures || 5, windowMs: opts.windowMs });
  const store = createStore({ dataDir, snapshotEvery: opts.snapshotEvery || 50, log: say });

  let indexCache = { mtime: 0, html: '', csp: '' };
  function index() {
    const file = path.join(ROOT, 'index.html');
    const st = fs.statSync(file);
    if (st.mtimeMs !== indexCache.mtime) {
      const html = fs.readFileSync(file, 'utf8');
      const csp = ["default-src 'self'", `script-src 'self' ${inlineScriptHashes(html).join(' ')}`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
      indexCache = { mtime: st.mtimeMs, html, csp };
    }
    return indexCache;
  }

  function headers(res, extra = {}) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', index().csp);
    res.setHeader('Cache-Control', 'no-cache');
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }
  function send(res, status, body, type, extra) {
    headers(res, extra);
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  }
  const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);

  function cookieToken(req) {
    const m = /(?:^|;\s*)ll_session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    return m ? m[1] : null;
  }
  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(new CommandError(415, 'Send Content-Type: application/json.'));
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new CommandError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new CommandError(400, 'Invalid JSON.')); } });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    if (pathname === '/' || pathname === '/index.html') { const { html } = index(); return send(res, 200, req.method === 'HEAD' ? '' : html, TYPES['.html']); }
    if (pathname === '/js/config.js') return send(res, 200, "window.LEDGERLINE_CONFIG = { mode: 'server' };\n", TYPES['.js']);
    let file = null;
    if (pathname === '/js/commands.js') file = path.join(__dirname, 'commands.js');
    else if (pathname.startsWith('/js/')) {
      let rel; try { rel = decodeURIComponent(pathname.slice(4)); } catch (e) { rel = ''; }
      const abs = path.resolve(JS_DIR, rel);
      if (rel && abs.startsWith(JS_DIR + path.sep) && TYPES[path.extname(abs)]) file = abs;
    }
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Not found' });
    send(res, 200, req.method === 'HEAD' ? '' : fs.readFileSync(file), TYPES[path.extname(file)]);
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    const ip = req.socket.remoteAddress || '?';
    if (route === 'GET /api/health') return json(res, 200, { ok: true, version: store.version, signedIn: !!auth.userFor(cookieToken(req)) });
    if (route === 'POST /api/login') {
      const wait = auth.limited(ip);
      if (wait) return json(res, 429, { error: `Too many failed sign-in attempts. Try again in ${wait} s.` }, { 'Retry-After': String(wait) });
      const body = await readJson(req);
      const r = await auth.login(ip, body.username, body.password);
      if (!r) return json(res, 401, { error: 'Incorrect username or password.' });
      const secure = req.socket.encrypted ? '; Secure' : '';
      return json(res, 200, r.user, { 'Set-Cookie': `${COOKIE}=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(auth.sessionTtlMs / 1000)}${secure}` });
    }
    const token = cookieToken(req);
    const user = auth.userFor(token);
    if (!user) return json(res, 401, { error: 'Sign in required.' });
    const actor = { username: user.username, user: user.name, role: user.role };
    switch (route) {
      case 'POST /api/logout': auth.logout(token); return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      case 'GET /api/me': return json(res, 200, user);
      case 'GET /api/state': {
        const since = url.searchParams.get('since');
        if (since !== null && Number(since) === store.version) { headers(res); res.writeHead(304); return res.end(); }
        return json(res, 200, { version: store.version, state: store.state() });
      }
      case 'POST /api/commands': {
        const body = await readJson(req);
        const version = store.commit(actor, body.baseVersion, body.commands);
        return json(res, 200, { version });
      }
      case 'POST /api/admin/reset': {
        await readJson(req);
        if (user.role !== 'Administrator') return json(res, 403, { error: 'Only the Administrator can reset the demo data.' });
        return json(res, 200, { version: store.reset(actor) });
      }
      default: return json(res, 404, { error: 'Not found' });
    }
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return json(res, 400, { error: 'Bad request' }); }
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (err instanceof CommandError) return json(res, err.status, { error: err.message, ...err.extra });
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: 'Internal error' }); else res.end();
    }
  });

  const port = opts.port !== undefined ? opts.port : Number(process.env.PORT || 8080);
  const host = opts.host || process.env.HOST || '127.0.0.1';
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  say(`Ledgerline Suite server on http://${host}:${actual}  (data: ${dataDir}, v${store.version})`);
  return {
    server, store, port: actual, url: `http://${host}:${actual}`,
    /** close({snapshot:false}) skips the final snapshot (tests use it to exercise log replay). */
    close({ snapshot = true } = {}) { auth.stop(); try { if (snapshot) store.snapshot(); } catch (e) { console.error(e); } return new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }); },
  };
}

module.exports = { start };

if (require.main === module) {
  start().then((app) => {
    const stop = () => { app.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }, (err) => { console.error(err); process.exit(1); });
}
