// session.js
// Stateful, group-aware dispatcher: a message + LINE sourceId (groupId/userId)
// is routed through the GameStore and returned as the standard backend envelope,
// with a friendly Thai `summary.message` for the chat reply.

import {
  detectIntent,
  parseCreateGame,
  parseJoin,
  parseHoleScores,
  parseParString,
  parseBulkScores,
  lookupPresetCourse,
} from "./parser.js";
import {
  settleHole,
  settleHoleHeadEatsTail,
  settleGame,
  scoreEmoji,
  strokesBetween,
} from "./engine.js";
import { findCustomCourse, rememberCourse } from "./courseStore.js";
import { saveRound } from "./db.js";
import { emptyEnvelope } from "./handler.js";

/** "A +40, B −20, C 0" — format a {name: amount} money map for chat. */
function fmtMoney(map) {
  return Object.entries(map)
    .map(([n, v]) => (v > 0 ? `${n} +${v}` : v < 0 ? `${n} −${Math.abs(v)}` : `${n} 0`))
    .join(", ");
}

function parForHole(game, hole) {
  const holes = game && game.course && game.course.holes;
  if (!holes) return null;
  const h = holes.find((x) => Number(x.hole) === Number(hole));
  return h ? h.par : null;
}

/** "⛳ หลุม 1 Par 4 เริ่ม !!" (par from the room's course). */
function holeAnnounce(game, n) {
  const par = parForHole(game, n);
  return par != null ? `⛳ หลุม ${n} Par ${par} เริ่ม !!` : `⛳ หลุม ${n} เริ่ม !!`;
}

/** When the roster is full, kick off hole 1 (or ask for pars first).
 *  `store` is optional but should be passed so current_hole is persisted. */
function maybeStartRound(game, store) {
  if (game.status === "ready" && game.current_hole == null) {
    if (game.course) {
      game.current_hole = 1;
      store?.save(game);
      return (
        `\n🏁 ผู้เล่นครบแล้ว!\n` +
        `${holeAnnounce(game, 1)}\n` +
        `📝 ส่งสกอร์: "หลุม 1 [ชื่อ] [แต้ม]"\n` +
        `เช่น "หลุม 1 แซม 5 Muay 6"\n` +
        `หรือส่งทีละคนก็ได้ เช่น "หลุม 1 แซม 5"\n` +
        `⛳ เช็คก่อนออกรอบ: พิมพ์ "แต้มต่อ" ดูว่าใครต่อใครเท่าไร`
      );
    }
    return (
      `\n🏁 ผู้เล่นครบแล้ว! กรอกพาร์สนามก่อน เช่น "454354434 443535444"\n` +
      `⛳ เช็คก่อนออกรอบ: พิมพ์ "แต้มต่อ" ดูว่าใครต่อใครเท่าไร`
    );
  }
  return "";
}

/** Strokes `receiver` gets from `giver` over the whole course, when pars are
 *  known. Returns null when the course hasn't been entered yet. */
function roundStrokes(game, receiver, giver) {
  const holes = game.course?.holes;
  if (!Array.isArray(holes) || holes.length === 0) return null;
  return holes.reduce(
    (sum, h) => sum + strokesBetween(game.stroke_matrix, receiver, giver, h.par),
    0
  );
}

/**
 * Human-readable "who gives whom what" table for the current roster.
 * Every pairing is classified on its OWN handicap gap, so this is the exact
 * allocation settlement will use — meant to be checked BEFORE teeing off.
 */
