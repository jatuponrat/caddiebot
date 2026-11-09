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
} from "../parser.js";
import {
  settleHoleHeadEatsTail,
  settleGame,
  strokesForHole,
  matchPlayerName,
} from "../engine.js";
import { verifySignature } from "../line.js";

const PAR = "454354434 443535444";
const [FRONT, BACK] = PAR.split(" ");
// The card the old "เดอะไพน์" preset loaded, typed the new way: holes 1-9 +
// ยืนยัน at setup, holes 10-18 at the turn — so par-dependent numbers stay put.
const PINE = ["445345434", "453443544"];
const pine = (d) => {
  d(PINE[0]);
  d("ยืนยัน");
};

/** A fully set-up 2-player game on a par-72 card, 100 a hole, no turbo. */
function game(G, names = ["แซม", "บอย"], rules = "กินกันทุกคน") {
  const store = new GameStore();
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน");
  d(FRONT);
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
    d("สร้างเกม 2 คน"); d(FRONT); d("ยืนยัน"); d("100"); d("ไม่มี"); d("กินกันทุกคน");
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
  d("๔๔๕๓๔๕๔๓๔"); // holes 1-9 in Thai digits
  d("ยืนยัน");
  assert.equal(store.activeGame("Gthai").course.total_par, 36);
  d("๑๐๐");
  assert.equal(store.activeGame("Gthai").stake, 100);
});

