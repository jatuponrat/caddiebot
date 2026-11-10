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
  parseBulkScores,
  parseHistoryQuery,
  parseParEdit,
  parseStake,
  parseFormat,
  parseParNine,
  parDigitsOnly,
  MAX_HOLE_SCORE,
  MIN_HOLE_NUMBER,
  MAX_HOLE_NUMBER,
  MIN_HOLE_SCORE,
  isValidHoleNumber,
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
import { PAR_ENTRY_STEPS } from "./gameStore.js";
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

// The par card goes in nine holes at a time: holes 1-9 when the game is set up,
// holes 10-18 at the turn — once the front nine is played and its money is in.
// Never all 18 in one message. These are the examples every prompt uses.
const FRONT_EG = "454354434";
const BACK_EG = "443535444";

/** How much of the card is in: 0 (none), 9 (holes 1-9) or 18. */
function knownHoles(game) {
  return game?.course?.holes?.length || 0;
}

/** The round has reached the turn: hole 9 is in for everyone, or someone has
 *  already scored a back-nine hole (the group moved on regardless). */
function atTheTurn(game) {
  const names = (game?.players || []).map((p) => p.name);
  const nine = game?.holes?.[9] || [];
  const nineDone =
    names.length > 0 && names.every((n) => nine.some((r) => r.name === n && r.gross != null));
  const backStarted = Object.keys(game?.holes || {}).some((h) => Number(h) >= 10);
  return nineDone || backStarted;
}

/** What to type next to give the round its pars. */
function parPrompt(game) {
  const held = heldNine(game);
  if (held) {
    return `พาร์ 9 หลุม${held.first === 1 ? "แรก" : "หลัง"}รอยืนยัน: พิมพ์ "ยืนยัน" ถ้าถูกต้อง หรือ "แก้ไข" เพื่อกรอกใหม่`;
  }
  return knownHoles(game) === 9
    ? `กรอกพาร์ 9 หลุมหลัง (หลุม 10-18) เช่น "${BACK_EG}"`
    : `กรอกพาร์ 9 หลุมแรก (หลุม 1-9) เช่น "${FRONT_EG}"`;
}

/** "หลุม 1-9: 4 5 4 3 5 4 4 3 4 (OUT 36)" / "หลุม 10-18: … (IN 36)". */
function nineLine(pars, first = 1) {
  const total = pars.reduce((a, b) => a + Number(b), 0);
  return `หลุม ${first}-${first + 8}: ${pars.join(" ")} (${first === 1 ? "OUT" : "IN"} ${total})`;
}

/** Pars of a card in hole order. */
function parsOf(holes) {
  return holes
    .slice()
    .sort((a, b) => Number(a.hole) - Number(b.hole))
    .map((h) => Number(h.par));
}

/** A nine typed outside the setup Q&A and waiting for "ยืนยัน": holes 1-9
 *  (the setup had already closed) or holes 10-18 (at the turn). */
function heldNine(game) {
  if (game?.pending_front9) return { first: 1, ...game.pending_front9 };
  if (game?.pending_back9) return { first: 10, ...game.pending_back9 };
  return null;
}

/**
 * Holes have been scored whose pars are not in yet (never typed, or typed and
 * still waiting for ยืนยัน): they settle as nothing until the pars count. Said
 * wherever money is shown, so a total missing holes is never presented as the
 * real thing — and it says what to type to fix it.
 */
function missingParsWarning(game) {
  const known = knownHoles(game);
  if (known >= 18) return "";
  const scored = Object.keys(game.holes || {}).map(Number);
  const front = known === 0 && scored.some((h) => h <= 9);
  const back = scored.some((h) => h >= 10);
  if (!front && !back) return "";
  const range = front && back ? "หลุม 1-18" : front ? "หลุม 1-9" : "หลุม 10-18";
  const held = heldNine(game);
  const what = held
    ? `พาร์ 9 หลุม${held.first === 1 ? "แรก" : "หลัง"}ยังไม่ได้ยืนยัน`
    : known === 0
      ? "ยังไม่มีพาร์สนาม"
      : "ยังไม่มีพาร์ 9 หลุมหลัง";
  return `⚠️ ${what} — ${range} ยังไม่คิดเงิน\n${parPrompt(game)}`;
}

/** Holes have been scored but no stake was ever set: say so (and that setting
 *  it now prices those holes too) instead of showing a silent 0. */
function noStakeWarning(game) {
  if (game.stake || !Object.keys(game.holes || {}).length) return "";
  return `⚠️ ยังไม่ได้ตั้งเงินเดิมพัน — ยังไม่คิดเงิน\n` +
    `พิมพ์ "หลุมละ 20" แล้วบอทจะคิดเงินทุกหลุมที่ลงไปแล้วให้`;
}

/** A held nine read back for "ยืนยัน" — the same check the setup gives holes 1-9. */
function heldNineConfirmMessage(game) {
  const held = heldNine(game);
  if (!held) return "";
  return held.first === 1
    ? `${nineLine(held.pars)}\nถูกต้องไหมครับ? (พิมพ์ ยืนยัน / แก้ไข)`
    : `${nineLine(held.pars, 10)} — พาร์รวม ${(game.course?.total_par || 0) + held.total}\n` +
        `ถูกต้องไหมครับ? (พิมพ์ ยืนยัน / แก้ไข)`;
}

/** The reply once a held nine counts: what was saved, what the money did, and
 *  where the round goes next. */
function heldNineSavedMessage(game, first, nineTotal, alreadyScored, store) {
  const settled = alreadyScored ? `\n💰 คิดเงินหลุมที่ลงไปแล้วให้แล้ว — พิมพ์ "ยอดล่าสุด" ดูยอด` : "";
  if (first === 1) {
    return (
      `บันทึกพาร์ 9 หลุมแรกแล้ว (OUT ${nineTotal}) ✅\n9 หลุมหลังบอทจะถามตอนจบหลุม 9` +
      settled +
      maybeStartRound(game, store)
    );
  }
  const total = game.course.total_par;
  const note = total < 69 || total > 74 ? " (ปกติ 70–72 ลองเช็กอีกครั้ง)" : "";
  const cur = game.current_hole;
  return (
    `บันทึกพาร์ 9 หลุมหลังแล้ว (IN ${nineTotal}) ✅ — พาร์รวม ${total}${note}` +
    settled +
    (cur && cur <= 18 ? `\n${holeAnnounce(game, cur)}` : "")
  );
}

/** Point the group back at the hole the round is waiting on. Used after the
 *  handicap table is acknowledged, so "ตกลง" leads straight back into play
 *  instead of leaving everyone staring at a table. */
