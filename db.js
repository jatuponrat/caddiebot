// db.js
// Optional Postgres persistence (Supabase). Enabled only when DATABASE_URL is set.
// `pg` is imported dynamically so the app (and tests) run fine without it installed
// or without a database configured — every function safely no-ops when disabled.

let pool = null;
let poolPromise = null;

export function dbEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

async function ensurePool() {
  if (!process.env.DATABASE_URL) return null;
  if (pool) return pool;
  if (!poolPromise) {
    poolPromise = (async () => {
      const pg = await import("pg");
      const { Pool } = pg.default || pg;
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
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
    return true;
  } catch (e) {
    console.error("[db] initDb error:", e.message);
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

/** Persist a finished (or settled) round for history. */
export async function saveRound(round) {
  const p = await ensurePool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO rounds (room_code, source_id, course_name, stake, turbo, players, holes, settlement)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        round.room_code ?? null,
        round.source_id ?? null,
        round.course_name ?? null,
        round.stake ?? null,
        round.turbo ?? null,
        JSON.stringify(round.players ?? []),
        JSON.stringify(round.holes ?? {}),
        JSON.stringify(round.settlement ?? {}),
      ]
    );
  } catch (e) {
    console.error("[db] saveRound error:", e.message);
  }
}
