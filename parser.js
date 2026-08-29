// parser.js
// Normalize messy Thai/English LINE messages into clean structures (spec: SCORE PARSING MODE).
// These functions only EXTRACT — assembly of final backend JSON happens in handler.js.

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";

/** Lowercase-safe normalize: Thai digits -> Arabic, collapse whitespace, trim. */
export function normalize(text) {
  if (text == null) return "";
  return String(text)
    .replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/** A line that names a hole: "หลุม 3 …", "hole 3 …", "H3 …". */
const HOLE_LINE_RE = /(?:(?:หลุม|hole|รู)\s*\d)|(?:^h\s*\d{1,2}\b)/i;

/**
 * Decide what kind of message this is.
 * @returns {'course_json'|'create_game'|'join'|'hole_scores'|'par_string'|'bulk_scores'|'settle'|'end_game'|'handicap'|'history'|'unknown'}
 */
export function detectIntent(text) {
  const raw = String(text ?? "");
  if (/^\s*[\[{]/.test(raw)) return "course_json"; // pasted JSON course
  const t = normalize(raw);

  // A line that really is a score or a join wins over any command word inside
  // it. "หลุม 1 แซม 5 บอย 6 สรุปทีหลังนะ" used to be read as "สรุป" and the
  // scores were dropped without a word; "เข้าร่วม จบเกม 95 92 90" ENDED the
  // game. Both checks require the line to actually parse, so "สรุปหลุม 3" (no
  // scores) still settles.
  if (HOLE_LINE_RE.test(t) && parseHoleScores(t).players.length > 0) return "hole_scores";
  if (/(เข้าร่วม|join)/i.test(t)) {
    const j = parseJoin(t);
    if (j.player && j.scores.length >= 3) return "join";
  }

  // "ดูพาร์" / "เช็คพาร์" — read the saved card back. Checked before the
  // par-card and command patterns, but only when the line carries no par card
  // of its own, so "พาร์ 454354434 443535444" still SETS the pars.
  if (
    /(ดูพาร์|เช็คพาร์|เช็กพาร์|ขอพาร์|พาร์สนาม|ดูสนาม|ขอดูพาร์|show\s*par|check\s*par)/i.test(t) &&
    (t.replace(/\D/g, "").length < 10)
  ) {
    return "show_par";
  }

  if (/(จบเกม|จบ\s*เกม|end\s*game)/i.test(t)) return "end_game";
  // History lookup — checked early so "ประวัติ" is never read as a score line,
  // and it is the one command that works while the bot is otherwise idle.
  if (/(ประวัติ|ประวัต|ย้อนหลัง|รอบเก่า|ดูรอบ|history)/i.test(t)) return "history";
  // Back-nine re-handicap — must beat the plain handicap question below.
  if (/(แต้มต่อใหม่|แต้มต่อเดิม|ใช้แต้มต่อใหม่|ใช้แต้มต่อเดิม|คิดแต้มต่อใหม่|เปลี่ยนแต้มต่อ)/i.test(t)) {
    return "back9_handicap";
  }
  // Must beat `settle` below: "สรุปแต้มต่อ" is a handicap question, not money.
  // Guarded against "เข้าร่วม …" so a join is never swallowed.
  if (!/(เข้าร่วม|join)/i.test(t) &&
      /(แต้มต่อ|แต้ม\s*ต่อ|ใครต่อใคร|ต่อกันเท่าไร|handicap|hdcp|\bhcp\b)/i.test(t)) {
    return "handicap";
  }
  // Live standings — must beat `settle`, whose pattern also matches "สรุป".
  if (/(ยอดล่าสุด|ยอดตอนนี้|ยอดสะสม|เงินล่าสุด|ใครนำ|ใครได้ใครเสีย|standings?)/i.test(t)) {
    return "standings";
  }
  if (/(รวม\s*18|รวมเงิน|เคลียร์เงิน|สรุปเงิน|สรุปผล|สรุป|คิดเงิน|settle)/i.test(t)) return "settle";
  if (/(สร้างเกม|สร้าง\s*เกม|create\s*game|new\s*game)/i.test(t)) return "create_game";
  // Set (or fix) the stake / rules AFTER the guided setup has closed — without
  // these, a group whose setup was cut short by an early join could never set a
  // stake at all and the round always settled to zero.
  if (/(หลุมละ|เดิมพัน|เงินเดิมพัน|\bstake\b)\s*[:：]?\s*\d+/i.test(t)) return "set_stake";
  if (/^(กติกา|เปลี่ยนกติกา|กฎ|rules?)/i.test(t) || /^(หัวกินหาง|กินกันทุกคน)$/i.test(t)) {
    return "set_format";
  }
  if (/(เข้าร่วม|join)/i.test(t)) return "join";
  if (HOLE_LINE_RE.test(t)) return "hole_scores";
  // Course par card: "454354434 443535444" (9+9), 18 contiguous digits, or "พาร์ ...".
  const noKw = t.replace(/^(พาร์|par|สนาม|course)\s*[:：]?\s*/i, "");
  const compact = noKw.replace(/\s+/g, "");
  if (noKw.length !== t.length && /\d/.test(compact)) return "par_string"; // explicit keyword
  if (/^\d{16,20}$/.test(compact)) return "par_string"; // bare ~18-digit par card
  // Bulk per-player card: "แซม 544535445 445354454" (name + 18 single-digit holes).
  // The name may be several words ("สมชาย ใจดี 445345434 453443544"). With a
  // single-token name required here, such a card fell through to the join
  // fallback below and the 18 par digits were read as a room code plus scores,
  // silently overwriting that player's handicap.
  if (/^\D\S*(?:\s+\D\S*)*\s+\d{9}\s+\d{9}$/.test(t) || /^\D\S*(?:\s+\D\S*)*\s+\d{18}$/.test(t)) {
    return "bulk_scores";
  }
  // Fallback: a room code (9-digit date code or legacy 4-digit) plus several
  // scores reads like a join, even without the "เข้าร่วม" keyword.
  if (/\b\d{9}\b/.test(t) && (t.match(/\d{2,3}/g) || []).length >= 3) return "join";
  if (/\b\d{4}\b/.test(t) && (t.match(/\d{2,3}/g) || []).length >= 4) return "join";
  return "unknown";
}

/** "หลุมละ 1,000 บาท" -> 1000. Commas and Thai digits included. */
export function parseStake(text) {
  const t = normalize(text).replace(/(\d),(?=\d{3}\b)/g, "$1"); // 1,000 -> 1000
  const m = t.match(/(?:หลุมละ|เดิมพัน|เงินเดิมพัน|stake)\s*[:：]?\s*(\d+)/i) || t.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** "กติกา หัวกินหาง" -> "head_tail"; "กินกันทุกคน" -> "all_vs_all". */
export function parseFormat(text) {
  const t = normalize(text);
  if (/หัวกินหาง|head\s*tail|^1$|1️⃣/i.test(t)) return "head_tail";
  if (/กินกันทุกคน|ทุกคน|all\s*vs\s*all|^2$|2️⃣/i.test(t)) return "all_vs_all";
  return null;
}

/** "สร้างเกม 4 คน" / "create game 4 players" -> expected player count if present. */
export function parseCreateGame(text) {
  const t = normalize(text);
  const m = t.match(/(\d{1,2})\s*(?:คน|players?|player|pax)/i);
  return { action: "create_game", expected_players: m ? Number(m[1]) : null };
}

/**
 * Flexible join. All of these work:
 *   "เข้าร่วม แซม 105 90 91"            (simple: name + 3 scores)
 *   "เข้าร่วม ชื่อ A 92,95,90"          (with ชื่อ keyword)
 *   "เข้าร่วม 4821 แซม 105 90 91"       (with room code)
 *   "join 4821 name Boom 92 95 90"
 * @returns {{action, room_code, player, scores:number[]}}
 */
/** A name may be several words ("สมชาย ใจดี") but never a whole sentence. */
export const MAX_NAME_WORDS = 3;
export const MAX_NAME_LENGTH = 40;

/** Take the leading run of non-numeric words as the player's name. */
function leadingName(s) {
  const words = [];
  for (const w of String(s).trim().split(/[\s,]+/)) {
    if (!w) continue;
    if (/^\d/.test(w)) break; // a number ends the name
    words.push(w.replace(/[,:：]+$/, ""));
    if (words.length >= MAX_NAME_WORDS) break;
  }
  const name = words.join(" ").trim();
  return name ? name.slice(0, MAX_NAME_LENGTH) : null;
}

export function parseJoin(text) {
  const t = normalize(text);
  // Room code: the 9-digit date code (160826001) or a legacy 4-digit one. The
  // 9-digit form MUST be matched first — otherwise it is chopped into "scores".
  const room = (t.match(/\b(\d{9})\b/) || t.match(/\b(\d{4})\b/) || [])[1] || null;
  let rest = room ? t.replace(room, " ") : t; // don't mistake room code for a score
  rest = rest.replace(/^.*?(เข้าร่วม|join)\s*/i, ""); // drop the command word
  // Name: prefer an explicit "ชื่อ/name" keyword, else the leading non-number
  // words. Multi-word names ("สมชาย ใจดี") are kept whole — truncating them
  // silently made the roster disagree with what the group actually typed.
  const kw = rest.match(/(?:ชื่อ|name|player)\s*[:：]?\s*(.*)$/i);
  let player = leadingName(kw ? kw[1] : rest);
  if (!player) {
    // Fallback: the name sits after the scores ("เข้าร่วม 105 90 91 แซม").
    const bare = rest.match(/([^\s,0-9][^\s,]*)/);
    player = bare ? bare[1].slice(0, MAX_NAME_LENGTH) : null;
  }
  const all = (rest.match(/\d{2,3}/g) || []).map(Number);
  // Only the last 3 rounds count. Anything beyond that is REPORTED, never
  // silently dropped — a 4th number is usually a typo the group should see.
  const scores = all.slice(0, 3);
  const extra_scores = all.slice(3);
  return { action: "join", room_code: room, player, scores, extra_scores };
}

/**
 * "ประวัติ 160826001" -> one round; bare "ประวัติ" -> this group's recent list.
 * Accepts the code with separators ("160826-001") and legacy 4-digit codes.
 * @returns {{code:string|null}}
 */
export function parseHistoryQuery(text) {
  const t = normalize(text).replace(/(ประวัติ|ประวัต|ย้อนหลัง|รอบเก่า|ดูรอบ|history|ห้อง|room)/gi, " ");
  const digits = (t.match(/\d[\d\s-]*/g) || [])
    .map((s) => s.replace(/\D/g, ""))
    .filter((s) => s.length >= 4);
  const code = digits.find((d) => d.length === 9) || digits.find((d) => d.length === 4) || null;
  return { code };
}

/**
 * "หลุม 1 A 5 B 6 C 5 D 7" (also multi-line, also Thai names).
 * @returns {{action, hole, players:{name,gross}[]}}
 */
/** A hole score is always a number, 1–10. Anything higher is recorded as 10. */
export const MIN_HOLE_SCORE = 1;
export const MAX_HOLE_SCORE = 10;

/** Clamp a typed score into the allowed range (11 -> 10, 0 -> 1). */
export function clampHoleScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.min(MAX_HOLE_SCORE, Math.max(MIN_HOLE_SCORE, Math.round(v)));
}

/** A round is 18 holes — anything outside that is a typo, not a hole. */
export const MIN_HOLE_NUMBER = 1;
export const MAX_HOLE_NUMBER = 18;

export function isValidHoleNumber(n) {
  const v = Number(n);
  return Number.isInteger(v) && v >= MIN_HOLE_NUMBER && v <= MAX_HOLE_NUMBER;
}

export function parseHoleScores(text) {
  const t = normalize(text);
  const holeMatch = t.match(/(?:หลุม|hole|รู|\bh)\s*[:：]?\s*(\d{1,2})/i);
  const rawHole = holeMatch ? Number(holeMatch[1]) : null;
  // "หลุม 25" / "หลุม 0" used to be accepted, recorded, and then counted in the
  // settlement ("สรุปเงินรวม 19 หลุม"). Flag it instead of swallowing it.
  const holeInvalid = rawHole != null && !isValidHoleNumber(rawHole);
  const hole = holeInvalid ? null : rawHole;
  const rest = holeMatch ? t.replace(holeMatch[0], " ") : t;

  const players = [];
  // Scores are ALWAYS a number. There is no "give up" marker: a hole with no
  // number is simply not recorded, which is far less error-prone than a special
  // value that every settlement path then has to special-case.
  // Walk the line token by token instead of matching one name word per score:
  // a player registered as "สมชาย ใจดี" must be scorable with the name the bot
  // itself prints, and capturing a single word rejected the WHOLE line —
  // including everyone else's scores on it.
  const add = (nameWords, raw) => {
    if (!nameWords.length) return;
    const gross = clampHoleScore(raw);
    const row = { name: nameWords.join(" "), gross };
    if (gross !== raw) row.capped_from = raw; // so the bot can say it adjusted
    players.push(row);
  };
  let nameWords = [];
  for (const tok of rest.split(/[\s,]+/).filter(Boolean)) {
    if (/^\d{1,2}$/.test(tok)) {
      add(nameWords, Number(tok));
      nameWords = [];
      continue;
    }
    // "A5" / "แซม5" — name and score written without a space.
    const glued = tok.match(/^([A-Za-z฀-๿][A-Za-z0-9฀-๿]*?)(\d{1,2})$/);
    if (glued) {
      nameWords.push(glued[1]);
      add(nameWords, Number(glued[2]));
      nameWords = [];
      continue;
    }
    if (/^[A-Za-z฀-๿]/.test(tok)) {
      nameWords.push(tok);
      if (nameWords.length > MAX_NAME_WORDS) nameWords.shift(); // keep the last few
      continue;
    }
    nameWords = []; // anything else (a stray long number) breaks the name
  }
  return {
    action: "hole_scores",
    hole,
    players,
    ...(holeInvalid ? { hole_invalid: rawHole } : {}),
  };
}

/**
 * Course par card entered as 18 par digits, e.g. "454354434 443535444" (9+9),
 * "454354434443535444", or "พาร์ 454354434 443535444". Each digit is a par (3-6).
 * @returns {{ok:true, holes, out, in, total} | {ok:false, reason:'count'|'range', ...}}
 */
export function parseParString(text) {
  const t = normalize(text).replace(/^(พาร์|par|สนาม|course)\s*[:：]?\s*/i, "");
  const digits = t.replace(/\D/g, "");
  if (digits.length !== 18) return { ok: false, reason: "count", count: digits.length };
  const pars = digits.split("").map(Number);
  if (pars.some((p) => p < 3 || p > 6)) return { ok: false, reason: "range", pars };
  const holes = pars.map((par, i) => ({ hole: i + 1, par }));
  const out = pars.slice(0, 9).reduce((a, b) => a + b, 0);
  const inn = pars.slice(9).reduce((a, b) => a + b, 0);
  return { ok: true, holes, out, in: inn, total: out + inn };
}

// Built-in courses: typing the name auto-loads the pars. Add more here.
const PRESET_COURSES = [
  { aliases: ["the pine", "thepine", "pine", "เดอะไพน์", "ไพน์"], pars: "445345434453443544" },
  { aliases: ["rachakram", "racha", "ราชาคราม", "ราชาคาม"], pars: "445344435435454434" },
];

/**
 * Look up a built-in course by (fuzzy) name. Returns the parsed par card plus a
 * canonical `preset` name, or null if the name isn't a known course.
 */
export function lookupPresetCourse(name) {
  const key = normalize(name).toLowerCase().replace(/\s+/g, "");
  if (key.length < 3) return null;
  // Match the whole name, or the alias as a leading run of WHOLE words
  // ("the pine golf club" -> the pine). A bare character-prefix match meant
  // "ไพน์เฮิร์สท" (Pinehurst — a different course) silently loaded The Pine's
  // card, and every stroke, net and baht for the round came off the wrong pars.
  const words = normalize(name).toLowerCase().split(/\s+/).filter(Boolean);
  for (const c of PRESET_COURSES) {
    const hit = c.aliases.some((a) => {
      const aw = a.toLowerCase().split(/\s+/).filter(Boolean);
      if (key === aw.join("")) return true;
      return words.length > aw.length && words.slice(0, aw.length).join(" ") === aw.join(" ");
    });
    if (hit) return { ...parseParString(c.pars), preset: c.aliases[0] };
  }
  return null;
}

/**
 * One player's full round in a single message: "แซม 544535445 445354454"
 * (name + 18 single-digit hole scores, optionally split 9+9). For holes scored
 * 10+, use the per-hole "หลุม …" command instead.
 * @returns {{ok:true, name, scores:number[]} | {ok:false, reason, ...}}
 */
export function parseBulkScores(text) {
  const t = normalize(text);
  const m = t.match(/^(\D\S*(?:\s+\D\S*)*)\s+([\d\s]+)$/);
  if (!m) return { ok: false, reason: "format" };
  const name = m[1];
  const digits = m[2].replace(/\D/g, "");
  if (digits.length !== 18) return { ok: false, reason: "count", name, count: digits.length };
  const scores = digits.split("").map(Number);
  if (scores.some((s) => s < 1 || s > 9)) return { ok: false, reason: "range", name };
  return { ok: true, name, scores };
}
