/* Ledgerline Suite — auth.js: demo users (scrypt-hashed passwords), in-memory sessions, login rate limit. */
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { writeAtomic } = require('./store.js');
const { E } = require('../js/load-node.js');

/** One demo user per role. Display names match Engine.ROLE_USERS so segregation-of-duties checks line up with the seed. */
const DEMO = [
  ['admin', 'Administrator'], ['controller', 'Controller'], ['ap', 'AP Specialist'],
  ['buyer', 'Buyer'], ['orders', 'Order Manager'], ['hr', 'HR Specialist'],
];
const demoPassword = (username) => `${username}-demo`;

const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));

async function hashUser(username, role, password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt);
  return { username, name: E.ROLE_USERS[role] || username, role, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

async function loadUsers(file, log) {
  if (!fs.existsSync(file)) {
    const users = [];
    for (const [u, role] of DEMO) users.push(await hashUser(u, role, demoPassword(u)));
    fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify({ users }, null, 2) + '\n');
    log(`Created ${file} with demo users (username / password):`);
    DEMO.forEach(([u, role]) => log(`  ${u.padEnd(11)} / ${demoPassword(u).padEnd(16)} ${role}`));
    return users;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')).users;
}

function createAuth({ users, sessionTtlMs = 8 * 3600 * 1000, maxFailures = 5, windowMs = 15 * 60 * 1000 }) {
  const byName = new Map(users.map((u) => [u.username, u]));
  const sessions = new Map(); // token -> {username, expires}
  const failures = new Map(); // ip -> {count, first}
  const dummySalt = crypto.randomBytes(16);

  function limited(ip) {
    const f = failures.get(ip); if (!f) return 0;
    if (Date.now() - f.first > windowMs) { failures.delete(ip); return 0; }
    return f.count >= maxFailures ? Math.ceil((f.first + windowMs - Date.now()) / 1000) : 0;
  }
  function fail(ip) { const f = failures.get(ip); if (!f || Date.now() - f.first > windowMs) failures.set(ip, { count: 1, first: Date.now() }); else f.count++; }

  /** Returns {token, user} or null. Always spends one scrypt so unknown users take as long as bad passwords. */
  async function login(ip, username, password) {
    const u = typeof username === 'string' ? byName.get(username) : undefined;
    const key = await scrypt(typeof password === 'string' ? password : '', u ? Buffer.from(u.salt, 'hex') : dummySalt);
    const ok = !!u && crypto.timingSafeEqual(key, Buffer.from(u.hash, 'hex'));
    if (!ok) { fail(ip); return null; }
    failures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username: u.username, expires: Date.now() + sessionTtlMs });
    return { token, user: publicUser(u) };
  }
  function publicUser(u) { return { username: u.username, name: u.name, role: u.role }; }
  /** Session user for a token (sliding expiry), or null. */
  function userFor(token) {
    const s = token && sessions.get(token); if (!s) return null;
    if (s.expires < Date.now()) { sessions.delete(token); return null; }
    s.expires = Date.now() + sessionTtlMs;
    const u = byName.get(s.username); return u ? publicUser(u) : null;
  }
  function logout(token) { sessions.delete(token); }
  const sweep = setInterval(() => { const now = Date.now(); for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t); }, 60 * 1000);
  sweep.unref();
  return { login, logout, userFor, limited, sessionTtlMs, stop: () => clearInterval(sweep) };
}

module.exports = { loadUsers, createAuth, DEMO, demoPassword };
