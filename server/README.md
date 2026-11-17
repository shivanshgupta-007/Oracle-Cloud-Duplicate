# Ledgerline Suite server

A multi-user back end for the Ledgerline Suite app. It uses only Node built-ins (Node 18 or later, tested on 22) and needs no `npm install`.

## Run

```sh
npm start                          # http://127.0.0.1:8080
PORT=3000 HOST=0.0.0.0 npm start   # other port, or listen on all interfaces
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `HOST` | `127.0.0.1` | Interface to listen on |
| `LEDGERLINE_DATA` | `server/data/` | Snapshot and command log |
| `LEDGERLINE_USERS` | `server/users.json` | User file |

`server/data/` and `server/users.json` are gitignored. To start over with fresh demo data, stop the server and delete `server/data/`.

Opening `index.html` straight from disk still works. It runs in local mode, with one user and the browser's localStorage.

## Demo users

`server/users.json` is created on first run. There is one user per role, and the credentials are printed to the console:

| Username | Password | Role | Name in the audit trail |
|---|---|---|---|
| admin | admin-demo | Administrator | System Administrator |
| controller | controller-demo | Controller | Avery Lin |
| ap | ap-demo | AP Specialist | Sam Achebe |
| buyer | buyer-demo | Buyer | Dana Whitfield |
| orders | orders-demo | Order Manager | Ines Duarte |
| hr | hr-demo | HR Specialist | Nadia Petrova |

Passwords are stored as scrypt hashes, each with its own random salt. To add users or change passwords, edit the file. The display names match the seed's users, so the segregation-of-duties rules work across users. For example, Dana cannot approve her own requisition.

## Architecture

- **Commands, not state.** The engine is deterministic given its state and inputs. The browser runs each action locally for instant feedback. It records each top-level call to an engine write function as `{fn, args}` and sends the batch with `POST /api/commands {baseVersion, commands}`. The server checks each command, then runs the batch as the signed-in user inside a JSON snapshot. If any command throws, the whole batch rolls back. The server sets `S.role` and `S.user` from the session, never from the client, and sets `S._clock` to server time, so audit timestamps come from the server. After each save the client reloads the server's state.
- **Conflicts.** If `baseVersion` is not the current version, the server answers `409 {version}`. The client fetches the latest state, re-applies its commands locally and retries once. If the retry also fails, it shows an error and the latest data.
- **Permission table:** `server/commands.js`. This is the single source of truth, and the server also serves it to the browser at `/js/commands.js`. It maps each write function to the perms that allow it, for example `createManualJournal → gl.post` and `receivePO → po.receive`, checked with `Engine.can(role, perm)`. A function that is not in the table but whose name starts with a write verb (`create…`, `approve…`, `post…`) is accepted only from the Administrator. Read-only functions are never accepted. **When you add an engine write function, add it to `PERMS`.**
- **Persistence:** `data/commands.jsonl` is an append-only log with one fsynced line per committed batch: `{v, ts, username, user, role, commands}`. `data/state.json` is a snapshot, `{version, savedAt, state}`, written every 50 batches and at shutdown. Each write goes to a temp file, then is renamed into place, and the log is compacted. At start-up the server loads the snapshot and replays log entries newer than it. If there is no snapshot, it runs the seed. It ignores a torn last line. `node:sqlite` is still experimental on Node 22, so the server uses JSON files.
- **Sessions:** `POST /api/login` sets an `HttpOnly; SameSite=Strict` cookie holding a random 32-byte token. Sessions live in an in-memory map with an 8-hour sliding expiry. After 5 failed sign-ins from one IP within 15 minutes, further attempts get `429`. POST bodies must be `application/json`.
- **Headers:** a CSP that allows the same origin plus Google Fonts, with the page's two inline scripts allowed by hash. Also `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` and `X-Frame-Options: DENY`.
- **Client** (`js/api-client.js`, active only when `/js/config.js` says `mode: 'server'`): shows a sign-in overlay and replaces `App.storage`. It hides the role selector and Reset demo from everyone but the Administrator, and adds the signed-in user's name and a Sign out button. Every 15 s it polls `GET /api/state?since=<version>`, which answers `304` when nothing changed, and re-renders unless a drawer is open.

## API

| Route | Auth | Result |
|---|---|---|
| `GET /api/health` | none | `{ok, version, signedIn}` |
| `POST /api/login` `{username, password}` | none | `{username, name, role}` and a session cookie; `401` or `429` on failure |
| `POST /api/logout` | session | `{ok}` |
| `GET /api/me` | session | `{username, name, role}` |
| `GET /api/state[?since=v]` | session | `{version, state}`, or `304` when `since` is current |
| `POST /api/commands` `{baseVersion, commands:[{fn, args, undef?}]}` | session | `{version}`; `400` for a rule violation or a non-command, `403` without permission, `409 {version}` when stale |
| `POST /api/admin/reset` | Administrator | Reseeds the demo company: `{version}` |

## Limits

- It runs as a single process. The state lives in memory, and commands run one at a time. A horizontally scaled setup would need a shared log and locking.
- Sessions and the login rate limit are in memory, so a restart signs everyone out.
- Each save and each poll that finds a change transfers the whole state (about 0.7 MB). There are no deltas.
- The server is plain HTTP. Put it behind a TLS proxy to use it beyond localhost. The cookie gets `Secure` only when the socket itself is TLS.
- An Administrator using the role selector only previews another role's screens. The server still runs that user's commands as Administrator.
