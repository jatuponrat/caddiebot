// roomcode.test.js
// Room codes are DDMMYY + a 3-digit running number for that day (160826001).
// These tests are offline — no database required.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dateKeyDDMMYY,
  partsAtOffset,
  buildRoomCode,
  parseRoomCode,
  normalizeRoomCode,
  formatRoomCodeDate,
  formatThaiDateTime,
  THAI_UTC_OFFSET_MIN,
} from "../engine.js";
import { GameStore } from "../gameStore.js";
import { parseJoin, parseHistoryQuery, detectIntent } from "../parser.js";

// ------------------------------------------------------------ date handling
test("the day key is Thai time, not the server's UTC day", () => {
  // 23:30 UTC on 15 Aug is already 06:30 on 16 Aug in Bangkok — a dawn tee-off
  // must not be stamped with the previous date.
  const d = new Date("2026-08-15T23:30:00Z");
  assert.equal(dateKeyDDMMYY(d, THAI_UTC_OFFSET_MIN), "160826");
});

test("late Thai evening still belongs to the same Thai day", () => {
  const d = new Date("2026-08-16T16:00:00Z"); // 23:00 Bangkok
  assert.equal(dateKeyDDMMYY(d, THAI_UTC_OFFSET_MIN), "160826");
});

test("a fixed offset never depends on ICU timezone data", () => {
  const p = partsAtOffset(new Date("2026-08-15T23:30:00Z"), THAI_UTC_OFFSET_MIN);
  assert.equal(p.day, 16);
  assert.equal(p.month, 8);
  assert.equal(p.year, 2026);
  assert.equal(p.hour, 6);
});

test("day, month and year are zero-padded", () => {
  assert.equal(dateKeyDDMMYY(new Date("2026-01-05T05:00:00Z"), THAI_UTC_OFFSET_MIN), "050126");
});

test("formatThaiDateTime renders Thai wall-clock time", () => {
  assert.equal(formatThaiDateTime(new Date("2026-08-15T23:30:00Z")), "16/08/26 06:30");
  assert.equal(formatThaiDateTime(null), "");
  assert.equal(formatThaiDateTime("not a date"), "");
});

// ------------------------------------------------------------ code building
test("buildRoomCode pads the running number to 3 digits", () => {
  assert.equal(buildRoomCode("160826", 1), "160826001");
  assert.equal(buildRoomCode("160826", 42), "160826042");
  assert.equal(buildRoomCode("160826", 999), "160826999");
});

test("parseRoomCode reads a code back", () => {
  const p = parseRoomCode("160826001");
  assert.equal(p.dateKey, "160826");
  assert.equal(p.day, 16);
  assert.equal(p.month, 8);
  assert.equal(p.year, 2026);
  assert.equal(p.seq, 1);
});

test("parseRoomCode rejects nonsense and legacy 4-digit codes", () => {
  assert.equal(parseRoomCode("4821"), null);
  assert.equal(parseRoomCode("990826001"), null); // day 99
  assert.equal(parseRoomCode("169926001"), null); // month 99
  assert.equal(parseRoomCode(""), null);
  assert.equal(parseRoomCode(null), null);
});

test("normalizeRoomCode keeps digits only", () => {
  assert.equal(normalizeRoomCode("160826-001"), "160826001");
  assert.equal(normalizeRoomCode("ห้อง 160826 001"), "160826001");
  assert.equal(normalizeRoomCode("#160826001 "), "160826001");
});

test("formatRoomCodeDate is display-only and tolerates old codes", () => {
  assert.equal(formatRoomCodeDate("160826001"), "16/08/26");
  assert.equal(formatRoomCodeDate("4821"), null);
});

// ------------------------------------------------------------ the sequence
test("codes run 001, 002, 003 within the same day", () => {
  const store = new GameStore();
  const a = store.createGame("G1", { expected_players: 4 }).room_code;
  const b = store.createGame("G2", { expected_players: 4 }).room_code;
  const c = store.createGame("G3", { expected_players: 4 }).room_code;
  const key = dateKeyDDMMYY();
  assert.equal(a, buildRoomCode(key, 1));
  assert.equal(b, buildRoomCode(key, 2));
  assert.equal(c, buildRoomCode(key, 3));
});