export function handicapTable(game) {
  const players = game.players || [];
  if (players.length < 2) return `ยังมีผู้เล่นไม่พอ — ต้องมีอย่างน้อย 2 คน`;
  if (!game.stroke_matrix) return `ยังคิดแต้มต่อไม่ได้ — ผู้เล่นยังเข้าร่วมไม่ครบ`;

  const byIdx = [...players].sort((a, b) => a.handicap_index - b.handicap_index);
  const lines = [`⛳ ตารางแต้มต่อ · ห้อง ${game.room_code}`, ""];
  lines.push(`แต้มต่อ: ${byIdx.map((p) => `${p.name} ${p.handicap_index}`).join(" · ")}`);

  // pairs that play straight up
  const even = [];
  for (let i = 0; i < byIdx.length; i++) {
    for (let j = i + 1; j < byIdx.length; j++) {
      const a = byIdx[i];
      const b = byIdx[j];
      const r = game.stroke_matrix[b.name]?.[a.name];
      if (!r || (!r.par3 && !r.par4 && !r.par5)) {
        even.push(`${a.name}–${b.name} (ห่าง ${b.handicap_index - a.handicap_index})`);
      }
    }
  }
  if (even.length) lines.push("", `🤝 เล่นตรงๆ ไม่ต่อกัน`, ...even.map((s) => `• ${s}`));

  // everyone who receives something, weakest first
  for (const p of [...byIdx].reverse()) {
    const rows = byIdx
      .filter((o) => o.name !== p.name)
      .map((o) => ({ o, r: game.stroke_matrix[p.name]?.[o.name] }))
      .filter(({ r }) => r && (r.par3 || r.par4 || r.par5))
      .map(({ o, r }) => {
        const gap = p.handicap_index - o.handicap_index;
        const tot = roundStrokes(game, p.name, o.name);
        const totTxt = tot == null ? "" : ` = ${tot} แต้ม`;
        return `• จาก ${o.name} (ห่าง ${gap}) → พาร์3:${r.par3} พาร์4:${r.par4} พาร์5:${r.par5}${totTxt}`;
      });
    if (rows.length) lines.push("", `📥 ${p.name} รับแต้มต่อ`, ...rows);
  }

  if (!game.course) lines.push("", `(ยังไม่ได้กรอกพาร์สนาม — ยอดรวมต่อรอบจะขึ้นหลังกรอก)`);
  lines.push("", `ตกลงกันแบบนี้ไหมครับ? แก้สกอร์ได้โดยพิมพ์ "เข้าร่วม" ใหม่`);
  return lines.join("\n");
}

const WELCOME_TH =
  `สวัสดีครับ ผมแคดดี้บอท ⛳\n` +
  `พิมพ์ "สร้างเกม 4 คน" (ระบุจำนวนคนด้วย) เพื่อเริ่ม\n` +
  `กรอกพาร์สนาม: "454354434 443535444"\n` +
  `เข้าร่วม: "เข้าร่วม แซม 105 90 91"\n` +
  `ลงแต้ม: "หลุม 1 A 5 B 6" หรือ "H1 แซม 4"\n` +
  `ดูแต้มต่อ: "แต้มต่อ" · สรุปเงิน: "รวม 18" · จบเกม: "จบเกม"`;

export function welcomeMessage() {
  return WELCOME_TH;
}

/** Envelope meaning "no active game — say nothing at all". The transport layer
 *  (server.js) must not reply when it sees this action. */
function idleEnvelope() {
  const env = emptyEnvelope();
  env.action = "idle";
  env.summary = {
    ok: false,
    idle: true,
    reason: "no_active_game",
    // Empty on purpose: the bot stays completely silent until "สร้างเกม".
    message: "",
  };
  return env;
}

export function isIdle(payload) {
  return payload?.action === "idle";
}

/**
 * @param {string} text - user message
 * @param {string} sourceId - LINE groupId (group chat) or userId (1:1)
 * @param {import('./gameStore.js').GameStore} store
 * @returns standard envelope (with Thai summary.message)
 */