function resumeRoundMessage(game, store) {
  if (!game.course) {
    return `รับทราบครับ ✅\nยังไม่มีพาร์สนาม — ${parPrompt(game)}`;
  }
  // At the turn the next hole has no par until the back nine is typed.
  if (knownHoles(game) === 9 && atTheTurn(game) && (game.current_hole ?? 10) >= 10) {
    return `รับทราบครับ ✅\n${parPrompt(game)}`;
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
      `\n🏁 ผู้เล่นครบแล้ว! แต่ยังไม่มีพาร์สนาม\n${parPrompt(game)}\n` +
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
 * The IN nine, shown at the turn. Half the round is still unplayed at that
 * point, so a card that does not match the real course can still be corrected
 * before it costs anybody money.
 */
export function backNineParCheck(game) {
  const holes = game?.course?.holes;
  if (!Array.isArray(holes) || holes.length !== 18) return "";
  const pars = holes
    .slice()
    .sort((a, b) => Number(a.hole) - Number(b.hole))
    .map((h) => Number(h.par));
  const inn = pars.slice(9).reduce((a, b) => a + b, 0);
  return (
    `📋 เช็กพาร์ 9 หลุมหลัง (เผื่อสนามไม่ตรง)\n` +
    `หลุม 10-18  ${pars.slice(9).join(" ")}  (IN ${inn})\n` +
    `ถ้าผิด พิมพ์ "แก้พาร์ หลุม 12 เป็น 5" ได้เลยครับ`
  );
}

/**
 * The par card, read back. Groups check this before teeing off — every stroke
 * and every baht is computed from these numbers. Until the turn only holes 1-9
 * are known. Courses have no name any more (only a round restored from before
 * that change still carries one).
 */
export function parCardMessage(game, { pendingNote = true } = {}) {
  const heldFront = !game?.course && game?.pending_front9
    ? game.pending_front9.pars.map((par, i) => ({ hole: i + 1, par }))
    : null;
  const holes = game?.course?.holes || game?.pending_course?.holes || heldFront || null;
  if (!holes || (holes.length !== 18 && holes.length !== 9)) return null;
  const pars = parsOf(holes);
  const out = pars.slice(0, 9).reduce((a, b) => a + b, 0);
  const name = game.course_name ? ` ${game.course_name}` : "";
  const turbo = game.turbo ? game.turbo_holes || [] : [];
  let lines;
  const heldBack = pars.length === 9 && game.course ? game.pending_back9 : null;
  if (heldBack) {
    lines = [
      `📋 พาร์สนาม${name} — รวม ${out + heldBack.total} (9 หลุมหลังรอยืนยัน)`,
      ``,
      `หลุม 1-9   ${pars.join(" ")}  (OUT ${out})`,
      `หลุม 10-18 ${heldBack.pars.join(" ")}  (IN ${heldBack.total})`,
    ];
  } else if (pars.length === 9) {
    lines = [
      `📋 พาร์สนาม${name} 9 หลุมแรก — รวม ${out}`,
      ``,
      `หลุม 1-9   ${pars.join(" ")}  (OUT ${out})`,
      `หลุม 10-18 ยังไม่ได้กรอก — ` +
        (game.course && atTheTurn(game) ? parPrompt(game) : `บอทจะถามตอนจบหลุม 9`),
    ];
  } else {
    const inn = pars.slice(9).reduce((a, b) => a + b, 0);
    lines = [
      `📋 พาร์สนาม${name} — รวม ${out + inn}`,
      ``,
      `หลุม 1-9   ${pars.slice(0, 9).join(" ")}  (OUT ${out})`,
      `หลุม 10-18 ${pars.slice(9).join(" ")}  (IN ${inn})`,
    ];
  }
  if (turbo.length) lines.push(`🔥 หลุมเทอร์โบ (เงินคูณ 2): ${turbo.join(", ")}`);
  if (pendingNote && !game.course && (game.pending_course || game.pending_front9)) {
    lines.push(`⚠️ ยังไม่ได้ยืนยัน — พิมพ์ "ยืนยัน" ถ้าถูกต้อง หรือ "แก้ไข" เพื่อกรอกใหม่`);
  }
  if (pendingNote && heldBack) {
    lines.push(`⚠️ 9 หลุมหลังยังไม่ได้ยืนยัน — พิมพ์ "ยืนยัน" ถ้าถูกต้อง หรือ "แก้ไข" เพื่อกรอกใหม่`);
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
    case "pars_front":
    case "course": // old name-first steps, restored from before this change
    case "await_pars":
      return parPrompt(game);
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
  const warn = missingParsWarning(game);
  if (warn) lines.push("", warn);
  const stakeWarn = noStakeWarning(game);
  if (stakeWarn) lines.push("", stakeWarn);
  return lines.join("\n");
}

/**
 * One screen with everything a group asks between holes: how each player is
 * scoring, what handicap they are playing off, and where the money stands.
 * Answerable at ANY point in the round, including before the first hole.
 */
export function statusMessage(game, store) {
  const s = settleGame(game);
  const players = game.players || [];
  if (!players.length) {
    return `ยังไม่มีผู้เล่นในห้องนี้ครับ — พิมพ์ "เข้าร่วม [ชื่อ] [สกอร์ 3 รอบ]"`;
  }

  // Gross so far, and the par for exactly the holes THAT player has played, so
  // "+3" always compares like with like even when someone is a hole behind.
  const stats = {};
  // grossVsPar only counts holes whose par is known — before the back nine is
  // typed, holes 10-18 have none and would make everyone look over par.
  for (const p of players) stats[p.name] = { holes: 0, gross: 0, par: 0, grossVsPar: 0 };
  for (const [holeNum, rows] of Object.entries(game.holes || {})) {
    const par = parForHole(game, Number(holeNum));
    for (const row of rows || []) {
      const st = stats[row.name];
      if (!st || row.gross == null) continue;
      st.holes += 1;
      st.gross += row.gross;
      if (par != null) {
        st.par += par;
        st.grossVsPar += row.gross;
      }
    }
  }

  const money = s.perPlayer || {};
  const ranked = [...players].sort(
    (a, b) => (money[b.name] || 0) - (money[a.name] || 0) || a.name.localeCompare(b.name)
  );
  const pad = Math.max(...players.map((p) => p.name.length));

  const header =
    `📊 สถานะล่าสุด · ห้อง ${game.room_code}` +
    (s.holesCounted ? ` (เล่นไปแล้ว ${s.holesCounted}/18 หลุม)` : " (ยังไม่เริ่มลงสกอร์)");
  const lines = [header, ""];

  for (const p of ranked) {
    const st = stats[p.name];
    const d = st.grossVsPar - st.par;
    const vsPar = st.holes && st.par ? ` (${d >= 0 ? "+" : ""}${d})` : "";
    const behind = st.holes && st.holes < s.holesCounted ? ` ⚠️ ลง ${st.holes} หลุม` : "";
    const scorePart = st.holes ? `สกอร์ ${st.gross}${vsPar}` : "ยังไม่มีสกอร์";
    const amt = money[p.name] || 0;
    const moneyPart =
      !game.stake || !s.holesCounted
        ? "เงิน —"
        : amt > 0
          ? `เงิน +${amt}`
          : amt < 0
            ? `เงิน −${Math.abs(amt)}`
            : "เงิน 0";
    lines.push(
      `${p.name.padEnd(pad)}  ${scorePart} · แต้มต่อ ${p.handicap_index} · ${moneyPart}${behind}`
    );
  }

  const tail = [];
  if (game.stake) {
    tail.push(`หลุมละ ${game.stake}${game.turbo ? ` (เทอร์โบ ${(game.turbo_holes || []).join(", ")} 🔥)` : ""}`);
  } else {
    tail.push("ยังไม่ได้ตั้งเงินเดิมพัน — พิมพ์ \"หลุมละ 20\"");
  }
  if (game.format) tail.push(game.format === "head_tail" ? "หัวกินหาง" : "กินกันทุกคน");
  if (game.back9_handicap) tail.push("ใช้แต้มต่อใหม่สำหรับ 9 หลุมหลังแล้ว");
  lines.push("", tail.join(" · "));

  // Where the round is right now. With pars missing, that is what the round
  // is waiting for: holes 1-9 (or their ยืนยัน), or holes 10-18 at the turn.
  const parsWanted = !game.course || (knownHoles(game) === 9 && atTheTurn(game));
  if (parsWanted) {
    lines.push(missingParsWarning(game) || `⛳ ${parPrompt(game)}`);
  } else if (game.current_hole && game.current_hole <= 18) {
    lines.push(holeAnnounce(game, game.current_hole).replace("เริ่ม !!", "กำลังเล่น"));
    const waiting = (game.players || [])
      .map((p) => p.name)
      .filter((n) => !(game.holes?.[game.current_hole] || []).some((r) => r.name === n));
    if (waiting.length && waiting.length < players.length) {
      lines.push(`รออีก: ${waiting.join(", ")}`);
    }
  } else if (s.holesCounted >= 18) {
    lines.push(`🏁 ครบ 18 หลุมแล้ว — พิมพ์ "รวม 18" หรือ "จบเกม" เพื่อสรุปเงิน`);
  }
  return lines.join("\n");
}

/**
 * Apply a corrected par card: fix the room's course and recompute the net of
 * every hole already played. Only this round changes — no course is saved for
 * next time. Returns what the money did.
 */
function applyParFix(game, sourceId, store, holes) {
  const before = settleGame(game).perPlayer;
  const r = store.setCourse(null, sourceId, { name: game.course_name || "", holes });
  if (!r.ok) return { ok: false, errors: r.errors };
  const total = holes.reduce((a, h) => a + Number(h.par || 0), 0);
  const after = settleGame(r.game).perPlayer;
  const moved = Object.keys({ ...before, ...after }).filter(
    (n) => (before[n] || 0) !== (after[n] || 0)
  );
  return { ok: true, game: r.game, before, after, moved, total };
}

/** "หลุม 3: 4 → 5" for every hole whose par changes. */
function parDiffLines(oldHoles, newHoles) {
  const oldBy = new Map((oldHoles || []).map((h) => [Number(h.hole), Number(h.par)]));
  const out = [];
  for (const h of newHoles) {
    const was = oldBy.get(Number(h.hole));
    if (was != null && was !== Number(h.par)) out.push(`หลุม ${h.hole}: ${was} → ${h.par}`);
  }
  return out;
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
        const totTxt = tot == null ? "" : ` = ${tot} แต้ม${knownHoles(game) === 9 ? " (9 หลุมแรก)" : ""}`;
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
  `พาร์สนามกรอกทีละ 9 หลุม: 9 หลุมแรกตอนเริ่ม · 9 หลุมหลังตอนจบหลุม 9\n` +
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
  // What was said, for the yes / no / cancel checks below: quotes copied from
  // the bot's own examples (“ยืนยัน”) and Thai digits do not change the answer.
  const said = normalize(raw);

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
    const trimmed = said;
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

  // Pending par correction (ยืนยัน/ยกเลิก after "แก้พาร์" on a round in progress)
  if (_og?.pending_par_edit && !_og.pending_override) {
    const trimmed = said;
    if (/^(ยืนยัน|ตกลง|โอเค|ใช่)/.test(trimmed) || /^(ok|okay|yes|y)$/i.test(trimmed)) {
      const { holes } = _og.pending_par_edit;
      _og.pending_par_edit = null;
      store.save(_og);
      const applied = applyParFix(_og, sourceId, store, holes);
      const env = emptyEnvelope();
      env.action = "edit_par";
      if (!applied.ok) {
        env.summary = { ok: false, message: `พาร์ไม่ถูกต้อง — ต้องเป็นเลข 3–6 ครบ 18 หลุมครับ` };
        return env;
      }
      const moneyLine = applied.moved.length
        ? `\n💰 เงินที่คิดใหม่: ${fmtMoney(applied.after)}\n(เดิม ${fmtMoney(applied.before)})`
        : `\n💰 เงินไม่เปลี่ยน`;
      env.course = applied.game.course;
      env.summary = {
        ok: true,
        changed: true,
        before: applied.before,
        after: applied.after,
        message: `แก้พาร์แล้ว ✅ คิดหลุมที่ผ่านมาใหม่ให้เรียบร้อย${moneyLine}\n\n${parCardMessage(applied.game)}`,
      };
      return env;
    }
    if (/^(ยกเลิก|ไม่)/.test(trimmed) || /^(no|n)$/i.test(trimmed)) {
      _og.pending_par_edit = null;
      store.save(_og);
      const env = emptyEnvelope();
      env.action = "edit_par";
      env.summary = { ok: false, message: "ยกเลิกแล้ว — พาร์เดิมยังคงอยู่" };
      return env;
    }
    // Anything else that is real gameplay drops the pending edit rather than
    // leaving it armed for a stray "ยืนยัน" five holes later.
    if (["hole_scores", "bulk_scores", "settle", "end_game"].includes(intent)) {
      _og.pending_par_edit = null;
      store.save(_og);
    }
  }

  // A nine typed outside the setup Q&A, waiting for ยืนยัน / แก้ไข — holes 1-9
  // (the Q&A had closed) or holes 10-18 (at the turn). The same check the setup
  // gives holes 1-9. Only a clear yes / no is taken here: anything else (a
  // corrected nine, a score, chatter) is handled as usual and leaves it waiting.
  const held = heldNine(_og);
  if (held && !_og.pending_override && !_og.pending_par_edit && intent !== "edit_par") {
    const yes = /^(ยืนยัน|ตกลง|โอเค|ใช่|ถูกต้อง)/.test(said) || /^(ok|okay|yes|y)$/i.test(said);
    const no = /^(แก้ไข|กรอกใหม่|ไม่ถูก|ไม่ใช่|ยกเลิก)/.test(said) || /^(no|n)$/i.test(said);
    if (yes || no) {
      _og.awaiting_handicap_ack = false; // this reply answered the pars, not the table
      const env = emptyEnvelope();
      env.action = "set_course_par";
      env.room_code = _og.room_code;
      const front = held.first === 1;
      if (no) {
        const r = front ? store.dropPendingFrontNine(sourceId) : store.dropPendingBackNine(sourceId);
        env.summary = {
          ok: true,
          nine: front ? "front" : "back",
          message: `ได้ครับ กรอกใหม่\n${parPrompt(r.game)}`,
        };
        return env;
      }
      const scored = Object.keys(_og.holes || {})
        .map(Number)
        .some((h) => (front ? h <= 9 : h >= 10));
      const r = front ? store.confirmFrontNine(sourceId) : store.confirmBackNine(sourceId);
      if (!r.ok) {
        env.summary = { ok: false, message: `พาร์ไม่ถูกต้อง — ต้องเป็นเลข 3–6 ครบ 9 หลุมครับ` };
        return env;
      }
      env.course = r.game.course;
      env.summary = {
        ok: true,
        nine: front ? "front" : "back",
        confirmed: true,
        total_par: r.game.course.total_par,
        message: heldNineSavedMessage(r.game, held.first, held.total, scored, store),
      };
      return env;
    }
  }

  // "ตกลง" straight after the handicap table -> jump back to the hole in play.
  // Skipped while a course confirmation is pending so "ยืนยัน" is never stolen.
  if (_og?.awaiting_handicap_ack && !_og.pending_course) {
    _og.awaiting_handicap_ack = false;
    const ack = /^\s*(ตกลง|ตกลงครับ|ตกลงค่ะ|โอเค|โอเคครับ|okay|ok|ใช่|yes|y)\s*$/i.test(said);
    // Only an ack is activity. Anything else just clears the flag: saving it the
    // normal way renewed the 12h window on the first chatter after a table.
    if (ack) store.save(_og);
    else store.saveQuiet(_og);
    if (ack) {
      const env = emptyEnvelope();
      env.action = "handicap_ack";
      env.room_code = _og.room_code;
      env.summary = { ok: true, message: resumeRoundMessage(_og, store) };
      return env;
    }
    // anything else — fall through and handle it normally
  }

  // "แก้พาร์ …" — the card was saved wrong. Correcting it re-runs the net of
  // every hole already played, so when money has moved the group confirms first.
  if (intent === "edit_par") {
    const g = store.activeGame(sourceId);
    const env = emptyEnvelope();
    env.action = "edit_par";
    if (!g) {
      env.summary = { ok: false, message: `ยังไม่มีเกมในกลุ่มนี้ — พิมพ์ "สร้างเกม" ก่อน` };
      return env;
    }
    const { card, hole, par } = parseParEdit(raw);
    const fixEg = `เช่น "แก้พาร์ หลุม 7 เป็น 5"`;

    // Pars never go in 18 at a time — not even as a correction.
    if (card) {
      env.summary = { ok: false, message: `แก้ทีละหลุมครับ (พิมพ์พาร์ 18 ตัวรวดไม่ได้) ${fixEg}` };
      return env;
    }
    const badHole = () => {
      env.summary = {
        ok: false,
        message: `หลุมต้องเป็น ${MIN_HOLE_NUMBER}–${MAX_HOLE_NUMBER} และพาร์ต้องเป็น 3–6 ครับ`,
      };
      return env;
    };

    // Holes 1-9 are typed but not confirmed yet (setup is showing them and
    // asking ยืนยัน): fix them in place and ask again.
    if (!g.course && g.pending_course) {
      if (hole == null) {
        env.summary = { ok: false, message: `${parCardMessage(g)}\n\nแก้ทีละหลุมได้เลย ${fixEg}` };
        return env;
      }
      if (!isValidHoleNumber(hole) || !(par >= 3 && par <= 6)) return badHole();
      if (hole > g.pending_course.holes.length) {
        env.summary = { ok: false, message: `หลุม 10-18 ยังไม่ได้กรอกครับ — บอทจะถามตอนจบหลุม 9` };
        return env;
      }
      const fixed = g.pending_course.holes.map((h) => ({
        hole: Number(h.hole),
        par: Number(h.hole) === hole ? par : Number(h.par),
      }));
      const diff = parDiffLines(g.pending_course.holes, fixed);
      const total = fixed.reduce((a, h) => a + Number(h.par), 0);
      store.setPendingCourse(sourceId, fixed, total);
      env.summary = {
        ok: true,
        changed: diff.length > 0,
        pending: true,
        total_par: total,
        message:
          (diff.length ? `แก้แล้ว ✅\n${diff.join("\n")}` : `พาร์ตรงกับที่กรอกไว้อยู่แล้วครับ 👍`) +
          `\n\n${parsConfirmMessage(fixed)}`,
      };
      return env;
    }

    // No hole named — show what is stored and how to correct it.
    if (hole == null) {
      env.summary = {
        ok: false,
        message:
          g.course || g.pending_front9
            ? `${parCardMessage(g)}\n\nแก้ทีละหลุมครับ ${fixEg}`
            : `ยังไม่มีพาร์สนามให้แก้ครับ\n${parPrompt(g)}`,
      };
      return env;
    }
    if (!isValidHoleNumber(hole) || !(par >= 3 && par <= 6)) return badHole();
    // A hole whose par has not been typed yet (no card, or the back nine before
    // the turn) has nothing to correct.
    // A nine waiting for ยืนยัน (held outside the setup): fix it in place and
    // ask again — nothing has been paid on it yet.
    const heldEdit = heldNine(g);
    if (heldEdit && hole >= heldEdit.first && hole <= heldEdit.first + 8) {
      const pars = heldEdit.pars.slice();
      const was = pars[hole - heldEdit.first];
      pars[hole - heldEdit.first] = par;
      const r =
        heldEdit.first === 1
          ? store.holdFrontNine(sourceId, pars)
          : store.setPendingBackNine(sourceId, pars);
      env.summary = {
        ok: true,
        changed: was !== par,
        pending: true,
        message:
          (was !== par ? `แก้แล้ว ✅\nหลุม ${hole}: ${was} → ${par}` : `พาร์ตรงกับที่กรอกไว้อยู่แล้วครับ 👍`) +
          `\n\n${heldNineConfirmMessage(r.game)}`,
      };
      return env;
    }
    if (hole > knownHoles(g)) {
      env.summary = {
        ok: false,
        message:
          `ยังไม่ได้กรอกพาร์หลุม ${hole} ครับ — ` +
          (!g.course || atTheTurn(g) ? parPrompt(g) : `9 หลุมหลังบอทจะถามตอนจบหลุม 9`),
      };
      return env;
    }
    const holes = g.course.holes.map((h) =>
      Number(h.hole) === hole ? { hole: Number(h.hole), par } : { hole: Number(h.hole), par: Number(h.par) }
    );

    const diff = parDiffLines(g.course?.holes, holes);
    if (g.course && diff.length === 0) {
      env.summary = { ok: true, changed: false, message: `พาร์ตรงกับที่บันทึกไว้อยู่แล้วครับ 👍` };
      return env;
    }

    // Holes already scored -> confirm, because their net (and the money) moves.
    const played = Object.keys(g.holes || {}).length;
    if (played > 0) {
      g.pending_par_edit = { holes };
      store.save(g);
      env.summary = {
        ok: false,
        pending: true,
        message:
          `จะแก้พาร์ตามนี้นะครับ:\n${diff.join("\n")}\n\n` +
          `⚠️ ลงสกอร์ไปแล้ว ${played} หลุม — แก้แล้วจะคิดแต้มสุทธิและเงินของหลุมที่ผ่านมาใหม่ทั้งหมด\n` +
          `พิมพ์ "ยืนยัน" เพื่อแก้ หรือ "ยกเลิก"`,
      };
      return env;
    }

    const applied = applyParFix(g, sourceId, store, holes);
    if (!applied.ok) {
      env.summary = { ok: false, message: `พาร์ไม่ถูกต้อง — ต้องเป็นเลข 3–6 ครบ 18 หลุมครับ` };
      return env;
    }
    env.course = applied.game.course;
    const stillAsking = store.pendingSetup(sourceId);
    env.summary = {
      ok: true,
      changed: true,
      total_par: applied.total,
      message:
        `แก้พาร์แล้ว ✅\n${diff.length ? `${diff.join("\n")}\n` : ""}\n${parCardMessage(applied.game)}` +
        (stillAsking ? `\n\n${setupQuestion(stillAsking)}` : ""),
    };
    return env;
  }

  // "สถานะ" — everyone's score, handicap and money on one screen, at any point.
  if (intent === "status") {
    const g = store.activeGame(sourceId);
    const env = emptyEnvelope();
    env.action = "status";
    env.room_code = g?.room_code || null;
    if (!g) {
      env.summary = { ok: false, message: `ยังไม่มีเกมในกลุ่มนี้ — พิมพ์ "สร้างเกม" ก่อน` };
      return env;
    }
    const s = settleGame(g);
    env.players = g.players;
    env.summary = {
      ok: true,
      holes_counted: s.holesCounted,
      per_player: s.perPlayer,
      message: statusMessage(g, store),
    };
    return env;
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
      ? {
          ok: true,
          total_par: g.course?.total_par ?? g.pending_course?.total ?? null,
          message: card,
        }
      : { ok: false, message: `ยังไม่ได้บันทึกพาร์สนามครับ\n${parPrompt(g)}` };
    return env;
  }

  // Cancel a game that is mid-setup.
  if (/^\s*(ยกเลิก|cancel)\s*$/i.test(said) && store.pendingSetup(sourceId)) {
    store.cancelGame(sourceId);
    const env = emptyEnvelope();
    env.action = "cancel";
    env.summary = { ok: true, message: `ยกเลิกเกมแล้ว — พิมพ์ "สร้างเกม 4 คน" เพื่อเริ่มใหม่` };
    return env;
  }

  // Pars go in nine holes at a time. While the round has no par card yet, a
  // message that is nothing but digits IS the par card, whatever detectIntent
  // made of it: a typo such as "454354437" otherwise reads as a 9-digit room
  // code (a join), and a join closes the setup Q&A.
  const parDigits = parDigitsOnly(raw);
  if (_og && knownHoles(_og) < 18 && parDigits) {
    const asking = store.pendingSetup(sourceId);
    if (asking && (PAR_ENTRY_STEPS.has(asking.setup) || asking.setup === "confirm_course")) {
      return handleSetupAnswer(raw, sourceId, store, asking);
    }
    // Outside the Q&A (it closed early, or this is the back nine at the turn) a
    // nine still counts. While the bot is waiting for one, a nine typed a digit
    // short or long is answered too, rather than met with silence. Any other run
    // of digits ("555") is chatter, left alone.
    const n = parDigits.length;
    const waitingForPars = !_og.course || (knownHoles(_og) === 9 && atTheTurn(_og));
    if (n === 9 || n === 18 || (waitingForPars && n >= 8 && n <= 10)) {
      return parCardEntry(raw, sourceId, store);
    }
  }

  // Guided setup: while a game is mid-setup, free-text replies are the answers.
  const pending = store.pendingSetup(sourceId);
  // While mid-setup, free-text replies go to setup — including a bulk-looking
  // card from a name that is not on the roster. A bulk card naming someone
  // already on the roster is a score card, not an answer — routing it into the
  // setup Q&A silently ate a player's whole round.
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
  // Real gameplay (a join or a score that was actually accepted) closes the
  // guided Q&A — see closeSetupForPlay. Its note is appended to that reply.
  let setupClosingNote = "";

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
    // Only money the group has already been told is protected. With no stake
    // set yet nothing has been announced, so the stake (and the rule) can still
    // be set — the early-join note promises "ตั้งเมื่อไรก็ได้".
    if (played > 0 && g.stake) {
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
      const priced = played > 0 && settleGame(g).perHole.some((h) => Object.values(h.results).some((v) => v));
      env.summary = {
        ok: true,
        stake: amount,
        message:
          `หลุมละ ${amount} ✅` +
          (played > 0
            ? priced
              ? `\n💰 คิดเงิน ${played} หลุมที่ลงไปแล้วให้แล้ว — พิมพ์ "ยอดล่าสุด" ดูยอด`
              : `\nหลุมที่ลงไปแล้ว ${played} หลุมคิดเงินด้วยเดิมพันนี้`
            : ""),
      };
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
      setup: game.setup,
      message:
        `สร้างห้อง ${game.room_code} แล้ว ✅ (${expected_players} คน)` +
        `\n${parPrompt(game)}`,
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
    // Typed pars still waiting for ยืนยัน: ending now would close the round with
    // those holes unpaid, for good. Ask first; "แก้ไข" drops them if they were junk.
    const heldAtEnd = heldNine(g);
    if (heldAtEnd) {
      env.summary = {
        ok: false,
        pending: true,
        message:
          `ยังไม่ได้ยืนยันพาร์ 9 หลุม${heldAtEnd.first === 1 ? "แรก" : "หลัง"}ครับ\n` +
          `${nineLine(heldAtEnd.pars, heldAtEnd.first)}\n` +
          `พิมพ์ "ยืนยัน" ถ้าถูกต้อง (หรือ "แก้ไข") แล้วพิมพ์ "จบเกม" อีกครั้ง`,
      };
      return env;
    }
    const names = g.players.map((p) => p.name).join(", ") || "—";
    const holesPlayed = Object.keys(g.holes).length;
    const s = settleGame(g);
    const settleLine = !s.holesCounted
      ? "\n(ยังไม่มีสกอร์ที่บันทึก)"
      : !g.stake
        ? "\n(รอบนี้ไม่ได้ตั้งเงินเดิมพัน จึงไม่มีเงินให้สรุป)"
        : `\n💰 สรุปเงิน: ${fmtMoney(s.perPlayer)}\n(บวก = ได้ / ลบ = จ่าย)` +
          (missingParsWarning(g) ? `\n⚠️ หลุมที่ไม่มีพาร์ไม่ได้คิดเงิน` : "");
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
        (g.course_name ? `สนาม ${g.course_name} · ` : "") +
        `ผู้เล่น: ${names} · เล่นไปแล้ว ${holesPlayed}/18 หลุม` +
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
    setupClosingNote = closeSetupForPlay(sourceId, store);
    const g = r.game;
    env.players = g.players;
    env.handicap_level = g.handicap_level;
    env.rules = g.rules;
    const count = g.players.length;
    // "3/2 คน" when more people join than the game was made for: show the count only.
    const cap = g.expected_players && count <= g.expected_players ? `/${g.expected_players}` : "";
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
    setupClosingNote = closeSetupForPlay(sourceId, store); // the score was accepted
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
    } else if (!game.stake) {
      // Without this the hole just ends with no money line and nobody notices
      // until the end that the whole round was played for nothing.
      moneyLine = `\n⚠️ ยังไม่ได้ตั้งเงินเดิมพัน — ยังไม่คิดเงิน · พิมพ์ "หลุมละ 20"`;
    }
    // advance the round pointer + announce the next hole
    let nextLine = "";
    if (game.current_hole == null || hole === game.current_hole) {
      const next = hole + 1;
      if (next <= 18) {
        game.current_hole = next;
        // Hole 10 has no par until the back nine is typed: at the turn the bot
        // asks for it (below) instead of announcing a hole it cannot score.
        if (game.course && !(knownHoles(game) === 9 && next === 10)) {
          nextLine = `\n${holeAnnounce(game, next)}`;
        }
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
      // Nine holes still to play — the last sensible moment to catch a par card
      // that does not match the course the group is actually standing on.
      const parCheck = backNineParCheck(game);
      if (parCheck) turnLine += `\n\n${parCheck}`;
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
    // The back nine's pars are asked for at the turn — after the front-nine
    // money is in — and any hole completed without its par says so (and what
    // to type), instead of quietly settling as nothing.
    let parAsk = "";
    if (hole === 9 && knownHoles(game) === 9) {
      parAsk = `\n\n⛳ จบ 9 หลุมแรก — ${parPrompt(game)}`;
    } else if (r.par == null && missingParsWarning(game)) {
      parAsk = `\n\n${missingParsWarning(game)}`;
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
      back_nine_pars_needed: Boolean(parAsk),
      message:
        setupClosingNote.trim() +
        (setupClosingNote ? "\n\n" : "") +
        `หลุม ${hole} ครบทุกคน ✅${turboTag}` +
        (cappedNote ? `\n⚠️ ปรับให้อยู่ในช่วง ${MIN_HOLE_SCORE}–${MAX_HOLE_SCORE}: ${cappedNote}` : "") +
        `${moneyLine}${turnLine}` +
        (turnLine && nextLine ? "\n" : "") +
        nextLine +
        parAsk,
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
        ? `บันทึกสนามแล้ว (พาร์รวม ${r.game.course.total_par})` +
          (store.pendingSetup(sourceId)
            ? `\n${setupQuestion(store.pendingSetup(sourceId))}`
            : maybeStartRound(r.game, store))
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
            `ยังไม่ได้ตั้งเงินเดิมพัน จึงยังไม่มีเงินให้สรุปครับ ` +
            `(เล่นไปแล้ว ${s.holesCounted}/18 หลุม)\n` +
            `พิมพ์ "หลุมละ 20" แล้วบอทจะคิดเงินทุกหลุมที่ลงไปแล้วให้\n` +
            `📒 ห้อง ${g.room_code} — ดูสกอร์ย้อนหลังได้ด้วย "ประวัติ ${g.room_code}"`
          : `สรุปเงินรวม 💰 (เล่นไปแล้ว ${s.holesCounted}/18 หลุม)\n${fmtMoney(s.perPlayer)}\n(บวก = ได้ / ลบ = จ่าย)\n` +
            (missingParsWarning(g) ? `${missingParsWarning(g)}\n` : "") +
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
    const closing = closeSetupForPlay(sourceId, store);
    const warn = missingParsWarning(r.game);
    env.summary = {
      ok: true,
      player: bulkName,
      message:
        `รับสกอร์ ${bulkName} ครบ 18 หลุมแล้ว ✅\nครบทุกคนแล้วพิมพ์ "รวม 18" เพื่อสรุปเงิน` +
        closing +
        (warn ? `\n\n${warn}` : ""),
    };
    return env;
  }

  if (intent === "par_string") return parCardEntry(raw, sourceId, store);

  const env = emptyEnvelope();
  env.action = "unknown";
  env.summary = {
    ok: false,
    message:
      `พิมพ์ "สร้างเกม", พาร์ทีละ 9 หลุม "454354434", "เข้าร่วม แซม 105 90 91", ` +
      `"หลุม 1 A 5 B 6", "สถานะ" หรือ "ดูพาร์"`,
  };
  return env;
}

/**
 * Real gameplay closes the guided Q&A — the group has clearly moved on. Called
 * only AFTER a join or a score was actually accepted: a join that failed (a
 * typo'd room code, pars pasted with a quote mark) used to close it silently,
 * and the bot never asked for ยืนยัน, the stake, turbo or กติกา again.
 * Whatever is still unset is named out loud; it can be set at any time
 * afterwards ("หลุมละ 20", "กติกา หัวกินหาง"). Typed holes 1-9 that were still
 * waiting for ยืนยัน keep waiting — they are never used without it.
 * @returns {string} note to append to the reply ("" when no Q&A was open)
 */
function closeSetupForPlay(sourceId, store) {
  const pending = store.pendingSetup(sourceId);
  if (!pending) return "";
  const notes = [];
  if (!pending.course && pending.pending_course) {
    if (pending.pending_course.holes.length === 9) {
      store.holdFrontNine(sourceId, parsOf(pending.pending_course.holes));
    } else {
      // A whole 18-hole card typed before pars went in nine at a time (a round
      // restored from the old version): it was shown in full — use it.
      const c = store.confirmCourse(sourceId);
      if (c.ok) notes.push(`✅ ใช้พาร์ที่กรอกไว้ (รวม ${c.total}) — ถ้าผิด พิมพ์ "แก้พาร์ หลุม 3 เป็น 5"`);
    }
  }
  const missing = [];
  // Only holes 1-9 belong to the setup; holes 10-18 are asked for at the turn.
  if (!pending.course) missing.push(`พาร์สนาม — ${parPrompt(pending)}`);
  if (pending.stake == null) missing.push('เงินเดิมพัน — พิมพ์ "หลุมละ 20"');
  if (pending.turbo == null) store.setTurbo(sourceId, false);
  if (!pending.format) store.setFormat(sourceId, "all_vs_all");
  store.finishSetup(sourceId);
  if (missing.length) {
    notes.push(
      `⚠️ ยังไม่ได้ตั้ง: ${missing.join(" · ")}\n` +
        `ตั้งเมื่อไรก็ได้ครับ — ถ้าไม่ตั้งเงินเดิมพัน รอบนี้จะไม่คิดเงิน`
    );
  }
  return notes.length ? `\n\n${notes.join("\n")}` : "";
}

/** "กรอกทีละ 9 หลุม" — the reply to a whole 18-digit card, which is never taken. */
function nineAtATime(game) {
  return knownHoles(game) === 9
    ? `กรอกทีละ 9 หลุมครับ (พิมพ์ 18 ตัวรวดไม่ได้) — ตอนนี้ขอแค่ 9 หลุมหลัง`
    : `กรอกทีละ 9 หลุมครับ (พิมพ์ 18 ตัวรวดไม่ได้) — ตอนนี้ขอแค่ 9 หลุมแรก\n9 หลุมหลังบอทจะถามตอนจบหลุม 9`;
}

/**
 * A nine of pars typed outside the setup Q&A: holes 10-18 at the turn, or holes
 * 1-9 when a join closed the Q&A before the front nine was in. Typed pars count
 * straight away here (there is no ยืนยัน step outside the Q&A), so they are read
 * back for checking. The back nine is only taken once the front nine has been
 * played: before that, the bot will ask for it at the turn.
 */
function parCardEntry(raw, sourceId, store) {
  const env = emptyEnvelope();
  env.action = "set_course_par";
  const g = store.activeGame(sourceId);
  if (!g) {
    env.summary = { ok: false, message: `ยังไม่มีเกมในกลุ่มนี้ — พิมพ์ "สร้างเกม" ก่อนแล้วค่อยกรอกพาร์` };
    return env;
  }
  // A setup question still open (stake, turbo, กติกา) is asked again after.
  const asking = store.pendingSetup(sourceId);
  const tail = asking ? `\n\n${setupQuestion(asking)}` : "";
  const digits = parDigitsOnly(raw) ?? normalize(raw).replace(/\D/g, "");
  const known = knownHoles(g);
  const fail = (message) => {
    env.summary = { ok: false, message: message + tail };
    return env;
  };

  if (known >= 18) {
    env.summary = { ok: false, total_par: g.course.total_par };
    return fail(
      `พาร์สนามครบ 18 หลุมแล้วครับ (รวม ${g.course.total_par})\n` +
        `ถ้าจะแก้ พิมพ์ "แก้พาร์ หลุม 7 เป็น 5" · ดูทั้งหมด พิมพ์ "ดูพาร์"`
    );
  }
  const backTooEarly = known === 9 && !atTheTurn(g);
  const notYet =
    `พาร์ 9 หลุมหลังกรอกตอนจบหลุม 9 ครับ — บอทจะถามเอง\n` +
    `ถ้า 9 หลุมแรกผิด พิมพ์ "แก้พาร์ หลุม 3 เป็น 5"`;
  if (digits.length === 18) return fail(backTooEarly ? notYet : `${nineAtATime(g)}\n${parPrompt(g)}`);
  if (backTooEarly) return fail(notYet);
  const nine = parseParNine(digits);
  if (!nine.ok) {
    return fail(
      nine.reason === "count"
        ? `พาร์ต้องมี 9 หลุม (นับได้ ${nine.count} ตัว) — กรอกใหม่\n${parPrompt(g)}`
        : `ค่าพาร์ต้องเป็นเลข 3–6 เท่านั้น — กรอกใหม่\n${parPrompt(g)}`
    );
  }

  // Holes 1-9 (the setup closed before they were typed): shown once for
  // "ยืนยัน" before they count, like everywhere else. Typed again = replaced.
  if (known === 0) {
    const r = store.holdFrontNine(sourceId, nine.pars);
    if (!r.ok) return fail(`พาร์ไม่ถูกต้อง — ต้องเป็นเลข 3–6 ครบ 9 หลุมครับ`);
    env.summary = {
      ok: true,
      nine: "front",
      pending: true,
      out: nine.total,
      message: heldNineConfirmMessage(r.game) + tail,
    };
    return env;
  }

  // Holes 10-18, at the turn: shown once for "ยืนยัน" before they count. A nine
  // typed again while they wait replaces them (a correction).
  const r = store.setPendingBackNine(sourceId, nine.pars);
  if (!r.ok) return fail(`พาร์ไม่ถูกต้อง — ต้องเป็นเลข 3–6 ครบ 9 หลุมครับ`);
  env.summary = {
    ok: true,
    nine: "back",
    pending: true,
    in: nine.total,
    total_par: r.game.course.total_par + nine.total,
    message: heldNineConfirmMessage(r.game) + tail,
  };
  return env;
}

/** Typed pars read back for "ยืนยัน": holes 1-9 (or a whole card from a round
 *  started before pars went in nine at a time). */
function parsConfirmMessage(holes) {
  const pars = parsOf(holes);
  if (pars.length === 9) return `${nineLine(pars)}\nถูกต้องไหมครับ? (พิมพ์ ยืนยัน / แก้ไข)`;
  const total = pars.reduce((a, b) => a + b, 0);
  return (
    `${nineLine(pars.slice(0, 9))}\n${nineLine(pars.slice(9), 10)}\n` +
    `ครบพาร์ ${total} ถูกต้องไหมครับ? (พิมพ์ ยืนยัน / แก้ไข)`
  );
}

/** Holes 1-9, shown once in the setup Q&A before they count. */
function confirmFrontEnv(env, nine) {
  env.summary = {
    ok: true,
    step: "confirm_course",
    total_par: nine.total,
    front_nine: nine.pars,
    message: parsConfirmMessage(nine.pars.map((par, i) => ({ hole: i + 1, par }))),
  };
  return env;
}

const RESTART_PARS_RE = /^(แก้ไข|แก้|ใหม่|กรอกใหม่|เริ่มใหม่|ย้อน)/;

/**
 * Holes 1-9 in the setup Q&A, then one look at them ("ยืนยัน") before they
 * count. Holes 10-18 are NOT part of the setup: the bot asks for them at the
 * turn, once the front nine is played and its money is in. No course name is
 * asked for and nothing is remembered — every round types its own pars.
 */
function parSetupAnswer(t, sourceId, store, game, env) {
  const step = "pars_front";
  const digits = parDigitsOnly(t);

  if (digits == null) {
    // "หลุมละ 20" typed while the pars are still going in: keep it (the stake
    // question is then skipped after ยืนยัน) and carry on with the pars.
    if (detectIntent(t) === "set_stake" && parseStake(t) > 0) {
      game.stake = parseStake(t);
      store.save(game);
      env.summary = { ok: true, step, stake: game.stake, message: `หลุมละ ${game.stake} ✅\n${parPrompt(game)}` };
      return env;
    }
    if (RESTART_PARS_RE.test(t)) {
      env.summary = { ok: false, step, message: `ได้ครับ\n${parPrompt(game)}` };
      return env;
    }
    if (/^(ยืนยัน|ตกลง|โอเค|ใช่|ok|yes)/i.test(t)) {
      env.summary = { ok: false, step, message: `ยังไม่มีพาร์ให้ยืนยันครับ\n${parPrompt(game)}` };
      return env;
    }
    // Words, not pars — most likely a course name typed out of habit.
    env.summary = {
      ok: false,
      step,
      message: (t ? `ใส่เฉพาะตัวเลขพาร์ครับ (ไม่ต้องใส่ชื่อสนาม)\n` : "") + parPrompt(game),
    };
    return env;
  }
  if (digits.length === 18) {
    env.summary = { ok: false, step, message: `${nineAtATime(game)}\n${parPrompt(game)}` };
    return env;
  }
  const nine = parseParNine(digits);
  if (!nine.ok) {
    env.summary = {
      ok: false,
      step,
      message:
        nine.reason === "count"
          ? `พาร์ต้องมี 9 หลุม (นับได้ ${nine.count} ตัว) — กรอกใหม่\n${parPrompt(game)}`
          : `ค่าพาร์ต้องเป็นเลข 3–6 เท่านั้น — กรอกใหม่\n${parPrompt(game)}`,
    };
    return env;
  }
  store.setPendingCourse(sourceId, nine.pars.map((par, i) => ({ hole: i + 1, par })), nine.total);
  return confirmFrontEnv(env, nine);
}

/** Guided game setup: consume the next free-text reply as
 *  holes 1-9 -> ยืนยัน -> stake -> turbo -> กติกา. */
// The guided questions are answered in a group where people keep chatting, so
// an answer must BE the answer — not merely contain it. Matching anywhere took
// "555" (laughter) as หลุมละ 555, "16.52" (a time) as หลุมละ 16, "มีใครไปบ้าง"
// as turbo on and "ทุกคนพร้อมยัง" as กินกันทุกคน. Polite endings still count:
// "มีครับ", "100 บาทค่ะ", "เลือก 1".
const POLITE_TAIL_RE = /(?:ครับผม|ครับ|คับ|ขรับ|ฮะ|ฮับ|ค่ะ|คะ|ค่า|จ้า|จ้ะ|จ๊ะ|นะ|น้า|เลย|ด้วย)+$/u;
function bareAnswer(text) {
  return normalize(text)
    .toLowerCase()
    .replace(/[\s!?.,~:：()\-]+/g, "")
    .replace(POLITE_TAIL_RE, "");
}
const TURBO_YES_RE = /^(?:มี|มีเทอร์โบ|เอา|เอาเทอร์โบ|ใช่|เปิด|เปิดเทอร์โบ|yes|y|turbo|เทอร์โบ|มีturbo)$/u;
const TURBO_NO_RE = /^(?:ไม่มี|ไม่|ไม่เอา|ไม่ต้อง|ปิด|no|n|ไม่มีเทอร์โบ|ไม่เอาเทอร์โบ|ไม่มีturbo)$/u;
const FORMAT_PREFIX_RE = /^(?:กติกา|เลือก|ข้อ|แบบ)/u;
const HEAD_TAIL_RE = /^(?:1|1️⃣|หัวกินหาง|headtail|headeatstail)$/u;
const ALL_VS_ALL_RE = /^(?:2|2️⃣|กินกันทุกคน|กินทุกคน|ทุกคน|allvsall)$/u;
/** The stake as a whole answer: "100", "1,000", "หลุมละ 50 บาท", "20 ครับ". */
const STAKE_ANSWER_RE =
  /^(?:(?:หลุมละ|เดิมพัน|เงินเดิมพัน|stake)\s*[:：]?\s*)?(?:฿\s*)?(\d+)\s*(?:บาท|฿|baht)?\s*(?:ครับผม|ครับ|คับ|ค่ะ|คะ|ค่า|จ้า|จ้ะ|นะ)?$/iu;

function handleSetupAnswer(text, sourceId, store, game) {
  const env = emptyEnvelope();
  env.action = "game_setup";
  // normalize(): Thai digits -> Arabic and whitespace collapsed. Without it the
  // setup Q&A was the one place "๑๐๐" did not work.
  const t = normalize(text);

  if (PAR_ENTRY_STEPS.has(game.setup)) return parSetupAnswer(t, sourceId, store, game, env);

  if (game.setup === "confirm_course") {
    // Another nine typed here is a corrected front nine: it replaces the one on
    // screen and is asked about again. 18 digits are never taken.
    const digits = parDigitsOnly(t);
    const pendingNine = game.pending_course?.holes?.length === 9;
    if (digits != null) {
      if (digits.length === 18) {
        env.summary = { ok: false, step: "confirm_course", message: `${nineAtATime(game)}\nพิมพ์ "ยืนยัน" หรือ "แก้ไข" ครับ` };
        return env;
      }
      const nine = digits.length === 9 && pendingNine ? parseParNine(digits) : null;
      if (nine?.ok) {
        store.setPendingCourse(sourceId, nine.pars.map((par, i) => ({ hole: i + 1, par })), nine.total);
        return confirmFrontEnv(env, nine);
      }
      env.summary = {
        ok: false,
        step: "confirm_course",
        message:
          (nine && !nine.ok ? `ค่าพาร์ต้องเป็นเลข 3–6 เท่านั้น\n` : "") +
          `พิมพ์ "ยืนยัน" ถ้าถูกต้อง หรือ "แก้ไข" เพื่อกรอกใหม่`,
      };
      return env;
    }
    const yes = /ยืนยัน|ใช่|ตกลง|โอเค|^ok$|yes|^y$/i.test(t);
    const no = /แก้ไข|ไม่|ใหม่|\bno\b|^n$/i.test(t);
    if (yes && !no) {
      const r = store.confirmCourse(sourceId);
      const next = setupQuestion(r.game);
      const nine = knownHoles(r.game) === 9;
      env.course = r.game.course;
      env.summary = {
        ok: true,
        step: r.game.setup,
        total_par: r.total,
        message:
          (nine
            ? `บันทึกพาร์ 9 หลุมแรกแล้ว (OUT ${r.total}) ✅\n9 หลุมหลังบอทจะถามตอนจบหลุม 9`
            : `บันทึกพาร์สนามแล้ว (รวม ${r.total}) ✅`) + (next ? `\n${next}` : ""),
      };
      return env;
    }
    if (no) {
      store.editCourse(sourceId);
      env.summary = {
        ok: true,
        step: "pars_front",
        message: `ได้ครับ กรอกใหม่\n${parPrompt(game)}`,
      };
      return env;
    }
    env.summary = { ok: false, step: "confirm_course", message: `พิมพ์ "ยืนยัน" หรือ "แก้ไข" ครับ` };
    return env;
  }

  if (game.setup === "stake") {
    // A par card sent late (a nine typed twice) is not a stake: "443535444"
    // would otherwise become 443,535,444 baht a hole.
    const late = parDigitsOnly(t);
    if (late && late.length >= 9) {
      env.summary = {
        ok: false,
        step: "stake",
        message: "ตอนนี้ถามเงินเดิมพันอยู่ครับ — เล่นกันหลุมละเท่าไร? (พิมพ์ตัวเลข เช่น 20)",
      };
      return env;
    }
    // "หลุมละ 1,000 บาท" must be 1000, not 1 — the first \d+ used to win.
    const said = normalize(t).replace(/(\d),(?=\d{3}\b)/g, "$1");
    const m = said.match(STAKE_ANSWER_RE);
    const amount = m ? Number(m[1]) : null;
    // A bare 555 / 5555 is laughter, not a stake — unless it says so.
    if (amount && /^5{3,}$/.test(said)) {
      env.summary = {
        ok: false,
        step: "stake",
        message: `เล่นกันหลุมละเท่าไรครับ? (พิมพ์ตัวเลข เช่น 20)\nถ้าหลุมละ ${said} จริง ๆ พิมพ์ "หลุมละ ${said}"`,
      };
      return env;
    }
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
    const b = bareAnswer(t);
    const no = TURBO_NO_RE.test(b);
    const yes = !no && TURBO_YES_RE.test(b);
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
    const b = bareAnswer(t).replace(FORMAT_PREFIX_RE, "");
    const isHeadTail = HEAD_TAIL_RE.test(b);
    const isAllVsAll = ALL_VS_ALL_RE.test(b);
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
      total_par: g.course?.total_par ?? null,
      stake: g.stake,
      turbo: g.turbo,
      turbo_holes: g.turbo_holes,
      format,
      message:
        `ตั้งค่าเกมเรียบร้อย ✅\n` +
        (knownHoles(g) === 9 ? `พาร์ 9 หลุมแรก ${g.course.total_par} · ` : g.course ? `พาร์ ${g.course.total_par} · ` : '') +
        `หลุมละ ${g.stake} · ${turboLine}\n` +
        `กติกา: ${formatLabel}\n` +
        `ต่อไป:\n` +
        (g.course ? '' : `• ${parPrompt(g)}\n`) +
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
    const head = [code, when, r.course_name, `${r.holes_counted ?? "-"}/18 หลุม`].filter(Boolean);
    return `${i + 1}. ${head.join(" · ")}\n   ${money}`;
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
