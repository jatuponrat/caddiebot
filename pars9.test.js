// pars9.test.js
// The par card goes in nine holes at a time: holes 1-9 (+ ยืนยัน) when the game
// is set up, holes 10-18 (+ ยืนยัน) at the turn — after hole 9 is played and the
// front-nine money is shown. Never 18 digits at once. No course name is asked
// for and no course is remembered between games.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameStore } from "../gameStore.js";
import { dispatch, welcomeMessage } from "../session.js";
import { settleGame } from "../engine.js";

const FRONT = "454354434"; // OUT 36 — hole 2 is a par 5
const BACK = "443535444"; // IN 36 — hole 12 is a par 3, hole 13 a par 5

/** A game with a 2-player roster; `setupTo` stops the Q&A early when asked. */
function setup(G = "G9", { stake = "100", players = true } = {}) {
  const store = new GameStore();
  const d = (t) => dispatch(t, G, store);
  const created = d("สร้างเกม 2 คน");
  const game = () => store.activeGame(G);
  return { store, d, G, created, game, ready };
  function ready() {
    d(FRONT);
    d("ยืนยัน");
    if (stake) d(stake);
    d("ไม่มี");
    d("2");
    if (players) {
      d("เข้าร่วม แซม 95 92 90");
      d("เข้าร่วม บอย 99 97 95");
    }
  }
}
const playHoles = (d, from, to, line = (h) => `หลุม ${h} แซม 4 บอย 5`) => {
  let out;
  for (let h = from; h <= to; h++) out = d(line(h));
  return out;
};

test("สร้างเกม asks for holes 1-9 straight away — no course name", () => {
  const { created, game } = setup();
  assert.match(created.summary.message, /กรอกพาร์ 9 หลุมแรก \(หลุม 1-9\) เช่น "454354434"/);
  assert.doesNotMatch(created.summary.message, /ชื่อสนาม|สนามชื่อ/);
  assert.equal(game().setup, "pars_front");
});

test("setup takes holes 1-9 only; the stored card is the front nine", () => {
  const { d, game } = setup();
  const shown = d(FRONT);
  assert.equal(shown.summary.step, "confirm_course");
  assert.match(shown.summary.message, /หลุม 1-9: 4 5 4 3 5 4 4 3 4 \(OUT 36\)/);
  const ok = d("ยืนยัน");
  assert.equal(ok.summary.step, "stake");
  const holes = game().course.holes;
  assert.equal(holes.length, 9);
  assert.deepEqual(holes.map((h) => h.par), [4, 5, 4, 3, 5, 4, 4, 3, 4]);
  assert.equal(game().course.total_par, 36);
});

test("18 digits at once are refused, in the Q&A and after it", () => {
  const { d, game } = setup();
  const a = d(`${FRONT} ${BACK}`);
  assert.equal(a.summary.ok, false);
  assert.match(a.summary.message, /ทีละ 9 หลุม/);
  assert.match(a.summary.message, /9 หลุมหลังบอทจะถามตอนจบหลุม 9/);
  assert.equal(game().pending_course, null);
  d("เข้าร่วม แซม 95 92 90"); // closes the Q&A
  const b = d(`${FRONT}${BACK}`);
  assert.equal(b.summary.ok, false);
  assert.match(b.summary.message, /ทีละ 9 หลุม/);
  assert.equal(game().course, null);
});

test("แก้ไข on the ยืนยัน screen asks for holes 1-9 again", () => {
  const { d, game } = setup();
  d("454354435"); // oops
  const out = d("แก้ไข");
  assert.equal(out.summary.step, "pars_front");
  assert.equal(game().pending_course, null);
  d(FRONT);
  d("ยืนยัน");
  assert.equal(game().course.holes[8].par, 4);
});

test("a corrected nine on the ยืนยัน screen replaces the one shown", () => {
  const { d, game } = setup();
  d("454354435");
  const again = d(FRONT);
  assert.equal(again.summary.step, "confirm_course");
  assert.match(again.summary.message, /\(OUT 36\)/);
  d("ยืนยัน");
  assert.equal(game().course.total_par, 36);
});

