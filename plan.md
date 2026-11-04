# Bouncer → house-conventions conversion plan

Convert `bouncer-tool` ("Auto Bouncer & Moderator") from its one-off architecture (plain-ESM `.mjs`, JSON-file + Neon Postgres state, Vercel/Docker deploys, self-managed `ADMIN_TOKEN` access control) to the conventions shared by the other Chat Hackers tools (events-tool, schedule-tool, welcome-tool, emails-tool, spacetube-tool, voice-tool):

- TypeScript + Express 5, long-running process under pm2 (`src/index.ts` entrypoint)
- DuckDB storage via `@duckdb/node-api` in `<tool>_duckdb.db`, multi-room, rows keyed by `room_id`
- Registration manifest `<tool>.json` written at boot, copied into `tool-hub/registrations/`
- Vite + React 19 dashboard in `web/` (singlefile build), served by the tool at `/`
- **No tool-side access management** — the hub already enforces access (AdminTokens + ❤️-react admin gate in `tool-hub/src/webserver.ts:58-81`, `checkAdmin` power levels in `tool-hub/src/index.ts:22-41`, per-room tool lock, opt-outs). No sibling tool has any auth code.

No live data migration: the Vercel/Neon deployment path is deleted outright, along with its docs.

## Execution order

Phases are ordered so each lands a green, reviewable diff. **Phase 0 (access removal) comes first** as requested: it is orthogonal to the framework/storage work, touches every file that later phases also touch, and deleting it first means the port phases never carry auth plumbing at all.

---

## Phase 0 — Remove self-managed access management

Scope rule: the **module secret** (inter-service credential the hub validates on `/api/send`, `/api/kick`, and the `/api/members` contract in `HUB-MEMBERS.md`) **stays**. Everything that gates *humans* goes: admin token, webhook-secret-in-URL, frontend login.

### 0.1 Identity object
- `server.mjs:18-21`: delete `identity.json` read/write and the `{uuid, secret, adminToken}` object. Replace with `const secret = process.env.MODULE_SECRET` (kept only until Phase 1 renames it) and `uuid: randomUUID()` at registration time.
- `api/index.mjs:7-13`: delete ADMIN_TOKEN/MODULE_SECRET/MODULE_UUID/BOUNCER_INSTANCE_ID validation; secret comes from env only, no derivation, no ≥24-char checks.
- Delete `data/identity.json` and `scripts/setup-secrets.mjs`; drop the `setup:secrets` script.

### 0.2 Auth gates
- `handler.mjs:14-17`: remove the webhook `?hook=` check and the `/api/*` bearer check. Keep route dispatch (webhook = `POST /`, API = `/api/*`, else 404) and `/health`.
- `operations.mjs:18` and `operations.mjs:42`: remove the duplicate in-`operate` secret/token re-checks; remove the `secureEqual` export (`operations.mjs:7`) and its imports (`handler.mjs:1`).
- `server.mjs:41`: remove the "Organiser token:" stdout print.

### 0.3 Registration
- `registration.mjs:3`: stop embedding `?hook=<secret>` in the registration URL; `url` is the bare origin (`http://localhost:5059`). Keep `secret` as a top-level field (hub contract, matches `ChatTool` in `tool-hub/types.ts:14-23`).
- `handler.mjs:18-21` + `operations.mjs` registration route + the "Download Hub JSON" button in `public/app.js`: delete. The registration file is written at boot; the operator copies it into `tool-hub/registrations/` like every other tool.

### 0.4 Frontend login
- `public/index.html:6`: delete the login card.
- `public/app.js:4-7, 76-80, 105`: delete `token` state, `sessionStorage['bouncer-token']`, the `Authorization` header in `api()`, the login/logout handlers. `#app` no longer needs `hidden` gating.

### 0.5 Env + docs
- `.env.example`: reduce to what siblings carry — `MODULE_SECRET=` (renamed to `bouncer_secret=` in Phase 1), `HUB_URL`/`dashboard_url=`, `PORT`/`HOST`. Remove ADMIN_TOKEN, MODULE_UUID, BOUNCER_INSTANCE_ID, PUBLIC_URL, DATABASE_URL.
- README/MODERATION.md: drop all organiser-token instructions ("download updated Hub JSON", token prerequisites).

### Phase 0 acceptance
- `npm test` green after stripping 401/token tests (the "401 without token" cases in `combined-moderation.test.mjs`, token setup in `server.test.mjs`, sync-route auth cases in `hub-members.test.mjs`).
- Hub events still processed with no secret in the webhook URL.
- `grep -ri 'adminToken\|ADMIN_TOKEN\|secureEqual\|bouncer-token' --include='*.mjs' --include='*.js' --include='*.html'` → only the kept module `secret` remains.

---

## Phase 1 — Standard project skeleton

Copy the sibling layout; keep behavior identical (still `.mjs`-era logic, now as TS in new paths):

