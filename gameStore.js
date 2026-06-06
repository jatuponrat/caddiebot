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

export class GameStore {
  constructor() {
    this.rooms = new Map(); // room_code -> game
    this.activeBySource = new Map(); // sourceId (groupId/userId) -> room_code
  }

  _newCode() {
    let code;
    let tries = 0;
    do {
      code = generateRoomCode();
    } while (this.rooms.has(code) && ++tries < 1000);
    return code;
  }

  /** Resolve the game for a room_code, falling back to the source's active room. */
  _resolve(room_code, sourceId) {
    if (room_code && this.rooms.has(room_code)) return this.rooms.get(room_code);
    if (sourceId && this.activeBySource.has(sourceId)) {
      return this.rooms.get(this.activeBySource.get(sourceId)) || null;
    }
    return null;
  }

  getGame(room_code) {
    return this.rooms.get(room_code) || null;
  }

  createGame(sourceId, { expected_players = null } = {}) {
    const room_code = this._newCode();
    const game = {
      room_code,
      source_id: sourceId || null,
      expected_players,
      status: "waiting_players",
      course: null,
      players: [], // { name, scores, handicap_index }
      diff: null,
      handicap_level: null,
      rules: null,
      receivers: [], // names that receive strokes (demo rule, see _recompute)
      holes: {}, // holeNumber -> [{ name, gross, strokes?, net? }]
      created_at: Date.now(),
    };
    this.rooms.set(room_code, game);
    if (sourceId) this.activeBySource.set(sourceId, room_code);
    return game;
  }

  setCourse(room_code, sourceId, courseInput) {
    const game = this._resolve(room_code, sourceId);
    if (!game) return { ok: false, error: "no active game" };
    const { valid, errors, course } = validateCourse(courseInput);
    game.course = course;
    return { ok: valid, errors, game };
  }

  join(sourceId, { room_code, player, scores }) {
    const game = this._resolve(room_code, sourceId);
    if (!game) return { ok: false, error: "room_not_found" };
    if (!player || !Array.isArray(scores) || scores.length !== 3) {
      return { ok: false, error: "need_name_and_3_scores", game };
    }
    const h = calculateHandicap(scores);
    const existing = game.players.find((p) => p.name === player);
    if (existing) {
      existing.scores = scores.slice(-3);
      existing.handicap_index = h.handicap_index;
    } else {
      game.players.push({
        name: player,
        scores: scores.slice(-3),
        handicap_index: h.handicap_index,
      });
    }
    if (sourceId) this.activeBySource.set(sourceId, game.room_code);
    this._recompute(game);
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
    if (game.expected_players && game.players.length >= game.expected_players) {
      if (game.status === "waiting_players") game.status = "ready";
    }
  }

  /** Record one hole. Net is computed only when the course (par) + rules exist. */
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

    const rows = players.map((p) => {
      const row = { name: p.name, gross: p.gross };
      if (canNet) {
        const strokes = recv.has(p.name) ? strokesForHole(par, rules) : 0;
        row.strokes = strokes;
        row.net = computeNet(p.gross, strokes);
      }
      return row;
    });

    game.holes[hole] = rows;
    if (game.status === "ready") game.status = "in_progress";
    return { ok: true, game, par, net_computed: canNet, players: rows };
  }
}