test("a typo in a nine is refused — it is never read as a room code / join", () => {
  const { d, game, ready } = setup();
  const out = d("454354437"); // has a 7; looks like a 9-digit room code
  assert.equal(out.action, "game_setup");
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /3.?6/);
  assert.equal(game().setup, "pars_front", "the Q&A must stay open");
  assert.equal(game().players.length, 0);
  // and the same at the turn
  ready();
  playHoles(d, 1, 9);
  const back = d("44353544"); // 8 digits
  assert.equal(back.summary.ok, false);
  assert.match(back.summary.message, /นับได้ 8 ตัว/);
  assert.equal(game().course.holes.length, 9);
});

test("digits with separators are fine", () => {
  const { d, game } = setup();
  d("4 5 4 3 5 4 4 3 4");
  d("ยืนยัน");
  assert.equal(game().course.total_par, 36);
});

test("the back nine is not taken before the turn — the bot asks for it after hole 9", () => {
  const { d, game, ready } = setup();
  ready();
  playHoles(d, 1, 5);
  const early = d(BACK);
  assert.equal(early.summary.ok, false);
  assert.match(early.summary.message, /ตอนจบหลุม 9/);
  assert.equal(game().course.holes.length, 9);
});

test("the turn: front-nine money, then the back-nine pars, then hole 10", () => {
  const { d, game, ready } = setup();
  ready();
  playHoles(d, 1, 8);
  const turn = d("หลุม 9 แซม 4 บอย 5");
  const m = turn.summary.message;
  assert.equal(turn.summary.turn_summary, true);
  assert.equal(turn.summary.back_nine_pars_needed, true);
  assert.match(m, /จบ OUT \(หลุม 1-9\) · ยอดสะสม/);
  assert.match(m, /แซม {2}\+700/); // บอย's stroke halves the two par 5s
  assert.match(m, /⛳ จบ 9 หลุมแรก — กรอกพาร์ 9 หลุมหลัง \(หลุม 10-18\) เช่น "443535444"/);
  assert.ok(m.indexOf("ยอดสะสม") < m.indexOf("กรอกพาร์ 9 หลุมหลัง"));
  assert.doesNotMatch(m, /หลุม 10 (Par \d )?เริ่ม/);

  const back = d(BACK);
  assert.equal(back.action, "set_course_par");
  assert.equal(back.summary.ok, true);
  assert.equal(back.summary.total_par, 72);
  assert.match(back.summary.message, /หลุม 10-18: 4 4 3 5 3 5 4 4 4 \(IN 36\) — พาร์รวม 72\nถูกต้องไหมครับ\? \(พิมพ์ ยืนยัน \/ แก้ไข\)/);
  assert.equal(game().course.holes.length, 9, "nothing counts before ยืนยัน");
  const ok = d("ยืนยัน");
  assert.match(ok.summary.message, /บันทึกพาร์ 9 หลุมหลังแล้ว \(IN 36\) ✅ — พาร์รวม 72/);
  assert.match(ok.summary.message, /⛳ หลุม 10 Par 4 เริ่ม/);
  assert.equal(game().course.holes.length, 18);
  assert.equal(game().course.holes[12].par, 5); // hole 13

  const h12 = playHoles(d, 10, 12);
  assert.equal(h12.summary.par, 3);
  assert.equal(h12.summary.net_computed, true);
  assert.match(h12.summary.message, /💰 หลุมนี้/);
  assert.match(h12.summary.message, /หลุม 13 Par 5 เริ่ม/);
});

test("no stake: there is no money summary, but the back nine is still asked for", () => {
  const { d, game } = setup("G9nostake");
  d(FRONT);
  d("ยืนยัน");
  d("เข้าร่วม แซม 95 92 90"); // closes the Q&A with no stake set
  d("เข้าร่วม บอย 99 97 95");
  assert.equal(game().stake, null);
  const turn = playHoles(d, 1, 9);
  assert.notEqual(turn.summary.turn_summary, true);
  assert.match(turn.summary.message, /กรอกพาร์ 9 หลุมหลัง/);
});

test("hole 9 completed out of order still asks for the back nine", () => {
  const { d, ready } = setup();
  ready();
  let out;
  for (const h of [1, 3, 9]) out = d(`หลุม ${h} แซม 4 บอย 5`);
  assert.equal(out.summary.back_nine_pars_needed, true);
});

