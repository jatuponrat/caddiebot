import { test } from "node:test";
import assert from "node:assert/strict";
import { GameStore } from "../gameStore.js";
import { dispatch, welcomeMessage } from "../session.js";

const par5Hole1 = () =>
  Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: i === 0 ? 5 : 4 }));

test("welcome message is Thai and mentions the bot", () => {
  assert.match(welcomeMessage(), /แคดดี้/);
});

test("full group flow: create -> join -> course -> hole with net", () => {
  const store = new GameStore();
  const G = "Cgroup1"; // a LINE groupId

  // create
  let out = dispatch("สร้างเกม 2 คน", G, store);
  assert.equal(out.action, "create_game");
  assert.match(out.room_code, /^\d{4}$/);
  assert.equal(out.summary.status, "waiting_players");

  // join A (no room code typed -> uses the group's active room)
  out = dispatch("เข้าร่วม ชื่อ A 92,95,90", G, store);
  assert.equal(out.summary.ok, true);
  assert.equal(out.summary.handicap_index, 92);
  assert.equal(out.players.length, 1);

  // join B -> roster full (2/2) => ready; diff 10 => level 1
  out = dispatch("เข้าร่วม ชื่อ B 80,82,84", G, store);
  assert.equal(out.summary.handicap_index, 82);
  assert.equal(out.players.length, 2);
  assert.equal(out.summary.status, "ready");
  assert.equal(out.handicap_level, 1);
  assert.deepEqual(out.rules, { par3: 0, par4: 1, par5: 0 });

  // set course (hole 1 = par 5) so net can be computed
  out = dispatch(JSON.stringify({ course: { name: "CC", holes: par5Hole1() } }), G, store);
  assert.equal(out.action, "extract_course");
  assert.equal(out.summary.ok, true);

  // hole 1 (par 5): A is the weaker player (hc 92 > 82) -> receives 1 stroke
  out = dispatch("หลุม 1 A 6 B 5", G, store);
  assert.equal(out.hole, 1);
  assert.equal(out.summary.par, 5);
  assert.equal(out.summary.net_computed, true);
  const by = Object.fromEntries(out.players.map((p) => [p.name, p]));
  assert.equal(by.A.strokes, 0); // level 1: par5 = 0 strokes
  assert.equal(by.A.net, 6);
  assert.equal(by.B.strokes, 0);
  assert.equal(by.B.net, 5);
});

test("hole before course is recorded but net is not computed", () => {
  const store = new GameStore();
  const G = "G2";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("เข้าร่วม ชื่อ A 92,95,90", G, store);
  dispatch("เข้าร่วม ชื่อ B 80,82,84", G, store);
  const out = dispatch("หลุม 1 A 6 B 5", G, store);
  assert.equal(out.summary.net_computed, false);
  assert.equal("net" in out.players[0], false);
});

test("join with no game in the group is rejected", () => {
  const store = new GameStore();
  const out = dispatch("เข้าร่วม ชื่อ A 92,95,90", "EmptyGroup", store);
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /ยังไม่มี|ไม่พบห้อง|สร้างเกม/);
});

test("two groups keep independent games", () => {
  const store = new GameStore();
  const a = dispatch("สร้างเกม 4 คน", "GA", store).room_code;
  const b = dispatch("สร้างเกม 4 คน", "GB", store).room_code;
  assert.notEqual(a, b);
  dispatch("เข้าร่วม ชื่อ A 90,90,90", "GA", store);
  const outB = dispatch("เข้าร่วม ชื่อ Z 80,80,80", "GB", store);
  // GB should only know about Z
  assert.equal(outB.players.length, 1);
  assert.equal(outB.players[0].name, "Z");
});

test("room code can also be typed explicitly to target a room", () => {
  const store = new GameStore();
  const code = dispatch("สร้างเกม 4 คน", "GroupX", store).room_code;
  // someone references the code directly (e.g. from a different context)
  const out = dispatch(`เข้าร่วม ${code} ชื่อ Kong 88,90,86`, "GroupX", store);
  assert.equal(out.room_code, code);
  assert.equal(out.summary.handicap_index, 88); // (88*2+90+86)/4 = 88
});

test("par card sets the course and enables net scoring", () => {
  const store = new GameStore();
  const G = "Gpar";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("เข้าร่วม ชื่อ A 92,95,90", G, store); // hc 92 (weaker)
  dispatch("เข้าร่วม ชื่อ B 80,82,84", G, store); // hc 82 (best) -> level 1

  const out = dispatch("454354434 443535444", G, store);
  assert.equal(out.action, "set_course_par");
  assert.equal(out.summary.ok, true);
  assert.equal(out.summary.total_par, 72);
  assert.match(out.summary.message, /กรอกพาร์ 72 สำเร็จ/);

  // hole 2 of the card is par 5; level 1 gives 0 strokes on par5
  const h = dispatch("หลุม 2 A 6 B 5", G, store);
  assert.equal(h.summary.par, 5);
  assert.equal(h.summary.net_computed, true);
  const by = Object.fromEntries(h.players.map((p) => [p.name, p]));
  assert.equal(by.A.strokes, 0); // level 1: par5 = 0 strokes
  assert.equal(by.A.net, 6);
  assert.equal(by.B.strokes, 0);
});