test("an empty answer at the par step is refused without printing null", () => {
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
  d("สร้างเกม 2 คน"); d("333333333"); d("ยืนยัน");
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
test("there is no course list any more: a course name loads nothing", () => {
  const store = new GameStore();
  const d = (t) => dispatch(t, "Gnames", store);
  d("สร้างเกม 2 คน");
  for (const name of ["เดอะไพน์", "The Pine", "Rachakram", "ราชาคราม"]) {
    const out = d(name);
    assert.equal(out.summary.ok, false, `${name} must not load a card`);
    assert.equal(store.activeGame("Gnames").course, null);
    assert.equal(store.activeGame("Gnames").setup, "pars_front");
  }
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

// ------------------------------------------------------------- ดูพาร์ (new)
test("ดูพาร์ reads the saved card back, even mid-setup", () => {
  const store = new GameStore();
  const G = "Gpar";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน");
  pine(d); // holes 1-9 confirmed, now asking for the stake
  const card = d("ดูพาร์");
  assert.equal(card.action, "show_par");
  assert.equal(card.summary.ok, true);
  assert.doesNotMatch(card.summary.message, /null|undefined/);
  assert.match(card.summary.message, /📋 พาร์สนาม 9 หลุมแรก — รวม 36/);
  assert.match(card.summary.message, /OUT 36/);
  assert.match(card.summary.message, /หลุม 10-18 ยังไม่ได้กรอก — บอทจะถามตอนจบหลุม 9/);
  // ...and it did not answer the stake question for us
  assert.equal(store.activeGame(G).stake, null);
  assert.equal(d("20").summary.ok, true);
  assert.equal(store.activeGame(G).stake, 20);
});

test("ดูพาร์ lists the turbo holes and works during play", () => {
  const store = new GameStore();
  const G = "Gpar2";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน"); pine(d); d("20"); d("มี"); d("กินกันทุกคน");
  d("เข้าร่วม แซม 95 92 90"); d("เข้าร่วม บอย 99 97 95");
  d("หลุม 1 แซม 4 บอย 5");
  const card = d("เช็คพาร์");
  assert.equal(card.summary.ok, true);
  assert.match(card.summary.message, /หลุมเทอร์โบ.*9, 18/);
});

test("ดูพาร์ before a course is set explains how to set one", () => {
  const store = new GameStore();
  dispatch("สร้างเกม 2 คน", "Gpar3", store);
  const out = dispatch("ดูพาร์", "Gpar3", store);
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /ยังไม่ได้บันทึกพาร์/);
});

test("a real par card still SETS the pars, it is not read as ดูพาร์", () => {
  assert.equal(detectIntent("พาร์ 454354434 443535444"), "par_string");
  assert.equal(detectIntent("454354434 443535444"), "par_string");
  assert.equal(detectIntent("ดูพาร์"), "show_par");
  assert.equal(detectIntent("เช็คพาร์สนามหน่อย"), "show_par");
});

// ------------------------------------------------------------ สถานะ (new)
test("สถานะ shows score, handicap and money for everyone, at any time", () => {
  const store = new GameStore();
  const G = "Gstatus";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน"); pine(d); d("100"); d("ไม่มี"); d("กินกันทุกคน");
  d("เข้าร่วม แซม 95 92 90");
  d("เข้าร่วม สมชาย ใจดี 105 103 101");

  // before a single score
  const early = d("สถานะ");
  assert.equal(early.action, "status");
  assert.equal(early.summary.ok, true);
  assert.match(early.summary.message, /ยังไม่เริ่มลงสกอร์/);
  assert.match(early.summary.message, /แต้มต่อ 92/);

  for (let h = 1; h <= 3; h++) d(`หลุม ${h} แซม 4 สมชาย ใจดี 6`);
  const out = d("สถานะ");
  const msg = out.summary.message;
  assert.match(msg, /เล่นไปแล้ว 3\/18 หลุม/);
  assert.match(msg, /แซม\s+สกอร์ 12/); // 3 holes x 4
  assert.match(msg, /สมชาย ใจดี\s+สกอร์ 18/);
  assert.match(msg, /แต้มต่อ 92/);
  assert.match(msg, /เงิน \+/);
  assert.match(msg, /เงิน −/);
  assert.equal(out.summary.holes_counted, 3);
});

test("สถานะ flags a player who is a hole behind and says who we are waiting for", () => {
  const store = new GameStore();
  const G = "Gstatus2";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน"); pine(d); d("100"); d("ไม่มี"); d("กินกันทุกคน");
  d("เข้าร่วม แซม 95 92 90"); d("เข้าร่วม บอย 99 97 95");
  d("หลุม 1 แซม 4 บอย 5");
  d("หลุม 2 แซม 4"); // บอย has not sent hole 2 yet
  const msg = d("สถานะ").summary.message;
  assert.match(msg, /ลง 1 หลุม/);
  assert.match(msg, /รออีก: บอย/);
});

test("สถานะ says so when no stake was set, instead of showing 0", () => {
  const store = new GameStore();
  const G = "Gstatus3";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน");
  d("เข้าร่วม แซม 95 92 90"); d("เข้าร่วม บอย 99 97 95");
  d("454354434 443535444");
  d("หลุม 1 แซม 4 บอย 5");
  const msg = d("สถานะ").summary.message;
  assert.match(msg, /เงิน —/);
  assert.match(msg, /ยังไม่ได้ตั้งเงินเดิมพัน/);
});

test("สรุปสถานะ is a status request, not a settlement", () => {
  assert.equal(detectIntent("สรุปสถานะ"), "status");
  assert.equal(detectIntent("สถานะ"), "status");
  assert.equal(detectIntent("ถึงไหนแล้ว"), "status");
  assert.equal(detectIntent("รวม 18"), "settle");
  assert.equal(detectIntent("สรุป"), "settle");
});

// ----------------------------------------------------------- แก้พาร์ (new)
function parGame(G, pars = "444444444 444444444") {
  const store = new GameStore();
  const d = (t) => dispatch(t, G, store);
  const [front] = pars.split(" ");
  d("สร้างเกม 2 คน"); d(front); d("ยืนยัน");
  d("100"); d("ไม่มี"); d("กินกันทุกคน");
  d("เข้าร่วม แซม 92 92 92"); d("เข้าร่วม บอย 100 100 100");
  return { store, d, G };
}

test("แก้พาร์ with no numbers shows the card and how to correct it", () => {
  const { d } = parGame("Gfix1");
  const out = d("แก้พาร์");
  assert.equal(out.action, "edit_par");
  assert.match(out.summary.message, /📋 พาร์สนาม/);
  assert.match(out.summary.message, /ทีละหลุม/);
  assert.match(out.summary.message, /แก้พาร์ หลุม 7 เป็น 5/);
});

test("แก้พาร์ before any score applies straight away", () => {
  const { store, d, G } = parGame("Gfix2");
  const out = d("แก้พาร์ หลุม 3 เป็น 5");
  assert.equal(out.summary.ok, true);
  assert.equal(out.summary.changed, true);
  assert.equal(store.activeGame(G).course.holes[2].par, 5);
  assert.match(out.summary.message, /หลุม 3: 4 → 5/);
});

test("แก้พาร์ mid-round asks first, then recomputes the money", () => {
  const { store, d, G } = parGame("Gfix3");
  for (let h = 1; h <= 3; h++) d(`หลุม ${h} แซม 4 บอย 5`);
  const before = settleGame(store.activeGame(G)).perPlayer;
  assert.equal(before["แซม"], 0, "level-2 strokes make these holes ties");

  const asked = d("แก้พาร์ หลุม 1 เป็น 5");
  assert.equal(asked.summary.ok, false);
  assert.equal(asked.summary.pending, true);
  assert.match(asked.summary.message, /หลุม 1: 4 → 5/);
  assert.match(asked.summary.message, /ลงสกอร์ไปแล้ว 3 หลุม/);
  assert.equal(store.activeGame(G).course.holes[0].par, 4, "nothing changes before ยืนยัน");

  const done = d("ยืนยัน");
  assert.equal(done.summary.ok, true);
  assert.equal(store.activeGame(G).course.holes[0].par, 5);
  const after = settleGame(store.activeGame(G)).perPlayer;
  assert.notDeepEqual(after, before, "hole 1 loses its stroke, so the money moves");
  assert.equal(Object.values(after).reduce((a, b) => a + b, 0), 0);
  assert.match(done.summary.message, /เงินที่คิดใหม่/);
});

test("ยกเลิก leaves the old pars alone", () => {
  const { store, d, G } = parGame("Gfix4");
  d("หลุม 1 แซม 4 บอย 5");
  d("แก้พาร์ หลุม 1 เป็น 3");
  const out = d("ยกเลิก");
  assert.equal(out.summary.ok, false);
  assert.equal(store.activeGame(G).course.holes[0].par, 4);
  assert.equal(store.activeGame(G).pending_par_edit, null);
});

test("a corrected card belongs to this round only — the next game starts blank", () => {
  const { store, d, G } = parGame("Gfix5");
  d("แก้พาร์ หลุม 2 เป็น 3");
  assert.equal(store.activeGame(G).course.holes[1].par, 3);
  d("จบเกม");
  d("สร้างเกม 2 คน");
  assert.equal(store.activeGame(G).course, null, "no card is carried into the next game");
});

test("แก้พาร์ rejects an impossible hole or par", () => {
  const { d } = parGame("Gfix6");
  assert.equal(d("แก้พาร์ หลุม 25 เป็น 4").summary.ok, false);
  assert.equal(d("แก้พาร์ หลุม 3 เป็น 9").summary.ok, false);
});

test("แก้พาร์ that changes nothing says so", () => {
  const { d } = parGame("Gfix7");
  const out = d("แก้พาร์ หลุม 1 เป็น 4");
  assert.equal(out.summary.changed, false);
  assert.match(out.summary.message, /ตรงกับที่บันทึกไว้/);
});

test("the one-hole form is not mistaken for a score line", () => {
  assert.equal(detectIntent("แก้พาร์ หลุม 7 เป็น 5"), "edit_par");
  assert.equal(detectIntent("หลุม 7 แซม 5"), "hole_scores");
});

test("the typed front nine is shown before it counts", () => {
  const store = new GameStore();
  const G = "Gload";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน");
  const out = d(PINE[0]);
  assert.equal(out.summary.step, "confirm_course");
  assert.match(out.summary.message, /หลุม 1-9: 4 4 5 3 4 5 4 3 4 \(OUT 36\)/);
  assert.match(out.summary.message, /ยืนยัน/);
  assert.equal(store.activeGame(G).course, null, "nothing counts before ยืนยัน");
});

test("18 digits are never taken — not at setup, not on the ยืนยัน screen, not as a fix", () => {
  const store = new GameStore();
  const G = "Gno18";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน");
  assert.match(d(PAR).summary.message, /ทีละ 9 หลุม/);
  d(FRONT);
  assert.match(d(PAR).summary.message, /ทีละ 9 หลุม/);
  assert.equal(store.activeGame(G).setup, "confirm_course");
  d("ยืนยัน");
  const fix = d(`แก้พาร์ ${PAR}`);
  assert.equal(fix.summary.ok, false);
  assert.match(fix.summary.message, /ทีละหลุม/);
  assert.equal(store.activeGame(G).course.holes.length, 9);
});

test("the front nine can be corrected on the spot — before and after ยืนยัน", () => {
  const store = new GameStore();
  const G = "Gload2";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน");
  d(PINE[0]);
  // still on the ยืนยัน screen: the unconfirmed nine is fixed in place
  const early = d("แก้พาร์ หลุม 1 เป็น 5");
  assert.equal(early.summary.ok, true);
  assert.match(early.summary.message, /หลุม 1: 4 → 5/);
  assert.match(early.summary.message, /\(OUT 37\)\nถูกต้องไหม/);
  assert.equal(store.activeGame(G).setup, "confirm_course");
  // a back-nine hole has nothing to fix yet
  assert.match(d("แก้พาร์ หลุม 12 เป็น 5").summary.message, /ตอนจบหลุม 9/);
  d("ยืนยัน");
  assert.equal(store.activeGame(G).course.holes[0].par, 5);
  // after ยืนยัน it applies straight away, and the open question is asked again
  const fix = d("แก้พาร์ หลุม 1 เป็น 4");
  assert.equal(fix.summary.ok, true);
  assert.equal(store.activeGame(G).course.holes[0].par, 4);
  assert.match(fix.summary.message, /หลุมละเท่าไร/);
  // ...and the setup carries on where it left off
  assert.equal(d("20").summary.ok, true);
  assert.equal(store.activeGame(G).stake, 20);
});

test("the front nine goes through its own ยืนยัน step", () => {
  const store = new GameStore();
  const G = "Gload3";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน");
  const asked = d(FRONT);
  assert.match(asked.summary.message, /ยืนยัน/);
});

test("the turn at hole 9: money summary first, then the back-nine pars are asked for", () => {
  const store = new GameStore();
  const G = "Gturn";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน"); pine(d); d("100"); d("ไม่มี"); d("กินกันทุกคน");
  d("เข้าร่วม แซม 92 92 92"); d("เข้าร่วม บอย 100 100 100");
  for (let h = 1; h <= 8; h++) {
    const out = d(`หลุม ${h} แซม 4 บอย 5`);
    assert.doesNotMatch(out.summary.message, /9 หลุมหลัง \(หลุม 10-18\)/, `hole ${h} must stay quiet`);
  }
  const turn = d("หลุม 9 แซม 4 บอย 5");
  const m = turn.summary.message;
  assert.equal(turn.summary.back_nine_pars_needed, true);
  assert.match(m, /จบ OUT/, "the money summary of the front nine");
  assert.match(m, /สกอร์ OUT/);
  assert.match(m, /จบ 9 หลุมแรก — กรอกพาร์ 9 หลุมหลัง \(หลุม 10-18\)/);
  assert.ok(m.indexOf("จบ OUT") < m.indexOf("กรอกพาร์ 9 หลุมหลัง"), "money first, then the pars");
  assert.doesNotMatch(m, /หลุม 10 (Par \d )?เริ่ม/, "hole 10 is not announced without its par");

  const back = d(PINE[1]);
  assert.equal(back.summary.ok, true);
  assert.equal(back.summary.pending, true);
  assert.match(back.summary.message, /หลุม 10-18: 4 5 3 4 4 3 5 4 4 \(IN 36\) — พาร์รวม 72\nถูกต้องไหม/);
  assert.equal(store.activeGame(G).course.holes.length, 9, "nothing counts before ยืนยัน");

  const ok = d("ยืนยัน");
  assert.match(ok.summary.message, /บันทึกพาร์ 9 หลุมหลังแล้ว \(IN 36\) ✅ — พาร์รวม 72/);
  assert.match(ok.summary.message, /หลุม 10 Par 4 เริ่ม/);
  assert.equal(store.activeGame(G).course.holes.length, 18);
});

test("a par fixed at the turn recomputes only what it should", () => {
  const store = new GameStore();
  const G = "Gturn2";
  const d = (t) => dispatch(t, G, store);
  d("สร้างเกม 2 คน"); pine(d); d("100"); d("ไม่มี"); d("กินกันทุกคน");
  d("เข้าร่วม แซม 92 92 92"); d("เข้าร่วม บอย 100 100 100");
  for (let h = 1; h <= 9; h++) d(`หลุม ${h} แซม 4 บอย 5`);
  d(PINE[1]); // the back nine, typed at the turn…
  d("ยืนยัน"); // …and confirmed
  const before = settleGame(store.activeGame(G)).perPlayer;

  d("แก้พาร์ หลุม 12 เป็น 5"); // a hole nobody has played yet
  const done = d("ยืนยัน");
  assert.equal(done.summary.ok, true);
  assert.equal(store.activeGame(G).course.holes[11].par, 5);
  const after = settleGame(store.activeGame(G)).perPlayer;
  assert.deepEqual(after, before, "holes 1-9 are untouched by a hole-12 fix");
});
