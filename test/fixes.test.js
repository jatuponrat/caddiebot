// fixes.test.js
// Regression tests for the three bugs found in the 2026-08-16 review:
//   1. front-nine gaps vs. the "แต้มต่อใหม่" offer
//   2. hole numbers outside 1-18 silently accepted
//   3. join dropping surnames and extra scores in silence
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../session.js";
import { GameStore } from "../gameStore.js";
import { parseJoin, parseHoleScores, isValidHoleNumber } from "../parser.js";
import { matchPlayerName, settleGame } from "../engine.js";

const PAR = "454354434 443535444"; // 9+9, par 72

/** A ready-to-play 2-player game: course, stake, no turbo, both joined. */
function newGame(G = "Gfix", names = ["A", "B"]) {
  const store = new GameStore();
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch(`สนาม-${G}`, G, store); // course name (unknown -> asks for pars)
  dispatch(PAR, G, store); // par card
  dispatch("ยืนยัน", G, store); // confirm the card
  dispatch("100", G, store); // stake
  dispatch("ไม่", G, store); // no turbo
  dispatch("กินกันทุกคน", G, store); // rules
  for (const [i, n] of names.entries()) {
    dispatch(`เข้าร่วม ${n} ${95 + i} ${92 + i} ${90 + i}`, G, store);
  }
  return { store, G };
}

// ---------------------------------------------------------------- bug 2
test("hole numbers outside 1-18 are rejected, not silently stored", () => {
  const { store, G } = newGame("Ghole");
  for (const bad of ["หลุม 25 A 5 B 6", "หลุม 0 A 5 B 6", "หลุม 19 A 5 B 6"]) {
    const out = dispatch(bad, G, store);
    assert.equal(out.summary.ok, false, `${bad} should be refused`);
    assert.match(out.summary.message, /1–18/);
  }
  const g = store.activeGame(G);
  assert.deepEqual(Object.keys(g.holes), [], "nothing may be recorded");
  assert.equal(settleGame(g).holesCounted, 0);
});

test("a valid hole still records after a rejected one", () => {
  const { store, G } = newGame("Ghole2");
  dispatch("หลุม 25 A 5 B 6", G, store);
  const out = dispatch("หลุม 1 A 5 B 6", G, store);
  assert.equal(out.summary.ok, true);
  assert.equal(out.summary.hole, 1);
  assert.equal(settleGame(store.activeGame(G)).holesCounted, 1);
});

test("parseHoleScores flags the bad number instead of returning it", () => {
  assert.equal(parseHoleScores("หลุม 25 A 5").hole, null);
  assert.equal(parseHoleScores("หลุม 25 A 5").hole_invalid, 25);
  assert.equal(parseHoleScores("หลุม 18 A 5").hole, 18);
  assert.equal(parseHoleScores("H9 A 5").hole, 9);
  assert.equal(parseHoleScores("หลุม 1 A 5").hole_invalid, undefined);
});

test("recordHole itself refuses an out-of-range hole", () => {
  const { store, G } = newGame("Ghole3");
  const r = store.recordHole(G, { hole: 25, players: [{ name: "A", gross: 5 }] });
  assert.equal(r.ok, false);
  assert.equal(r.error, "bad_hole_number");
  assert.ok(isValidHoleNumber(18) && !isValidHoleNumber(19) && !isValidHoleNumber(0));
});

// ---------------------------------------------------------------- bug 3
test("a multi-word name is kept whole", () => {
  const p = parseJoin("เข้าร่วม สมชาย ใจดี 90 88 92");
  assert.equal(p.player, "สมชาย ใจดี");
  assert.deepEqual(p.scores, [90, 88, 92]);
});

test("a 4th score is reported, never dropped in silence", () => {
  const p = parseJoin("เข้าร่วม สมชาย 90 88 92 85");
  assert.deepEqual(p.extra_scores, [85]);
  const { store, G } = newGame("Gjoin", []);
  const out = dispatch("เข้าร่วม สมชาย 90 88 92 85", G, store);
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /3 รอบล่าสุด/);
  assert.equal(store.activeGame(G).players.length, 0, "nothing may be registered");
});

