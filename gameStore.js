// gameStore.js
// In-memory room/game state. One game is bound to a LINE source (groupId in a
// group, or userId in a 1:1 chat) so members can just chat without re-typing the
// room code. This is a DEMO store — swap for a DB/backend in production.

import {
  generateRoomCode,
  calculateHandicap,
  classifyHandicapLevel,
  strokesForHole,
  computeNet,
  validateCourse,
} from "./engine.js";
import { saveSession, deleteSession, loadActiveSessions } from "./db.js";

// A game lives 12 hours from the moment it is created — NOT a rolling window.
// After that the room is dropped and the bot goes silent until someone types
// "สร้างเกม" / "สร้างเกมส์" to start a brand-new game.
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TURBO_HOLES = [9, 18]; // closing hole of each nine

export class GameStore {
  constructor() {
    this.rooms = new Map(); // room_code -> game
    this.activeBySource = new Map(); // sourceId (groupId/userId) -> room_code
    this._writes = new Map(); // sourceId -> promise chain (serializes DB writes)
  }

  /** Queue a DB write for a source. Writes for the same source_id run in the
   *  order they were issued, so an expiry DELETE can never land after the
   *  INSERT of the replacement game created in the same tick. */
  _queue(sourceId, fn, label) {
    if (!sourceId) return;
    const prev = this._writes.get(sourceId) || Promise.resolve();
    const next = prev
      .then(fn)
      .catch((e) => console.error(`[store] ${label} error:`, e.message));
    this._writes.set(sourceId, next);
    next.finally(() => {
      if (this._writes.get(sourceId) === next) this._writes.delete(sourceId);
    });
  }

  /** Persist game state to DB (no-op if DB disabled). */
  _persist(game) {
    if (!game?.source_id) return;
    const snapshot = JSON.parse(JSON.stringify(game)); // freeze current state
    this._queue(game.source_id, () => saveSession(game.source_id, snapshot), "persist");
  }

  /** Remove session from DB when a game ends or expires. */
  _persistDelete(sourceId) {
    this._queue(sourceId, () => deleteSession(sourceId), "delete");
  }

  /** Restore active sessions from DB into memory (call once at startup). */
  async loadFromDb() {
    const rows = await loadActiveSessions();
    let n = 0;
    for (const { sourceId, game } of rows) {
      if (!game?.room_code) continue;
      this.rooms.set(game.room_code, game);
      if (sourceId) this.activeBySource.set(sourceId, game.room_code);
      n++;
    }
    return n;
  }

  _newCode() {
    let code;
    let tries = 0;
    do {
      code = generateRoomCode();
    } while (this.rooms.has(code) && ++tries < 1000);
    return code;
  }

  _expired(game) {
    return Boolean(game && game.expires_at && Date.now() > game.expires_at);
  }

  _drop(game) {
    if (!game) return;
    this._persistDelete(game.source_id); // clean up expired session from DB
    this.rooms.delete(game.room_code);
    if (game.source_id && this.activeBySource.get(game.source_id) === game.room_code) {
      this.activeBySource.delete(game.source_id);
    }
  }

  /** Resolve the game for a room_code, falling back to the source's active room.
   *  Expired games are dropped. The 12h deadline is FIXED at creation time, so
   *  activity does NOT extend it. */
  _resolve(room_code, sourceId) {
    let game = null;
    if (room_code && this.rooms.has(room_code)) game = this.rooms.get(room_code);
    else if (sourceId && this.activeBySource.has(sourceId)) {
      game = this.rooms.get(this.activeBySource.get(sourceId)) || null;
    }
    if (this._expired(game)) {
      this._drop(game);
      return null;
    }
    return game;
  }

  getGame(room_code) {
    const game = this.rooms.get(room_code) || null;
    if (this._expired(game)) {
      this._drop(game);
      return null;
    }
    return game;
  }

  createGame(sourceId, { expected_players = null } = {}) {
    // "สร้างเกม" always starts from a clean slate — discard whatever this
    // source had before (finished, abandoned or expired).
    if (sourceId && this.activeBySource.has(sourceId)) {
      this._drop(this.rooms.get(this.activeBySource.get(sourceId)));
      this.activeBySource.delete(sourceId);
    }
    const room_code = this._newCode();
    const now = Date.now();
    const game = {
      room_code,
      source_id: sourceId || null,
      expected_players,
      status: "waiting_players",
      // --- game setup, collected via guided Q&A after "สร้างเกม" ---
      course_name: null,
      stake: null, // money per hole; RECORDED for backend, never settled here
      turbo: null, // boolean
      turbo_holes: [], // e.g. [9, 18] when turbo is on
      format: null, // "all_vs_all" | "head_tail"
      setup: "course", // pending step: course -> [confirm_course] -> stake -> turbo -> format -> done
      pending_course: null, // {holes,total} awaiting "ยืนยัน" when entered as name+par
      // --- play data ---
      course: null, // 18-hole par data
      players: [], // { name, scores, handicap_index }
      diff: null,
      handicap_level: null,
      rules: null,
      receivers: [],
      holes: {}, // holeNumber -> [{ name, gross, strokes?, net? }]
      current_hole: null, // the hole the round is waiting on (set when roster is full)
      created_at: now,
      expires_at: now + SESSION_TTL_MS,
    };
    this.rooms.set(room_code, game);
    if (sourceId) this.activeBySource.set(sourceId, room_code);
    this._persist(game);
    return game;
  }

