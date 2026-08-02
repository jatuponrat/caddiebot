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

/**
 * Decide what kind of message this is.
 * @returns {'course_json'|'create_game'|'join'|'hole_scores'|'par_string'|'bulk_scores'|'settle'|'end_game'|'handicap'|'unknown'}
 */
export function detectIntent(text) {
  const raw = String(text ?? "");
  if (/^\s*[\[{]/.test(raw)) return "course_json"; // pasted JSON course
  const t = normalize(raw);
  if (/(จบเกม|จบ\s*เกม|end\s*game)/i.test(t)) return "end_game";
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
  if (/(เข้าร่วม|join)/i.test(t)) return "join";
  if (/(หลุม|hole|รู)\s*\d/i.test(t) || /^h\s*\d{1,2}\b/i.test(t)) return "hole_scores";
  // Course par card: "454354434 443535444" (9+9), 18 contiguous digits, or "พาร์ ...".
  const noKw = t.replace(/^(พาร์|par|สนาม|course)\s*[:：]?\s*/i, "");
  const compact = noKw.replace(/\s+/g, "");
  if (noKw.length !== t.length && /\d/.test(compact)) return "par_string"; // explicit keyword
  if (/^\d{16,20}$/.test(compact)) return "par_string"; // bare ~18-digit par card
  // Bulk per-player card: "แซม 544535445 445354454" (name + 18 single-digit holes).
  if (/^\S+\s+\d{9}\s+\d{9}$/.test(t) || /^\S+\s+\d{18}$/.test(t)) return "bulk_scores";
  // Fallback: a 4-digit code plus several scores reads like a join.
  if (/\b\d{4}\b/.test(t) && (t.match(/\d{2,3}/g) || []).length >= 4) return "join";
  return "unknown";
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
export function parseJoin(text) {
  const t = normalize(text);
  const room = (t.match(/\b(\d{4})\b/) || [])[1] || null;
  let rest = room ? t.replace(room, " ") : t; // don't mistake room code for a score
  rest = rest.replace(/^.*?(เข้าร่วม|join)\s*/i, ""); // drop the command word
  // Name: prefer an explicit "ชื่อ/name" keyword, else the first non-number word.
  const kw = rest.match(/(?:ชื่อ|name|player)\s*[:：]?\s*([^\s,0-9]+)/i);
  const bare = rest.match(/([^\s,0-9][^\s,]*)/);
  const player = kw ? kw[1] : bare ? bare[1] : null;
  const scores = (rest.match(/\d{2,3}/g) || []).map(Number).slice(0, 3);
  return { action: "join", room_code: room, player, scores };
}

/**
 * "หลุม 1 A 5 B 6 C 5 D 7" (also multi-line, also Thai names).
 * @returns {{action, hole, players:{name,gross}[]}}
 */
export function parseHoleScores(text) {
  const t = normalize(text);
  const holeMatch = t.match(/(?:หลุม|hole|รู|\bh)\s*[:：]?\s*(\d{1,2})/i);
  const hole = holeMatch ? Number(holeMatch[1]) : null;
  const rest = holeMatch ? t.replace(holeMatch[0], " ") : t;

  const players = [];
  // value is a 1-2 digit score OR "g"/"G" = give up (แพ้หลุมนั้น)
  const re = /([A-Za-z฀-๿][A-Za-z0-9฀-๿]*)\s*[:：]?\s*(\d{1,2}|[gG])\b/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    if (/^[gG]$/.test(m[2])) players.push({ name: m[1], gross: null, give_up: true });
    else players.push({ name: m[1], gross: Number(m[2]) });
  }
  return { action: "hole_scores", hole, players };
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
  for (const c of PRESET_COURSES) {
    const hit = c.aliases.some((a) => {
      const aa = a.toLowerCase().replace(/\s+/g, "");
      return aa.length >= 3 && (key === aa || key.startsWith(aa));
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
  const m = t.match(/^(\S+)\s+([\d\s]+)$/);
  if (!m) return { ok: false, reason: "format" };
  const name = m[1];
  const digits = m[2].replace(/\D/g, "");
  if (digits.length !== 18) return { ok: false, reason: "count", name, count: digits.length };
  const scores = digits.split("").map(Number);
  if (scores.some((s) => s < 1 || s > 9)) return { ok: false, reason: "range", name };
  return { ok: true, name, scores };
}
