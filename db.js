// db.js
// Optional Postgres persistence (Supabase). Enabled only when DATABASE_URL is set.
// `pg` is imported dynamically so the app (and tests) run fine without it installed
// or without a database configured — every function safely no-ops when disabled.

let pool = null;
let poolPromise = null;
let lastError = null; // set whenever a real connection attempt fails

export function dbEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

/** The most recent connection failure message, or null if the last attempt
 *  succeeded (or none has happened yet). Surfaced on /health so a stale/wrong
 *  DATABASE_URL (e.g. a paused Supabase project) is visible, not silent. */
export function dbLastError() {
  return lastError;
}

async function ensurePool() {
  if (!process.env.DATABASE_URL) return null;
  if (pool) return pool;
  if (!poolPromise) {
    poolPromise = (async () => {
      const pg = await import("pg");
      const { Pool } = pg.default || pg;
      // Supabase/Render need SSL; a local Postgres refuses it outright, which
      // is what you hit when running the bot against a test DB on your machine.
      const url = process.env.DATABASE_URL;
      const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
      const sslOff = local || /^(0|false|disable)$/i.test(process.env.DATABASE_SSL || "");
      pool = new Pool({
        connectionString: url,
        ssl: sslOff ? false : { rejectUnauthorized: false },
        max: 3,
      });
      return pool;
    })();
  }
  return poolPromise;
}

/** Create tables if they don't exist. Returns true if the DB is active. */
export async function initDb() {
  const p = await ensurePool();
  if (!p) return false;
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS courses (
        name        text PRIMARY KEY,
        pars        text NOT NULL,
        total_par   integer NOT NULL,
        created_at  timestamptz DEFAULT now()
      );`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        source_id   text PRIMARY KEY,
        room_code   text NOT NULL,
        state       jsonb NOT NULL,
        expires_at  timestamptz NOT NULL,
        updated_at  timestamptz DEFAULT now()
      );`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS rounds (
        id          bigserial PRIMARY KEY,
        room_code   text,
        source_id   text,
        course_name text,
        stake       integer,
        turbo       boolean,
        players     jsonb,
        holes       jsonb,
        settlement  jsonb,
        created_at  timestamptz DEFAULT now()
      );`);
    // Added later: archive_key makes archiving idempotent — settling twice, or
    // settling and then "จบเกม", updates ONE row instead of duplicating it.
    // Legacy rows keep NULL and a unique index tolerates any number of NULLs,
    // so nothing needs back-filling.
    await p.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS archive_key   text`);
    await p.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS ended_reason  text`);
    await p.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS format        text`);
    await p.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS course        jsonb`);
    await p.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS holes_counted integer`);
    await p.query(
      `ALTER TABLE rounds ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`
    );
    await p.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS rounds_archive_key_idx ON rounds (archive_key)`
    );
    await p.query(
      `CREATE INDEX IF NOT EXISTS rounds_source_created_idx ON rounds (source_id, created_at DESC)`
    );
    await p.query(`CREATE INDEX IF NOT EXISTS rounds_room_code_idx ON rounds (room_code)`);
    lastError = null;
    return true;
  } catch (e) {
    console.error("[db] initDb error:", e.message);
    lastError = e.message;
    return false;
  }
}

/** Upsert a course (name is case-insensitive-unique by lower(name)). */
export async function saveCourse(name, pars, totalPar) {
  const p = await ensurePool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO courses (name, pars, total_par) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET pars = EXCLUDED.pars, total_par = EXCLUDED.total_par`,
      [name, pars, totalPar]
    );
  } catch (e) {
    console.error("[db] saveCourse error:", e.message);
  }
}

/** Return all saved courses: [{ name, pars, total_par }]. */
export async function listCourses() {
  const p = await ensurePool();
  if (!p) return [];
  try {
    const { rows } = await p.query(`SELECT name, pars, total_par FROM courses`);
    return rows;
  } catch (e) {
    console.error("[db] listCourses error:", e.message);
    return [];
  }
}