  // ---- guided setup --------------------------------------------------------

  /** The active game for this source if it's still mid-setup, else null. */
  pendingSetup(sourceId) {
    const game = this._resolve(null, sourceId);
    return game && game.setup && game.setup !== "done" ? game : null;
  }

  /** The active (non-expired) game for this source, or null. */
  activeGame(sourceId) {
    return this._resolve(null, sourceId);
  }

  setCourseName(sourceId, name) {
    const game = this._resolve(null, sourceId);
    if (!game) return { ok: false, error: "no active game" };
    game.course_name = String(name || "").trim() || null;
    game.setup = "stake";
    this._persist(game);
    return { ok: true, game };
  }

  /** Course name not found — keep the name and wait for the user to type the pars. */
  awaitPars(sourceId, name) {
    const game = this._resolve(null, sourceId);
    if (!game) return { ok: false, error: "no active game" };
    game.course_name = String(name || "").trim() || null;
    game.setup = "await_pars";
    this._persist(game);
    return { ok: true, game };
  }

  /** Stash a name+par course awaiting the user's "ยืนยัน". */
  setPendingCourse(sourceId, name, holes, total) {
    const game = this._resolve(null, sourceId);
    if (!game) return { ok: false, error: "no active game" };
    game.course_name = String(name || "").trim() || null;
    game.pending_course = { holes, total };
    game.setup = "confirm_course";
    this._persist(game);
    return { ok: true, game };
  }

  /** Apply the pending course after confirmation, then move on to stake. */
  confirmCourse(sourceId) {
    const game = this._resolve(null, sourceId);
    if (!game || !game.pending_course) return { ok: false, error: "no pending course" };
    const { course } = validateCourse({ name: game.course_name, holes: game.pending_course.holes });
    game.course = course;
    const total = game.pending_course.total;
    game.pending_course = null;
    game.setup = "stake";
    if (game.rules) this._recomputeNets(game);
    this._persist(game);
    return { ok: true, game, total };
  }

  /** Discard the pending course and ask for the pars again (keep the name). */
  editCourse(sourceId) {
    const game = this._resolve(null, sourceId);
    if (!game) return { ok: false, error: "no active game" };
    game.pending_course = null;
    game.setup = "await_pars";
    this._persist(game);
    return { ok: true, game };
  }

  setStake(sourceId, stake) {
    const game = this._resolve(null, sourceId);
    if (!game) return { ok: false, error: "no active game" };
    game.stake = Number(stake);
    game.setup = "turbo";
    this._persist(game);
    return { ok: true, game };
  }

  setTurbo(sourceId, on) {
    const game = this._resolve(null, sourceId);
    if (!game) return { ok: false, error: "no active game" };
    game.turbo = Boolean(on);
    game.turbo_holes = on ? [...TURBO_HOLES] : [];
    game.setup = "format"; // advance to กติกา selection
    this._persist(game);
    return { ok: true, game };
  }

  setFormat(sourceId, format) {
    const game = this._resolve(null, sourceId);
    if (!game) return { ok: false, error: "no active game" };
    game.format = format; // "all_vs_all" | "head_tail"
    game.setup = "done";
    this._persist(game);
    return { ok: true, game };
  }

  /** End the setup Q&A early (e.g. when real gameplay begins). */
  finishSetup(sourceId) {
    const game = this._resolve(null, sourceId);
    if (game) {
      game.setup = "done";
      this._persist(game);
    }
    return game;
  }

  cancelGame(sourceId) {
    const game = this._resolve(null, sourceId);
    if (!game) return false;
    this._persistDelete(game.source_id); // explicit delete (not via _drop to avoid double-call)
    this.rooms.delete(game.room_code);
    if (game.source_id && this.activeBySource.get(game.source_id) === game.room_code) {
      this.activeBySource.delete(game.source_id);
    }
    return true;
  }

  // ---- course / roster / scoring ------------------------------------------

  setCourse(room_code, sourceId, courseInput) {
    const game = this._resolve(room_code, sourceId);
    if (!game) return { ok: false, error: "no active game" };
    const { valid, errors, course } = validateCourse(courseInput);
    game.course = course;
    // Retroactively compute net for holes recorded before the course was set.
    if (valid && game.rules) this._recomputeNets(game);
    this._persist(game);
    return { ok: valid, errors, game };
  }