```
src/index.ts        entrypoint: express app, toolRegistration, generateRegistrationFile(), static serve
src/duckdb.ts       storage (Phase 2 — stub file until then? No: port in Phase 2; Phase 1 keeps JSON storage behind a temporary adapter)
src/bouncer.ts      pure helpers (from bouncer.mjs: CSV, normalizePhone, prepareImport, report, digest, participantFromEvent)
src/moderation.ts   pure matching engine (from moderation.mjs)
src/hub.ts          hub API client (from hub-members.mjs: fetchMemberSnapshot, sendKicks, DEFAULT_HUB_URL)
src/operations.ts   request routing + state ops (from operations.mjs, moderation-operations.mjs)
types.ts            MatrixEvent (minimal, events-tool style), domain types: Participant, Decision, ModerationConfig, Incident, Rule, Settings
```

- `tsconfig.json`: copy `events-tool/tsconfig.json` (nodenext, `outDir: ./dist`, exclude web/dist).
- `package.json`: name `bouncer-tool`, standard scripts (`test: vitest run`, `build: npx tsc`, `start: node dist/src/index.js`, `dev`, `dev-web: vite web`, `build-web: vite build web`). Deps: `@duckdb/node-api`, `dotenv`, `express ^5`, `uuid`; dev: `vite ^7`, `vitest`, `@vitejs/plugin-react-swc`, `vite-plugin-singlefile`, `@types/*`. Delete `@neondatabase/serverless` and `@electric-sql/pglite` in Phase 2, not here.
- `src/index.ts` mirrors `events-tool/src/index.ts:15-37`: `toolRegistration` object (`id: 'bouncer'`, `uuid: uuidv4()`, `url: http://localhost:5059`, emoji/title/introduction/description unchanged, `secret`, `event_types: { passive: ['m.room.member', 'm.room.message'] }`), written to `./bouncer.json` at boot.
- Unify module id on **`bouncer`** (what `hub-members.mjs:2`, `registration.mjs:5`, and the live `tool-hub/registrations/bouncer.json` already use). Fix README/HUB-MEMBERS references to `whatsapp-bouncer`.
- Port: keep 5059 (already registered in the hub's registrations file; no sibling collision).

### Phase 1 acceptance
- `npm run build && npm start` boots the Express app on 5059, writes `bouncer.json`, serves the existing `public/` dashboard via express static, webhook + API behavior unchanged, vitest suite green (ported tests colocated as `src/*.test.ts`).

---

## Phase 2 — DuckDB multi-room storage

Replace `storage.mjs` (JSON CAS store + Neon) with `src/duckdb.ts` following `events-tool/src/duckdb.ts`:

- File `bouncer_duckdb.db` at `DUCKDB_DATA_DIR ?? repo root`; `tables` array of `{name, creationCommand}` + create-if-missing loop; all-`VARCHAR`/`BOOLEAN` columns, ISO-string timestamps; positional `prepare`/`bindVarchar` accessors; promise-queue write lock (schedule-tool `withWriteLock` pattern) replaces optimistic-CAS.
- Single always-on process under pm2 ⇒ no CAS/409 machinery, no 2 MB cap, no revision digests for concurrency (`digest()` stays as a pure id helper).
- **Multi-room split** of the current single state blob — every table keyed by `room_id`:

  | Table | Columns (from state fields) |
  | --- | --- |
  | `Settings` | room_id, country, auto_kick, exempt_user_ids, roster_sync (JSON) |
  | `Approved` | room_id, entry_id, name, phone_raw, phone, user_id, reference, source, membership |
  | `Participants` | room_id, participant_id, user_id, name, phone_raw, phone, phone_error, phone_source, source, reference, issues, membership, event_ts, kick_status, kick_at |
  | `Decisions` | room_id, user_id, status, note, decided_at, expires_at, signature |
  | `ModerationConfig` | room_id, mode, warning, cooldown_seconds, exempt_senders, rules (JSON) |
  | `Incidents` | room_id, incident_id, event_id, sender, display_name, text, matches, exceptions, status, note, warning, created_at, reviewed_at |
  | `Seen` | room_id, digest, kind, seen_at (7-day pruning stays, now `DELETE WHERE seen_at < …`) |
  | `Audit` | room_id, at, action, detail |

- `operate(state, context)` becomes per-room handlers over these tables (`getXxxByRoomId` / `insertXxx` / `updateXxx` accessors, events-tool naming). Demo data (`/api/demo`) loads into the same tables tagged by the demo room id and is deleted wholesale on reset — same user-visible behavior.
- Room scoping changes with the storage model:
  - Drop the "one group per instance" settings lockout (`operations.mjs:50-61`).
  - Webhook events carry `event.room_id` ⇒ route to that room's rows directly.
  - API routes take `roomId` from the query string, matching the hub proxy convention (`/bouncer?roomId=…` → tool `/api/…?roomId=…`).
- Delete: `storage.mjs`, `db/setup.sql`, `api/index.mjs`, `vercel.json`, `.vercelignore`, `Dockerfile`, `compose.yaml`, `.dockerignore`, `DEPLOY-VERCEL.md`, Postgres deps.

### Phase 2 acceptance
- Restart persistence: import approved list → restart → list intact (replaces the PGlite/Neon tests).
- Two rooms imported side by side don't bleed into each other (new test; the old design couldn't express this).
- Concurrent same-room writes serialize without errors (write-lock test).
- Demo load/clear and 7-day `Seen` pruning verified.

