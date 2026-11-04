# Auto Bouncer & Moderator

Matrix tool for Chat Hackers: checks new room members against an organiser-approved phone-number list, and flags/warns/removes on message rules. Runs as a long-running Express service backed by DuckDB, registered with the [tool-hub](../tool-hub) like the other Chat Hackers tools.

## Layout

Conventions match the sibling tools (events-tool, schedule-tool):

- `src/` — TypeScript server: Express app (`index.ts` entrypoint, `app.ts` wiring), room-scoped routes (`operations.ts`), DuckDB storage (`duckdb.ts`), comparison engine (`bouncer.ts`), message rules (`moderation.ts`), hub client (`hub.ts`)
- `web/` — React 19 + Vite dashboard, built to a single inlined `web/dist/index.html` (vite-plugin-singlefile), served at `/` by the server
- `bouncer.json` — tool registration payload written at startup; share it with the Hub operator privately (contains the module secret)
- `data/` — `bouncer_duckdb.db` (DuckDB, multi-room: every row is keyed by `room_id`)

## Run

```sh
npm install
npm run build-web   # builds web/dist/index.html
npm run build       # tsc -> dist/
npm start           # http://localhost:5059
```

`.env`:

```
PORT=5059
bouncer_secret=choose-a-long-private-secret   # module secret embedded in bouncer.json
dashboard_url=https://your-hub.example        # hub origin, used for kick calls
DUCKDB_DATA_DIR=./data                        # optional; defaults to repo root
```

Deploy: `./deploy.sh` (git pull, install, build web + server, `pm2 restart bouncer`).

## Hub integration

The Hub sends passive `m.room.member` and `m.room.message` events to the webhook at `/`. The tool responds with `{success, response}`; `response.message` (when moderation rules fire in live mode) is sent back to the room by the Hub. Removals are requested by the tool calling the Hub's kick API with the module secret.

The dashboard is room-scoped: all `/api/*` routes take `?roomId=...`. Access control lives in the Hub, which proxies the dashboard only for approved admins — this tool tracks no tokens itself.

## Tests

```sh
npm test            # vitest: unit tests + end-to-end suite over the real HTTP surface
```

## Notes

- A phone-number match is only a match to the supplied list, not proof of ownership, affiliation or eligibility. Numbers are normalised conservatively; opaque identities are never guessed.
- Moderation starts in demo mode per room: incidents are recorded but nothing is sent or removed until live mode is enabled for that room.
- Demo data (Load demo) can only be loaded into an empty room and is clearly labelled; clearing it removes the labelled rows.
- Exports contain full phone numbers; handle them privately.
