// server.js
// Express LINE webhook — group-aware. Add the bot to a LINE group and each
// group becomes its own game room (keyed by groupId). Messages are routed
// through the stateful session dispatcher; the bot replies in Thai.

import express from "express";
import { GameStore, SESSION_TTL_MS } from "./gameStore.js";
import { dispatch, welcomeMessage, isIdle } from "./session.js";
import { verifySignature, replyJson, replyText } from "./line.js";
import { initDb, dbEnabled, dbLastError } from "./db.js";
import { loadCoursesFromDb } from "./courseStore.js";

const PORT = process.env.PORT || 3000;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

const store = new GameStore(); // in-memory; swap for DB/backend in production
const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Health + self-diagnosis. Open this in a browser to confirm persistence is
// ACTUALLY working, not just configured:
//   database_url_set: true  -> DATABASE_URL env var is present
//   db_connected:     true  -> the Postgres connection actually succeeded —
//                              this is the one that matters. If this is false
//                              while database_url_set is true, the connection
//                              string is stale/wrong (e.g. a paused Supabase
//                              project) and games still die on every sleep.
//   keep_alive:       true  -> SELF_URL is set, the free instance won't sleep mid-round
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "caddiebot-engine",
    database_url_set: dbEnabled(),
    db_connected: _dbStatus.connected,
    db_error: _dbStatus.error,
    keep_alive: Boolean(process.env.SELF_URL),
    session_ttl_hours: SESSION_TTL_MS / 3600000,
    live_games: store.rooms.size,
    uptime_min: Math.round(process.uptime() / 60), // small number = just cold-started
    started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  })
);

// One game per LINE source: group > room > 1:1 user.
function sourceIdOf(source = {}) {
  return source.groupId || source.roomId || source.userId || null;
}

app.post("/webhook", async (req, res) => {
  const signature = req.get("x-line-signature");
  if (CHANNEL_SECRET) {
    if (!verifySignature(req.rawBody, signature, CHANNEL_SECRET)) {
      return res.status(401).json({ ok: false, error: "bad signature" });
    }
  } else {
    console.warn("[caddiebot] LINE_CHANNEL_SECRET not set — signature check skipped (dev only).");
  }

  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  res.status(200).json({ ok: true, received: events.length }); // ack fast

  for (const ev of events) {
    try {
      await processEvent(ev);
    } catch (err) {
      console.error("[caddiebot] event error:", err);
    }
  }
});

// --- startup / state restore ------------------------------------------------
// The DB restore MUST finish before we answer webhooks. Previously it ran inside
// the listen() callback, so a message arriving during a cold start (very common
// on Render's free plan, which sleeps after ~15 min idle) found an empty store
// and the bot went silent — looking exactly like "the game timed out".
let _ready = null;
// Surfaced on /health — database_url_set only means the env var is present;
// db_connected means a real query actually succeeded. A stale/wrong connection
// string (e.g. a paused Supabase project) shows database_url_set:true,
// db_connected:false — the games still silently die every time the instance
// sleeps until this is fixed.
const _dbStatus = { connected: false, error: null };

async function tryConnectDb() {
  if (!dbEnabled()) return false;
  const ok = await initDb();
  _dbStatus.connected = ok;
  _dbStatus.error = ok ? null : dbLastError();
  if (!ok) return false;
  const [courses, sessions] = await Promise.all([loadCoursesFromDb(), store.loadFromDb()]);
  console.log(
    `[caddiebot] DB ready — loaded ${courses} course(s), ${sessions} active session(s)`
  );
  return true;
}