/** Upsert the live game state for a source (group/user). Fire-and-forget safe. */
export async function saveSession(sourceId, game) {
  const p = await ensurePool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO sessions (source_id, room_code, state, expires_at, updated_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), now())
       ON CONFLICT (source_id) DO UPDATE
         SET room_code   = EXCLUDED.room_code,
             state       = EXCLUDED.state,
             expires_at  = EXCLUDED.expires_at,
             updated_at  = now()`,
      [sourceId, game.room_code, JSON.stringify(game), game.expires_at]
    );
  } catch (e) {
    console.error("[db] saveSession error:", e.message);
  }
}

/** Delete a session when a game ends or is cancelled. */
export async function deleteSession(sourceId) {
  const p = await ensurePool();
  if (!p) return;
  try {
    await p.query(`DELETE FROM sessions WHERE source_id = $1`, [sourceId]);
  } catch (e) {
    console.error("[db] deleteSession error:", e.message);
  }
}

/**
 * Delete a session ONLY while it is still expired. Used by the expiry sweep:
 * between the sweep's SELECT and its DELETE the group may have started a new
 * game (which overwrites this same row), and an unguarded DELETE would throw
 * that new game away.
 */
export async function deleteExpiredSession(sourceId) {
  const p = await ensurePool();
  if (!p || !sourceId) return 0;
  try {
    const r = await p.query(
      `DELETE FROM sessions WHERE source_id = $1 AND expires_at <= now()`,
      [sourceId]
    );
    return r.rowCount || 0;
  } catch (e) {
    console.error("[db] deleteExpiredSession error:", e.message);
    return 0;
  }
}

/** Load ONE source's non-expired session. Returns the game state, or null.
 *  Used to re-hydrate a single group after a restart / free-tier spin-down. */
export async function loadSession(sourceId) {
  const p = await ensurePool();
  if (!p || !sourceId) return null;
  try {
    const { rows } = await p.query(
      `SELECT state FROM sessions WHERE source_id = $1 AND expires_at > now()`,
      [sourceId]
    );
    return rows[0]?.state ?? null;
  } catch (e) {
    console.error("[db] loadSession error:", e.message);
    return null;
  }
}

/** Load all non-expired sessions from DB. Returns [{sourceId, game}]. */
export async function loadActiveSessions() {
  const p = await ensurePool();
  if (!p) return [];
  try {
    const { rows } = await p.query(
      `SELECT source_id, state FROM sessions WHERE expires_at > now()`
    );
    return rows.map((r) => ({ sourceId: r.source_id, game: r.state }));
  } catch (e) {
    console.error("[db] loadActiveSessions error:", e.message);
    return [];
  }
}

/**
 * Persist a finished / settled / expired round for history.
 * Idempotent: keyed on archive_key (the room code), so re-archiving the same
 * round overwrites it rather than creating a duplicate.
 */
export async function saveRound(round) {
  const p = await ensurePool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO rounds
         (archive_key, room_code, source_id, course_name, stake, turbo, format,
          ended_reason, players, holes, course, settlement, holes_counted, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (archive_key) DO UPDATE SET
         course_name   = EXCLUDED.course_name,
         stake         = EXCLUDED.stake,
         turbo         = EXCLUDED.turbo,
         format        = EXCLUDED.format,
         ended_reason  = EXCLUDED.ended_reason,
         players       = EXCLUDED.players,
         holes         = EXCLUDED.holes,
         course        = EXCLUDED.course,
         settlement    = EXCLUDED.settlement,
         holes_counted = EXCLUDED.holes_counted,
         updated_at    = now()`,
      [
        round.archive_key ?? round.room_code ?? null,
        round.room_code ?? null,
        round.source_id ?? null,
        round.course_name ?? null,
        round.stake ?? null,
        round.turbo ?? null,
        round.format ?? null,
        round.ended_reason ?? null,
        JSON.stringify(round.players ?? []),
        JSON.stringify(round.holes ?? {}),
        JSON.stringify(round.course ?? null),
        JSON.stringify(round.settlement ?? {}),
        round.holes_counted ?? null,
      ]
    );
  } catch (e) {
    console.error("[db] saveRound error:", e.message);
  }
}

/** One archived round by code (date code or legacy 4-digit), newest first. */
export async function findRound(code) {
  const p = await ensurePool();
  if (!p || !code) return null;
  try {
    const { rows } = await p.query(
      `SELECT * FROM rounds
        WHERE archive_key = $1 OR room_code = $1
        ORDER BY created_at DESC LIMIT 1`,
      [String(code)]
    );
    return rows[0] ?? null;
  } catch (e) {
    console.error("[db] findRound error:", e.message);
    return null;
  }
}

/** The most recent archived rounds for one LINE group / chat. */
export async function listRounds(sourceId, limit = 5) {
  const p = await ensurePool();
  if (!p || !sourceId) return [];
  try {
    const { rows } = await p.query(
      `SELECT room_code, archive_key, course_name, stake, ended_reason,
              holes_counted, settlement, created_at
         FROM rounds WHERE source_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [sourceId, Math.max(1, Math.min(20, Number(limit) || 5))]
    );
    return rows;
  } catch (e) {
    console.error("[db] listRounds error:", e.message);
    return [];
  }
}

/**
 * Highest running number already used for a DDMMYY day, across live sessions
 * AND archived rounds. Used to seed the in-process counter after a restart so
 * codes are never reissued.
 */
export async function maxRoomSeqForDay(dateKey) {
  const p = await ensurePool();
  if (!p || !dateKey) return 0;
  try {
    const { rows } = await p.query(
      `SELECT max(seq) AS seq FROM (
         SELECT substring(room_code from 7 for 3)::int AS seq FROM sessions
          WHERE room_code ~ ('^' || $1 || '[0-9]{3}$')
         UNION ALL
         SELECT substring(room_code from 7 for 3)::int AS seq FROM rounds
          WHERE room_code ~ ('^' || $1 || '[0-9]{3}$')
       ) t`,
      [String(dateKey)]
    );
    return Number(rows[0]?.seq) || 0;
  } catch (e) {
    console.error("[db] maxRoomSeqForDay error:", e.message);
    return 0;
  }
}

/**
 * Find sessions whose 12h window has already elapsed and hand them back so the
 * caller can archive them, then delete them. This is the path that saves rounds
 * which die while the bot is idle — nothing is in memory then, so GameStore's
 * own expiry check never runs for them.
 */
export async function takeExpiredSessions(limit = 50) {
  const p = await ensurePool();
  if (!p) return [];
  try {
    const { rows } = await p.query(
      `SELECT source_id, state FROM sessions
        WHERE expires_at <= now() ORDER BY expires_at ASC LIMIT $1`,
      [Math.max(1, Math.min(500, Number(limit) || 50))]
    );
    return rows.map((r) => ({ sourceId: r.source_id, game: r.state }));
  } catch (e) {
    console.error("[db] takeExpiredSessions error:", e.message);
    return [];
  }
}