test("par card without a game asks to create one first", () => {
  const store = new GameStore();
  const out = dispatch("454354434 443535444", "GnoGame", store);
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /สร้างเกม/);
});

test("invalid par card asks to re-enter", () => {
  const store = new GameStore();
  const G = "Gbad2";
  // a fresh group with a game but skip setup straight to par entry
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("เข้าร่วม A 90 90 90", G, store); // ends setup
  const out = dispatch("45435443 443535444", G, store); // only 17 digits
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /กรอกใหม่|18/);
});

test("guided setup: course -> stake -> turbo (มี)", () => {
  const store = new GameStore();
  const G = "Gsetup";
  let out = dispatch("สร้างเกม 4 คน", G, store);
  assert.match(out.summary.message, /สนามชื่ออะไร/);
  out = dispatch("The Pine", G, store);
  assert.equal(out.action, "game_setup");
  assert.equal(out.summary.step, "stake");
  out = dispatch("20", G, store);
  assert.equal(out.summary.step, "turbo");
  out = dispatch("มี", G, store);
  assert.equal(out.summary.step, "done");
  assert.equal(out.summary.turbo, true);
  assert.deepEqual(out.summary.turbo_holes, [9, 18]);
  assert.equal(out.summary.stake, 20);
  assert.match(out.summary.message, /เทอร์โบ: หลุม 9 และ 18/);
});

test("guided setup: ไม่มี turbo", () => {
  const store = new GameStore();
  const G = "Gsetup2";
  dispatch("สร้างเกม 4 คน", G, store);
  dispatch("The Pine", G, store);
  dispatch("50", G, store);
  const out = dispatch("ไม่มี", G, store);
  assert.equal(out.summary.turbo, false);
  assert.deepEqual(out.summary.turbo_holes, []);
});

test("real gameplay bypasses pending setup", () => {
  const store = new GameStore();
  const G = "Gbypass";
  dispatch("สร้างเกม 2 คน", G, store); // setup pending
  const out = dispatch("เข้าร่วม แซม 105 90 91", G, store);
  assert.equal(out.action, "join");
  assert.equal(out.summary.ok, true);
  assert.equal(out.summary.handicap_index, 94); // (90*2+105+91)/4 = 94
});

test("turbo hole is flagged when recording scores", () => {
  const store = new GameStore();
  const G = "Gturbo";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("The Pine", G, store);
  dispatch("20", G, store);
  dispatch("มี", G, store); // turbo -> holes 9, 18
  dispatch("เข้าร่วม A 92 95 90", G, store);
  dispatch("เข้าร่วม B 80 82 84", G, store);
  dispatch("454354434 443535444", G, store); // par card
  const t = dispatch("หลุม 9 A 5 B 4", G, store);
  assert.equal(t.summary.turbo, true);
  assert.match(t.summary.message, /เทอร์โบ/);
  const n = dispatch("หลุม 1 A 5 B 4", G, store);
  assert.equal(n.summary.turbo, false);
});

test("session expires after its TTL (6h)", () => {
  const store = new GameStore();
  const G = "Gttl";
  const code = dispatch("สร้างเกม 2 คน", G, store).room_code;
  store.rooms.get(code).expires_at = Date.now() - 1000; // force-expire
  const out = dispatch("เข้าร่วม แซม 105 90 91", G, store);
  assert.equal(out.summary.ok, false); // game gone
  assert.equal(store.getGame(code), null);
});

test("preset course auto-loads pars; net works without manual entry", () => {
  const store = new GameStore();
  const G = "Gpreset";
  dispatch("สร้างเกม 2 คน", G, store);
  const c = dispatch("The Pine", G, store);
  assert.equal(c.summary.par_loaded, true);
  assert.match(c.summary.message, /โหลดพาร์ 72/);
  dispatch("20", G, store); // stake
  dispatch("ไม่มี", G, store); // turbo off
  dispatch("เข้าร่วม A 92 95 90", G, store);
  dispatch("เข้าร่วม B 80 82 84", G, store);
  const h = dispatch("หลุม 3 A 6 B 5", G, store); // The Pine hole 3 = par 5
  assert.equal(h.summary.net_computed, true);
  assert.equal(h.summary.par, 5);
});