test("back-nine holes scored before their pars: not counted, said out loud, settled later", () => {
  const { d, game, ready } = setup();
  ready();
  playHoles(d, 1, 9);
  const h10 = d("หลุม 10 แซม 4 บอย 5"); // the group ignored the prompt
  assert.equal(h10.summary.net_computed, false);
  assert.match(h10.summary.message, /ยังไม่มีพาร์ 9 หลุมหลัง — หลุม 10-18 ยังไม่คิดเงิน/);
  d("หลุม 11 แซม 4 บอย 5");
  const half = d("รวม 18");
  assert.match(half.summary.message, /หลุม 10-18 ยังไม่คิดเงิน/);
  assert.equal(half.summary.per_player["แซม"], 700, "only holes 1-9 so far");
  const status = d("สถานะ").summary.message;
  assert.match(status, /แซม\s+สกอร์ 44 \(\+0\)/, "vs par only over holes whose par is known");

  d(BACK);
  assert.match(d("สถานะ").summary.message, /พาร์ 9 หลุมหลังยังไม่ได้ยืนยัน — หลุม 10-18 ยังไม่คิดเงิน/);
  const ok = d("ยืนยัน");
  assert.match(ok.summary.message, /คิดเงินหลุมหลังที่ลงไปแล้วให้แล้ว/);
  assert.equal(settleGame(game()).perPlayer["แซม"], 900, "holes 10-11 (par 4s) now count");
  assert.doesNotMatch(d("รวม 18").summary.message, /ยังไม่คิดเงิน/);
});

test("a join on the ยืนยัน screen uses the typed front nine", () => {
  const { d, game } = setup();
  d(FRONT);
  const j = d("เข้าร่วม แซม 95 92 90");
  assert.match(j.summary.message, /ใช้พาร์ 9 หลุมแรกที่กรอกไว้ \(OUT 36\)/);
  assert.doesNotMatch(j.summary.message, /พาร์สนาม —/, "pars are not listed as missing");
  assert.equal(game().course.holes.length, 9);
  assert.equal(game().pending_course, null);
});

test("pars typed after the Q&A closed: holes 1-9 count at once, 10-18 at the turn", () => {
  const { d, game } = setup();
  const j = d("เข้าร่วม แซม 95 92 90"); // closes the Q&A before any par
  assert.match(j.summary.message, /พาร์สนาม — กรอกพาร์ 9 หลุมแรก/);
  d("เข้าร่วม บอย 99 97 95"); // roster full, still no card
  const f = d(FRONT);
  assert.equal(f.action, "set_course_par");
  assert.match(f.summary.message, /หลุม 1-9: 4 5 4 3 5 4 4 3 4 \(OUT 36\) ✅/);
  assert.match(f.summary.message, /ตอนจบหลุม 9/);
  assert.match(f.summary.message, /หลุม 1 Par 4 เริ่ม/, "the round starts once holes 1-9 are in");
  assert.equal(game().course.holes.length, 9);
  const h2 = d("หลุม 2 แซม 5 บอย 6");
  assert.equal(h2.summary.par, 5);
  assert.equal(h2.summary.net_computed, true);
});

test("a nine sent once the card is complete changes nothing", () => {
  const { d, game, ready } = setup();
  ready();
  playHoles(d, 1, 9);
  d(BACK);
  d("ยืนยัน");
  const before = JSON.stringify(game().course);
  const out = d(BACK);
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /ครบ 18 หลุมแล้ว/);
  assert.equal(JSON.stringify(game().course), before);
});

test("holes 10-18 go through ยืนยัน: shown, held, then counted", () => {
  const { d, game, ready } = setup();
  ready();
  playHoles(d, 1, 9);
  assert.match(d(`${FRONT} ${BACK}`).summary.message, /ทีละ 9 หลุม/, "18 digits are refused here too");
  d(BACK);
  assert.deepEqual(game().pending_back9.pars, [4, 4, 3, 5, 3, 5, 4, 4, 4]);
  const card = d("ดูพาร์").summary.message;
  assert.match(card, /📋 พาร์สนาม — รวม 72 \(9 หลุมหลังรอยืนยัน\)/);
  assert.match(card, /หลุม 10-18 4 4 3 5 3 5 4 4 4 {2}\(IN 36\)/);
  assert.match(card, /⚠️ 9 หลุมหลังยังไม่ได้ยืนยัน/);
  // chatter neither confirms nor drops it
  for (const msg of ["555", "ไปกินข้าวกันไหม", "สวัสดีครับ"]) d(msg);
  assert.ok(game().pending_back9, "still waiting for ยืนยัน");
  assert.equal(game().course.holes.length, 9);
  d("ยืนยันครับ");
  assert.equal(game().pending_back9, null);
  assert.equal(game().course.holes.length, 18);
});