test("a player registered with a surname can be scored by first name", () => {
  const { store, G } = newGame("Gname", []);
  dispatch("เข้าร่วม สมชาย ใจดี 90 88 92", G, store);
  dispatch("เข้าร่วม บอย 95 93 94", G, store);
  const g0 = store.activeGame(G);
  assert.deepEqual(g0.players.map((p) => p.name), ["สมชาย ใจดี", "บอย"]);

  const out = dispatch("หลุม 1 สมชาย 5 บอย 6", G, store);
  assert.equal(out.summary.ok, true);
  assert.equal(out.summary.complete, true);
  const rows = store.activeGame(G).holes[1];
  assert.deepEqual(rows.map((r) => r.name).sort(), ["บอย", "สมชาย ใจดี"]);
  assert.equal(store.activeGame(G).players.length, 2, "no phantom player");
});

test("an ambiguous first name is reported, not guessed", () => {
  const { store, G } = newGame("Gamb", []);
  dispatch("เข้าร่วม สมชาย ใจดี 90 88 92", G, store);
  dispatch("เข้าร่วม สมชาย รักกอล์ฟ 95 93 94", G, store);
  const out = dispatch("หลุม 1 สมชาย 5", G, store);
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /มากกว่า 1 คน/);
});

test("matchPlayerName never matches a partial word", () => {
  assert.equal(matchPlayerName(["Sammy"], "Sam").ok, false);
  assert.equal(matchPlayerName(["Sam Smith"], "sam").name, "Sam Smith");
  assert.equal(matchPlayerName(["Sam Smith"], "SAM SMITH").name, "Sam Smith");
  assert.equal(matchPlayerName(["A", "B"], "C").reason, "not_found");
});

test("a bulk 18-hole card resolves to the registered name", () => {
  const { store, G } = newGame("Gbulk", []);
  dispatch("เข้าร่วม สมชาย ใจดี 90 88 92", G, store);
  dispatch("เข้าร่วม บอย 95 93 94", G, store);
  const out = dispatch("สมชาย 544535445 445354454", G, store);
  assert.equal(out.summary.ok, true);
  assert.equal(out.summary.player, "สมชาย ใจดี");
  assert.equal(store.activeGame(G).players.length, 2);
  const out2 = dispatch("ใครก็ไม่รู้ 544535445 445354454", G, store);
  assert.equal(out2.summary.ok, false);
});

// ---------------------------------------------------------------- bug 1
test("the OUT recap does not offer a handicap it would then refuse", () => {
  const { store, G } = newGame("Gfront");
  // holes 1-8 complete, hole 9 only for A -> B's front nine has a gap.
  for (let h = 1; h <= 8; h++) dispatch(`หลุม ${h} A 5 B 6`, G, store);
  const g = store.activeGame(G);
  g.holes[9] = [];
  store.recordHole(G, { hole: 9, players: [{ name: "A", gross: 5 }] });
  const out = dispatch("หลุม 9 B 6", G, store);
  assert.equal(out.summary.ok, true);

  // full front nine -> the offer is real and applying it works
  const r = store.applyBack9Handicap(G);
  assert.equal(r.ok, true);
});

test("an incomplete front nine blocks the offer and says who is missing", () => {
  const { store, G } = newGame("Gfront2");
  for (let h = 1; h <= 8; h++) dispatch(`หลุม ${h} A 5 B 6`, G, store);
  // Skip hole 3 for B by deleting it, then close hole 9 for both.
  const g = store.activeGame(G);
  g.holes[3] = g.holes[3].filter((r) => r.name !== "B");
  const out = dispatch("หลุม 9 A 5 B 6", G, store);
  assert.match(out.summary.message, /ยังไม่ครบ|ขาด/);
  assert.doesNotMatch(out.summary.message, /พิมพ์ "แต้มต่อใหม่" เพื่อเปลี่ยน/);
  const r = store.applyBack9Handicap(G);
  assert.equal(r.ok, false);
  assert.equal(r.error, "front_nine_incomplete");
});

test("money still balances to zero with the new name resolution", () => {
  const { store, G } = newGame("Gmoney", []);
  dispatch("เข้าร่วม สมชาย ใจดี 90 88 92", G, store);
  dispatch("เข้าร่วม บอย 95 93 94", G, store);
  for (let h = 1; h <= 18; h++) {
    dispatch(`หลุม ${h} สมชาย ${4 + (h % 3)} บอย ${5 + (h % 2)}`, G, store);
  }
  const s = settleGame(store.activeGame(G));
  assert.equal(s.holesCounted, 18);
  assert.equal(Object.values(s.perPlayer).reduce((a, b) => a + b, 0), 0);
});
