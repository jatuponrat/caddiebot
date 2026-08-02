# Caddiebot Engine

Deterministic backend + LINE webhook for the AI Golf Caddie. It parses messy
Thai/English LINE messages, computes local handicaps, classifies the game
handicap level, and structures hole scores into the standard backend JSON
envelope. It **never** finalizes money settlement — that stays in your backend.

the engine here is the deterministic math and parsing.

## Run

```bash
npm install            # needs network access to npm (only dependency: express)
cp .env.example .env   # add your LINE channel secret + access token
npm run dev            # local: loads .env, auto-restarts, webhook on :3000
npm test               # 37 tests, no network or deps needed
```

Scripts: `npm run dev` (local, loads `.env`) · `npm start` (production/Render —
reads real env vars, no `.env` file) · `npm run start:local` (production-style
run locally with `.env`). To deploy on Render, see **DEPLOY.th.md**.

## Endpoints

- `POST /webhook` — LINE Messaging API webhook. Verifies `x-line-signature`,
  routes each event through the handler, replies with the structured JSON.
- `POST /simulate` — no signature; `{ "text": "...", "sourceId": "..." }` → JSON.
  Reuse the same `sourceId` across calls to simulate one group chat:
  ```bash
  S=mygroup
  curl -s localhost:3000/simulate -d '{"text":"สร้างเกม 2 คน","sourceId":"'$S'"}' -H 'content-type: application/json'
  curl -s localhost:3000/simulate -d '{"text":"เข้าร่วม ชื่อ A 92,95,90","sourceId":"'$S'"}' -H 'content-type: application/json'
  ```
- `GET /health` — liveness check.

## What each message becomes

| Input | `action` |
|---|---|
| `สร้างเกม 4 คน` / `create game` | `create_game` (+ 4-digit `room_code`) |
| `เข้าร่วม 4821 ชื่อ A 92,95,90` | `join` (+ inline `handicap_index`) |
| `หลุม 1 A 5 B 6 C 5 D 7` | `hole_scores` (+ `net` if context given) |
| pasted course JSON | `extract_course` (validated, 18 holes) |

## Group usage (add the bot to a LINE group)

Add the bot to a LINE group and **that group becomes the room** — state is keyed
by `groupId`, so members just chat (no need to retype the room code):

1. Add the bot → it posts a Thai welcome with the commands.
2. Anyone: `สร้างเกม 4 คน` → bot creates the room.
3. Each player: `เข้าร่วม ชื่อ A 92,95,90` → handicap computed, roster updates.
4. Type the par card: a preset course name, or `454354434 443535444`.
5. Each hole: `หลุม 1 A 5 B 6 C 5 D 7` → net computed from stored handicaps.

The bot replies with the friendly Thai `summary.message`; the full JSON envelope
still goes to your backend. State is in-memory (`src/gameStore.js`) — swap for a
DB in production.

## Handicap formula (spec rule #4)

Best (lowest) of the last 3 rounds is weighted double:
`round((best*2 + other two) / 4)`. e.g. `[92,95,90]` → `round(367/4)` → **92**.

## Game handicap level (spec rule #5)

Diff = highest − lowest handicap among players.

| diff | level |
|---|---|
| ≤ 5 | 0 |
| 6–12 | 1 |
| 13–16 | 2 |
| 17–23 | 3 |
| 24–30 | 4 |
| 31+ | 5 |

## ⚠️ Confirm the stroke rules table

The spec only defines the stroke allocation for **level 2**
(`{par4:1, par5:1, par3:0}`). Levels 0,1,3,4,5 in
`HANDICAP_RULES_TABLE` (top of `src/engine.js`) are a reasonable **default** —
edit that one table to match your real game rules. It's the single source of
truth for strokes-per-hole-type.

## Net scores & settlement

`hole_scores` returns gross only by default. It adds a `net` **suggestion** when
you pass context — either `strokesByPlayer: {name: n}`, or `course` + `rules` +
`receivers` (which players get strokes). Who receives strokes and all money
settlement remain the backend's job (spec rules #6, #8).

## Files

```
engine.js     handicap, level + rules table, net, course validation, room code
parser.js     Thai/English intent detection + extraction (Thai-digit aware)
handler.js    stateless message -> standard backend JSON envelope
gameStore.js  in-memory room/game state, keyed by LINE groupId
session.js    stateful, group-aware dispatcher (Thai replies)
line.js       LINE signature verification + reply (text / JSON)
server.js     Express webhook (group-aware) + /simulate + /health
test/         37 node:test cases (engine, parser, handler, session)
```
