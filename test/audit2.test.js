// audit2.test.js
// Regression tests for the 2026-08-24 audit. One test per bug found, named so a
// failure says which behaviour came back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, resolveTypedName } from "../session.js";
import { GameStore } from "../gameStore.js";
import {
  detectIntent,
  parseBulkScores,
  parseHoleScores,
  parseStake,
  parseFormat,
  lookupPresetCourse,
} from "../parser.js";
import {
  settleHoleHeadEatsTail,
  settleGame,
  strokesForHole,
  matchPlayerName,
} from "../engine.js";
import { verifySignature } from "../line.js";

const PAR = "454354434 443535444";

/** A fully set-up 2-player game on a par-72 card, 100 a hole, no turbo. */
function game(G, names = ["แซม", "บอย"], rules = "กินกันทุกคน") {
  const store = new GameStore();
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน");
  d(`สนาม-${G}`);
  d(PAR);
  d("ยืนยัน");
  d("100");
  d("ไม่มี");
  d(rules);
  names.forEach((n, i) => d(`เข้าร่วม ${n} ${95 + i} ${92 + i} ${90 + i}`));
  return { store, d, G };
}

// ---------------------------------------------------------------- crashes
test("an unverifiable body is a failed signature, not a thrown error", () => {
  // express.json's verify hook never runs for a non-JSON Content-Type, so
  // rawBody arrives undefined. crypto.update(undefined) THREW, and on an async
  // Express route that killed the process — one curl took the whole bot down.
  assert.doesNotThrow(() => verifySignature(undefined, "sig", "secret"));
  assert.equal(verifySignature(undefined, "sig", "secret"), false);
  assert.equal(verifySignature(null, "sig", "secret"), false);
  assert.equal(verifySignature({}, "sig", "secret"), false);
  assert.equal(verifySignature(Buffer.from("{}"), "wrong", "secret"), false);
});

// ------------------------------------------------------- rooms and groups
test("a room code from another group cannot be joined or hijacked", () => {
  const store = new GameStore();
  const setup = (G) => {
    const d = (t) => dispatch(t, G, store);
    d("สร้างเกม 2 คน"); d(`สนาม-${G}`); d(PAR); d("ยืนยัน"); d("100"); d("ไม่มี"); d("กินกันทุกคน");
    d("เข้าร่วม เอ 95 92 90"); d("เข้าร่วม บี 99 97 95");
    return d;
  };
  const dA = setup("GA");
  const codeA = store.activeGame("GA").room_code;
  const dB = setup("GB");
  const codeB = store.activeGame("GB").room_code;

  const out = dB(`เข้าร่วม ${codeA} ซี 90 90 90`);
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /กลุ่มอื่น/);
  assert.equal(store.rooms.get(codeA).players.length, 2, "A's roster is untouched");
  assert.equal(store.activeGame("GB").room_code, codeB, "B still owns its own room");
  assert.equal(dB("หลุม 1 เอ 5 บี 6").summary.ok, true, "B can still play");
});

// ------------------------------------------------------------ intent routing
test("a score line containing a command word is still a score line", () => {
  const { store, d, G } = game("Gcmd");
  const out = d("หลุม 1 แซม 5 บอย 6 สรุปทีหลังนะ");
  assert.equal(out.action, "hole_scores");
  assert.equal(out.summary.ok, true);
  assert.deepEqual(Object.keys(store.activeGame(G).holes), ["1"]);
  // ...but a genuine settle request with no scores on it still settles.
  assert.equal(detectIntent("สรุปหลุม 3"), "settle");
  assert.equal(detectIntent("สรุป"), "settle");
  assert.equal(detectIntent("จบเกม"), "end_game");
});

test("a join whose player name is a command word does not fire the command", () => {
  const { store, d, G } = game("Gcmd2", []);
  const out = d("เข้าร่วม จบเกม 95 92 90");
  assert.equal(out.action, "join");
  assert.ok(store.activeGame(G), "the game must still be alive");
});

