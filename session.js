// session.js
// Stateful, group-aware dispatcher: a message + LINE sourceId (groupId/userId)
// is routed through the GameStore and returned as the standard backend envelope,
// with a friendly Thai `summary.message` for the chat reply.

import {
  normalize,
  detectIntent,
  parseCreateGame,
  parseJoin,
  parseHoleScores,
  parseParString,
  parseBulkScores,
  parseHistoryQuery,
  parseStake,
  parseFormat,
  lookupPresetCourse,
  MAX_HOLE_SCORE,
  MIN_HOLE_NUMBER,
  MAX_HOLE_NUMBER,
  MIN_HOLE_SCORE,
} from "./parser.js";
import {
  settleHole,
  settleHoleHeadEatsTail,
  settleGame,
  scoreEmoji,
  strokesBetween,
  classifyHandicapLevel,
  formatRoomCodeDate,
  normalizeRoomCode,
  formatThaiDateTime,
  matchPlayerName,
  matrixForHole,
} from "./engine.js";
import { findCustomCourse, rememberCourse } from "./courseStore.js";
import { findRound, listRounds } from "./db.js";
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

/** Point the group back at the hole the round is waiting on. Used after the
 *  handicap table is acknowledged, so "ตกลง" leads straight back into play
 *  instead of leaving everyone staring at a table. */