test("แก้ไข on the back-nine ยืนยัน drops it and asks for holes 10-18 again", () => {
  const { d, game, ready } = setup();
  ready();
  playHoles(d, 1, 9);
  d("443535445"); // oops
  const out = d("แก้ไข");
  assert.match(out.summary.message, /กรอกใหม่\nกรอกพาร์ 9 หลุมหลัง \(หลุม 10-18\)/);
  assert.equal(game().pending_back9, null);
  assert.equal(game().course.holes.length, 9);
  d(BACK);
  d("ยืนยัน");
  assert.equal(game().course.holes[17].par, 4);
});

test("a corrected nine, or แก้พาร์ หลุม 12, fixes the held back nine and asks again", () => {
  const { d, game, ready } = setup();
  ready();
  playHoles(d, 1, 9);
  d("443535445");
  const again = d(BACK); // typed again: replaces the one shown
  assert.match(again.summary.message, /\(IN 36\) — พาร์รวม 72\nถูกต้องไหม/);
  const fix = d("แก้พาร์ หลุม 12 เป็น 4");
  assert.match(fix.summary.message, /หลุม 12: 3 → 4/);
  assert.match(fix.summary.message, /\(IN 37\) — พาร์รวม 73\nถูกต้องไหม/);
  assert.equal(game().course.holes.length, 9, "still held");
  d("ยืนยัน");
  assert.equal(game().course.holes[11].par, 4);
  assert.equal(game().course.total_par, 73);
});

test("playing on without ยืนยัน uses the typed back nine — and says so", () => {
  for (const next of ["หลุม 10 แซม 4 บอย 5", "รวม 18", "จบเกม", "แซม 444444444 444444444"]) {
    const { d, game, ready } = setup(`Gauto-${next}`);
    ready();
    playHoles(d, 1, 9);
    d(BACK);
    const out = d(next);
    assert.match(out.summary.message, /✅ ใช้พาร์ 9 หลุมหลังที่กรอกไว้ \(IN 36\) — พาร์รวม 72/, next);
    if (game()) assert.equal(game().course.holes.length, 18, next);
  }
  // and the hole that triggered it is netted and paid on the back-nine par
  const { d, ready } = setup("Gauto-net");
  ready();
  playHoles(d, 1, 9);
  d(BACK);
  const h10 = d("หลุม 10 แซม 4 บอย 5");
  assert.equal(h10.summary.par, 4);
  assert.equal(h10.summary.net_computed, true);
  assert.match(h10.summary.message, /💰 หลุมนี้/);
});

test("ยืนยัน for a re-sent hole is answered first; the back nine keeps waiting", () => {
  const { d, game, ready } = setup();
  ready();
  playHoles(d, 1, 9);
  d(BACK); // held
  d("หลุม 9 แซม 5 บอย 5"); // hole 9 again -> "ยืนยันแก้ไขไหม?"
  const first = d("ยืนยัน");
  assert.match(first.summary.message, /แก้ไขหลุม 9 แล้ว/);
  assert.ok(game().pending_back9, "the back nine is still waiting");
  const second = d("ยืนยัน");
  assert.match(second.summary.message, /บันทึกพาร์ 9 หลุมหลังแล้ว/);
  assert.equal(game().course.holes.length, 18);
});

test("a late nine on the stake question is not taken as the stake", () => {
  const { d, game } = setup();
  d(FRONT);
  d("ยืนยัน"); // now asking the stake
  const out = d(FRONT); // someone re-sends the nine
  assert.equal(out.summary.ok, false);
  assert.equal(game().stake, null, "454354434 baht a hole is not a stake");
  assert.match(out.summary.message, /หลุมละเท่าไร/, "the open question is asked again");
  assert.equal(d("20").summary.ok, true);
  assert.equal(game().stake, 20);
});

test("ดูพาร์ shows holes 1-9, and asks for 10-18 once the turn is reached", () => {
  const { d, ready } = setup();
  ready();
  const early = d("ดูพาร์").summary.message;
  assert.match(early, /📋 พาร์สนาม 9 หลุมแรก — รวม 36/);
  assert.match(early, /หลุม 10-18 ยังไม่ได้กรอก — บอทจะถามตอนจบหลุม 9/);
  playHoles(d, 1, 9);
  assert.match(d("ดูพาร์").summary.message, /หลุม 10-18 ยังไม่ได้กรอก — กรอกพาร์ 9 หลุมหลัง/);
  d(BACK);
  assert.match(d("ดูพาร์").summary.message, /📋 พาร์สนาม — รวม 72/);
});

