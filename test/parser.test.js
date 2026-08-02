import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize,
  detectIntent,
  parseCreateGame,
  parseJoin,
  parseHoleScores,
  parseParString,
  parseBulkScores,
  lookupPresetCourse,
} from "../parser.js";

test("normalize converts Thai digits and collapses whitespace", () => {
  assert.equal(normalize("หลุม ๑   A    ๕"), "หลุม 1 A 5");
});

test("detectIntent classifies all message kinds", () => {
  assert.equal(detectIntent("สร้างเกม"), "create_game");
  assert.equal(detectIntent("create game 4 players"), "create_game");
  assert.equal(detectIntent("เข้าร่วม 4821 ชื่อ A 92,95,90"), "join");
  assert.equal(detectIntent("join 4821 name A 92 95 90"), "join");
  assert.equal(detectIntent("หลุม 1 A 5 B 6"), "hole_scores");
  assert.equal(detectIntent("hole 7 A 5 B 6"), "hole_scores");
  assert.equal(detectIntent('{"course":{}}'), "course_json");
  assert.equal(detectIntent("454354434 443535444"), "par_string");
  assert.equal(detectIntent("454354434443535444"), "par_string");
  assert.equal(detectIntent("พาร์ 454354434 443535444"), "par_string");
  assert.equal(detectIntent("สวัสดีครับ"), "unknown");
});

test("parseParString reads a 9+9 par card", () => {
  const r = parseParString("454354434 443535444");
  assert.equal(r.ok, true);
  assert.equal(r.total, 72);
  assert.equal(r.out, 36);
  assert.equal(r.in, 36);
  assert.equal(r.holes.length, 18);
  assert.deepEqual(r.holes[0], { hole: 1, par: 4 });
});

test("parseParString accepts no-space and keyword forms", () => {
  assert.equal(parseParString("454354434443535444").total, 72);
  assert.equal(parseParString("พาร์ 454354434 443535444").total, 72);
  assert.equal(parseParString("๔๕๔๓๕๔๔๓๔ ๔๔๓๕๓๕๔๔๔").total, 72); // Thai digits
});

test("parseParString rejects wrong count and bad pars", () => {
  assert.equal(parseParString("45435443 443535444").ok, false); // 17 digits
  assert.equal(parseParString("45435443 443535444").reason, "count");
  assert.equal(parseParString("454354437 443535444").ok, false); // contains a 7
  assert.equal(parseParString("454354437 443535444").reason, "range");
});

test("lookupPresetCourse finds built-in courses, else null", () => {
  assert.equal(lookupPresetCourse("The Pine").total, 72);
  assert.equal(lookupPresetCourse("the pine golf club").total, 72);
  assert.equal(lookupPresetCourse("Rachakram").total, 72);
  assert.equal(lookupPresetCourse("racha").total, 72);
  assert.equal(lookupPresetCourse("สนามที่ไม่รู้จัก"), null);
});

test("detectIntent: settle / end_game / bulk", () => {
  assert.equal(detectIntent("รวม 18"), "settle");
  assert.equal(detectIntent("สรุป"), "settle");
  assert.equal(detectIntent("จบเกม"), "end_game");
  assert.equal(detectIntent("แซม 544535445 445354454"), "bulk_scores");
});

test("parseBulkScores reads 18 single-digit holes; rejects bad input", () => {
  const r = parseBulkScores("แซม 544535445 445354454");
  assert.equal(r.ok, true);
  assert.equal(r.name, "แซม");
  assert.equal(r.scores.length, 18);
  assert.equal(r.scores[0], 5);
  assert.equal(parseBulkScores("แซม 54453544 445354454").reason, "count"); // 17
  assert.equal(parseBulkScores("แซม 044535445 445354454").reason, "range"); // has 0
});

test("parseCreateGame extracts expected players", () => {
  assert.equal(parseCreateGame("สร้างเกม 4 คน").expected_players, 4);
  assert.equal(parseCreateGame("create game 3 players").expected_players, 3);
  assert.equal(parseCreateGame("สร้างเกม").expected_players, null);
});

test("parseJoin (Thai) extracts room, name, scores", () => {
  const r = parseJoin("เข้าร่วม 4821 ชื่อ A 92,95,90");
  assert.equal(r.room_code, "4821");
  assert.equal(r.player, "A");
  assert.deepEqual(r.scores, [92, 95, 90]);
});

test("parseJoin (English, space-separated scores)", () => {
  const r = parseJoin("join 4821 name Boom 92 95 90");
  assert.equal(r.room_code, "4821");
  assert.equal(r.player, "Boom");
  assert.deepEqual(r.scores, [92, 95, 90]);
});

test("parseJoin keeps the room code out of the scores", () => {
  const r = parseJoin("เข้าร่วม 1234 ชื่อ ก้อง 88,90,86");
  assert.equal(r.room_code, "1234");
  assert.equal(r.player, "ก้อง");
  assert.deepEqual(r.scores, [88, 90, 86]);
});

test("parseJoin (simple format, no ชื่อ keyword, no room code)", () => {
  const r = parseJoin("เข้าร่วม แซม 105 90 91");
  assert.equal(r.room_code, null);
  assert.equal(r.player, "แซม");
  assert.deepEqual(r.scores, [105, 90, 91]);
});

test("parseHoleScores single line", () => {
  const r = parseHoleScores("หลุม 7 A 5 B 6 C 5 D 7");
  assert.equal(r.hole, 7);
  assert.deepEqual(r.players, [
    { name: "A", gross: 5 },
    { name: "B", gross: 6 },
    { name: "C", gross: 5 },
    { name: "D", gross: 7 },
  ]);
});

test("parseHoleScores multi-line with Thai names", () => {
  const r = parseHoleScores("หลุม 1\nสมชาย 5\nบี 6\nซี 5");
  assert.equal(r.hole, 1);
  assert.deepEqual(r.players, [
    { name: "สมชาย", gross: 5 },
    { name: "บี", gross: 6 },
    { name: "ซี", gross: 5 },
  ]);
});

test("parseHoleScores handles name+score with no space", () => {
  const r = parseHoleScores("หลุม 3 A5 B6");
  assert.equal(r.hole, 3);
  assert.deepEqual(r.players, [
    { name: "A", gross: 5 },
    { name: "B", gross: 6 },
  ]);
});

test("hole shorthand: H1 = หลุม 1", () => {
  assert.equal(detectIntent("H1 แซม 4"), "hole_scores");
  assert.equal(detectIntent("h12 เอ 5 บี 6"), "hole_scores");
  const r = parseHoleScores("H1 แซม 4");
  assert.equal(r.hole, 1);
  assert.deepEqual(r.players, [{ name: "แซม", gross: 4 }]);
  const r2 = parseHoleScores("h12 เอ 5 บี 6");
  assert.equal(r2.hole, 12);
  assert.deepEqual(r2.players, [
    { name: "เอ", gross: 5 },
    { name: "บี", gross: 6 },
  ]);
});