async function bootstrap() {
  if (!dbEnabled()) {
    console.log("[caddiebot] no DATABASE_URL — running in-memory (no persistence)");
    console.warn(
      "[caddiebot] WARNING: without DATABASE_URL every restart/sleep wipes live games."
    );
    return;
  }
  const ok = await tryConnectDb();
  if (!ok) {
    console.warn(
      `[caddiebot] DB configured but init failed (${_dbStatus.error}) — running in-memory. ` +
        `Will keep retrying every 5 min in case the DB comes back (e.g. an unpaused Supabase project).`
    );
    // Self-heal: once the user fixes DATABASE_URL / un-pauses the DB, pick it
    // up without needing a redeploy.
    const retry = setInterval(async () => {
      if (await tryConnectDb()) {
        console.log("[caddiebot] DB connection recovered.");
        clearInterval(retry);
      }
    }, 5 * 60 * 1000);
    retry.unref?.();
  }
}

export function ready() {
  if (!_ready) _ready = bootstrap().catch((e) => console.error("[caddiebot] bootstrap:", e));
  return _ready;
}

export async function processEvent(ev) {
  await ready(); // never serve a webhook from a half-loaded store
  // Bot added to a group/room, or a user adds the bot as a friend -> greet (Thai).
  if ((ev.type === "join" || ev.type === "follow") && ev.replyToken) {
    return replyText(ev.replyToken, welcomeMessage(), ACCESS_TOKEN);
  }
  // New member(s) joined a group the bot is in -> greet.
  if (ev.type === "memberJoined" && ev.replyToken) {
    return replyText(ev.replyToken, welcomeMessage(), ACCESS_TOKEN);
  }

  if (ev.type !== "message" || !ev.replyToken) return;
  const sourceId = sourceIdOf(ev.source);

  // Cold in-memory cache? Try to re-hydrate this group's game from the DB before
  // deciding there's no live game. Without this, a restart mid-round silently
  // killed the game even though the state was still in Postgres.
  if (sourceId && !store.activeGame(sourceId)) {
    await store.restoreSource(sourceId).catch(() => null);
  }

  if (ev.message.type === "text") {
    const payload = dispatch(ev.message.text, sourceId, store);
    // No live game (never started, or expired after 12h) -> total silence.
    // Only "สร้างเกม" / "สร้างเกมส์" wakes the bot back up.
    if (isIdle(payload)) return;
    // In a group/room, stay quiet on unrelated chatter so the bot isn't noisy.
    // In 1:1 chat, reply with the help hint.
    if (payload.action === "unknown" && ev.source?.type !== "user") return;
    return replyJson(ev.replyToken, payload, ACCESS_TOKEN); // sends Thai summary.message
  }

  // Images, stickers, files, audio — the bot is text-only and stays silent.
  // Scorecard-photo reading (AI vision) was removed: pars are typed in instead,
  // either as a preset course name or the 18-digit par card.
  return;
}

// Local test endpoint (no signature): POST {text, sourceId, ctx} -> JSON.
// Use the same sourceId across calls to simulate one group chat.
app.post("/simulate", (req, res) => {
  const { text, sourceId } = req.body || {};
  res.json(dispatch(text ?? "", sourceId ?? "sim-default", store));
});

// Render's free plan spins the instance down after ~15 min without traffic — and
// a golf group goes quiet far longer than that between holes. Pinging our own
// /health keeps the process (and the in-memory game) alive during a round.
// Set SELF_URL to the Render URL, e.g. https://caddiebot.onrender.com
function startKeepAlive() {
  const url = (process.env.SELF_URL || "").replace(/\/+$/, "");
  if (!url) {
    console.warn("[caddiebot] SELF_URL not set — no keep-alive ping (instance may sleep).");
    return;
  }
  const every = Number(process.env.KEEPALIVE_MS || 10 * 60 * 1000);
  setInterval(() => {
    fetch(`${url}/health`).catch(() => {});
  }, every).unref?.();
  console.log(`[caddiebot] keep-alive pinging ${url}/health every ${Math.round(every / 60000)}m`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  app.listen(PORT, async () => {
    console.log(`[caddiebot] webhook listening on :${PORT}`);
    await ready();
    startKeepAlive();
  });
}

export { app, store };