test("สถานะ and ตกลง at the turn point at the back-nine pars", () => {
  const { d, ready } = setup();
  ready();
  playHoles(d, 1, 9);
  assert.match(d("สถานะ").summary.message, /⛳ กรอกพาร์ 9 หลุมหลัง/);
  d("แต้มต่อ");
  const ack = d("ตกลง");
  assert.equal(ack.action, "handicap_ack");
  assert.match(ack.summary.message, /กรอกพาร์ 9 หลุมหลัง/);
});

test("แต้มต่อ with only holes 1-9 labels the totals as front-nine totals", () => {
  const { d, ready } = setup();
  d(FRONT);
  d("ยืนยัน");
  d("เข้าร่วม แซม 90 90 90");
  d("เข้าร่วม บอย 120 120 120");
  assert.match(d("แต้มต่อ").summary.message, /แต้ม \(9 หลุมแรก\)/);
});

test("หลุมละ 20 typed during par entry is kept and the stake question skipped", () => {
  const { d, game } = setup();
  const s = d("หลุมละ 20");
  assert.equal(s.summary.ok, true);
  assert.equal(game().stake, 20);
  assert.equal(game().setup, "pars_front");
  d(FRONT);
  const ok = d("ยืนยัน");
  assert.equal(ok.summary.step, "turbo");
  assert.match(ok.summary.message, /เทอร์โบ/);
});

test("a round restored mid-setup from the old name-first steps carries on with holes 1-9", () => {
  for (const legacy of ["course", "await_pars"]) {
    const { store, d, G, game } = setup(`Glegacy-${legacy}`);
    game().setup = legacy; // as saved by the previous version
    game().course_name = legacy === "await_pars" ? "Kbsc" : null;
    store.save(game());
    const out = d(FRONT);
    assert.equal(out.summary.step, "confirm_course", legacy);
    d("ยืนยัน");
    assert.equal(store.activeGame(G).course.total_par, 36, legacy);
  }
});

test("an old 18-hole card awaiting ยืนยัน (saved before this version) is still accepted", () => {
  const { store, d, G, game } = setup("Glegacy18");
  const holes = (FRONT + BACK).split("").map((p, i) => ({ hole: i + 1, par: Number(p) }));
  game().pending_course = { holes, total: 72 };
  game().setup = "confirm_course";
  game().course_name = "Kbsc";
  store.save(game());
  const ok = d("ยืนยัน");
  assert.match(ok.summary.message, /บันทึกพาร์สนามแล้ว \(รวม 72\)/);
  assert.equal(store.activeGame(G).course.holes.length, 18);
});

test("plain digits chatter (555) stays chatter", () => {
  const { d, ready } = setup();
  ready();
  assert.equal(d("555").action, "unknown", "the server stays silent on 'unknown' in a group");
});

test("a 9-hole round: play 9, จบเกม — settled with no back-nine warning", () => {
  const { d, ready } = setup();
  ready();
  playHoles(d, 1, 9);
  const end = d("จบเกม");
  assert.match(end.summary.message, /แซม \+700/);
  assert.doesNotMatch(end.summary.message, /ไม่ได้คิดเงิน/);
});

test("the finished setup and จบเกม show no empty course name", () => {
  const { d } = setup();
  d(FRONT);
  d("ยืนยัน");
  d("20");
  d("ไม่มี");
  const done = d("2");
  assert.match(done.summary.message, /พาร์ 9 หลุมแรก 36 · หลุมละ 20/);
  assert.doesNotMatch(done.summary.message, /สนาม (null|undefined|-)/);
  d("เข้าร่วม แซม 95 92 90");
  d("เข้าร่วม บอย 99 97 95");
  d("หลุม 1 แซม 4 บอย 5");
  const end = d("จบเกม");
  assert.doesNotMatch(end.summary.message, /สนาม/);
  assert.match(end.summary.message, /ผู้เล่น: แซม, บอย/);
});

test("the welcome message teaches 9 holes at setup, 9 at the turn", () => {
  assert.match(welcomeMessage(), /ทีละ 9 หลุม/);
  assert.match(welcomeMessage(), /ตอนจบหลุม 9/);
  assert.doesNotMatch(welcomeMessage(), /454354434 443535444/);
});