test("every code is 9 digits and unique", () => {
  const store = new GameStore();
  const codes = new Set();
  for (let i = 0; i < 25; i++) {
    const code = store.createGame(`Grp${i}`, { expected_players: 2 }).room_code;
    assert.match(code, /^\d{9}$/);
    codes.add(code);
  }
  assert.equal(codes.size, 25);
});

test("a seeded sequence continues instead of reissuing a used code", () => {
  const store = new GameStore();
  const key = dateKeyDDMMYY();
  store._seq.set(key, 7); // as if seedRoomSeq() read 7 out of the database
  assert.equal(store.createGame("G", { expected_players: 2 }).room_code, buildRoomCode(key, 8));
});

test("the running number is per day, so an old day never blocks today", () => {
  const store = new GameStore();
  store._seq.set("010126", 400); // last new year's rounds
  const code = store.createGame("G", { expected_players: 2 }).room_code;
  assert.equal(code, buildRoomCode(dateKeyDDMMYY(), 1));
});

test("seedRoomSeq is safe with the database switched off", async () => {
  const store = new GameStore();
  const n = await store.seedRoomSeq("160826");
  assert.equal(typeof n, "number");
});

// ------------------------------------------------------- codes in messages
test("a 9-digit code in a join is a code, not three scores", () => {
  const p = parseJoin("เข้าร่วม 160826001 แซม 105 90 91");
  assert.equal(p.room_code, "160826001");
  assert.deepEqual(p.scores, [105, 90, 91]);
  assert.equal(p.player, "แซม");
});

test("a legacy 4-digit code still joins", () => {
  const p = parseJoin("เข้าร่วม 4821 แซม 105 90 91");
  assert.equal(p.room_code, "4821");
  assert.deepEqual(p.scores, [105, 90, 91]);
});

test("a bare code plus scores reads as a join", () => {
  assert.equal(detectIntent("160826001 แซม 105 90 91"), "join");
});

test("ประวัติ is its own intent and beats a score line", () => {
  assert.equal(detectIntent("ประวัติ"), "history");
  assert.equal(detectIntent("ประวัติ 160826001"), "history");
  assert.equal(detectIntent("ดูรอบ 160826001"), "history");
});

test("parseHistoryQuery picks the code out of the sentence", () => {
  assert.equal(parseHistoryQuery("ประวัติ 160826001").code, "160826001");
  assert.equal(parseHistoryQuery("ประวัติ ห้อง 160826-001").code, "160826001");
  assert.equal(parseHistoryQuery("ประวัติ").code, null);
  assert.equal(parseHistoryQuery("ประวัติ 4821").code, "4821");
});

// ---------------------------------------------------------------- archiving
test("a round with holes is archived; an empty room is not", () => {
  const store = new GameStore();
  const game = store.createGame("Garch", { expected_players: 2 });
  assert.equal(store.archiveGame(game, "ended"), null, "no holes -> no history row");

  game.players = [{ name: "A", handicap_index: 90 }, { name: "B", handicap_index: 92 }];
  game.holes = { 1: [{ name: "A", gross: 4, net: 4 }, { name: "B", gross: 5, net: 5 }] };
  const round = store.archiveGame(game, "settled");
  assert.equal(round.archive_key, game.room_code);
  assert.equal(round.room_code, game.room_code);
  assert.equal(round.ended_reason, "settled");
  assert.equal(round.holes_counted, 1);
});

test("the archive key is the room code, so re-settling updates one row", () => {
  const store = new GameStore();
  const game = store.createGame("Garch2", { expected_players: 2 });
  game.players = [{ name: "A" }, { name: "B" }];
  game.holes = { 1: [{ name: "A", gross: 4 }, { name: "B", gross: 5 }] };
  const first = store.archiveGame(game, "settled");
  const second = store.archiveGame(game, "ended");
  assert.equal(first.archive_key, second.archive_key);
});
