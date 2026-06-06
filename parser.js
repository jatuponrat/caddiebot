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
 * @returns {'course_json'|'create_game'|'join'|'hole_scores'|'unknown'}
 */
export function detectIntent(text) {
  const raw = String(text ?? "");
  if (/^\s*[\[{]/.test(raw)) return "course_json"; // pasted JSON course
  const t = normalize(raw);
  if (/(สร้างเกม|สร้าง\s*เกม|create\s*game|new\s*game)/i.test(t)) return "create_game";
  if (/(เข้าร่วม|join)/i.test(t)) return "join";
  if (/(หลุม|hole|รู)\s*\d/i.test(t)) return "hole_scores";
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
 * "เข้าร่วม 4821 ชื่อ A 92,95,90" / "join 4821 name A 92 95 90"
 * @returns {{action, room_code, player, scores:number[]}}
 */
export function parseJoin(text) {
  const t = normalize(text);
  const room = (t.match(/\b(\d{4})\b/) || [])[1] || null;
  const rest = room ? t.replace(room, " ") : t; // don't mistake room code for a score
  const nameMatch = rest.match(/(?:ชื่อ|name|player)\s*[:：]?\s*([^\s,0-9]+)/i);
  const player = nameMatch ? nameMatch[1] : null;
  const scores = (rest.match(/\d{2,3}/g) || []).map(Number).slice(0, 3);
  return { action: "join", room_code: room, player, scores };
}

/**
 * "หลุม 1 A 5 B 6 C 5 D 7" (also multi-line, also Thai names).
 * @returns {{action, hole, players:{name,gross}[]}}
 */
export function parseHoleScores(text) {
  const t = normalize(text);
  const holeMatch = t.match(/(?:หลุม|hole|รู)\s*[:：]?\s*(\d{1,2})/i);
  const hole = holeMatch ? Number(holeMatch[1]) : null;
  const rest = holeMatch ? t.replace(holeMatch[0], " ") : t;

  const players = [];
  const re = /([A-Za-z฀-๿][A-Za-z0-9฀-๿]*)\s*[:：]?\s*(\d{1,2})\b/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    players.push({ name: m[1], gross: Number(m[2]) });
  }
  return { action: "hole_scores", hole, players };
}