test("a bulk card with a multi-word name is scores, never a join", () => {
  const { store, d, G } = game("Gbulkname", ["สมชาย ใจดี", "บอย"]);
  const before = store.activeGame(G).players.map((p) => p.handicap_index);
  assert.equal(detectIntent("สมชาย ใจดี 445345434 453443544"), "bulk_scores");
  const out = d("สมชาย ใจดี 445345434 453443544");
  assert.equal(out.action, "bulk_scores");
  assert.equal(out.summary.ok, true);
  const g = store.activeGame(G);
  assert.equal(g.players.length, 2, "no phantom player");
  assert.deepEqual(g.players.map((p) => p.handicap_index), before, "handicaps untouched");
  assert.equal(parseBulkScores("สมชาย ใจดี 444444444 444444444").name, "สมชาย ใจดี");
});

// ------------------------------------------------------------------- setup
test("gameplay closes the setup Q&A out loud, and the settle says there is no stake", () => {
  const store = new GameStore();
  const d = (t) => dispatch(t, "Gearly", store);
  d("สร้างเกม 2 คน");
  const joined = d("เข้าร่วม แซม 95 92 90");
  assert.match(joined.summary.message, /ยังไม่ได้ตั้ง/);
  assert.match(joined.summary.message, /เงินเดิมพัน/);
  d("เข้าร่วม บอย 99 97 95");
  d(PAR);
  d("หลุม 1 แซม 5 บอย 6");
  const s = d("รวม 18");
  assert.match(s.summary.message, /ไม่ได้ตั้งเงินเดิมพัน/);
  assert.doesNotMatch(s.summary.message, /แซม 0, บอย 0/);
});

test("the stake and the rules can be set after the setup closed", () => {
  const store = new GameStore();
  const d = (t) => dispatch(t, "Glate", store);
  d("สร้างเกม 2 คน");
  d("เข้าร่วม แซม 95 92 90");
  d("เข้าร่วม บอย 99 97 95");
  d(PAR);
  assert.equal(d("หลุมละ 1,000 บาท").summary.ok, true);
  assert.equal(store.activeGame("Glate").stake, 1000, "1,000 is not 1");
  assert.equal(d("กติกา หัวกินหาง").summary.ok, true);
  assert.equal(store.activeGame("Glate").format, "head_tail");
  assert.equal(store.activeGame("Glate").setup, "done", "the Q&A must stay closed");
  // Once money has been played for, changing them would rewrite it: refuse.
  d("หลุม 1 แซม 4 บอย 6");
  assert.equal(d("หลุมละ 50").summary.ok, false);
  assert.equal(store.activeGame("Glate").stake, 1000);
});

test('"สร้างเกม" with no number asks, and the answer is not swallowed', () => {
  const store = new GameStore();
  const d = (t) => dispatch(t, "Gcount", store);
  const ask = d("สร้างเกม");
  assert.equal(ask.summary.ok, false);
  assert.match(ask.summary.message, /กี่คน/);
  const made = d("4 คน");
  assert.equal(made.action, "create_game");
  assert.equal(store.activeGame("Gcount").expected_players, 4);
});

test("Thai digits work in the setup answers too", () => {
  const store = new GameStore();
  const d = (t) => dispatch(t, "Gthai", store);
  d("สร้างเกม ๒ คน");
  d("เดอะไพน์");
  d("๑๐๐");
  assert.equal(store.activeGame("Gthai").stake, 100);
});

test("an empty course answer is not accepted as a course name", () => {
  const store = new GameStore();
  const d = (t) => dispatch(t, "Gblank", store);
  d("สร้างเกม 2 คน");
  const out = d("   ");
  assert.equal(out.summary.ok, false);
  assert.doesNotMatch(String(out.summary.message), /null/);
});

