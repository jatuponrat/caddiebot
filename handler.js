// handler.js
// Turns one incoming message into the standard backend JSON envelope (spec: OUTPUT FORMAT STANDARD).
// Pure & synchronous — no LINE/IO here, so it is trivially testable.

import {
  generateRoomCode,
  calculateHandicap,
  buildGameStructure,
  classifyHandicapLevel,
  strokesForHole,
  computeNet,
  validateCourse,
} from "./engine.js";
import {
  detectIntent,
  parseCreateGame,
  parseJoin,
  parseHoleScores,
} from "./parser.js";

/** The canonical empty envelope every response is built from (spec BONUS format). */
export function emptyEnvelope() {
  return {
    action: null,
    room_code: null,
    course: null,
    players: [],
    handicap_level: null,
    rules: null,
    hole: null,
    scores: [],
    summary: {},
  };
}

/** Look up the par for a hole from a course object, if available. */
function parForHole(course, hole) {
  if (!course || !Array.isArray(course.holes) || !hole) return null;
  const found = course.holes.find((h) => Number(h.hole) === Number(hole));
  return found ? Number(found.par) : null;
}

/**
 * Main entry point.
 * @param {string} text - raw user message
 * @param {object} ctx  - optional game context:
 *   { course, rules, handicap_level, receivers:string[], strokesByPlayer:{name:strokes} }
 * @returns standard envelope
 */
export function handleMessage(text, ctx = {}) {
  const intent = detectIntent(text);
  switch (intent) {
    case "course_json":
      return handleCourse(text);
    case "create_game":
      return handleCreateGame(text);
    case "join":
      return handleJoin(text);
    case "hole_scores":
      return handleHoleScores(text, ctx);
    default:
      return {
        ...emptyEnvelope(),
        action: "unknown",
        summary: { ok: false, message: "Could not classify message", input: text },
      };
  }
}

export function handleCourse(text) {
  const env = emptyEnvelope();
  env.action = "extract_course";
  let parsed;
  try {
    parsed = typeof text === "object" ? text : JSON.parse(text);
  } catch {
    env.summary = { ok: false, message: "Invalid course JSON" };
    return env;
  }
  const courseInput = parsed.course ?? parsed;
  const { valid, errors, course } = validateCourse(courseInput);
  env.course = course;
  env.summary = { ok: valid, errors, total_par: course?.total_par };
  return env;
}

export function handleCreateGame(text) {
  const { expected_players } = parseCreateGame(text);
  const env = emptyEnvelope();
  env.action = "create_game";
  env.room_code = generateRoomCode(); // backend validates uniqueness
  env.summary = {
    ok: true,
    status: "waiting_players",
    expected_players,
    message: "Room created. Backend must confirm code is unique.",
  };
  return env;
}

export function handleJoin(text) {
  const { room_code, player, scores } = parseJoin(text);
  const env = emptyEnvelope();
  env.action = "join";
  env.room_code = room_code;
  env.scores = scores;
  const ok = Boolean(room_code && player && scores.length === 3);
  let handicap = null;
  if (scores.length === 3) {
    const h = calculateHandicap(scores);
    handicap = h.handicap_index;
    env.players = [
      { name: player, scores, avg_score: h.avg_score, handicap_index: h.handicap_index },
    ];
  } else if (player) {
    env.players = [{ name: player, scores }];
  }
  env.summary = {
    ok,
    player,
    handicap_index: handicap,
    message: ok
      ? "Player joined."
      : "Need room_code, name, and exactly 3 scores.",
  };
  return env;
}

export function handleHoleScores(text, ctx = {}) {
  const { hole, players } = parseHoleScores(text);
  const env = emptyEnvelope();
  env.action = "hole_scores";
  env.hole = hole;

  const par = ctx.par ?? parForHole(ctx.course, hole);
  const rules = ctx.rules ?? null;
  const receivers = new Set(ctx.receivers ?? []);
  const strokesByPlayer = ctx.strokesByPlayer ?? null;

  // Net is ONLY a suggestion and ONLY when handicap context exists (spec rule #6).
  const canNet = Boolean(strokesByPlayer || (par != null && rules));

  env.players = players.map((p) => {
    const row = { name: p.name, gross: p.gross };
    if (canNet) {
      let strokes = 0;
      if (strokesByPlayer && strokesByPlayer[p.name] != null) {
        strokes = Number(strokesByPlayer[p.name]);
      } else if (par != null && rules && receivers.has(p.name)) {
        strokes = strokesForHole(par, rules);
      }
      row.strokes = strokes;
      row.net = computeNet(p.gross, strokes);
    }
    return row;
  });

  env.summary = {
    ok: hole != null && players.length > 0,
    hole,
    par,
    net_computed: canNet,
    note: "Money settlement is NOT finalized here (backend only).",
  };
  return env;
}

// Re-export for callers that want the whole-game structuring helper.
export { buildGameStructure, classifyHandicapLevel };
