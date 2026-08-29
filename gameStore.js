// gameStore.js
// In-memory room/game state. One game is bound to a LINE source (groupId in a
// group, or userId in a 1:1 chat) so members can just chat without re-typing the
// room code. This is a DEMO store — swap for a DB/backend in production.

import {
  generateRoomCode,
  dateKeyDDMMYY,
  buildRoomCode,
  parseRoomCode,
  calculateHandicap,
  classifyHandicapLevel,
  strokesForHole,
  buildStrokeMatrix,
  matrixForHole,
  strokesBetween,
  computeNet,
  validateCourse,
  settleGame,
} from "./engine.js";
import { isValidHoleNumber } from "./parser.js";
import {
  saveSession,
  deleteSession,
  loadActiveSessions,
  loadSessionAny,
  saveRound,
  maxRoomSeqForDay,
  takeExpiredSessions,
  deleteExpiredSession,
} from "./db.js";

// ROLLING 12-hour window: a game stays alive for 12 hours after the LAST
// activity (setup answer, join, hole score, settle...). Every action pushes the
// deadline out, so a round can never expire while people are still playing —
// only 12 hours of complete silence kills it. After that the room is dropped
// and the bot ignores everything until someone types "สร้างเกม" / "สร้างเกมส์".
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TURBO_HOLES = [9, 18]; // closing hole of each nine

export class GameStore {
  constructor() {
    this.rooms = new Map(); // room_code -> game
    this.activeBySource = new Map(); // sourceId (groupId/userId) -> room_code
    this._writes = new Map(); // sourceId -> promise chain (serializes DB writes)
    this._seq = new Map(); // "160826" -> highest running number handed out that day
    this._restores = new Map(); // sourceId -> in-flight restoreSource promise
    this._awaitCount = new Map(); // sourceId -> deadline for "กี่คนครับ?" 
  }

  /**
   * Seed today's running number from the database so a restart doesn't reissue
   * codes that already exist. Called once at boot (server.js), and again lazily
   * the first time a new day is seen. Safe to call with the DB disabled.
   */
  async seedRoomSeq(dateKey = dateKeyDDMMYY()) {
    const n = await maxRoomSeqForDay(dateKey).catch(() => 0);
    const current = this._seq.get(dateKey) || 0;
    if (n > current) this._seq.set(dateKey, n);
    return this._seq.get(dateKey) || 0;
  }