// -------------------------------------------------------------------- names
test("a score line accepts the full multi-word name the roster shows", () => {
  const { store, d, G } = game("Gfull", ["สมชาย ใจดี", "บอย"]);
  const out = d("หลุม 1 สมชาย ใจดี 5 บอย 6");
  assert.equal(out.summary.ok, true);
  assert.equal(out.summary.complete, true);
  const rows = store.activeGame(G).holes[1];
  assert.deepEqual(rows.map((r) => r.name).sort(), ["บอย", "สมชาย ใจดี"]);
});

test("a stray word in front of a name does not lose the line", () => {
  const { d } = game("Gstray");
  const out = d("หลุม 1 นะครับ แซม 5 บอย 6");
  assert.equal(out.summary.ok, true);
  assert.equal(resolveTypedName(["แซม", "บอย"], "นะครับ แซม").name, "แซม");
});

test("name+score with no space still parses", () => {
  assert.deepEqual(parseHoleScores("หลุม 3 A5 B6").players, [
    { name: "A", gross: 5 },
    { name: "B", gross: 6 },
  ]);
});

test("a score before anyone joined is refused, and the round still balances", () => {
  const { store, d, G } = game("Gnoroster", []);
  const out = d("หลุม 1 แซน 5 บอย 6");
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /ยังไม่มีผู้เล่น/);
  d("เข้าร่วม แซม 95 92 90");
  d("เข้าร่วม บอย 99 97 95");
  d("หลุม 1 แซม 5 บอย 6");
  const s = settleGame(store.activeGame(G));
  assert.equal(Object.values(s.perPlayer).reduce((a, b) => a + b, 0), 0);
});

test("settleGame counts a stray name instead of eating its money", () => {
  const s = settleGame({
    players: [{ name: "A" }, { name: "B" }],
    stake: 20,
    format: "all_vs_all",
    course: { holes: [{ hole: 1, par: 4 }] },
    holes: { 1: [{ name: "A", net: 4 }, { name: "B", net: 5 }, { name: "Ghost", net: 3 }] },
  });
  assert.equal(Object.values(s.perPlayer).reduce((a, b) => a + b, 0), 0);
});

// -------------------------------------------------------------------- money
test("head-eats-tail money does not depend on typing order", () => {
  const rows = [
    { name: "A", net: 4 }, { name: "B", net: 4 }, { name: "C", net: 4 },
    { name: "D", net: 4 }, { name: "E", net: 6 },
  ];
  const one = settleHoleHeadEatsTail(rows, 20);
  const two = settleHoleHeadEatsTail([rows[1], rows[0], ...rows.slice(2)], 20);
  assert.deepEqual(one, two);
  assert.equal(Object.values(one).reduce((a, b) => a + b, 0), 0);
});

test("rows with no net rank by gross instead of NaN", () => {
  const rows = [
    { name: "A", gross: 7 }, { name: "B", gross: 5 },
    { name: "C", gross: 6 }, { name: "D", gross: 4 },
  ];
  // Without a course there is no net, so no pairing can be decided — but the
  // RESULT must not depend on the order the rows arrived (it did: the sort
  // comparator returned NaN and left them in insertion order).
  const fwd = settleHoleHeadEatsTail(rows, 20);
  const rev = settleHoleHeadEatsTail([...rows].reverse(), 20);
  assert.deepEqual(fwd, rev);
  assert.equal(Object.values(fwd).reduce((a, b) => a + b, 0), 0);
  // With nets present the ranking is by net and the pairing fires.
  const withNet = rows.map((r) => ({ ...r, net: r.gross }));
  const m = settleHoleHeadEatsTail(withNet, 20);
  assert.equal(m.D, 20);
  assert.equal(m.A, -20);
});

test("par 6 gets the par-5 allowance instead of being played scratch", () => {
  const rules = { par3: 1, par4: 2, par5: 2 };
  assert.equal(strokesForHole(6, rules), 2);
  assert.equal(strokesForHole(5, rules), 2);
});