  join(sourceId, { room_code, player, scores }) {
    const game = this._resolve(room_code, sourceId);
    if (!game) return { ok: false, error: "room_not_found" };
    const cleanName = typeof player === "string" ? player.trim() : player;
    if (!cleanName || !Array.isArray(scores) || scores.length !== 3) {
      return { ok: false, error: "need_name_and_3_scores", game };
    }
    const player_ = cleanName;
    const h = calculateHandicap(scores);
    const existing = game.players.find((p) => p.name === player_);
    if (existing) {
      existing.scores = scores.slice(-3);
      existing.handicap_index = h.handicap_index;
    } else {
      game.players.push({
        name: player_,
        scores: scores.slice(-3),
        handicap_index: h.handicap_index,
      });
    }
    if (sourceId) this.activeBySource.set(sourceId, game.room_code);
    this._recompute(game);
    this._persist(game);
    return { ok: true, game, handicap_index: h.handicap_index };
  }

  /** Recompute diff, level, rules, receivers and status after a roster change. */
  _recompute(game) {
    if (game.players.length === 0) return;
    const indices = game.players.map((p) => p.handicap_index);
    const best = Math.min(...indices);
    game.diff = Math.max(...indices) - best;
    const { handicap_level, rules } = classifyHandicapLevel(game.diff);
    game.handicap_level = handicap_level;
    game.rules = rules;
    // DEMO stroke allocation: the lowest-handicap player gives; everyone else
    // receives strokes per the rules table. Adjust to your real game logic.
    game.receivers = game.players
      .filter((p) => p.handicap_index > best)
      .map((p) => p.name);
    // Auto-ready: use expected count when given; otherwise treat 2+ players as full.
    const cap = game.expected_players;
    if ((cap ? game.players.length >= cap : game.players.length >= 2) &&
        game.status === "waiting_players") {
      game.status = "ready";
    }
    // Retroactively recompute net for already-recorded holes when the handicap
    // rules or receiver list changes (e.g. a new player joins and shifts the diff).
    if (game.course) this._recomputeNets(game);
  }

  /** Recompute strokes/net for every already-recorded hole row using the current
   *  course par + handicap rules. Called after rules or course change mid-game. */
  _recomputeNets(game) {
    if (!game.course || !game.rules) return;
    const recv = new Set(game.receivers || []);
    for (const [holeNum, rows] of Object.entries(game.holes)) {
      const par = game.course.holes.find((h) => Number(h.hole) === Number(holeNum))?.par ?? null;
      if (par == null) continue;
      for (const row of rows) {
        if (row.give_up || row.gross == null) continue;
        const strokes = recv.has(row.name) ? strokesForHole(par, game.rules) : 0;
        row.strokes = strokes;
        row.net = computeNet(row.gross, strokes);
      }
    }
  }

  /** Record a hole, UPSERTING the submitted players (so each person can send
   *  their own score separately). Net is computed when course (par) + rules exist. */
  recordHole(sourceId, { room_code, hole, players }) {
    const game = this._resolve(room_code, sourceId);
    if (!game) return { ok: false, error: "room_not_found" };
    if (hole == null) return { ok: false, error: "no_hole_number", game };

    const par = game.course
      ? game.course.holes.find((h) => Number(h.hole) === Number(hole))?.par ?? null
      : null;
    const rules = game.rules;
    const recv = new Set(game.receivers || []);
    const canNet = Boolean(rules && par != null);
    const arr = game.holes[hole] || (game.holes[hole] = []);

    for (const p of players) {
      const row = { name: p.name };
      if (p.give_up) {
        row.give_up = true;
        row.gross = null;
      } else {
        row.gross = p.gross;
        if (canNet) {
          const strokes = recv.has(p.name) ? strokesForHole(par, rules) : 0;
          row.strokes = strokes;
          row.net = computeNet(p.gross, strokes);
        }
      }
      const idx = arr.findIndex((r) => r.name === p.name);
      if (idx >= 0) arr[idx] = row;
      else arr.push(row);
    }

    if (game.status === "ready") game.status = "in_progress";
    this._persist(game);
    return { ok: true, game, par, net_computed: canNet, hole: Number(hole) };
  }

  /** Record ALL 18 holes for one player at once (upserts that player per hole). */
  recordBulk(sourceId, name, scores) {
    const game = this._resolve(null, sourceId);
    if (!game) return { ok: false, error: "room_not_found" };
    if (!Array.isArray(scores) || scores.length !== 18) {
      return { ok: false, error: "need_18", game };
    }
    const rules = game.rules;
    const recv = new Set(game.receivers || []);
    for (let i = 0; i < 18; i++) {
      const hole = i + 1;
      const gross = scores[i];
      const par = game.course
        ? game.course.holes.find((h) => Number(h.hole) === hole)?.par ?? null
        : null;
      const row = { name, gross };
      if (rules && par != null) {
        const strokes = recv.has(name) ? strokesForHole(par, rules) : 0;
        row.strokes = strokes;
        row.net = computeNet(gross, strokes);
      }
      const arr = game.holes[hole] || (game.holes[hole] = []);
      const idx = arr.findIndex((r) => r.name === name);
      if (idx >= 0) arr[idx] = row;
      else arr.push(row);
    }
    if (game.status === "ready") game.status = "in_progress";
    this._persist(game);
    return { ok: true, game, name };
  }
}