---

## Phase 3 — Hub contract alignment

Align the webhook with what the hub actually sends/expects (`tool-hub/src/index.ts:35-47`, `:196-232`):

- `app.post("/", …)` body is the hub envelope `{event, botUserId, displayName}`; tool responds `{success: true, response}` where `response` is a string, `{message, recipient?, context?}`, or an array. Map the moderation warning reply (`{message: warning, context: {autoModerator: true, moduleEvent: true}}`) into that shape; kicks already go out-of-band via `POST {dashboard_url}/api/kick?roomId&toolId&secret` (`hub.ts`), which the hub validates (`tool-hub/src/webserver.ts:182-196`) — keep.
- `fetchMemberSnapshot` keeps calling hub `GET /api/members?roomId&toolId` with the bearer module secret (`hub-members.mjs:54-76` → `hub.ts`). **Open dependency, unchanged by this conversion**: the inspected hub has no `/api/members` endpoint; HUB-MEMBERS.md remains the contract doc for the hub operator.
- Enrichment fields on forwarded events (`participant`, `botUserId`, `displayName` per HUB-MEMBERS.md) validated against `tool-hub` types during implementation.

### Phase 3 acceptance
- End-to-end against the real hub: registration copied to `tool-hub/registrations/`, hub restarted, tool receives a passive `m.room.message`, warning path returns a group message, auto-kick path calls `/api/kick` successfully.

---

## Phase 4 — Frontend port to `web/` (React)

Rebuild `public/` (vanilla `app.js` + `index.html`) as the sibling dashboard shape:

- `web/`: `index.html`, `main.tsx` (`BrowserRouter`), `App.tsx` (reads `roomId` from query — hub proxy link `/{tool.id}?roomId=…`; without it, show the "Open this dashboard from the Chat Hackers hub" notice like `schedule-tool/web/App.tsx:177`), `requests.ts` (same-origin calls through the hub proxy; bare-origin calls for hub APIs), `vite.config.ts` with `@vitejs/plugin-react-swc` + `vite-plugin-singlefile`.
- Port the existing UI 1:1 as React components: room/country settings, People table with review/kick actions, Flagged messages with review flow, bouncer settings (auto-remove, exempt list, CSV import with preview/confirm), message-rules editor (mode/warning/rules/cooldown), demo load/clear, report export. **No login card** (Phase 0 removed it); all calls scoped by `?roomId=`.
- Express serves `web/dist/index.html` at `/` (`events-tool/src/index.ts:38-43` pattern). Delete `public/`.

### Phase 4 acceptance
- `npm run dev-web` exercises every flow against the dev server; built singlefile served through the hub proxy at `/bouncer?roomId=…` renders with real data.

---

## Phase 5 — Deploy story, docs, cleanup

- `deploy.sh` (events-tool pattern): `git pull && npm i && npm run build-web && npm run build && pm2 restart bouncer`.
- `.gitignore`: sibling-style — `bouncer.json`, `*duckdb.db`, `*duckdb.db.wal`, `dist/`, `web/dist/`, `.env`.
- `.env.example`: `bouncer_secret=`, `dashboard_url=`, `DUCKDB_DATA_DIR=` (optional), port note.
- README rewritten in the schedule-tool style: purpose, getting started (clone → `npm install` → `npm run dev` → copy `bouncer.json` into hub `registrations` → restart hub), Environment table, notes on demo mode + moderation. Fold MODERATION.md/HUB-MEMBERS.md content in or keep as secondary docs (keep — they carry the hub contract).
- `LICENSE`: GPL copy from any sibling.
- Delete the old root `.mjs` files (`server.mjs`, `handler.mjs`, `bouncer.mjs`, `operations.mjs`, `moderation.mjs`, `moderation-operations.mjs`, `hub-members.mjs`, `registration.mjs`, `storage.mjs`) and `tests/` once their ports are green — no shims, no re-exports.
- Remove `data/` artifacts (`identity.json`, old `state.json`/`whatsapp-bouncer.json`) from the repo.

### Final acceptance checklist
1. `npm run build-web && npm run build && npm start` from a clean clone; `npm test` green.
2. Tool boots on 5059, writes `bouncer.json` with no `?hook=` and no auth anywhere; hub processes events for two rooms independently.
3. `grep -ri 'adminToken\|ADMIN_TOKEN\|vercel\|neon\|pglite\|identity.json\|sessionStorage' src web types.ts` → zero hits.
4. Real-hub smoke per Phase 3, plus dashboard smoke per Phase 4 through the hub proxy.