export function dispatch(text, sourceId, store) {
  const raw = String(text ?? "");
  const intent = detectIntent(text);

  // --- 12h idle kill switch ------------------------------------------------
  // A game expires 12 hours after the LAST activity (rolling window — see
  // SESSION_TTL_MS + GameStore.touch). Reading the game below renews it, so an
  // in-progress round never dies mid-play. Once there is no live game for this
  // source, Caddiebot ignores EVERYTHING except "สร้างเกม" / "สร้างเกมส์",
  // which starts a completely fresh game.
  const _og = store.activeGame(sourceId);
  if (!_og && intent !== "create_game") return idleEnvelope();

  // Pending hole-override confirmation (ยืนยัน/ยกเลิก after re-submitting a complete hole)
  if (_og?.pending_override) {
    const trimmed = raw.trim();
    if (/^(ยืนยัน|ใช่|yes|^y)$/i.test(trimmed)) {
      const { hole, players } = _og.pending_override;
      _og.pending_override = null;
      store.save(_og);
      const r = store.recordHole(sourceId, { hole, players });
      const env = emptyEnvelope();
      env.action = "hole_scores";
      env.hole = hole;
      const rows = r.game.holes[hole] || [];
      const turbo = Boolean(r.game.turbo && (r.game.turbo_holes || []).includes(hole));
      const netComputed = Boolean(r.game.rules && r.par != null);
      const stakeHole = (r.game.stake || 0) * (turbo ? 2 : 1);
      let holeMoney = null;
      let moneyLine = "";
      if (netComputed && r.game.stake) {
        const settleFn = r.game.format === "head_tail" ? settleHoleHeadEatsTail : settleHole;
        const ctx = r.game.stroke_matrix ? { par: r.par, matrix: r.game.stroke_matrix } : null;
        holeMoney = settleFn(rows, stakeHole, ctx);
        moneyLine = `\n💰 หลุมนี้ (หลุมละ ${stakeHole}): ${fmtMoney(holeMoney)}`;
      }
      env.summary = {
        ok: true, hole, complete: true, par: r.par, net_computed: netComputed,
        turbo, stake: r.game.stake, money: holeMoney,
        message: `แก้ไขหลุม ${hole} แล้ว ✅${turbo ? " 🔥" : ""}${moneyLine}`,
      };
      return env;
    }
    if (/^(ยกเลิก|ไม่|no|^n)$/i.test(trimmed)) {
      _og.pending_override = null;
      store.save(_og);
      const env = emptyEnvelope();
      env.action = "hole_scores";
      env.summary = { ok: false, message: "ยกเลิกแล้ว — สกอร์เดิมยังคงอยู่" };
      return env;
    }
    // not a yes/no — fall through (pending_override stays until answered)
  }

  // Cancel a game that is mid-setup.
  if (/^\s*(ยกเลิก|cancel)\s*$/i.test(raw) && store.pendingSetup(sourceId)) {
    store.cancelGame(sourceId);
    const env = emptyEnvelope();
    env.action = "cancel";
    env.summary = { ok: true, message: `ยกเลิกเกมแล้ว — พิมพ์ "สร้างเกม 4 คน" เพื่อเริ่มใหม่` };
    return env;
  }

  // Guided setup: while a game is mid-setup, free-text replies are the answers.
  const pending = store.pendingSetup(sourceId);
  // While mid-setup, answers (incl. "ชื่อ + พาร์" which looks like bulk/par) go to setup.
  if (
    pending &&
    (intent === "unknown" || intent === "bulk_scores" || intent === "par_string")
  ) {
    return handleSetupAnswer(raw, sourceId, store, pending);
  }
  // Real gameplay (join/score) — end any leftover setup so later chat isn't captured.
  if (pending && (intent === "join" || intent === "hole_scores")) {
    store.finishSetup(sourceId);
  }

  if (intent === "create_game") {
    const { expected_players } = parseCreateGame(text);
    if (!expected_players) {
      const env = emptyEnvelope();
      env.action = "create_game";
      env.summary = {
        ok: false,
        message: `ระบุจำนวนผู้เล่นด้วยครับ เช่น "สร้างเกม 4 คน"`,
      };
      return env;
    }
    const game = store.createGame(sourceId, { expected_players });
    const env = emptyEnvelope();
    env.action = "create_game";
    env.room_code = game.room_code;
    env.summary = {
      ok: true,
      status: game.status,
      expected_players,
      setup: "course",
      message:
        `สร้างห้อง ${game.room_code} แล้ว ✅ (${expected_players} คน)` +
        `\nสนามชื่ออะไรครับ? (พิมพ์ชื่อสนาม)`,
    };
    return env;
  }

  if (intent === "end_game") {
    const env = emptyEnvelope();
    env.action = "end_game";
    const g = store.activeGame(sourceId);
    if (!g) {
      env.summary = { ok: false, message: "ไม่มีเกมที่กำลังเล่นอยู่ในกลุ่มนี้" };
      return env;
    }
    const names = g.players.map((p) => p.name).join(", ") || "—";
    const holesPlayed = Object.keys(g.holes).length;
    const s = settleGame(g);
    const settleLine = s.holesCounted
      ? `\n💰 สรุปเงิน (${s.holesCounted} หลุม): ${fmtMoney(s.perPlayer)}\n(บวก = ได้ / ลบ = จ่าย)`
      : "\n(ยังไม่มีสกอร์ที่บันทึก)";
    env.players = g.players;
    env.summary = {
      ok: true,
      course_name: g.course_name,
      stake: g.stake,
      turbo: g.turbo,
      holes_played: holesPlayed,
      per_player: s.perPlayer,
      message:
        `จบเกมแล้ว ✅\n` +
        `สนาม ${g.course_name || "-"} · ผู้เล่น: ${names} · ${holesPlayed}/18 หลุม` +
        settleLine,
    };
    // persist the round for history (no-op if DB disabled)
    saveRound({
      room_code: g.room_code,
      source_id: sourceId,
      course_name: g.course_name,
      stake: g.stake,
      turbo: g.turbo,
      players: g.players,
      holes: g.holes,
      settlement: s.perPlayer,
    }).catch(() => {});
    store.cancelGame(sourceId);
    return env;
  }

  if (intent === "handicap") {
    const g = store.activeGame(sourceId);
    const env = emptyEnvelope();
    env.action = "handicap";
    env.room_code = g?.room_code || null;
    env.players = g?.players || [];
    env.handicap_level = g?.handicap_level ?? null;
    env.rules = g?.rules ?? null;
    env.stroke_matrix = g?.stroke_matrix ?? null;
    env.summary = {
      ok: Boolean(g?.stroke_matrix && (g.players || []).length >= 2),
      message: g ? handicapTable(g) : `ยังไม่มีเกม — พิมพ์ "สร้างเกม 4 คน" ก่อนครับ`,
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
            ? `ไม่พบห้อง — พิมพ์ "สร้างเกม" ก่อน หรือใส่รหัสห้องให้ถูกต้อง`
            : `ต้องมีชื่อและสกอร์ 3 รอบ เช่น "เข้าร่วม แซม 105 90 91"`,
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
        maybeStartRound(g, store),
    };
    return env;
  }

  if (intent === "hole_scores") {
    const parsed = parseHoleScores(text);
    const env = emptyEnvelope();
    env.action = "hole_scores";
    env.hole = parsed.hole;

    // If no players could be parsed at all, reject immediately.
    if (!parsed.players || parsed.players.length === 0) {
      const hint = store.activeGame(sourceId);
      const names = hint ? hint.players.map((p) => p.name).filter(Boolean).join(", ") : "";
      env.summary = {
        ok: false,
        message:
          `อ่านชื่อ/แต้มไม่ได้ — ส่งสกอร์แบบนี้ครับ:\n` +
          `"หลุม ${parsed.hole || 1} [ชื่อ] [แต้ม]" หรือ "H${parsed.hole || 1} [ชื่อ] [แต้ม]"\n` +
          (names ? `ชื่อผู้เล่น: ${names}` : ""),
      };
      return env;
    }

    // Reject scores submitted under a name that isn't in the registered roster.
    // "ไม่ต้องแจ้งรับ" — don't confirm; only warn and stop.
    const activeGame = store.activeGame(sourceId);
    if (activeGame && parsed.players && parsed.players.length > 0) {
      const registered = activeGame.players.map((p) => p.name).filter(Boolean);
      if (registered.length > 0) {
        const unknown = parsed.players
          .map((p) => p.name)
          .filter((n) => n && !registered.includes(n));
        if (unknown.length > 0) {
          env.summary = {
            ok: false,
            message:
              `ไม่พบชื่อ "${unknown.join(", ")}" — กรุณาพิมพ์ชื่อให้ตรงกับที่ลงทะเบียน\n` +
              `(ชื่อที่ลงทะเบียน: ${registered.join(", ")})`,
          };
          return env;
        }
      }
    }

    // If this hole is already complete, ask for confirmation before overwriting.
    if (activeGame) {
      const existingRows = activeGame.holes[parsed.hole] || [];
      const regNames = activeGame.players.map((p) => p.name).filter(Boolean);
      const alreadyDone = regNames.length > 0 && regNames.every((n) => existingRows.some((r) => r.name === n));
      if (alreadyDone) {
        activeGame.pending_override = { hole: parsed.hole, players: parsed.players };
        store.save(activeGame); // survive a restart while waiting for ยืนยัน/ยกเลิก
        env.summary = {
          ok: false,
          message:
            `หลุม ${parsed.hole} ส่งครบแล้ว — ยืนยันแก้ไขไหมครับ?\n` +
            `(พิมพ์ "ยืนยัน" หรือ "ยกเลิก")`,
        };
        return env;
      }
    }

    const r = store.recordHole(sourceId, parsed);
    if (!r.ok) {
      env.summary = {
        ok: false,
        message:
          r.error === "room_not_found"
            ? `ยังไม่มีเกมในกลุ่มนี้ — พิมพ์ "สร้างเกม" ก่อน`
            : `อ่านหมายเลขหลุมไม่ได้ เช่น "หลุม 1 A 5 B 6"`,
      };
      return env;
    }
    const game = r.game;
    const hole = r.hole;
    const rows = game.holes[hole] || [];
    const registered = game.players.map((p) => p.name).filter(Boolean);
    const waiting = registered.filter((n) => !rows.some((x) => x.name === n));
    const complete = registered.length > 0 && waiting.length === 0;
    env.players = rows;
    env.handicap_level = game.handicap_level;
    env.rules = game.rules;

    if (!complete) {
      const got = parsed.players.map((p) => p.name).join(", ");
      env.summary = {
        ok: true,
        hole,
        complete: false,
        message:
          `รับหลุม ${hole}: ${got || "-"} ✅` +
          (registered.length ? ` (รออีก: ${waiting.join(", ")})` : ""),
      };
      return env;
    }

    // everyone is in for this hole
    const turbo = Boolean(game.turbo && (game.turbo_holes || []).includes(hole));
    const netComputed = Boolean(game.rules && r.par != null);
    const turboTag = turbo ? " 🔥 หลุมเทอร์โบ" : "";
    const stakeHole = (game.stake || 0) * (turbo ? 2 : 1);
    let holeMoney = null;
    let moneyLine = "";
    if (netComputed && game.stake) {
      const settleFn = game.format === "head_tail" ? settleHoleHeadEatsTail : settleHole;
      const ctx = game.stroke_matrix ? { par: r.par, matrix: game.stroke_matrix } : null;
      holeMoney = settleFn(rows, stakeHole, ctx);
      moneyLine = `\n💰 หลุมนี้ (หลุมละ ${stakeHole}): ${fmtMoney(holeMoney)}`;
    }
    // advance the round pointer + announce the next hole
    let nextLine = "";
    if (game.current_hole == null || hole === game.current_hole) {
      const next = hole + 1;
      if (next <= 18) {
        game.current_hole = next;
        if (game.course) nextLine = `\n${holeAnnounce(game, next)}`;
      } else {
        game.current_hole = null;
        nextLine = `\n🏁 ครบ 18 หลุม! พิมพ์ "รวม 18" หรือ "จบเกม" เพื่อสรุปเงิน`;
      }
      store.save(game); // current_hole is set directly here — persist it
    }
    env.summary = {
      ok: true,
      hole,
      complete: true,
      par: r.par,
      net_computed: netComputed,
      turbo,
      stake: game.stake,
      money: holeMoney,
      message: `หลุม ${hole} ครบทุกคน ✅${turboTag}${moneyLine}${nextLine}`,
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
        ? `บันทึกสนามแล้ว (พาร์รวม ${r.game.course.total_par})` + maybeStartRound(r.game, store)
        : "ข้อมูลสนามไม่ครบ 18 หลุม หรือค่าพาร์ผิด",
    };
    return env;
  }

  if (intent === "settle") {
    const env = emptyEnvelope();
    env.action = "settle";
    const g = store.activeGame(sourceId);
    if (!g) {
      env.summary = { ok: false, message: `ไม่มีเกมที่กำลังเล่นอยู่ — พิมพ์ "สร้างเกม" ก่อน` };
      return env;
    }
    store.save(g); // asking for the money is real activity — renew the 12h window
    const s = settleGame(g);
    env.players = g.players;
    env.summary = {
      ok: true,
      holes_counted: s.holesCounted,
      per_player: s.perPlayer,
      message: s.holesCounted
        ? `สรุปเงินรวม ${s.holesCounted} หลุม 💰\n${fmtMoney(s.perPlayer)}\n(บวก = ได้ / ลบ = จ่าย)`
        : "ยังไม่มีสกอร์ที่บันทึก — ลงแต้มก่อนนะครับ",
    };
    return env;
  }

  if (intent === "bulk_scores") {
    const parsed = parseBulkScores(text);
    const env = emptyEnvelope();
    env.action = "bulk_scores";
    if (!parsed.ok) {
      env.summary = {
        ok: false,
        message:
          parsed.reason === "count"
            ? `สกอร์ต้องครบ 18 หลุม (นับได้ ${parsed.count}) เช่น "แซม 544535445 445354454"`
            : `สกอร์แต่ละหลุมเป็นเลข 1–9 (หลุม 10+ ใช้ "หลุม X …" แทน)`,
      };
      return env;
    }
    const r = store.recordBulk(sourceId, parsed.name, parsed.scores);
    if (!r.ok) {
      env.summary = { ok: false, message: `ยังไม่มีเกมในกลุ่มนี้ — พิมพ์ "สร้างเกม" ก่อน` };
      return env;
    }
    env.summary = {
      ok: true,
      player: parsed.name,
      message: `รับสกอร์ ${parsed.name} ครบ 18 หลุมแล้ว ✅\nครบทุกคนแล้วพิมพ์ "รวม 18" เพื่อสรุปเงิน`,
    };
    return env;
  }

  if (intent === "par_string") {
    const r = parseParString(text);
    const env = emptyEnvelope();
    env.action = "set_course_par";
    if (!r.ok) {
      env.summary = {
        ok: false,
        message:
          r.reason === "count"
            ? `กรอกพาร์ไม่ครบ 18 หลุม (นับได้ ${r.count} ตัว) — กรอกใหม่ เช่น "454354434 443535444"`
            : `ค่าพาร์ต้องเป็นเลข 3–6 เท่านั้น — กรอกใหม่ เช่น "454354434 443535444"`,
      };
      return env;
    }
    const set = store.setCourse(null, sourceId, { name: "", holes: r.holes });
    if (!set.ok && set.error === "no active game") {
      env.summary = {
        ok: false,
        message: `ยังไม่มีเกมในกลุ่มนี้ — พิมพ์ "สร้างเกม" ก่อนแล้วค่อยกรอกพาร์`,
      };
      return env;
    }
    env.course = set.game?.course ?? null;
    env.handicap_level = set.game?.handicap_level ?? null;
    const note = r.total < 69 || r.total > 74 ? " (ปกติ 70–72 ลองเช็กอีกครั้ง)" : "";
    env.summary = {
      ok: true,
      total_par: r.total,
      out: r.out,
      in: r.in,
      message:
        `กรอกพาร์ ${r.total} สำเร็จแล้ว ✅ (OUT ${r.out} / IN ${r.in})${note}` +
        maybeStartRound(set.game, store),
    };
    return env;
  }

  const env = emptyEnvelope();
  env.action = "unknown";
  env.summary = {
    ok: false,
    message:
      `พิมพ์ "สร้างเกม", "กรอกพาร์ 454354434 443535444", "เข้าร่วม แซม 105 90 91", หรือ "หลุม 1 A 5 B 6"`,
  };
  return env;
}

