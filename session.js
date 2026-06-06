// session.js
// Stateful, group-aware dispatcher: a message + LINE sourceId (groupId/userId)
// is routed through the GameStore and returned as the standard backend envelope,
// with a friendly Thai `summary.message` for the chat reply.

import {
  detectIntent,
  parseCreateGame,
  parseJoin,
  parseHoleScores,
} from "./parser.js";
import { emptyEnvelope } from "./handler.js";

const WELCOME_TH =
  "สวัสดีครับ ผมแคดดี้บอท ⛳\n" +
  "พิมพ์ “สร้างเกม 4 คน” เพื่อเริ่ม\n" +
  "เข้าร่วม: “เข้าร่วม <รหัส> ชื่อ <ชื่อ> 92,95,90”\n" +
  "ลงแต้ม: “หลุม 1 A 5 B 6 C 5 D 7”\n" +
  "ส่งรูปสกอร์การ์ดเพื่อดึงพาร์ 18 หลุม";

export function welcomeMessage() {
  return WELCOME_TH;
}

/**
 * @param {string} text - user message
 * @param {string} sourceId - LINE groupId (group chat) or userId (1:1)
 * @param {import('./gameStore.js').GameStore} store
 * @returns standard envelope (with Thai summary.message)
 */
export function dispatch(text, sourceId, store) {
  const intent = detectIntent(text);

  if (intent === "create_game") {
    const { expected_players } = parseCreateGame(text);
    const game = store.createGame(sourceId, { expected_players });
    const env = emptyEnvelope();
    env.action = "create_game";
    env.room_code = game.room_code;
    env.summary = {
      ok: true,
      status: game.status,
      expected_players,
      message:
        `สร้างห้อง ${game.room_code} แล้ว ✅ รอผู้เล่นเข้าร่วม` +
        (expected_players ? ` (0/${expected_players})` : ""),
    };
    return env;
  }

  if (intent === "join") {
    const parsed = parseJoin(text);
    const r = store.join(sourceId, parsed);
    const env = emptyEnvelope();
    env.action = "join";
    env.room_code = parsed.room_code || r.game?.room_code || null;
    env.scores = parsed.scores;
    if (!r.ok) {
      env.summary = {
        ok: false,
        message:
          r.error === "room_not_found"
            ? "ไม่พบห้อง — พิมพ์ “สร้างเกม” ก่อน หรือใส่รหัสห้องให้ถูกต้อง"
            : "ต้องมีชื่อและสกอร์ 3 รอบ เช่น “เข้าร่วม 4821 ชื่อ A 92,95,90”",
      };
      return env;
    }
    const g = r.game;
    env.players = g.players;
    env.handicap_level = g.handicap_level;
    env.rules = g.rules;
    const count = g.players.length;
    const cap = g.expected_players ? `/${g.expected_players}` : "";
    env.summary = {
      ok: true,
      player: parsed.player,
      handicap_index: r.handicap_index,
      status: g.status,
      message:
        `${parsed.player} เข้าร่วมแล้ว (แต้มต่อ ${r.handicap_index}) ` +
        `— ผู้เล่น ${count}${cap} คน` +
        (g.status === "ready" ? " ครบแล้ว เริ่มได้เลย!" : ""),
    };
    return env;
  }

  if (intent === "hole_scores") {
    const parsed = parseHoleScores(text);
    const r = store.recordHole(sourceId, parsed);
    const env = emptyEnvelope();
    env.action = "hole_scores";
    env.hole = parsed.hole;
    if (!r.ok) {
      env.summary = {
        ok: false,
        message:
          r.error === "room_not_found"
            ? "ยังไม่มีเกมในกลุ่มนี้ — พิมพ์ “สร้างเกม” ก่อน"
            : "อ่านหมายเลขหลุมไม่ได้ เช่น “หลุม 1 A 5 B 6”",
      };
      return env;
    }
    env.players = r.players;
    env.handicap_level = r.game.handicap_level;
    env.rules = r.game.rules;
    env.summary = {
      ok: true,
      hole: parsed.hole,
      par: r.par,
      net_computed: r.net_computed,
      message: r.net_computed
        ? `บันทึกหลุม ${parsed.hole} แล้ว (คิด net จากแต้มต่อให้แล้ว)`
        : `บันทึกหลุม ${parsed.hole} แล้ว — ส่งรูปสกอร์การ์ดก่อนถึงจะคิด net ได้`,
      note: "ไม่สรุปเงินที่นี่ — เป็นหน้าที่ backend",
    };
    return env;
  }

  if (intent === "course_json") {
    const env = emptyEnvelope();
    env.action = "extract_course";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      env.summary = { ok: false, message: "รูปแบบ JSON สนามไม่ถูกต้อง" };
      return env;
    }
    const r = store.setCourse(parsed.room_code || null, sourceId, parsed.course ?? parsed);
    env.course = r.game?.course ?? null;
    env.summary = {
      ok: r.ok,
      errors: r.errors,
      message: r.ok
        ? `บันทึกสนามแล้ว (พาร์รวม ${r.game.course.total_par})`
        : "ข้อมูลสนามไม่ครบ 18 หลุม หรือค่าพาร์ผิด",
    };
    return env;
  }

  const env = emptyEnvelope();
  env.action = "unknown";
  env.summary = {
    ok: false,
    message:
      "พิมพ์ “สร้างเกม”, “เข้าร่วม <รหัส> ชื่อ <ชื่อ> 92,95,90”, หรือ “หลุม 1 A 5 B 6”",
  };
  return env;
}
