/* Ledgerline Suite — store.js: authoritative engine state on the server.
 * Persistence = snapshot (state.json: {version, savedAt, state}) + append-only command log
 * (commands.jsonl, one JSON line per committed batch: {v, ts, username, user, role, commands}).
 * Start-up loads the snapshot and replays every log entry with v > snapshot.version; with no
 * snapshot it runs the seed. Files are replaced atomically (write temp file, fsync, rename). */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { E, seed } = require('../js/load-node.js');
const C = require('./commands.js');

class CommandError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; } }

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function createStore({ dataDir, snapshotEvery = 50, log = () => {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const snapFile = path.join(dataDir, 'state.json');
  const logFile = path.join(dataDir, 'commands.jsonl');
  let version = 0;
  let sinceSnapshot = 0;

  /** Run one batch against E.S as `actor`, all or nothing. Throws CommandError (state restored). */
  function execute(actor, commands, ts) {
    const snap = JSON.stringify(E.S);
    let i = 0;
    try {
      for (; i < commands.length; i++) {
        const { fn, args, undef } = commands[i];
        const a = args.slice(); // JSON has no undefined: `undef` lists positions that were undefined in the client call
        if (Array.isArray(undef)) undef.forEach((k) => { if (Number.isInteger(k) && k >= 0 && k < a.length) a[k] = undefined; });
        E.S.role = actor.role; E.S.user = actor.user; E.S._clock = ts;
        E[fn](...a);
      }
    } catch (err) {
      E.load(JSON.parse(snap));
      throw new CommandError(err instanceof CommandError ? err.status : 400, err.message || String(err), { index: i, fn: commands[i] && commands[i].fn });
    }
  }

  function snapshot() {
    writeAtomic(snapFile, JSON.stringify({ version, savedAt: new Date().toISOString(), state: E.S }));
    writeAtomic(logFile, ''); // every entry is now <= version; compact the log
    sinceSnapshot = 0;
  }

  function init() {
    if (fs.existsSync(snapFile)) {
      const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
      E.load(snap.state); version = snap.version;
      log(`Loaded snapshot v${version}`);
    } else {
      seed(); version = 0; snapshot();
      log('No data found: seeded the demo company (v0).');
    }
    if (fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
      let replayed = 0;
      for (let n = 0; n < lines.length; n++) {
        let entry;
        try { entry = JSON.parse(lines[n]); } catch (e) { if (n === lines.length - 1) { log('Ignored a torn last log line.'); break; } throw e; }
        if (entry.v <= version) continue;
        if (entry.v !== version + 1) throw new Error(`Command log gap: expected v${version + 1}, found v${entry.v}`);
        execute(entry, entry.commands, entry.ts); version = entry.v; replayed++; sinceSnapshot++;
      }
      if (replayed) log(`Replayed ${replayed} logged batch(es) to v${version}.`);
    }
  }

  /** Validate shape and permissions of a batch without running it. */
  function check(actor, commands) {
    if (!Array.isArray(commands) || !commands.length) throw new CommandError(400, 'commands must be a non-empty array.');
    if (commands.length > 200) throw new CommandError(400, 'Too many commands in one request.');
    commands.forEach((c, i) => {
      if (!c || typeof c.fn !== 'string' || !Array.isArray(c.args)) throw new CommandError(400, `Command ${i} must be {fn, args: []}.`);
      if (!C.isWrite(c.fn) || typeof E[c.fn] !== 'function') throw new CommandError(400, `${c.fn} is not an accepted command.`, { index: i, fn: c.fn });
      if (!C.allowed(E, actor.role, c.fn)) throw new CommandError(403, `Your role (${actor.role}) is not allowed to run ${c.fn}.`, { index: i, fn: c.fn });
    });
  }

  /** Apply a batch for `actor` ({username, user, role}); returns the new version. */
  function commit(actor, baseVersion, commands) {
    check(actor, commands); // permission errors win over version conflicts: a retry would not help
    if (baseVersion !== version) throw new CommandError(409, 'The data changed since you loaded it.', { version });
    const ts = new Date().toISOString();
    execute(actor, commands, ts);
    const entry = { v: version + 1, ts, username: actor.username, user: actor.user, role: actor.role, commands };
    const fd = fs.openSync(logFile, 'a');
    try { fs.writeSync(fd, JSON.stringify(entry) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    version = entry.v; sinceSnapshot++;
    if (sinceSnapshot >= snapshotEvery) snapshot();
    return version;
  }

  /** Reseed the demo company (admin). */
  function reset(actor) {
    seed(); E.S.role = actor.role; E.S.user = actor.user;
    version++; snapshot();
    return version;
  }

  init();
  return { get version() { return version; }, state: () => E.S, commit, reset, snapshot, check, CommandError };
}

module.exports = { createStore, CommandError, writeAtomic };