test("unknown course -> ask pars -> confirm total -> setup (and net works)", () => {
  const store = new GameStore();
  const G = "Gunknown";
  dispatch("สร้างเกม 2 คน", G, store);
  const a = dispatch("สนามลับ XYZ", G, store);
  assert.equal(a.summary.step, "await_pars");
  assert.match(a.summary.message, /กรอกพาร์/);

  const b = dispatch("454354434 443535444", G, store); // type the pars
  assert.equal(b.summary.step, "confirm_course");
  assert.match(b.summary.message, /ครบพาร์ 72 ถูกต้องไหม/);

  const c = dispatch("ยืนยัน", G, store);
  assert.equal(c.summary.step, "stake");

  dispatch("20", G, store);
  dispatch("ไม่มี", G, store);
  dispatch("เข้าร่วม A 92 95 90", G, store);
  dispatch("เข้าร่วม B 80 82 84", G, store);
  const h = dispatch("หลุม 1 A 5 B 6", G, store); // hole 1 = par 4 from entered pars
  assert.equal(h.summary.par, 4);
  assert.equal(h.summary.net_computed, true);
});

test("unknown course -> wrong pars -> แก้ไข re-asks for pars", () => {
  const store = new GameStore();
  const G = "GunknownEdit";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("สนามใหม่", G, store); // -> await_pars
  dispatch("454354434 443535444", G, store); // -> confirm_course
  const out = dispatch("แก้ไข", G, store);
  assert.equal(out.summary.step, "await_pars");
  assert.match(out.summary.message, /กรอกพาร์/);
});

test("จบเกม ends the session", () => {
  const store = new GameStore();
  const G = "Gend";
  const code = dispatch("สร้างเกม 2 คน", G, store).room_code;
  dispatch("เข้าร่วม A 90 90 90", G, store);
  const out = dispatch("จบเกม", G, store);
  assert.equal(out.action, "end_game");
  assert.equal(out.summary.ok, true);
  assert.match(out.summary.message, /จบเกมแล้ว/);
  assert.equal(store.getGame(code), null);
});

test("จบเกม with no active game is reported", () => {
  const store = new GameStore();
  const out = dispatch("จบเกม", "GnoGame", store);
  assert.equal(out.summary.ok, false);
});

function setupMoneyGame(store, G) {
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("The Pine", G, store); // par 72 loaded
  dispatch("20", G, store); // stake 20
  dispatch("ไม่มี", G, store); // no turbo
  dispatch("เข้าร่วม A 80 80 80", G, store); // hc 80 (best)
  dispatch("เข้าร่วม B 95 95 95", G, store); // hc 95 -> diff 15 -> level 2, B gets strokes
}

test("money: per-hole pairwise shown + รวม 18 totals", () => {
  const store = new GameStore();
  const G = "Gmoney";
  setupMoneyGame(store, G);

  // The Pine hole 1 = par4 (level2 par4=1): A4 vs B5-1=4 -> tie -> 0
  let h = dispatch("หลุม 1 A 4 B 5", G, store);
  assert.equal(h.summary.net_computed, true);
  assert.equal(h.summary.money.A, 0);
  assert.equal(h.summary.money.B, 0);

  // hole 3 = par5 (par5=1): A5 vs B7-1=6 -> A wins +20
  h = dispatch("หลุม 3 A 5 B 7", G, store);
  assert.equal(h.summary.money.A, 20);
  assert.equal(h.summary.money.B, -20);
  assert.match(h.summary.message, /💰/);

  const s = dispatch("รวม 18", G, store);
  assert.equal(s.action, "settle");
  assert.equal(s.summary.per_player.A, 20);
  assert.equal(s.summary.per_player.B, -20);
});

test("money: turbo hole doubles the stake", () => {
  const store = new GameStore();
  const G = "Gturbomoney";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("The Pine", G, store);
  dispatch("20", G, store);
  dispatch("มี", G, store); // turbo on -> holes 9,18 x2
  dispatch("เข้าร่วม A 80 80 80", G, store);
  dispatch("เข้าร่วม B 80 80 80", G, store); // equal hc -> level 0, no strokes
  const h = dispatch("หลุม 9 A 4 B 5", G, store); // par4, A wins, turbo x2 -> 40
  assert.equal(h.summary.turbo, true);
  assert.equal(h.summary.money.A, 40);
  assert.equal(h.summary.money.B, -40);
});

test("bulk: submit full rounds then settle", () => {
  const store = new GameStore();
  const G = "Gbulk";
  setupMoneyGame(store, G);
  const a = dispatch("A 444444444 444444444", G, store); // all 4s
  assert.equal(a.action, "bulk_scores");
  assert.equal(a.summary.ok, true);
  dispatch("B 555555555 555555555", G, store); // all 5s
  const s = dispatch("รวม 18", G, store);
  // B (weaker) gets 1 stroke on par4/par5 -> ties those; loses only the 4 par-3 holes
  assert.equal(s.summary.per_player.A, 80); // 4 par-3 holes x 20
  assert.equal(s.summary.per_player.B, -80);
});