function resumeRoundMessage(game, store) {
  if (!game.course) {
    return `รับทราบครับ ✅\nกรอกพาร์สนามก่อนนะครับ เช่น "454354434 443535444"`;
  }
  if (game.current_hole == null) {
    if (Object.keys(game.holes || {}).length >= 18) {
      return `รับทราบครับ ✅\n🏁 ครบ 18 หลุมแล้ว — พิมพ์ "รวม 18" หรือ "จบเกม" เพื่อสรุปเงิน`;
    }
    game.current_hole = 1;
    store?.save(game);
  }
  const n = game.current_hole;
  const names = (game.players || []).slice(0, 2).map((p) => p.name);
  const eg = names.length === 2 ? `${names[0]} 5 ${names[1]} 6` : `${names[0] || "ชื่อ"} 5`;
  return (
    `รับทราบครับ ✅\n` +
    `${holeAnnounce(game, n)}\n` +
    `📝 ส่งสกอร์: "หลุม ${n} [ชื่อ] [แต้ม]"\n` +
    `เช่น "หลุม ${n} ${eg}"`
  );
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

// Holes after which the bot posts the running total on its own.
const TURN_HOLES = [9];

/** "แซม   6 8 4 7 6 5 4 5 5 = 50 (+14)" for every player, holes 1-9. */
export function frontNineCard(game, store) {
  const front = store.frontNine(game);
  const names = Object.keys(front);
  if (!names.length) return "";
  const pad = Math.max(...names.map((n) => n.length));
  const parOut = (game.course?.holes || [])
    .filter((h) => Number(h.hole) <= 9)
    .reduce((a, h) => a + Number(h.par || 0), 0);
  const lines = [`📋 สกอร์ OUT (หลุม 1-9${parOut ? ` · พาร์ ${parOut}` : ""})`];
  for (const [name, v] of Object.entries(front).sort((a, b) => a[1].total - b[1].total)) {
    const cells = v.holes.map((g) => (g == null ? "-" : String(g))).join(" ");
    const vsPar = parOut && v.complete ? ` (${v.total - parOut >= 0 ? "+" : ""}${v.total - parOut})` : "";
    lines.push(`${name.padEnd(pad)}  ${cells} = ${v.total}${vsPar}${v.complete ? "" : " ⚠️"}`);
  }
  return lines.join("\n");
}

/**
 * The saved par card, read back. Groups check this before teeing off — an
 * auto-loaded course is worth a second pair of eyes, since every stroke and
 * every baht is computed from these 18 numbers.
 */
export function parCardMessage(game) {
  const holes = game?.course?.holes || game?.pending_course?.holes || null;
  if (!holes || holes.length !== 18) return null;
  const pars = holes
    .slice()
    .sort((a, b) => Number(a.hole) - Number(b.hole))
    .map((h) => Number(h.par));
  const out = pars.slice(0, 9).reduce((a, b) => a + b, 0);
  const inn = pars.slice(9).reduce((a, b) => a + b, 0);
  const turbo = game.turbo ? game.turbo_holes || [] : [];
  const row = (from) => pars.slice(from, from + 9).join(" ");
  const lines = [
    `📋 พาร์สนาม ${game.course_name || "-"} — รวม ${out + inn}`,
    ``,
    `หลุม 1-9   ${row(0)}  (OUT ${out})`,
    `หลุม 10-18 ${row(9)}  (IN ${inn})`,
  ];
  if (turbo.length) lines.push(`🔥 หลุมเทอร์โบ (เงินคูณ 2): ${turbo.join(", ")}`);
  if (!game.course && game.pending_course) {
    lines.push(`⚠️ ยังไม่ได้ยืนยัน — พิมพ์ "ยืนยัน" ถ้าถูกต้อง หรือ "แก้ไข" เพื่อกรอกใหม่`);
  }
  return lines.join("\n");
}

/** What the new back-nine handicaps would be: front-nine gross x 2. */
export function back9Preview(game, store) {
  const front = store.frontNine(game);
  // Never show a number for someone whose front nine has a gap: OUT x 2 off 8
  // holes is simply too low, and quoting it made the bot advertise a handicap
  // that "แต้มต่อใหม่" would then refuse to apply.
  return game.players
    .map((p) =>
      front[p.name]?.complete
        ? `${p.name} ${p.handicap_index} → ${front[p.name].total * 2}`
        : `${p.name} ${p.handicap_index} → ยังไม่ครบ 9 หลุม`
    )
    .join(" · ");
}

/**
 * Resolve a name as typed on a score line against the roster.
 *
 * The line is tokenised greedily, so a stray word can end up glued to the front
 * of a name ("หลุม 1 นะครับ แซม 5"). Try the whole thing first, then drop
 * leading words one at a time — the trailing words are the name.
 */
export function resolveTypedName(registered, typed) {
  const words = String(typed ?? "").trim().split(/\s+/).filter(Boolean);
  let ambiguous = null;
  for (let i = 0; i < words.length; i++) {
    const m = matchPlayerName(registered, words.slice(i).join(" "));
    if (m.ok) return m;
    if (m.reason === "ambiguous" && !ambiguous) ambiguous = m;
  }
  return ambiguous || { ok: false, reason: "not_found", matches: [] };
}

/** The question the guided setup is currently waiting on. */
export function setupQuestion(game) {
  switch (game?.setup) {
    case "course":
      return "ต่อกันที่ตั้งค่าเกมนะครับ — สนามชื่ออะไรครับ? (พิมพ์ชื่อสนาม)";
    case "await_pars":
      return `กรอกพาร์ 18 หลุมของสนาม ${game.course_name || ""} ด้วยครับ เช่น "454354434 443535444"`;
    case "confirm_course":
      return 'ยืนยันพาร์สนามด้วยครับ (พิมพ์ ยืนยัน / แก้ไข)';
    case "stake":
      return "เล่นกันหลุมละเท่าไรครับ? (พิมพ์ตัวเลข เช่น 20)";
    case "turbo":
      return 'มีเทอร์โบไหมครับ? (พิมพ์ มี / ไม่มี)';
    case "format":
      return (
        "กติกาการแพ้ชนะครับ?\n" +
        "1️⃣ หัวกินหาง (อันดับ 1 ชนะอันดับสุดท้าย)\n" +
        "2️⃣ กินกันทุกคน (ทุกคู่เปรียบสกอร์)"
      );
    default:
      return "";
  }
}

/** Who still has a missing score in holes 1-9. */
export function frontNineMissing(game, store) {
  const front = store.frontNine(game);
  return Object.entries(front)
    .filter(([, v]) => !v.complete)
    .map(([n]) => n);
}

/**
 * Live money standings: who is up, who is down, and how much of the round is
 * still to play. Ranked so the answer to "ใครนำ" is the first line, not
 * something you have to scan an unsorted list for.
 */
export function standingsMessage(game, title = null) {
  const s = settleGame(game);
  if (!s.holesCounted) {
    return `ยังไม่มีสกอร์ที่บันทึก — ลงแต้มหลุมแรกก่อนนะครับ`;
  }
  const ranked = Object.entries(s.perPlayer).sort((a, b) => b[1] - a[1]);
  const pad = Math.max(...ranked.map(([n]) => n.length));
  const lines = [
    title ||
      `💰 ยอดล่าสุด · ห้อง ${game.room_code} (เล่นไปแล้ว ${s.holesCounted}/18 หลุม)`,
    "",
  ];
  ranked.forEach(([name, amt], i) => {
    const money = amt > 0 ? `+${amt}` : amt < 0 ? `−${Math.abs(amt)}` : "0";
    lines.push(`${i + 1}. ${name.padEnd(pad)}  ${money}`);
  });

  const played = new Set(Object.keys(game.holes || {}).map(Number));
  const left = 18 - s.holesCounted;
  const turboLeft = (game.turbo ? game.turbo_holes || [] : []).filter((h) => !played.has(h));
  const tail = [];
  if (left > 0) tail.push(`เหลืออีก ${left} หลุม`);
  if (turboLeft.length) tail.push(`หลุมเทอร์โบที่ยังไม่เล่น: ${turboLeft.join(", ")} 🔥`);
  if (tail.length) lines.push("", tail.join(" · "));
  if (left === 0) lines.push("", `🏁 ครบ 18 หลุมแล้ว — พิมพ์ "จบเกม" เพื่อปิดห้อง`);
  return lines.join("\n");
}

/** Stroke rules for a gap, for display. */
function rulesForGap(gap) {
  return classifyHandicapLevel(gap).rules;
}

/** The handicap gap for a pairing (0 = they play straight up). */
function pairGapOf(game, receiver, giver) {
  const v = game.stroke_matrix?.[receiver]?.[giver];
  return typeof v === "number" ? v : 0;
}

/** Strokes `receiver` gets from `giver` over the whole course, when the course
 *  is known. Returns null before the par card is entered. */
function roundStrokes(game, receiver, giver) {
  const holes = game.course?.holes;
  if (!Array.isArray(holes) || holes.length === 0) return null;
  return holes.reduce(
    (sum, h) => sum + strokesBetween(game.stroke_matrix, receiver, giver, { par: h.par }),
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
      // a gap inside band 0 still reads as "no strokes" — check the rules,
      // not the raw gap, or a 2-stroke gap prints a pointless "0 แต้ม" row
      const r = rulesForGap(pairGapOf(game, b.name, a.name));
      if (!r.par3 && !r.par4 && !r.par5) {
        even.push(`${a.name}–${b.name} (ห่าง ${b.handicap_index - a.handicap_index})`);
      }
    }
  }
  if (even.length) lines.push("", `🤝 เล่นตรงๆ ไม่ต่อกัน`, ...even.map((s) => `• ${s}`));

  // everyone who receives something, weakest first
  for (const p of [...byIdx].reverse()) {
    const rows = byIdx
      .filter((o) => o.name !== p.name)
      .map((o) => ({ o, gap: pairGapOf(game, p.name, o.name) }))
      .map(({ o, gap }) => ({ o, gap, r: rulesForGap(gap) }))
      .filter(({ r }) => r.par3 || r.par4 || r.par5)
      .map(({ o, gap, r }) => {
        const tot = roundStrokes(game, p.name, o.name);
        const totTxt = tot == null ? "" : ` = ${tot} แต้ม`;
        return `• จาก ${o.name} (ห่าง ${gap}) → พาร์3:${r.par3} พาร์4:${r.par4} พาร์5:${r.par5}${totTxt}`;
      });
    if (rows.length) lines.push("", `📥 ${p.name} รับแต้มต่อ`, ...rows);
  }

  if (!game.course) lines.push("", `(ยังไม่ได้กรอกพาร์สนาม — ยอดรวมต่อรอบจะขึ้นหลังกรอก)`);
  lines.push(
    "",
    `ตกลงกันแบบนี้ไหมครับ?`,
    `✅ ตกลง → พิมพ์ "ตกลง" แล้วเริ่มเล่นต่อได้เลย`,
    `✏️ แก้สกอร์ → พิมพ์ "เข้าร่วม [ชื่อเดิม] [3 สกอร์ใหม่]"`
  );
  return lines.join("\n");
}

