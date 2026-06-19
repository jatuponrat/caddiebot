// server.js
// Express LINE webhook — group-aware. Add the bot to a LINE group and each
// group becomes its own game room (keyed by groupId). Messages are routed
// through the stateful session dispatcher; the bot replies in Thai.

import express from "express";
import { GameStore } from "./gameStore.js";
import { dispatch, welcomeMessage } from "./session.js";
import { emptyEnvelope } from "./handler.js";
import { verifySignature, replyJson, replyText } from "./line.js";
import { initDb, dbEnabled } from "./db.js";
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

app.get("/health", (_req, res) => res.json({ ok: true, service: "caddiebot-engine" }));

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

export async function processEvent(ev) {
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

  if (ev.message.type === "text") {
    const payload = dispatch(ev.message.text, sourceId, store);
    // In a group/room, stay quiet on unrelated chatter so the bot isn't noisy.
    // In 1:1 chat, reply with the help hint.
    if (payload.action === "unknown" && ev.source?.type !== "user") return;
    return replyJson(ev.replyToken, payload, ACCESS_TOKEN); // sends Thai summary.message
  }

  if (ev.message.type === "image") {
    // Engine can't OCR. Hand the image off to the AI vision step:
    //   GET https://api-data.line.me/v2/bot/message/{messageId}/content
    // then send it to the Caddie AI vision model to fill course.holes, and POST
    // the resulting JSON back here (course_json) to store it for the group.
    const payload = {
      ...emptyEnvelope(),
      action: "image_received",
      summary: {
        ok: true,
        awaiting_course_extraction: true,
        message_id: ev.message.id,
        source_id: sourceId,
        message: "ได้รับรูปสกอร์การ์ดแล้ว กำลังส่งให้ AI อ่านพาร์ 18 หลุม…",
      },
    };
    return replyJson(ev.replyToken, payload, ACCESS_TOKEN);
  }

  return replyText(
    ev.replyToken,
    "รองรับเฉพาะข้อความและรูปภาพครับ",
    ACCESS_TOKEN
  );
}

// Local test endpoint (no signature): POST {text, sourceId, ctx} -> JSON.
// Use the same sourceId across calls to simulate one group chat.
app.post("/simulate", (req, res) => {
  const { text, sourceId } = req.body || {};
  res.json(dispatch(text ?? "", sourceId ?? "sim-default", store));
});

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  app.listen(PORT, async () => {
    console.log(`[caddiebot] webhook listening on :${PORT}`);
    if (dbEnabled()) {
      const ok = await initDb();
      if (ok) {
        const [courses, sessions] = await Promise.all([
          loadCoursesFromDb(),
          store.loadFromDb(),
        ]);
        console.log(
          `[caddiebot] DB ready — loaded ${courses} course(s), ${sessions} active session(s)`
        );
      } else {
        console.warn("[caddiebot] DB configured but init failed — running in-memory");
      }
    } else {
      console.log("[caddiebot] no DATABASE_URL — running in-memory (no persistence)");
    }
  });
}

export { app, store };