test("editing a front-nine hole after a re-handicap reports the frozen money", () => {
  const store = new GameStore();
  const G = "Gfreeze";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน"); d("สนามฟรีซ"); d("333333333 444444444"); d("ยืนยัน");
  d("20"); d("ไม่มี"); d("กินกันทุกคน");
  d("เข้าร่วม A 90 90 90"); d("เข้าร่วม B 100 100 100");
  for (let h = 1; h <= 9; h++) d(`หลุม ${h} A 4 B 5`);
  const before = settleGame(store.activeGame(G)).perPlayer;
  d("แต้มต่อใหม่");
  d("หลุม 3 A 4 B 5");
  const confirmed = d("ยืนยัน");
  const money = confirmed.summary.money;
  const after = settleGame(store.activeGame(G)).perPlayer;
  assert.deepEqual(after, before, "re-handicapping must not move front-nine money");
  assert.equal(money.A, 20, "and the message must agree with the books");
  assert.equal(money.B, -20);
});

// ------------------------------------------------------------------ courses
test("a course name is not matched on a partial word", () => {
  assert.equal(lookupPresetCourse("ไพน์เฮิร์สท"), null);
  assert.equal(lookupPresetCourse("Rachaphruek"), null);
  assert.equal(lookupPresetCourse("The Pine").total, 72);
  assert.equal(lookupPresetCourse("the pine golf club").total, 72);
});

test("a course the bot rejects is not stored", () => {
  const store = new GameStore();
  const G = "Gbadcourse";
  dispatch("สร้างเกม 2 คน", G, store);
  const holes = Array.from({ length: 17 }, (_, i) => ({ hole: i + 1, par: 4 }));
  const out = dispatch(JSON.stringify({ course: { name: "bad", holes } }), G, store);
  assert.equal(out.summary.ok, false);
  assert.equal(store.activeGame(G).course, null);
});

// -------------------------------------------------------------------- edits
test("a pending edit is cancelled by carrying on with the round", () => {
  const { store, d, G } = game("Gpending");
  d("หลุม 1 แซม 4 บอย 6");
  const asked = d("หลุม 1 แซม 9 บอย 9");
  assert.match(asked.summary.message, /ยืนยัน/);
  d("หลุม 2 แซม 4 บอย 5"); // the group just plays on
  assert.equal(store.activeGame(G).pending_override, null);
  const late = d("ยืนยัน");
  assert.doesNotMatch(String(late.summary.message), /แก้ไขหลุม 1/);
  assert.equal(store.activeGame(G).holes[1].find((r) => r.name === "แซม").gross, 4);
});

test('"ยืนยันครับ" confirms an edit like "ยืนยัน"', () => {
  const { store, d, G } = game("Gpolite");
  d("หลุม 1 แซม 4 บอย 6");
  d("หลุม 1 แซม 7 บอย 6");
  const out = d("ยืนยันครับ");
  assert.match(out.summary.message, /แก้ไขหลุม 1/);
  assert.equal(store.activeGame(G).holes[1].find((r) => r.name === "แซม").gross, 7);
});

test("a score of 0 is described as adjusted into range, not capped at the max", () => {
  const { d } = game("Gzero");
  const out = d("หลุม 1 แซม 0 บอย 6");
  assert.match(out.summary.message, /1–10/);
});

// ------------------------------------------------------------- helpers used
test("parseStake and parseFormat read the natural phrasings", () => {
  assert.equal(parseStake("หลุมละ 1,000 บาท"), 1000);
  assert.equal(parseStake("เดิมพัน 50"), 50);
  assert.equal(parseFormat("กติกา หัวกินหาง"), "head_tail");
  assert.equal(parseFormat("กินกันทุกคน"), "all_vs_all");
});

test("matchPlayerName still refuses partial words and reports ambiguity", () => {
  assert.equal(matchPlayerName(["Sammy"], "Sam").ok, false);
  assert.equal(matchPlayerName(["สมชาย ใจดี", "สมชาย รักกอล์ฟ"], "สมชาย").reason, "ambiguous");
});