const WELCOME_TH =
  `สวัสดีครับ ผมแคดดี้บอท ⛳\n` +
  `พิมพ์ "สร้างเกม 4 คน" (ระบุจำนวนคนด้วย) เพื่อเริ่ม\n` +
  `กรอกพาร์สนาม: "454354434 443535444"\n` +
  `เข้าร่วม: "เข้าร่วม แซม 105 90 91"\n` +
  `ลงแต้ม: "หลุม 1 A 5 B 6" หรือ "H1 แซม 4"\n` +
  `ดูแต้มต่อ: "แต้มต่อ" · ยอดเงินล่าสุด: "ยอดล่าสุด"\n` +
  `สรุปเงิน: "รวม 18" · จบเกม: "จบเกม"`;

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
  if (!_og && intent !== "create_game") {
    // "สร้างเกม" with no number asks "กี่คนครับ?" — the answer arrives with no
    // game in existence, so without this it hit the idle rule and got silence.
    const wanted = store.awaitingPlayerCount?.(sourceId);
    const answer = wanted ? Number((String(raw).match(/\d{1,2}/) || [])[0]) : NaN;
    if (wanted && Number.isFinite(answer) && answer >= 1 && answer <= 20) {
      return dispatch(`สร้างเกม ${answer} คน`, sourceId, store);
    }
    return idleEnvelope();
  }

  // Pending hole-override confirmation (ยืนยัน/ยกเลิก after re-submitting a complete hole)
  if (_og?.pending_override) {
    const trimmed = raw.trim();
    // No \b here: Thai letters are not word characters, so a boundary anchor
    // never matches after "ยืนยัน" and "ยืนยันครับ" fell through to the generic
    // help text while the edit stayed armed.
    if (/^(ยืนยัน|ตกลง|โอเค|ใช่)/.test(trimmed) || /^(ok|okay|yes|y)$/i.test(trimmed)) {
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
        // matrixForHole, not stroke_matrix: after a back-nine re-handicap the
        // front nine settles on the FROZEN matrix. Reading the live one made the
        // bot report a different number than the books for an edited hole 1-9.
        const frozen = matrixForHole(r.game, hole);
        const ctx = frozen ? { par: r.par, matrix: frozen } : null;
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
    if (/^(ยกเลิก|ไม่)/.test(trimmed) || /^(no|n)$/i.test(trimmed)) {
      _og.pending_override = null;
      store.save(_og);
      const env = emptyEnvelope();
      env.action = "hole_scores";
      env.summary = { ok: false, message: "ยกเลิกแล้ว — สกอร์เดิมยังคงอยู่" };
      return env;
    }
    // Not a yes/no. A pending edit used to sit armed indefinitely: play carried
    // on and a "ยืนยัน" typed five holes later silently rewrote the old hole.
    // Anything that is real gameplay cancels it instead.
    if (intent === "hole_scores" || intent === "bulk_scores" || intent === "settle" || intent === "end_game") {
      _og.pending_override = null;
      store.save(_og);
    }
  }

  // "ตกลง" straight after the handicap table -> jump back to the hole in play.
  // Skipped while a course confirmation is pending so "ยืนยัน" is never stolen.
  if (_og?.awaiting_handicap_ack && !_og.pending_course) {
    _og.awaiting_handicap_ack = false;
    store.save(_og);
    if (/^\s*(ตกลง|ตกลงครับ|ตกลงค่ะ|โอเค|โอเคครับ|okay|ok|ใช่|yes|y)\s*$/i.test(raw)) {
      const env = emptyEnvelope();
      env.action = "handicap_ack";
      env.room_code = _og.room_code;
      env.summary = { ok: true, message: resumeRoundMessage(_og, store) };
      return env;
    }
    // anything else — fall through and handle it normally
  }

  // "ดูพาร์" — a read, so it is answered even while the setup Q&A is open and
  // never counts as an answer to the question being asked.
  if (intent === "show_par") {
    const g = store.activeGame(sourceId);
    const env = emptyEnvelope();
    env.action = "show_par";
    env.room_code = g?.room_code || null;
    env.course = g?.course ?? null;
    const card = g ? parCardMessage(g) : null;
    env.summary = card
      ? { ok: true, total_par: (g.course || g.pending_course)?.total ?? null, message: card }
      : {
          ok: false,
          message:
            `ยังไม่ได้บันทึกพาร์สนามครับ\n` +
            `พิมพ์ชื่อสนาม หรือกรอกพาร์ 18 หลุม เช่น "454354434 443535444"`,
        };
    return env;
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
  // A bulk card naming someone already on the roster is a score card, not an
  // answer — routing it into the setup Q&A silently ate a player's whole round.
  const bulkFromKnownPlayer =
    pending &&
    intent === "bulk_scores" &&
    (() => {
      const b = parseBulkScores(raw);
      if (!b.ok) return false;
      const roster = (pending.players || []).map((x) => x.name).filter(Boolean);
      return roster.length > 0 && resolveTypedName(roster, b.name).ok;
    })();

  if (
    pending &&
    !bulkFromKnownPlayer &&
    (intent === "unknown" ||
      intent === "bulk_scores" ||
      intent === "par_string" ||
      // While the Q&A is open these ARE the answers to it.
      intent === "set_stake" ||
      intent === "set_format")
  ) {
    return handleSetupAnswer(raw, sourceId, store, pending);
  }
  // Real gameplay (join / score) closes the guided Q&A — the group has clearly
  // moved on. It used to close SILENTLY, so stake and pars stayed null, the bot
  // never asked again, and the round ended with "ทุกคน 0" presented as a real
  // settlement. Now whatever is still unset is named out loud, and it can be
  // set at any time afterwards ("หลุมละ 20", "กติกา หัวกินหาง").
  let setupClosingNote = "";
  if (pending && (intent === "join" || intent === "hole_scores" || bulkFromKnownPlayer)) {
    const missing = [];
    if (!pending.course) missing.push('พาร์สนาม — พิมพ์ "454354434 443535444"');
    if (pending.stake == null) missing.push('เงินเดิมพัน — พิมพ์ "หลุมละ 20"');
    if (pending.turbo == null) store.setTurbo(sourceId, false);
    if (!pending.format) store.setFormat(sourceId, "all_vs_all");
    store.finishSetup(sourceId);
    if (missing.length) {
      setupClosingNote =
        `\n\n⚠️ ยังไม่ได้ตั้ง: ${missing.join(" · ")}\n` +
        `ตั้งเมื่อไรก็ได้ครับ — ถ้าไม่ตั้งเงินเดิมพัน รอบนี้จะไม่คิดเงิน`;
    }
  }

  // Set the stake / rules after setup has closed. Both change how EVERY hole
  // settles, so they are refused once scores exist rather than silently
  // rewriting money the group has already been told.
  if (intent === "set_stake" || intent === "set_format") {
    const g = store.activeGame(sourceId);
    const env = emptyEnvelope();
    env.action = intent;
    if (!g) {
      env.summary = { ok: false, message: `ยังไม่มีเกมในกลุ่มนี้ — พิมพ์ "สร้างเกม" ก่อน` };
      return env;
    }
    const played = Object.keys(g.holes || {}).length;
    if (played > 0) {
      env.summary = {
        ok: false,
        message:
          `ลงสกอร์ไปแล้ว ${played} หลุม — เปลี่ยน${intent === "set_stake" ? "เงินเดิมพัน" : "กติกา"}ตอนนี้จะทำให้เงินหลุมที่ผ่านมาเปลี่ยนตามครับ\n` +
          `ถ้าต้องการจริง ๆ ให้ "จบเกม" แล้วสร้างเกมใหม่`,
      };
      return env;
    }
    // store.setStake / setFormat also drive the guided Q&A forward. When the
    // setup is already finished they must not re-open it, or the group's next
    // message gets swallowed as an answer to a question nobody asked.
    const wasDone = g.setup === "done";
    const keepSetupState = () => {
      if (wasDone && g.setup !== "done") {
        g.setup = "done";
        store.save(g);
      }
    };
    if (intent === "set_stake") {
      const amount = parseStake(raw);
      if (!amount || amount < 0) {
        env.summary = { ok: false, message: 'พิมพ์เป็นตัวเลขครับ เช่น "หลุมละ 20"' };
        return env;
      }
      store.setStake(sourceId, amount);
      keepSetupState();
      env.summary = { ok: true, stake: amount, message: `หลุมละ ${amount} ✅` };
      return env;
    }
    const format = parseFormat(raw);
    if (!format) {
      env.summary = { ok: false, message: 'พิมพ์ "กติกา หัวกินหาง" หรือ "กติกา กินกันทุกคน" ครับ' };
      return env;
    }
    store.setFormat(sourceId, format);
    keepSetupState();
    env.summary = {
      ok: true,
      format,
      message: `กติกา: ${format === "head_tail" ? "หัวกินหาง" : "กินกันทุกคน"} ✅`,
    };
    return env;
  }

  if (intent === "create_game") {
    const { expected_players } = parseCreateGame(text);
    if (!expected_players) {
      // No game exists yet, so the idle rule would swallow the group's natural
      // answer ("4 คน") and the bot would go completely silent. Remember that we
      // asked, and treat the next number as the answer (see the check above).
      store.awaitPlayerCount?.(sourceId);
      const env = emptyEnvelope();
      env.action = "create_game";
      env.summary = {
        ok: false,
        awaiting: "player_count",
        message: `กี่คนครับ? (พิมพ์ตัวเลข เช่น "4 คน")`,
      };
      return env;
    }
    store.clearPlayerCountWait?.(sourceId);
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
    const settleLine = !s.holesCounted
      ? "\n(ยังไม่มีสกอร์ที่บันทึก)"
      : !g.stake
        ? "\n(รอบนี้ไม่ได้ตั้งเงินเดิมพัน จึงไม่มีเงินให้สรุป)"
        : `\n💰 สรุปเงิน: ${fmtMoney(s.perPlayer)}\n(บวก = ได้ / ลบ = จ่าย)`;
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
        `สนาม ${g.course_name || "-"} · ผู้เล่น: ${names} · เล่นไปแล้ว ${holesPlayed}/18 หลุม` +
        settleLine +
        `\n📒 ห้อง ${g.room_code} — ดูย้อนหลังได้ด้วย "ประวัติ ${g.room_code}"`,
    };
    // cancelGame archives the round to `rounds` before wiping the session.
    store.cancelGame(sourceId, "ended");
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
    const tableOk = Boolean(g?.stroke_matrix && (g.players || []).length >= 2);
    if (tableOk) {
      // the next "ตกลง" means "we agree — carry on playing"
      g.awaiting_handicap_ack = true;
      store.save(g);
    }
    env.summary = {
      ok: tableOk,
      message: g ? handicapTable(g) : `ยังไม่มีเกม — พิมพ์ "สร้างเกม 4 คน" ก่อนครับ`,
    };
    return env;
  }

  if (intent === "join") {
    const parsed = parseJoin(text);
    const env0 = emptyEnvelope();
    // More than 3 numbers: which three are "the last 3 rounds" is a guess, and
    // guessing changes the handicap. Ask instead of silently dropping one.
    if (parsed.extra_scores && parsed.extra_scores.length > 0) {
      env0.action = "join";
      env0.room_code = parsed.room_code || null;
      env0.summary = {
        ok: false,
        message:
          `ใส่สกอร์ 3 รอบล่าสุดเท่านั้นครับ — ได้รับ ` +
          `${parsed.scores.concat(parsed.extra_scores).length} ตัว ` +
          `(${parsed.scores.concat(parsed.extra_scores).join(", ")})\n` +
          `เช่น "เข้าร่วม ${parsed.player || "แซม"} ${parsed.scores.join(" ")}"`,
      };
      return env0;
    }
    const r = store.join(sourceId, parsed);
    const env = emptyEnvelope();
    env.action = "join";
    env.room_code = parsed.room_code || r.game?.room_code || null;
    env.scores = parsed.scores;
    if (!r.ok) {
      env.summary = {
        ok: false,
        message:
          r.error === "room_other_source"
            ? `รหัสห้อง ${parsed.room_code} เป็นของกลุ่มอื่นครับ — เข้าร่วมไม่ได้\n` +
              `ถ้าจะเล่นในกลุ่มนี้ พิมพ์ "สร้างเกม" หรือ "เข้าร่วม [ชื่อ] [สกอร์ 3 รอบ]" โดยไม่ต้องใส่รหัส`
            : r.error === "room_not_found"
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
    const stillSettingUp = store.pendingSetup(sourceId);
    env.summary = {
      ok: true,
      player: r.player_name || parsed.player,
      handicap_index: r.handicap_index,
      status: g.status,
      setup_pending: stillSettingUp ? stillSettingUp.setup : null,
      message:
        `${r.player_name || parsed.player} เข้าร่วมแล้ว (แต้มต่อ ${r.handicap_index}) ` +
        `— ผู้เล่น ${count}${cap} คน` +
        (stillSettingUp ? `\n\n${setupQuestion(stillSettingUp)}` : maybeStartRound(g, store)) +
        setupClosingNote,
    };
    return env;
  }

  if (intent === "hole_scores") {
    const parsed = parseHoleScores(text);
    const env = emptyEnvelope();
    env.action = "hole_scores";
    env.hole = parsed.hole;

    // Hole number outside 1-18. This used to be accepted and stored, so the
    // score vanished from the round while still inflating "สรุปเงินรวม X หลุม".
    if (parsed.hole_invalid != null) {
      env.summary = {
        ok: false,
        hole_invalid: parsed.hole_invalid,
        message:
          `หลุมต้องอยู่ระหว่าง ${MIN_HOLE_NUMBER}–${MAX_HOLE_NUMBER} ` +
          `(ได้รับ "หลุม ${parsed.hole_invalid}") — ยังไม่ได้บันทึกนะครับ\n` +
          `เช่น "หลุม 12 แซม 5"`,
      };
      return env;
    }

    // If no players could be parsed at all, reject immediately.
    if (!parsed.players || parsed.players.length === 0) {
      const hint = store.activeGame(sourceId);
      const names = hint ? hint.players.map((p) => p.name).filter(Boolean).join(", ") : "";
      // "g" used to mean "give up". It no longer exists — say so plainly
      // instead of leaving the group staring at a generic parse error.
      const usedGiveUp = /(^|\s)[gG]($|\s)/.test(String(text));
      env.summary = {
        ok: false,
        message: usedGiveUp
          ? `ไม่มี "g" (ยอมแพ้) แล้วครับ — ใส่สกอร์เป็นตัวเลขเสมอ (สูงสุด ${MAX_HOLE_SCORE})\n` +
            `เช่น "หลุม ${parsed.hole || 1} ${names.split(", ")[0] || "ชื่อ"} 8"` +
            (names ? `\nชื่อผู้เล่น: ${names}` : "")
          : `อ่านชื่อ/แต้มไม่ได้ — ส่งสกอร์แบบนี้ครับ:\n` +
            `"หลุม ${parsed.hole || 1} [ชื่อ] [แต้ม]" หรือ "H${parsed.hole || 1} [ชื่อ] [แต้ม]"\n` +
            `แต้มต้องเป็นตัวเลข 1–${MAX_HOLE_SCORE}\n` +
            (names ? `ชื่อผู้เล่น: ${names}` : ""),
      };
      return env;
    }

    // Tell the group when a typed score was pulled down to the 10 ceiling, so
    // a fat-fingered "12" is never silently recorded as something else.
    const cappedNote = parsed.players
      .filter((p) => p.capped_from != null)
      .map((p) => `${p.name} ${p.capped_from}→${p.gross}`)
      .join(", ");

    // Reject scores submitted under a name that isn't in the registered roster.
    // "ไม่ต้องแจ้งรับ" — don't confirm; only warn and stop.
    const activeGame = store.activeGame(sourceId);
    if (activeGame && parsed.players && parsed.players.length > 0) {
      const registered = activeGame.players.map((p) => p.name).filter(Boolean);
      if (registered.length === 0) {
        // Nothing to check a name against yet. Recording the row anyway (as this
        // used to) put a non-player on the card, and settlement then dropped
        // that row's money — the round stopped summing to zero.
        env.summary = {
          ok: false,
          message:
            `ยังไม่มีผู้เล่นในห้องนี้ — พิมพ์ "เข้าร่วม [ชื่อ] [สกอร์ 3 รอบ]" ก่อนนะครับ\n` +
            `เช่น "เข้าร่วม แซม 105 90 91"`,
        };
        return env;
      }
      if (registered.length > 0) {
        // A score line is parsed one word at a time, so "สมชาย" has to be able
        // to reach a player registered as "สมชาย ใจดี". matchPlayerName only
        // resolves an UNAMBIGUOUS match; anything else is reported, not guessed.
        const unknown = [];
        const ambiguous = [];
        for (const p of parsed.players) {
          if (!p.name) continue;
          const m = resolveTypedName(registered, p.name);
          if (m.ok) p.name = m.name; // canonicalise before anything is stored
          else if (m.reason === "ambiguous") ambiguous.push(`${p.name} → ${m.matches.join(" / ")}`);
          else unknown.push(p.name);
        }
        if (ambiguous.length > 0) {
          env.summary = {
            ok: false,
            message:
              `ชื่อ "${ambiguous.join(", ")}" ตรงกับผู้เล่นมากกว่า 1 คน — พิมพ์ให้ชัดกว่านี้ครับ\n` +
              `(ชื่อที่ลงทะเบียน: ${registered.join(", ")})`,
          };
          return env;
        }
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
            : r.error === "bad_hole_number"
              ? `หลุมต้องอยู่ระหว่าง ${MIN_HOLE_NUMBER}–${MAX_HOLE_NUMBER} (ได้รับ "หลุม ${r.hole}") — ยังไม่ได้บันทึกนะครับ`
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
          setupClosingNote.trim() +
          (setupClosingNote ? "\n\n" : "") +
          `รับหลุม ${hole}: ${got || "-"} ✅` +
          (registered.length ? ` (รออีก: ${waiting.join(", ")})` : "") +
          (cappedNote ? `\n⚠️ ปรับให้อยู่ในช่วง ${MIN_HOLE_SCORE}–${MAX_HOLE_SCORE}: ${cappedNote}` : ""),
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
      const holeMatrix = matrixForHole(game, hole);
      const ctx = holeMatrix ? { par: r.par, matrix: holeMatrix } : null;
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
    // Turn of the nine: post the running total unprompted. Nobody remembers to
    // ask, and this is where a group naturally stops for a drink.
    let turnLine = "";
    if (TURN_HOLES.includes(hole) && netComputed && game.stake) {
      const label = hole === 9 ? "จบ OUT (หลุม 1-9)" : `จบหลุม ${hole}`;
      turnLine = `\n\n${standingsMessage(game, `🔄 ${label} · ยอดสะสม`)}`;
      const card = frontNineCard(game, store);
      if (card) turnLine += `\n\n${card}`;
      // Offer fresh handicaps for the back nine while everyone is looking at
      // the front-nine numbers — this is the only moment the offer makes sense.
      if (!game.back9_handicap && game.players.length >= 2) {
        const missingFront = frontNineMissing(game, store);
        if (missingFront.length > 0) {
          // Offering the swap here would be a lie: applyBack9Handicap refuses
          // an incomplete front nine, so say what is missing instead.
          turnLine +=
            `\n\n🔁 ยังเปลี่ยนแต้มต่อสำหรับ 9 หลุมหลังไม่ได้ — ` +
            `สกอร์ 9 หลุมแรกยังไม่ครบ (ขาด: ${missingFront.join(", ")})` +
            `\nลงให้ครบแล้วพิมพ์ "แต้มต่อใหม่" ได้เลยครับ`;
        } else {
          game.awaiting_back9_handicap = true;
          store.save(game);
          turnLine +=
            `\n\n🔁 9 หลุมหลังจะใช้แต้มต่อใหม่ไหมครับ?` +
            `\n(คิดจากสกอร์ 9 หลุมแรก ×2 — ${back9Preview(game, store)})` +
            `\nพิมพ์ "แต้มต่อใหม่" เพื่อเปลี่ยน · "แต้มต่อเดิม" เพื่อใช้ของเดิม`;
        }
      }
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
      turn_summary: Boolean(turnLine),
      message:
        setupClosingNote.trim() +
        (setupClosingNote ? "\n\n" : "") +
        `หลุม ${hole} ครบทุกคน ✅${turboTag}` +
        (cappedNote ? `\n⚠️ ปรับให้อยู่ในช่วง ${MIN_HOLE_SCORE}–${MAX_HOLE_SCORE}: ${cappedNote}` : "") +
        `${moneyLine}${turnLine}` +
        (turnLine ? `\n${nextLine}` : nextLine),
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

  if (intent === "back9_handicap") {
    const env = emptyEnvelope();
    env.action = "back9_handicap";
    const g = store.activeGame(sourceId);
    env.room_code = g?.room_code || null;
    if (g) {
      g.awaiting_back9_handicap = false;
      store.save(g);
    }
    if (/(เดิม|ไม่|no)/i.test(raw)) {
      env.summary = {
        ok: true,
        changed: false,
        message: `รับทราบครับ ✅ 9 หลุมหลังใช้แต้มต่อเดิม`,
      };
      return env;
    }
    const r = store.applyBack9Handicap(sourceId);
    if (!r.ok) {
      env.summary = {
        ok: false,
        changed: false,
        message:
          r.error === "already_applied"
            ? `เปลี่ยนแต้มต่อสำหรับ 9 หลุมหลังไปแล้วครับ`
            : r.error === "front_nine_incomplete"
              ? `ยังลงสกอร์ 9 หลุมแรกไม่ครบ (ขาด: ${(r.missing || []).join(", ")}) — ลงให้ครบก่อนนะครับ`
              : `ไม่มีเกมที่กำลังเล่นอยู่`,
      };
      return env;
    }
    const rows = r.game.players.map(
      (p) => `${p.name}: ${r.before[p.name]} → ${p.handicap_index}`
    );
    env.players = r.game.players;
    env.summary = {
      ok: true,
      changed: true,
      before: r.before,
      after: r.after,
      message:
        `🔁 แต้มต่อใหม่สำหรับ 9 หลุมหลัง ✅\n` +
        rows.join("\n") +
        `\n\nหลุม 1-9 คิดเงินด้วยแต้มต่อเดิม ไม่เปลี่ยนย้อนหลัง\n` +
        `พิมพ์ "แต้มต่อ" เพื่อดูตารางใหม่`,
    };
    return env;
  }

  if (intent === "standings") {
    const env = emptyEnvelope();
    env.action = "standings";
    const g = store.activeGame(sourceId);
    if (!g) {
      env.summary = { ok: false, message: `ไม่มีเกมที่กำลังเล่นอยู่ — พิมพ์ "สร้างเกม" ก่อน` };
      return env;
    }
    store.save(g); // asking for the money is real activity — renew the 12h window
    const s = settleGame(g);
    env.players = g.players;
    env.summary = {
      ok: s.holesCounted > 0,
      holes_counted: s.holesCounted,
      holes_left: 18 - s.holesCounted,
      per_player: s.perPlayer,
      message: standingsMessage(g),
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
    // Snapshot to history now: plenty of groups settle with "รวม 18" and then
    // just stop typing, so this may be the last time the round is ever seen.
    // Idempotent — "จบเกม" later updates the same row.
    store.archiveGame(g, "settled");
    env.players = g.players;
    env.room_code = g.room_code;
    env.summary = {
      ok: true,
      holes_counted: s.holesCounted,
      per_player: s.perPlayer,
      message: !s.holesCounted
        ? "ยังไม่มีสกอร์ที่บันทึก — ลงแต้มก่อนนะครับ"
        : !g.stake
          ? // Printing "ทุกคน 0" as a settlement made a round with no stake look
            // like everyone had broken even. Say what actually happened.
            `รอบนี้ไม่ได้ตั้งเงินเดิมพัน จึงไม่มีเงินให้สรุปครับ ` +
            `(เล่นไปแล้ว ${s.holesCounted}/18 หลุม)\n` +
            `ตั้งก่อนออกรอบครั้งหน้าด้วย "หลุมละ 20"\n` +
            `📒 ห้อง ${g.room_code} — ดูสกอร์ย้อนหลังได้ด้วย "ประวัติ ${g.room_code}"`
          : `สรุปเงินรวม 💰 (เล่นไปแล้ว ${s.holesCounted}/18 หลุม)\n${fmtMoney(s.perPlayer)}\n(บวก = ได้ / ลบ = จ่าย)\n` +
            `📒 ห้อง ${g.room_code} — ดูย้อนหลังได้ด้วย "ประวัติ ${g.room_code}"`,
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
    // Same one-word-name problem as the per-hole path: resolve to the roster
    // so a bulk card can never open a phantom second player.
    let bulkName = parsed.name;
    const bulkGame = store.activeGame(sourceId);
    const bulkRoster = (bulkGame?.players || []).map((p) => p.name).filter(Boolean);
    if (bulkRoster.length > 0) {
      const m = resolveTypedName(bulkRoster, bulkName);
      if (m.ok) bulkName = m.name;
      else {
        env.summary = {
          ok: false,
          message:
            (m.reason === "ambiguous"
              ? `ชื่อ "${bulkName}" ตรงกับผู้เล่นมากกว่า 1 คน (${m.matches.join(" / ")})`
              : `ไม่พบชื่อ "${bulkName}"`) + `\n(ชื่อที่ลงทะเบียน: ${bulkRoster.join(", ")})`,
        };
        return env;
      }
    }
    const r = store.recordBulk(sourceId, bulkName, parsed.scores);
    if (!r.ok) {
      env.summary = { ok: false, message: `ยังไม่มีเกมในกลุ่มนี้ — พิมพ์ "สร้างเกม" ก่อน` };
      return env;
    }
    env.summary = {
      ok: true,
      player: bulkName,
      message: `รับสกอร์ ${bulkName} ครบ 18 หลุมแล้ว ✅\nครบทุกคนแล้วพิมพ์ "รวม 18" เพื่อสรุปเงิน`,
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
    // If the guided setup was waiting for the course, this answered it — move on
    // to the next question instead of leaving the Q&A stuck on "สนามชื่ออะไร".
    let nextQuestion = "";
    if (set.game && ["course", "await_pars", "confirm_course"].includes(set.game.setup)) {
      set.game.setup = set.game.stake == null ? "stake" : set.game.turbo == null ? "turbo" : "format";
      set.game.pending_course = null;
      store.save(set.game);
      nextQuestion = `\n${setupQuestion(set.game)}`;
    }
    env.summary = {
      ok: true,
      total_par: r.total,
      out: r.out,
      in: r.in,
      message:
        `กรอกพาร์ ${r.total} สำเร็จแล้ว ✅ (OUT ${r.out} / IN ${r.in})${note}` +
        (nextQuestion || maybeStartRound(set.game, store)),
    };
    return env;
  }

  const env = emptyEnvelope();
  env.action = "unknown";
  env.summary = {
    ok: false,
    message:
      `พิมพ์ "สร้างเกม", "กรอกพาร์ 454354434 443535444", "เข้าร่วม แซม 105 90 91", ` +
      `"หลุม 1 A 5 B 6" หรือ "ดูพาร์" เพื่อเช็กพาร์สนาม`,
  };
  return env;
}

/** Guided game setup: consume the next free-text reply as course -> stake -> turbo. */
function handleSetupAnswer(text, sourceId, store, game) {
  const env = emptyEnvelope();
  env.action = "game_setup";
  // normalize(): Thai digits -> Arabic and whitespace collapsed. Without it the
  // setup Q&A was the one place "๑๐๐" did not work.
  const t = normalize(text);

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
    if (!t || !/[A-Za-z฀-๿0-9]/.test(t)) {
      env.summary = {
        ok: false,
        step: "course",
        message: `สนามชื่ออะไรครับ? (พิมพ์ชื่อสนาม เช่น "เดอะไพน์")`,
      };
      return env;
    }
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
    // "หลุมละ 1,000 บาท" must be 1000, not 1 — the first \d+ used to win.
    const amount = parseStake(t);
    if (!amount || amount < 0) {
      env.summary = { ok: false, step: "stake", message: "พิมพ์เป็นตัวเลขครับ เช่น 20 (หลุมละกี่บาท)" };
      return env;
    }
    const r = store.setStake(sourceId, amount);
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

/* ----------------------------------------------------------------------------
 * HISTORY — reading rounds back out of the `rounds` table
 *
 * This is the one command that must answer while the bot is otherwise idle:
 * a group looks up an old round precisely because the game is long gone. It
 * needs the database, so it lives on the async path (dispatchAsync) rather than
 * inside the synchronous dispatch().
 * -------------------------------------------------------------------------- */

const ENDED_REASON_TH = {
  ended: "จบเกม",
  settled: "รวมเงินแล้ว",
  expired: "หมดเวลา 12 ชม.",
  replaced: "ถูกสร้างเกมใหม่ทับ",
};

/** "16/08/26 07:12" in Thai time (UTC+7), from a DB timestamp. */
function fmtWhen(ts) {
  return ts ? formatThaiDateTime(ts) : "";
}

/** Total gross per player across an archived `holes` object. */
function grossTotals(holes) {
  const totals = {};
  for (const rows of Object.values(holes || {})) {
    for (const row of rows || []) {
      if (!row?.name) continue;
      totals[row.name] = totals[row.name] || { gross: 0, played: 0 };
      if (row.gross == null) continue; // hole never got a number
      totals[row.name].gross += Number(row.gross);
      totals[row.name].played++;
    }
  }
  return totals;
}

function formatRoundDetail(row) {
  const code = row.archive_key || row.room_code;
  const dateLabel = formatRoomCodeDate(code) || fmtWhen(row.created_at);
  const settlement = row.settlement || {};
  const players = Array.isArray(row.players) ? row.players : [];
  const totals = grossTotals(row.holes);

  const head = `📒 ประวัติ ห้อง ${code}${dateLabel ? ` · ${dateLabel}` : ""}`;
  const setup = [
    row.course_name ? `สนาม ${row.course_name}` : null,
    row.stake != null ? `หลุมละ ${row.stake}` : null,
    row.turbo ? "เทอร์โบ 🔥" : null,
    row.format === "head_tail" ? "หัวกินหาง" : row.format === "all_vs_all" ? "กินกันทุกคน" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const hcpLine = players.length
    ? `แต้มต่อ: ${players.map((p) => `${p.name} ${p.handicap_index}`).join(" · ")}`
    : "";

  const moneyLine = Object.keys(settlement).length
    ? `\n💰 สรุปเงิน (เล่นไปแล้ว ${row.holes_counted ?? "-"}/18 หลุม)\n${fmtMoney(settlement)}\n(บวก = ได้ / ลบ = จ่าย)`
    : "\n(รอบนี้ไม่มีสกอร์ที่บันทึกไว้)";

  const cardLines = Object.entries(totals)
    .sort((a, b) => a[1].gross - b[1].gross)
    .map(([name, t]) => `${name} ${t.gross} (${t.played} หลุม)`);
  const cardBlock = cardLines.length ? `\n\n📋 สกอร์รวม\n${cardLines.join("\n")}` : "";

  const status = ENDED_REASON_TH[row.ended_reason] || row.ended_reason || "";
  const when = fmtWhen(row.updated_at || row.created_at);

  return (
    `${head}\n${setup}` +
    (hcpLine ? `\n${hcpLine}` : "") +
    moneyLine +
    cardBlock +
    (status ? `\n\nสถานะ: ${status}${when ? ` · ${when}` : ""}` : "")
  );
}

function formatRoundList(rows) {
  const lines = rows.map((r, i) => {
    const code = r.archive_key || r.room_code;
    const when = formatRoomCodeDate(code) || fmtWhen(r.created_at);
    const money = Object.keys(r.settlement || {}).length ? fmtMoney(r.settlement) : "—";
    return `${i + 1}. ${code} · ${when} · ${r.course_name || "-"} · ${r.holes_counted ?? "-"}/18 หลุม\n   ${money}`;
  });
  return (
    `📒 ${rows.length} รอบล่าสุดของกลุ่มนี้\n\n${lines.join("\n")}\n\n` +
    `ดูละเอียด: พิมพ์ "ประวัติ [เลขห้อง]"`
  );
}

/** Build the reply for a history request. Always answers — never silent. */
export async function historyReply(text, sourceId, store = null) {
  const env = emptyEnvelope();
  env.action = "history";
  const { code } = parseHistoryQuery(text);

  if (code) {
    const row = await findRound(normalizeRoomCode(code)).catch(() => null);
    env.room_code = code;
    if (!row) {
      const live = store?.activeGame?.(sourceId);
      env.summary = {
        ok: false,
        message:
          `ไม่พบประวัติของห้อง ${code} ครับ\n` +
          (live ? `(ห้องที่กำลังเล่นอยู่ตอนนี้คือ ${live.room_code})\n` : "") +
          `ลองพิมพ์ "ประวัติ" เฉยๆ เพื่อดูรอบล่าสุดของกลุ่มนี้`,
      };
      return env;
    }
    env.players = Array.isArray(row.players) ? row.players : [];
    env.summary = { ok: true, round: row, message: formatRoundDetail(row) };
    return env;
  }

  const rows = await listRounds(sourceId, 5).catch(() => []);
  if (!rows.length) {
    const live = store?.activeGame?.(sourceId);
    env.summary = {
      ok: false,
      message: live
        ? `ยังไม่มีรอบที่จบในกลุ่มนี้ครับ\n(ห้องที่กำลังเล่นอยู่: ${live.room_code})`
        : `ยังไม่มีประวัติการแข่งของกลุ่มนี้ครับ`,
    };
    return env;
  }
  env.summary = { ok: true, rounds: rows, message: formatRoundList(rows) };
  return env;
}

/**
 * Async front door. Identical to dispatch() for every command except "ประวัติ",
 * which needs a database round-trip. server.js and /simulate both use this.
 */
export async function dispatchAsync(text, sourceId, store) {
  if (detectIntent(text) === "history") return historyReply(text, sourceId, store);
  return dispatch(text, sourceId, store);
}