/** Guided game setup: consume the next free-text reply as course -> stake -> turbo. */
function handleSetupAnswer(text, sourceId, store, game) {
  const env = emptyEnvelope();
  env.action = "game_setup";
  const t = String(text).trim();

  if (game.setup === "course") {
    // (a) "ชื่อ + พาร์ 18 หลุม" เช่น "Kbsc 454435434 435444354"
    const m = t.match(/^(\S+)\s+([\d\s]{10,})$/);
    if (m) {
      const pp = parseParString(m[2]);
      if (!pp.ok) {
        env.summary = {
          ok: false,
          step: "course",
          message: `พาร์ต้องเป็นเลข 3–6 ครบ 18 หลุม เช่น "Kbsc 454435434 435444354"`,
        };
        return env;
      }
      store.setPendingCourse(sourceId, m[1], pp.holes, pp.total);
      env.summary = {
        ok: true,
        step: "confirm_course",
        course_name: m[1],
        total_par: pp.total,
        message:
          `สนาม ${m[1]} — พาร์รวม ${pp.total} (OUT ${pp.out} / IN ${pp.in})\n` +
          `ครบพาร์ ${pp.total} ถูกต้องไหมครับ? (พิมพ์ ยืนยัน / แก้ไข)`,
      };
      return env;
    }
    // (b) พาร์ล้วนไม่มีชื่อ -> ขอชื่อ
    if (/^[\d\s]{10,}$/.test(t) && parseParString(t).ok) {
      env.summary = {
        ok: false,
        step: "course",
        message: `ใส่ชื่อสนามด้วยครับ เช่น "Kbsc 454435434 435444354"`,
      };
      return env;
    }
    // (c) ชื่อเฉย ๆ -> สนามสำเร็จรูป/คลัง (โหลดเลย) หรือ ไม่พบ -> ขอกรอกพาร์เอง
    const found = lookupPresetCourse(t) || findCustomCourse(t);
    if (found && found.ok) {
      const r = store.setCourseName(sourceId, t);
      store.setCourse(null, sourceId, { name: r.game.course_name, holes: found.holes });
      env.course = r.game.course;
      env.summary = {
        ok: true,
        step: "stake",
        course_name: r.game.course_name,
        par_loaded: true,
        message: `สนาม ${r.game.course_name} ✅ โหลดพาร์ ${found.total} ให้อัตโนมัติ\nเล่นกันหลุมละเท่าไรครับ? (พิมพ์ตัวเลข เช่น 20)`,
      };
      return env;
    }
    const r = store.awaitPars(sourceId, t);
    env.summary = {
      ok: true,
      step: "await_pars",
      course_name: r.game.course_name,
      par_loaded: false,
      message: `ไม่พบสนาม "${r.game.course_name}" — กรอกพาร์ 18 หลุมด้วยครับ\nเช่น "454354434 443535444" (9+9 หลุม)`,
    };
    return env;
  }

  if (game.setup === "await_pars") {
    const pp = parseParString(t);
    if (!pp.ok) {
      env.summary = {
        ok: false,
        step: "await_pars",
        message: `พาร์ต้องเป็นเลข 3–6 ครบ 18 หลุม — กรอกใหม่ เช่น "454354434 443535444"`,
      };
      return env;
    }
    store.setPendingCourse(sourceId, game.course_name, pp.holes, pp.total);
    env.summary = {
      ok: true,
      step: "confirm_course",
      course_name: game.course_name,
      total_par: pp.total,
      message:
        `สนาม ${game.course_name} — พาร์รวม ${pp.total} (OUT ${pp.out} / IN ${pp.in})\n` +
        `ครบพาร์ ${pp.total} ถูกต้องไหมครับ? (พิมพ์ ยืนยัน / แก้ไข)`,
    };
    return env;
  }

  if (game.setup === "confirm_course") {
    const yes = /ยืนยัน|ใช่|ตกลง|โอเค|^ok$|yes|^y$/i.test(t);
    const no = /แก้ไข|ไม่|ใหม่|\bno\b|^n$/i.test(t);
    if (yes && !no) {
      const r = store.confirmCourse(sourceId);
      // remember in the course library so the name loads the pars next time
      rememberCourse(r.game.course_name, r.game.course.holes, r.total);
      env.course = r.game.course;
      env.summary = {
        ok: true,
        step: "stake",
        course_name: r.game.course_name,
        total_par: r.total,
        message: `บันทึกสนาม ${r.game.course_name} (พาร์ ${r.total}) ✅ (จำไว้ใช้ครั้งหน้าได้เลย)\nเล่นกันหลุมละเท่าไรครับ? (พิมพ์ตัวเลข เช่น 20)`,
      };
      return env;
    }
    if (no) {
      store.editCourse(sourceId);
      env.summary = {
        ok: true,
        step: "await_pars",
        message: `ได้ครับ กรอกพาร์สนามใหม่อีกครั้ง เช่น "454354434 443535444"`,
      };
      return env;
    }
    env.summary = { ok: false, step: "confirm_course", message: `พิมพ์ "ยืนยัน" หรือ "แก้ไข" ครับ` };
    return env;
  }

  if (game.setup === "stake") {
    const num = (t.match(/\d+/) || [])[0];
    if (!num) {
      env.summary = { ok: false, step: "stake", message: "พิมพ์เป็นตัวเลขครับ เช่น 20 (หลุมละกี่บาท)" };
      return env;
    }
    const r = store.setStake(sourceId, Number(num));
    env.summary = {
      ok: true,
      step: "turbo",
      stake: r.game.stake,
      message: `หลุมละ ${r.game.stake} ✅\nมีเทอร์โบไหมครับ? (พิมพ์ มี / ไม่มี)`,
    };
    return env;
  }

  if (game.setup === 'turbo') {
    const no = /ไม่มี|ไม่|\bno\b|^n$/i.test(t);
    const yes = !no && /มี|ใช่|\byes\b|^y$|turbo|เทอร์โบ/i.test(t);
    if (!yes && !no) {
      env.summary = { ok: false, step: 'turbo', message: 'ตอบ "มี" หรือ "ไม่มี" ครับ' };
      return env;
    }
    const r = store.setTurbo(sourceId, yes);
    const g = r.game;
    const turboLine = g.turbo
      ? `เทอร์โบ: หลุม ${g.turbo_holes.join(' และ ')} 🔥`
      : 'ไม่มีเทอร์โบ';
    env.summary = {
      ok: true,
      step: 'format',
      stake: g.stake,
      turbo: g.turbo,
      turbo_holes: g.turbo_holes,
      message:
        `${turboLine} ✅\nกติกาการแพ้ชนะครับ?\n` +
        `1️⃣ หัวกินหาง (อันดับ 1 ชนะอันดับสุดท้าย)\n` +
        `2️⃣ กินกันทุกคน (ทุกคู่เปรียบสกอร์)`,
    };
    return env;
  }

  if (game.setup === 'format') {
    // 1 = หัวกินหาง, 2 = กินกันทุกคน (menu order — keep in sync with the prompt above)
    const isHeadTail = /^1$|หัวกินหาง/i.test(t);
    const isAllVsAll = /^2$|กินกันทุกคน/i.test(t);
    if (!isAllVsAll && !isHeadTail) {
      env.summary = {
        ok: false,
        step: 'format',
        message: 'เลือก "1" หัวกินหาง หรือ "2" กินกันทุกคน ครับ',
      };
      return env;
    }
    const format = isHeadTail ? 'head_tail' : 'all_vs_all';
    const r = store.setFormat(sourceId, format);
    const g = r.game;
    const turboLine = g.turbo
      ? `เทอร์โบ: หลุม ${g.turbo_holes.join(' และ ')} 🔥`
      : 'ไม่มีเทอร์โบ';
    const formatLabel = format === 'head_tail' ? 'หัวกินหาง 🏹' : 'กินกันทุกคน';
    env.summary = {
      ok: true,
      step: 'done',
      course_name: g.course_name,
      stake: g.stake,
      turbo: g.turbo,
      turbo_holes: g.turbo_holes,
      format,
      message:
        `ตั้งค่าเกมเรียบร้อย ✅\n` +
        `สนาม ${g.course_name} · หลุมละ ${g.stake} · ${turboLine}\n` +
        `กติกา: ${formatLabel}\n` +
        `ต่อไป:\n` +
        (g.course ? '' : '• กรอกพาร์: 454354434 443535444\n') +
        `• ผู้เล่นพิมพ์: เข้าร่วม แซม 105 90 91`,
    };
    return env;
  }

  env.action = 'unknown';
  env.summary = { ok: false, message: '' };
  return env;
}