test("bulk: out-of-range digit is rejected", () => {
  const store = new GameStore();
  const G = "Gbulkbad";
  setupMoneyGame(store, G);
  const out = dispatch("A 044444444 444444444", G, store); // has a 0
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /1.?9|หลุม/);
});

test("จบเกม shows settlement then closes", () => {
  const store = new GameStore();
  const G = "Gendmoney";
  setupMoneyGame(store, G);
  dispatch("หลุม 3 A 5 B 7", G, store); // A +20
  const out = dispatch("จบเกม", G, store);
  assert.match(out.summary.message, /💰/);
  assert.equal(out.summary.per_player.A, 20);
  assert.equal(store.activeGame(G), null); // closed
});

test("roster complete auto-announces hole 1 with par", () => {
  const store = new GameStore();
  const G = "Gstart";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("The Pine", G, store); // hole 1 = par 4
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store);
  dispatch("เข้าร่วม A 90 90 90", G, store); // 1/2
  const out = dispatch("เข้าร่วม B 90 90 90", G, store); // 2/2 -> start
  assert.match(out.summary.message, /หลุม 1 Par 4 เริ่ม/);
});

test("per-player scoring advances to next hole when all submit", () => {
  const store = new GameStore();
  const G = "Ginc";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("The Pine", G, store);
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store);
  dispatch("เข้าร่วม A 90 90 90", G, store);
  dispatch("เข้าร่วม B 90 90 90", G, store); // start at hole 1
  const p1 = dispatch("หลุม 1 A 4", G, store); // only A
  assert.equal(p1.summary.complete, false);
  assert.match(p1.summary.message, /รออีก: B/);
  const p2 = dispatch("หลุม 1 B 5", G, store); // B completes the hole
  assert.equal(p2.summary.complete, true);
  assert.match(p2.summary.message, /หลุม 2 Par 4 เริ่ม/);
});

test("H1 shorthand records a hole like หลุม 1", () => {
  const store = new GameStore();
  const G = "Gh1";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("The Pine", G, store);
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store);
  dispatch("เข้าร่วม เอ 90 90 90", G, store);
  dispatch("เข้าร่วม บี 90 90 90", G, store);
  dispatch("H1 เอ 4", G, store); // partial
  const out = dispatch("H1 บี 5", G, store); // completes hole 1
  assert.equal(out.summary.hole, 1);
  assert.equal(out.summary.complete, true);
});

test("custom course via name+par: confirm then saved & usable", () => {
  const store = new GameStore();
  const G = "Gcustom";
  dispatch("สร้างเกม 2 คน", G, store);
  const c = dispatch("Kbsc 454435434 435444354", G, store);
  assert.equal(c.summary.step, "confirm_course");
  assert.equal(c.summary.total_par, 72);
  assert.match(c.summary.message, /ยืนยัน/);

  const ok = dispatch("ยืนยัน", G, store);
  assert.equal(ok.summary.step, "stake");
  assert.match(ok.summary.message, /บันทึกสนาม Kbsc/);

  dispatch("20", G, store);
  dispatch("ไม่มี", G, store);
  dispatch("เข้าร่วม A 92 95 90", G, store);
  dispatch("เข้าร่วม B 80 82 84", G, store);
  const h = dispatch("หลุม 2 A 6 B 5", G, store); // Kbsc hole 2 = par 5
  assert.equal(h.summary.par, 5);
  assert.equal(h.summary.net_computed, true);
});

test("saved course is remembered and reusable in a later game (by name)", () => {
  const store = new GameStore();
  dispatch("สร้างเกม 2 คน", "GAlib", store);
  dispatch("MyCourseX 454435434 435444354", "GAlib", store);
  dispatch("ยืนยัน", "GAlib", store); // saved to the course library
  // a new game — typing just the name should load the saved pars
  dispatch("สร้างเกม 2 คน", "GBlib", store);
  const out = dispatch("MyCourseX", "GBlib", store);
  assert.equal(out.summary.par_loaded, true);
  assert.match(out.summary.message, /โหลดพาร์ 72/);
});

test("custom course: invalid pars rejected; bare pars at course step need a name", () => {
  const store = new GameStore();
  const G = "Gcustom2";
  dispatch("สร้างเกม 2 คน", G, store);
  const bad = dispatch("Kbsc 454435437 435444354", G, store); // has a 7
  assert.equal(bad.summary.ok, false);
  assert.match(bad.summary.message, /3.?6|18/);

  const bare = dispatch("454435434 435444354", G, store); // no name at course step
  assert.equal(bare.summary.ok, false);
  assert.match(bare.summary.message, /ชื่อสนาม/);
});
