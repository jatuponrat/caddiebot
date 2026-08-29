// history.pg.test.js
// End-to-end history tests against a REAL Postgres. Skipped unless
// TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5433/caddiebot_test \
//     node --test "test/history.pg.test.js"
import { test } from "node:test";
import assert from "node:assert/strict";

const URL_ = process.env.TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const skip = URL_ ? false : "set TEST_DATABASE_URL to run the Postgres suite";

const db = await import("../db.js");
const { GameStore } = await import("../gameStore.js");
const { dispatch, dispatchAsync } = await import("../session.js");
const { dateKeyDDMMYY, buildRoomCode } = await import("../engine.js");

const PAR = "454354434 443535444";

/**
 * Fully set up, two players joined, ready to score.
 * Seeds the running number from the DB first — every test builds its own
 * GameStore, and without seeding they would all hand out ...001 and then
 * overwrite each other's history row (archive_key is the room code).
 */
async function readyGame(store, G) {
  await store.seedRoomSeq();
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch(`สนาม-${G}`, G, store);
  dispatch(PAR, G, store);
  dispatch("ยืนยัน", G, store);
  dispatch("100", G, store);
  dispatch("ไม่", G, store);
  dispatch("กินกันทุกคน", G, store);
  dispatch("เข้าร่วม A 95 92 90", G, store);
  dispatch("เข้าร่วม B 99 97 95", G, store);
  return store.activeGame(G);
}

/** The archive write is queued on the store's write chain — let it land. */
const settleDb = () => new Promise((r) => setTimeout(r, 250));

test("schema initialises", { skip }, async () => {
  assert.equal(await db.initDb(), true);
  assert.equal(db.dbEnabled(), true);
});

test("จบเกม archives the round and ประวัติ <code> reads it back", { skip }, async () => {
  await db.initDb();
  const store = new GameStore();
  const G = `Ghist-${Date.now()}`;
  const game = await readyGame(store, G);
  const code = game.room_code;
  for (let h = 1; h <= 3; h++) dispatch(`หลุม ${h} A 4 B 6`, G, store);
  dispatch("จบเกม", G, store);
  await settleDb();

  const row = await db.findRound(code);
  assert.ok(row, "the round must exist in `rounds`");
  assert.equal(row.room_code, code);
  assert.equal(row.ended_reason, "ended");
  assert.equal(row.holes_counted, 3);

  const out = await dispatchAsync(`ประวัติ ${code}`, G, store);
  assert.equal(out.action, "history");
  assert.equal(out.summary.ok, true);
  assert.match(out.summary.message, new RegExp(code));
});

test("history answers even though the room is gone", { skip }, async () => {
  await db.initDb();
  const store = new GameStore();
  const G = `Gsilent-${Date.now()}`;
  const code = (await readyGame(store, G)).room_code;
  dispatch("หลุม 1 A 4 B 5", G, store);
  dispatch("จบเกม", G, store);
  await settleDb();

  assert.equal(store.activeGame(G), null, "the game is closed");
  // The 12h silence rule swallows everything else — history is the exception.
  const out = await dispatchAsync("ประวัติ", G, store);
  assert.equal(out.summary.ok, true);
  assert.match(out.summary.message, new RegExp(code));
});

test("archiving is idempotent: settle then end keeps ONE row", { skip }, async () => {
  await db.initDb();
  const store = new GameStore();
  const G = `Gidem-${Date.now()}`;
  const code = (await readyGame(store, G)).room_code;
  for (let h = 1; h <= 2; h++) dispatch(`หลุม ${h} A 4 B 5`, G, store);
  dispatch("รวม 18", G, store);
  await settleDb();
  dispatch("จบเกม", G, store);
  await settleDb();

  const rows = await db.listRounds(G, 20);
  assert.equal(rows.filter((r) => r.room_code === code).length, 1);
  assert.equal(rows.find((r) => r.room_code === code).ended_reason, "ended");
});

test("an unknown code says so instead of throwing", { skip }, async () => {
  await db.initDb();
  const out = await dispatchAsync("ประวัติ 010101999", `Gnone-${Date.now()}`, new GameStore());
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /ไม่พบประวัติ/);
});

test("a group with no finished rounds gets a friendly answer", { skip }, async () => {
  await db.initDb();
  const out = await dispatchAsync("ประวัติ", `Gempty-${Date.now()}`, new GameStore());
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /ยังไม่มีประวัติ/);
});

test("maxRoomSeqForDay sees archived rounds, so codes are never reissued", { skip }, async () => {
  await db.initDb();
  const store = new GameStore();
  const G = `Gseq-${Date.now()}`;
  const code = (await readyGame(store, G)).room_code;
  dispatch("หลุม 1 A 4 B 5", G, store);
  dispatch("จบเกม", G, store);
  await settleDb();

  const key = dateKeyDDMMYY();
  const max = await db.maxRoomSeqForDay(key);
  assert.ok(max >= Number(code.slice(6)), `seed ${max} must cover ${code}`);

  // A brand-new process seeds from the DB and continues past the archived code.
  const fresh = new GameStore();
  await fresh.seedRoomSeq(key);
  const next = fresh.createGame(`${G}-2`, { expected_players: 2 }).room_code;
  assert.notEqual(next, code);
  assert.equal(next, buildRoomCode(key, max + 1));
});

test("a session survives a restart through the sessions table", { skip }, async () => {
  await db.initDb();
  const store = new GameStore();
  const G = `Gload-${Date.now()}`;
  const code = (await readyGame(store, G)).room_code;
  dispatch("หลุม 1 A 4 B 5", G, store);
  await settleDb();

  const restarted = new GameStore();
  await restarted.loadFromDb();
  const back = restarted.activeGame(G);
  assert.ok(back, "the live game must come back after a restart");
  assert.equal(back.room_code, code);
  assert.deepEqual(back.players.map((p) => p.name), ["A", "B"]);
  assert.equal(back.holes[1].length, 2);
  dispatch("จบเกม", G, restarted);
  await settleDb();
});