  /** Highest running number this process knows about for a day (live + seeded). */
  _highestSeq(dateKey) {
    let max = this._seq.get(dateKey) || 0;
    for (const code of this.rooms.keys()) {
      const p = parseRoomCode(code);
      if (p && p.dateKey === dateKey && p.seq > max) max = p.seq;
    }
    return max;
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

  /** Persist game state to DB (no-op if DB disabled). Every persist is a real
   *  game action (setup answer, join, score, edit), so this is also where the
   *  rolling TTL is renewed — plain group chatter never gets here and therefore
   *  never extends the deadline. */
  _persist(game) {
    this.touch(game);
    if (!game?.source_id) return;
    const snapshot = JSON.parse(JSON.stringify(game)); // freeze current state
    this._queue(game.source_id, () => saveSession(game.source_id, snapshot), "persist");
  }

  /** Remove session from DB when a game ends or expires. */
  _persistDelete(sourceId) {
    this._queue(sourceId, () => deleteSession(sourceId), "delete");
  }

  /** Delete ONLY if the stored row is still expired. A plain DELETE here could
   *  wipe a game created after the sweep's query ran; this one cannot. */
  _persistDeleteExpired(sourceId) {
    this._queue(sourceId, () => deleteExpiredSession(sourceId), "delete-expired");
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

  /**
   * Next room code: DDMMYY (Bangkok) + a 3-digit running number for that day,
   * e.g. "160826001". Falls back to the legacy random 4-digit code only if a
   * day somehow overflows 999 rounds.
   */
  _newCode() {
    const dateKey = dateKeyDDMMYY();
    let seq = this._highestSeq(dateKey) + 1;
    while (seq <= 999) {
      const code = buildRoomCode(dateKey, seq);
      if (!this.rooms.has(code)) {
        this._seq.set(dateKey, seq);
        return code;
      }
      seq++;
    }
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

  /**
   * Write a round into the permanent `rounds` history. Idempotent — the row is
   * keyed on the room code, so settling twice (or settling and then ending)
   * updates the same row instead of duplicating it.
   *
   * Called on EVERY path that destroys a game: "จบเกม", "รวม 18", the 12h
   * expiry, and "สร้างเกม" overwriting an abandoned round. Before this, a group
   * that simply stopped typing lost the round entirely.
   *
   * @param {object} game
   * @param {"ended"|"settled"|"expired"|"replaced"} reason
   */
  archiveGame(game, reason = "ended") {
    if (!game?.room_code) return null;
    // Nothing was played — an abandoned setup is not worth a history row.
    if (!game.holes || Object.keys(game.holes).length === 0) return null;
    const s = settleGame(game);
    const round = {
      archive_key: game.room_code,
      room_code: game.room_code,
      source_id: game.source_id ?? null,
      course_name: game.course_name ?? null,
      stake: game.stake ?? null,
      turbo: game.turbo ?? null,
      format: game.format ?? null,
      ended_reason: reason,
      players: game.players ?? [],
      holes: game.holes ?? {},
      course: game.course ?? null,
      settlement: s.perPlayer,
      holes_counted: s.holesCounted,
      created_at_ms: game.created_at ?? null,
    };
    game.archived_reason = reason;
    // Fire-and-forget on the source's write queue so it can never race the
    // session DELETE that follows.
    if (game.source_id) this._queue(game.source_id, () => saveRound(round), "archive");
    else saveRound(round).catch((e) => console.error("[store] archive error:", e.message));
    return round;
  }

  /**
   * Archive + delete every session whose 12h window has already elapsed.
   * Games that expire while the bot is idle are never touched by the in-memory
   * expiry checks (nothing is in memory), so without this sweep they would be
   * deleted by nothing and simply linger, then vanish on the next restart.
   * Run at boot and on a timer from server.js.
   */
  async sweepExpired() {
    let n = 0;
    // takeExpiredSessions() is capped (LIMIT 50). A single pass left the rest
    // unarchived until the next timer 30 minutes later — and anything the group
    // touched in between was lost. Keep going until the query comes back empty.
    for (let pass = 0; pass < 200; pass++) {
      const rows = await takeExpiredSessions().catch(() => []);
      if (!rows.length) break;
      let archivedThisPass = 0;
      for (const row of rows) if (this._sweepRow(row)) archivedThisPass++;
      n += archivedThisPass;
      // Rows we deliberately skipped (a source that is live again) come back
      // every pass; stop instead of spinning on them.
      if (archivedThisPass === 0) break;
    }
    return n;
  }

  /**
   * Retire ONE expired session. Split out from sweepExpired so the ordering
   * hazard below is testable.
   *
   * The query in sweepExpired takes real time, and a group can type "สร้างเกม"
   * in that window. If we blindly cleaned up every row the query returned, the
   * sweep would delete the session row and the in-memory mapping of the BRAND
   * NEW game — the bot would go silent immediately after being woken up, which
   * looks exactly like the timeout bug this feature exists to prevent. So a
   * source that is live again is left completely alone: createGame already
   * archived the old round as "replaced" and overwrote its row.
   *
   * @returns {boolean} true if this row was archived
   */
  _sweepRow({ sourceId, game }) {
    if (!game?.room_code) {
      if (sourceId) this._persistDeleteExpired(sourceId);
      return false;
    }
    const liveCode = sourceId ? this.activeBySource.get(sourceId) : null;
    if (liveCode && liveCode !== game.room_code) {
      // The source is live again on a DIFFERENT room. We must not touch the new
      // game's row or mapping — but the OLD round still deserves its history.
      // (It used to be dropped on the assumption createGame had archived it;
      // that only holds when the old game was in memory, which it is not after
      // the instance sleeps — so a whole round vanished.) archive_key is the old
      // room code, so this can never collide with the new round.
      this.archiveGame({ ...game, source_id: game.source_id || sourceId }, "expired");
      this.rooms.delete(game.room_code);
      return true;
    }

    this.archiveGame({ ...game, source_id: game.source_id || sourceId }, "expired");
    if (sourceId) this._persistDeleteExpired(sourceId);
    this.rooms.delete(game.room_code);
    if (sourceId && this.activeBySource.get(sourceId) === game.room_code) {
      this.activeBySource.delete(sourceId);
    }
    return true;
  }

  _drop(game, reason = "expired") {
    if (!game) return;
    this.archiveGame(game, reason); // save history BEFORE the state is thrown away
    this._persistDelete(game.source_id); // clean up expired session from DB
    this.rooms.delete(game.room_code);
    if (game.source_id && this.activeBySource.get(game.source_id) === game.room_code) {
      this.activeBySource.delete(game.source_id);
    }
  }

  /** Rolling TTL: a real game action pushes the deadline to 12h from NOW.
   *  Field-only — the caller (_persist) does the DB write, so this can never
   *  recurse. Idle chatter does NOT come through here on purpose: golf groups
   *  keep talking for days after a round and a stale game must still die. */
  touch(game) {
    if (!game) return game;
    const now = Date.now();
    game.expires_at = now + SESSION_TTL_MS;
    game.last_active_at = now;
    return game;
  }

  /** Resolve the game for a room_code, falling back to the source's active room.
   *  Expired games are dropped. Reading alone does NOT renew the TTL. */
  _resolve(room_code, sourceId) {
    let game = null;
    if (room_code && this.rooms.has(room_code)) {
      const candidate = this.rooms.get(room_code);
      // A room belongs to the LINE source that created it. Typing another
      // group's code used to add the player to THAT group's roster and then
      // repoint this group at the other room, stranding its own round.
      if (candidate?.source_id && sourceId && candidate.source_id !== sourceId) return null;
      game = candidate;
    } else if (sourceId && this.activeBySource.has(sourceId)) {
      game = this.rooms.get(this.activeBySource.get(sourceId)) || null;
    }
    if (this._expired(game)) {
      this._drop(game);
      return null;
    }
    return game;
  }

  /** Re-hydrate ONE source's game from the DB (used when the in-memory cache is
   *  cold — e.g. Render restarted or the free instance was spun down mid-round).
   *  Returns the live game, or null if there is none / it expired. */
  async restoreSource(sourceId) {
    if (!sourceId) return null;
    if (this.activeBySource.has(sourceId)) return this._resolve(null, sourceId);
    // Two LINE events for the same group arrive as separate concurrent requests.
    // Without this, each one loaded its OWN copy of the game and the second
    // _persist overwrote the first — a whole hole silently disappeared.
    const inFlight = this._restores.get(sourceId);
    if (inFlight) return inFlight;
    const promise = this._restoreSourceOnce(sourceId).finally(() => {
      if (this._restores.get(sourceId) === promise) this._restores.delete(sourceId);
    });
    this._restores.set(sourceId, promise);
    return promise;
  }

  async _restoreSourceOnce(sourceId) {
    if (this.activeBySource.has(sourceId)) return this._resolve(null, sourceId);
    // Deliberately loads EXPIRED rows too — see below; loadSession() would hide
    // exactly the round that still needs archiving.
    const row = await loadSessionAny(sourceId);
    const game = row?.game ?? null;
    if (!game?.room_code) return null;
    const rowExpired = row.expiresAt ? new Date(row.expiresAt).getTime() <= Date.now() : false;
    if (this._expired(game) || rowExpired) {
      // The 12h window elapsed while the bot was asleep. This is the ONLY
      // moment the round is in memory, so archive it here — deleting the row
      // first (as this used to) meant the round was never written to history
      // at all, which on a sleepy free instance is the normal case.
      game.source_id = game.source_id || sourceId;
      this.archiveGame(game, "expired");
      this._persistDeleteExpired(sourceId);
      return null;
    }
    game.source_id = game.source_id || sourceId;
    this.rooms.set(game.room_code, game);
    this.activeBySource.set(sourceId, game.room_code);
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

  /** Force a state save. session.js mutates game objects directly (current_hole,
   *  pending_override); without this those edits vanish on restart. */
  save(game) {
    this._persist(game);
    return game;
  }

  createGame(sourceId, { expected_players = null } = {}) {
    // "สร้างเกม" always starts from a clean slate — discard whatever this
    // source had before (finished, abandoned or expired).
    if (sourceId && this.activeBySource.has(sourceId)) {
      this._drop(this.rooms.get(this.activeBySource.get(sourceId)), "replaced");
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
      stroke_matrix: null, // matrix[receiver][giver] -> handicap gap for that pair
      front_matrix: null, // frozen copy used by holes 1-9 after a back-9 re-handicap
      front_reference_player: null,
      back9_handicap: false, // true once the back nine runs on fresh handicaps
      reference_player: null, // strongest player; scorecard net is shown vs them
      holes: {}, // holeNumber -> [{ name, gross, strokes?, net? }]
      current_hole: null, // the hole the round is waiting on (set when roster is full)
      awaiting_handicap_ack: false, // true right after "แต้มต่อ" prints the table
      created_at: now,
      last_active_at: now,
      expires_at: now + SESSION_TTL_MS, // rolling: renewed on every action
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

  /** "สร้างเกม" with no player count: remember that the bot asked, so the
   *  answer is not swallowed by the idle rule (there is no game yet). */
  awaitPlayerCount(sourceId) {
    if (!sourceId) return;
    this._awaitCount.set(sourceId, Date.now() + 10 * 60 * 1000);
  }

  awaitingPlayerCount(sourceId) {
    const until = sourceId ? this._awaitCount.get(sourceId) : null;
    if (!until) return false;
    if (Date.now() > until) {
      this._awaitCount.delete(sourceId);
      return false;
    }
    return true;
  }

  clearPlayerCountWait(sourceId) {
    if (sourceId) this._awaitCount.delete(sourceId);
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

  cancelGame(sourceId, reason = "ended") {
    const game = this._resolve(null, sourceId);
    if (!game) return false;
    if (game.archived_reason !== reason) this.archiveGame(game, reason);
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
    // Only a VALID card is stored. It used to be assigned before this check, so
    // a card the bot rejected out loud ("ข้อมูลสนามไม่ครบ 18 หลุม") was still in
    // play: its missing holes had no par, so they settled for nothing while
    // still counting towards the round.
    if (!valid) return { ok: false, errors, game };
    game.course = course;
    // Retroactively compute net for holes recorded before the course was set.
    if (game.rules) this._recomputeNets(game);
    this._persist(game);
    return { ok: valid, errors, game };
  }

  join(sourceId, { room_code, player, scores }) {
    const game = this._resolve(room_code, sourceId);
    // A code that resolves to a DIFFERENT room than the one typed means the code
    // does not exist — _resolve fell back to this source's active room. Joining
    // that silently put the player in a room nobody asked for.
    if (room_code && game && game.room_code !== room_code) {
      return { ok: false, error: "room_not_found" };
    }
    if (!game) {
      // Distinguish "no such room" from "that room is another group's".
      if (room_code && this.rooms.has(room_code)) {
        const other = this.rooms.get(room_code);
        if (other?.source_id && other.source_id !== sourceId) {
          return { ok: false, error: "room_other_source" };
        }
      }
      return { ok: false, error: "room_not_found" };
    }
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
    return { ok: true, game, handicap_index: h.handicap_index, player_name: player_ };
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
    // Stroke allocation is PER PAIR: every pairing is classified on its own
    // handicap gap (see engine.buildStrokeMatrix). This is what settlement uses.
    game.stroke_matrix = buildStrokeMatrix(game.players);
    // Scorecard net is shown against the strongest player in the group — one
    // row of the matrix, so the number on screen agrees with how money is run.
    game.reference_player = game.players.find((p) => p.handicap_index === best)?.name ?? null;
    // `receivers` + `rules` remain FIELD-RELATIVE and are display-only: they
    // drive the net shown on the scorecard. Money never reads them.
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
  /** Display strokes for one player on one hole: what they receive from the
   *  group's strongest player. Settlement uses the full matrix, not this. */
  _displayStrokes(game, name, par, hole = null) {
    if (par == null) return 0;
    const matrix = hole == null ? game.stroke_matrix : matrixForHole(game, hole);
    const ref =
      hole != null && game.front_matrix && Number(hole) <= 9
        ? game.front_reference_player || game.reference_player
        : game.reference_player;
    if (matrix && ref) {
      return strokesBetween(matrix, name, ref, { par });
    }
    // legacy games persisted before the matrix existed
    const recv = new Set(game.receivers || []);
    return recv.has(name) ? strokesForHole(par, game.rules) : 0;
  }

  /** Gross totals for holes 1-9: { name -> {holes:[], total, complete} }. */
  frontNine(game) {
    const out = {};
    for (const p of game.players || []) {
      const holes = [];
      let total = 0;
      let complete = true;
      for (let h = 1; h <= 9; h++) {
        const row = (game.holes?.[h] || []).find((r) => r.name === p.name);
        const g = row ? row.gross ?? null : null;
        holes.push(g);
        if (g == null) complete = false;
        else total += g;
      }
      out[p.name] = { holes, total, complete };
    }
    return out;
  }

  /**
   * Re-handicap for the back nine off the front-nine scores (OUT x 2).
   *
   * The front-nine matrix is frozen first, so holes 1-9 keep settling exactly as
   * they already did — re-handicapping must never rewrite money the group has
   * already seen. Only holes 10-18 use the new numbers.
   */
  applyBack9Handicap(sourceId) {
    const game = this._resolve(null, sourceId);
    if (!game) return { ok: false, error: "room_not_found" };
    if (game.back9_handicap) return { ok: false, error: "already_applied", game };
    const front = this.frontNine(game);
    const missing = Object.entries(front)
      .filter(([, v]) => !v.complete)
      .map(([n]) => n);
    if (missing.length) return { ok: false, error: "front_nine_incomplete", missing, game };

    // freeze what holes 1-9 were played under
    game.front_matrix = game.stroke_matrix;
    game.front_reference_player = game.reference_player;

    const before = {};
    for (const p of game.players) {
      before[p.name] = p.handicap_index;
      p.handicap_index = front[p.name].total * 2;
    }
    game.back9_handicap = true;
    this._recompute(game); // rebuilds stroke_matrix from the new indices
    this._persist(game);
    return {
      ok: true,
      game,
      before,
      after: Object.fromEntries(game.players.map((p) => [p.name, p.handicap_index])),
    };
  }

  _recomputeNets(game) {
    if (!game.course || !game.rules) return;
    for (const [holeNum, rows] of Object.entries(game.holes)) {
      const par = game.course.holes.find((h) => Number(h.hole) === Number(holeNum))?.par ?? null;
      if (par == null) continue;
      for (const row of rows) {
        if (row.gross == null) continue;
        const strokes = this._displayStrokes(game, row.name, par, Number(holeNum));
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
    if (room_code && game.room_code !== room_code) {
      return { ok: false, error: "room_not_found" }; // typed code does not exist
    }
    if (hole == null) return { ok: false, error: "no_hole_number", game };
    // Last line of defence: a round is 18 holes. Storing "หลุม 25" here is what
    // made the settlement report "สรุปเงินรวม 19 หลุม" while the score itself
    // silently went nowhere the group could see.
    if (!isValidHoleNumber(hole)) {
      return { ok: false, error: "bad_hole_number", hole: Number(hole), game };
    }

    const par = game.course
      ? game.course.holes.find((h) => Number(h.hole) === Number(hole))?.par ?? null
      : null;
    const rules = game.rules;
    const canNet = Boolean(rules && par != null);
    const arr = game.holes[hole] || (game.holes[hole] = []);

    for (const p of players) {
      // Scores are numbers only — the parser has already clamped them to 1-10.
      const row = { name: p.name, gross: p.gross };
      if (canNet) {
        const strokes = this._displayStrokes(game, p.name, par, Number(hole));
        row.strokes = strokes;
        row.net = computeNet(p.gross, strokes);
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
    for (let i = 0; i < 18; i++) {
      const hole = i + 1;
      const gross = scores[i];
      const par = game.course
        ? game.course.holes.find((h) => Number(h.hole) === hole)?.par ?? null
        : null;
      const row = { name, gross };
      if (rules && par != null) {
        const strokes = this._displayStrokes(game, name, par, hole);
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
