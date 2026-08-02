import { test } from "node:test";
import assert from "node:assert/strict";
import { GameStore, SESSION_TTL_MS } from "../gameStore.js";
import { dispatch, welcomeMessage, isIdle } from "../session.js";

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

  // join B -> roster full (2/2) => ready; gap 10 => level 2 (par4 only)
  out = dispatch("เข้าร่วม ชื่อ B 80,82,84", G, store);
  assert.equal(out.summary.handicap_index, 82);
  assert.equal(out.players.length, 2);
  assert.equal(out.summary.status, "ready");

  // set course (hole 1 = par 5) so net can be computed
  out = dispatch(JSON.stringify({ course: { name: "CC", holes: par5Hole1() } }), G, store);
  assert.equal(out.action, "extract_course");
  assert.equal(out.summary.ok, true);

  // hole 1 is a par 5; gap 10 -> level 2 gives par4 only, so nothing here
  out = dispatch("หลุม 1 A 6 B 5", G, store);
  assert.equal(out.hole, 1);
  assert.equal(out.summary.par, 5);
  assert.equal(out.summary.net_computed, true);
  const by = Object.fromEntries(out.players.map((p) => [p.name, p]));
  assert.equal(by.A.strokes, 0);
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

test("join with no game in the group is ignored silently", () => {
  const store = new GameStore();
  const out = dispatch("เข้าร่วม ชื่อ A 92,95,90", "EmptyGroup", store);
  assert.equal(out.action, "idle");
  assert.equal(out.summary.ok, false);
  assert.equal(out.summary.message, "");
  assert.equal(isIdle(out), true);
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
  dispatch("เข้าร่วม ชื่อ B 80,82,84", G, store); // hc 82 (best) -> gap 10

  const out = dispatch("454354434 443535444", G, store);
  assert.equal(out.action, "set_course_par");
  assert.equal(out.summary.ok, true);
  assert.equal(out.summary.total_par, 72);
  assert.match(out.summary.message, /กรอกพาร์ 72 สำเร็จ/);

  // hole 2 is a par 5; gap 10 -> level 2 is par4-only, so no stroke here
  const h = dispatch("หลุม 2 A 6 B 5", G, store);
  assert.equal(h.summary.par, 5);
  assert.equal(h.summary.net_computed, true);
  const by = Object.fromEntries(h.players.map((p) => [p.name, p]));
  assert.equal(by.A.strokes, 0);
  assert.equal(by.A.net, 6);
  assert.equal(by.B.strokes, 0);
});

test("par card without a game is ignored silently", () => {
  const store = new GameStore();
  const out = dispatch("454354434 443535444", "GnoGame", store);
  assert.equal(out.action, "idle");
  assert.equal(out.summary.message, "");
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

test("guided setup: course -> stake -> turbo -> format (full flow)", () => {
  const store = new GameStore();
  const G = "Gsetup";
  let out = dispatch("สร้างเกม 4 คน", G, store);
  assert.match(out.summary.message, /สนามชื่ออะไร/);
  out = dispatch("The Pine", G, store);
  assert.equal(out.action, "game_setup");
  assert.equal(out.summary.step, "stake");
  out = dispatch("20", G, store);
  assert.equal(out.summary.step, "turbo");
  // turbo now advances to format step
  out = dispatch("มี", G, store);
  assert.equal(out.summary.step, "format");
  assert.equal(out.summary.turbo, true);
  assert.deepEqual(out.summary.turbo_holes, [9, 18]);
  assert.equal(out.summary.stake, 20);
  assert.match(out.summary.message, /เทอร์โบ: หลุม 9 และ 18/);
  assert.match(out.summary.message, /กินกันทุกคน|หัวกินหาง/);
  // menu is 1 = หัวกินหาง, 2 = กินกันทุกคน
  assert.match(out.summary.message, /1️⃣ หัวกินหาง[\s\S]*2️⃣ กินกันทุกคน/);
  // choose กินกันทุกคน -> done
  out = dispatch("2", G, store);
  assert.equal(out.summary.step, "done");
  assert.equal(out.summary.format, "all_vs_all");
  assert.match(out.summary.message, /ตั้งค่าเกมเรียบร้อย/);
});

test("guided setup: กติกา step rejects invalid answer", () => {
  const store = new GameStore();
  const G = "GformatBad";
  dispatch("สร้างเกม 4 คน", G, store);
  dispatch("The Pine", G, store);
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store); // turbo -> now at format step
  const out = dispatch("บางอย่าง", G, store);
  assert.equal(out.summary.ok, false);
  assert.equal(out.summary.step, "format");
});

test("guided setup: หัวกินหาง selected and stored on game", () => {
  const store = new GameStore();
  const G = "Gformat2";
  dispatch("สร้างเกม 4 คน", G, store);
  dispatch("The Pine", G, store);
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store); // turbo -> format step
  const out = dispatch("1", G, store); // select หัวกินหาง
  assert.equal(out.summary.step, "done");
  assert.equal(out.summary.format, "head_tail");
  assert.match(out.summary.message, /หัวกินหาง/);
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

test("session expires after its TTL (12h idle)", () => {
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
  dispatch("เข้าร่วม B 95 95 95", G, store); // hc 95 -> gap 15 -> level 3 (par4+par5)
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
  // level 3 strokes par4 + par5 -> B ties those 14 holes, loses the 4 par 3s
  assert.equal(s.summary.per_player.A, 80); // 4 par-3 holes x 20
  assert.equal(s.summary.per_player.B, -80);
  assert.equal(s.summary.per_player.A + s.summary.per_player.B, 0);
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

test("หัวกินหาง: per-hole and รวม 18 use head-eats-tail settlement", () => {
  const store = new GameStore();
  const G = "Ghet";
  // 4 equal-handicap players -> level 0, no strokes
  dispatch("สร้างเกม 4 คน", G, store);
  dispatch("The Pine", G, store); // par loaded
  dispatch("20", G, store); // stake 20
  dispatch("ไม่มี", G, store); // no turbo -> format step
  dispatch("1", G, store); // หัวกินหาง
  dispatch("เข้าร่วม A 80 80 80", G, store);
  dispatch("เข้าร่วม B 80 80 80", G, store);
  dispatch("เข้าร่วม C 80 80 80", G, store);
  dispatch("เข้าร่วม D 80 80 80", G, store);
  // all equal handicap -> diff=0 -> level 0, no strokes given
  // hole 1 net: A=4 B=5 C=6 D=7 -> sorted A B C D -> A vs D unique, B vs C unique
  const h = dispatch("หลุม 1 A 4 B 5 C 6 D 7", G, store);
  assert.equal(h.summary.net_computed, true);
  assert.equal(h.summary.money.A, 20);
  assert.equal(h.summary.money.B, 20);
  assert.equal(h.summary.money.C, -20);
  assert.equal(h.summary.money.D, -20);
  // settle game totals
  const s = dispatch("รวม 18", G, store);
  assert.equal(s.summary.per_player.A, 20);
  assert.equal(s.summary.per_player.D, -20);
});

test("หัวกินหาง: level strokes applied to ranking (receiver with equal gross wins)", () => {
  // A=80 (best/giver), B=95 (receiver), diff=15 -> level 2: par4+1, par5+1
  // Hole 1 = par 4; both score gross 5 -> A.net=5, B.net=4 -> B ranked higher
  // หัวกินหาง 2-player: B(head) beats A(tail)
  const store = new GameStore();
  const G = "Ghet2";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("The Pine", G, store);
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store); // -> format step
  dispatch("1", G, store); // หัวกินหาง
  dispatch("เข้าร่วม A 80 80 80", G, store); // hc 80 giver
  dispatch("เข้าร่วม B 95 95 95", G, store); // hc 95 receiver, diff=15, level 2
  const h = dispatch("หลุม 1 A 5 B 5", G, store); // equal gross; B.net=4 (gets 1 stroke)
  assert.equal(h.summary.net_computed, true);
  // B should win because B.net(4) < A.net(5)
  assert.equal(h.summary.money.B, 20);
  assert.equal(h.summary.money.A, -20);
});

test("กินกันทุกคน: level strokes applied to ranking (receiver with equal gross wins)", () => {
  // A=80 (giver), B=95 (receiver), diff=15 -> level 2: par4+1
  // Hole 1 = par 4; A.gross=5 A.net=5, B.gross=5 B.net=4 -> B wins pairwise
  const store = new GameStore();
  const G = "Gavall2";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("The Pine", G, store);
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store); // -> format step
  dispatch("1", G, store); // กินกันทุกคน
  dispatch("เข้าร่วม A 80 80 80", G, store);
  dispatch("เข้าร่วม B 95 95 95", G, store);
  const h = dispatch("หลุม 1 A 5 B 5", G, store); // equal gross; B.net=4
  assert.equal(h.summary.net_computed, true);
  assert.equal(h.summary.money.B, 20);
  assert.equal(h.summary.money.A, -20);
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

test("hole_scores: wrong name rejected with warning, correct names still listed", () => {
  const store = new GameStore();
  const G = "GwrongName";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("The Pine", G, store);
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store);
  dispatch("1", G, store); // กินกันทุกคน
  dispatch("เข้าร่วม เรียว 90 90 90", G, store);
  dispatch("เข้าร่วม Honey 90 90 90", G, store);

  // someone types "เ" (just the leading vowel) instead of "เรียว"
  const out = dispatch("หลุม 1 เ 4", G, store);
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /ไม่พบชื่อ/);
  assert.match(out.summary.message, /เรียว/); // listed the registered names

  // the bad submission must NOT have been recorded — hole is still waiting for both
  const g = store.activeGame(G);
  const rows = g.holes[1] || [];
  assert.equal(rows.length, 0, "no rows should be recorded for an unknown name");
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

// --- 12-hour game lifetime -------------------------------------------------

test("SESSION_TTL_MS is 12 hours", () => {
  assert.equal(SESSION_TTL_MS, 12 * 60 * 60 * 1000);
});

test("the 12h deadline ROLLS — every action pushes it 12h from now", () => {
  const store = new GameStore();
  const G = "GttlRolling";
  const created = dispatch("สร้างเกม 2 คน", G, store);

  // pretend the group has been quiet for 11 hours: 1h left on the clock
  const g0 = store.rooms.get(created.room_code);
  g0.expires_at = Date.now() + 60 * 60 * 1000;

  // any activity must renew the full 12h window
  dispatch("Kbsc 454354434 443535444", G, store);
  dispatch("ยืนยัน", G, store);
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store);
  dispatch("1", G, store);
  dispatch("เข้าร่วม ชื่อ A 92,95,90", G, store);

  const g = store.activeGame(G);
  assert.equal(g.room_code, created.room_code);
  const remaining = g.expires_at - Date.now();
  assert.ok(
    remaining > SESSION_TTL_MS - 5000 && remaining <= SESSION_TTL_MS,
    `deadline should be ~12h out, got ${remaining}ms`
  );
});

test("plain group chatter does NOT extend the deadline", () => {
  const store = new GameStore();
  const G = "GttlChatter";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("Kbsc8 454354434 443535444", G, store);
  dispatch("ยืนยัน", G, store);
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store);
  dispatch("1", G, store);
  dispatch("เข้าร่วม ชื่อ A 92,95,90", G, store);
  dispatch("เข้าร่วม ชื่อ B 80,82,84", G, store);

  // pretend the round finished 11h ago: 1h left, then the group just chats
  const deadline = Date.now() + 60 * 60 * 1000;
  store.activeGame(G).expires_at = deadline;
  for (const msg of ["ไปกินข้าวกันไหม", "555", "อาทิตย์หน้าว่างไหม", "ok"]) {
    dispatch(msg, G, store);
  }
  assert.equal(
    store.activeGame(G).expires_at,
    deadline,
    "chatter must not renew a stale game"
  );
});

test("a long round never expires mid-play (hole scores renew the window)", () => {
  const store = new GameStore();
  const G = "GttlLongRound";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("Kbsc9 454354434 443535444", G, store);
  dispatch("ยืนยัน", G, store);
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store);
  dispatch("1", G, store);
  dispatch("เข้าร่วม ชื่อ A 92,95,90", G, store);
  dispatch("เข้าร่วม ชื่อ B 80,82,84", G, store);

  // simulate a slow 18 holes: before each hole the clock is nearly out
  for (let h = 1; h <= 18; h++) {
    store.activeGame(G).expires_at = Date.now() + 1000; // 1s left
    const out = dispatch(`หลุม ${h} A 5 B 4`, G, store);
    assert.equal(isIdle(out), false, `hole ${h} must still be accepted`);
  }
  assert.equal(Object.keys(store.activeGame(G).holes).length, 18);
});

test("after 12h the bot goes silent for everything except สร้างเกม", () => {
  const store = new GameStore();
  const G = "GttlExpire";
  dispatch("สร้างเกม 2 คน", G, store);
  dispatch("Kbsc2 454354434 443535444", G, store);
  dispatch("ยืนยัน", G, store);
  dispatch("20", G, store);
  dispatch("ไม่มี", G, store);
  dispatch("1", G, store);
  dispatch("เข้าร่วม ชื่อ A 92,95,90", G, store);
  dispatch("เข้าร่วม ชื่อ B 80,82,84", G, store);
  dispatch("หลุม 1 A 6 B 5", G, store);

  // fast-forward past the 12h deadline
  store.activeGame(G).expires_at = Date.now() - 1;

  for (const msg of [
    "หลุม 2 A 5 B 4",
    "เข้าร่วม ชื่อ C 90,90,90",
    "รวม 18",
    "จบเกม",
    "454354434 443535444",
    "สวัสดีครับ",
    "ยืนยัน",
  ]) {
    const out = dispatch(msg, G, store);
    assert.equal(isIdle(out), true, `should stay silent for: ${msg}`);
    assert.equal(out.summary.message, "");
  }
});

test('"สร้างเกม" / "สร้างเกมส์" after expiry starts a completely fresh game', () => {
  const store = new GameStore();
  const G = "GttlRestart";
  const first = dispatch("สร้างเกม 2 คน", G, store);
  dispatch("เข้าร่วม ชื่อ A 92,95,90", G, store);
  store.activeGame(G).expires_at = Date.now() - 1;

  // note the ส์ spelling — must work too
  const again = dispatch("สร้างเกมส์ 3 คน", G, store);
  assert.equal(again.action, "create_game");
  assert.equal(again.summary.expected_players, 3);

  const g = store.activeGame(G);
  assert.equal(g.players.length, 0, "roster must be wiped");
  assert.deepEqual(g.holes, {});
  assert.equal(g.course, null);
  assert.equal(g.stake, null);
  assert.equal(g.setup, "course");
  // the old room must be gone from the store entirely
  assert.equal(store.getGame(first.room_code), null);
});

test('"สร้างเกม" mid-game also resets everything', () => {
  const store = new GameStore();
  const G = "GreCreate";
  const first = dispatch("สร้างเกม 2 คน", G, store);
  dispatch("เข้าร่วม ชื่อ A 92,95,90", G, store);
  const second = dispatch("สร้างเกม 4 คน", G, store);
  assert.notEqual(second.room_code, first.room_code);
  assert.equal(store.activeGame(G).players.length, 0);
  assert.equal(store.getGame(first.room_code), null);
});

// --- "แต้มต่อ" command -------------------------------------------------------

/** Room-9678 roster, fully set up on an 18-hole par-72 card. */
function roster9678() {
  const store = new GameStore();
  const G = "Ghcp";
  dispatch("สร้างเกม 5 คน", G, store);
  const g = store.activeGame(G);
  store.setCourseName(G, "CascataDA");
  store.setStake(G, 20);
  store.setTurbo(G, false);
  store.setFormat(G, "all_vs_all");
  store.finishSetup(G);
  store.setCourse(G === null ? null : g.room_code, G, {
    name: "CascataDA",
    holes: [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5].map((par, i) => ({
      hole: i + 1,
      par,
    })),
  });
  for (const [n, s] of [
    ["แซม", [96, 105, 94]],
    ["เรียว", [93, 92, 97]],
    ["หมวย", [119, 109, 110]],
    ["ติน", [115, 126, 118]],
    ["หนึ่ง", [89, 94, 95]],
  ]) {
    store.join(G, { player: n, scores: s });
  }
  return { store, G };
}

test("แต้มต่อ prints the per-pair table", () => {
  const { store, G } = roster9678();
  const out = dispatch("แต้มต่อ", G, store);
  assert.equal(out.action, "handicap");
  assert.equal(out.summary.ok, true);
  const m = out.summary.message;
  assert.match(m, /ติน รับแต้มต่อ/);
  assert.match(m, /จาก หนึ่ง \(ห่าง 27\) → พาร์3:1 พาร์4:2 พาร์5:1 = 28 แต้ม/);
  assert.match(m, /จาก หมวย \(ห่าง 7\) → พาร์3:0 พาร์4:1 พาร์5:0 = 10 แต้ม/);
  assert.match(m, /จาก แซม \(ห่าง 15\) → พาร์3:0 พาร์4:1 พาร์5:1 = 14 แต้ม/);
  // the finer bands pay a gap of 5 that the old six-band table ignored
  assert.match(m, /แซม รับแต้มต่อ/);
  assert.match(m, /จาก หนึ่ง \(ห่าง 5\) → พาร์3:0 พาร์4:0 พาร์5:1 = 4 แต้ม/);
  // a gap of 2 is still an even game
  assert.match(m, /หนึ่ง–เรียว \(ห่าง 2\)/);
  assert.doesNotMatch(m, /เรียว รับแต้มต่อ/);
});

test("แต้มต่อ works before the course is entered (no round totals yet)", () => {
  const store = new GameStore();
  const G = "Ghcp2";
  dispatch("สร้างเกม 2 คน", G, store);
  store.join(G, { player: "A", scores: [92, 95, 90] });
  store.join(G, { player: "B", scores: [118, 120, 116] });
  const out = dispatch("แต้มต่อ", G, store);
  assert.equal(out.summary.ok, true);
  assert.match(out.summary.message, /ยังไม่ได้กรอกพาร์สนาม/);
  assert.match(out.summary.message, /จาก A \(ห่าง 26\) → พาร์3:1 พาร์4:2 พาร์5:1/);
  assert.doesNotMatch(out.summary.message, /แต้ม$/m);
});

test("แต้มต่อ does not disturb a game mid-setup", () => {
  const store = new GameStore();
  const G = "Ghcp3";
  dispatch("สร้างเกม 4 คน", G, store);
  assert.ok(store.pendingSetup(G), "precondition: mid-setup");
  dispatch("แต้มต่อ", G, store);
  assert.ok(store.pendingSetup(G), "setup must survive the query");
});

test("แต้มต่อ never swallows a join", () => {
  const { store, G } = roster9678();
  const out = dispatch("เข้าร่วม แต้มต่อทดสอบ 100 101 102", G, store);
  assert.equal(out.action, "join");
});

// --- "ตกลง" after the handicap table ----------------------------------------

test('ตกลง after แต้มต่อ points the group back at the hole in play', () => {
  const { store, G } = roster9678();
  dispatch("แต้มต่อ", G, store);
  const out = dispatch("ตกลง", G, store);
  assert.equal(out.action, "handicap_ack");
  assert.equal(out.summary.ok, true);
  assert.match(out.summary.message, /รับทราบครับ/);
  assert.match(out.summary.message, /หลุม 1 Par 4 เริ่ม/);
  assert.match(out.summary.message, /ส่งสกอร์/);
});

test('the table tells players how to accept it', () => {
  const { store, G } = roster9678();
  const out = dispatch("แต้มต่อ", G, store);
  assert.match(out.summary.message, /พิมพ์ "ตกลง"/);
});

test('ตกลง mid-round resumes the CURRENT hole, never restarts at 1', () => {
  const { store, G } = roster9678();
  const names = ["แซม", "หมวย", "ติน", "หนึ่ง", "เรียว"];
  for (const h of [1, 2]) {
    dispatch(`หลุม ${h} ` + names.map((n) => `${n} 5`).join(" "), G, store);
  }
  assert.equal(store.activeGame(G).current_hole, 3);
  dispatch("แต้มต่อ", G, store);
  const out = dispatch("ตกลง", G, store);
  assert.match(out.summary.message, /หลุม 3 /);
  assert.doesNotMatch(out.summary.message, /หลุม 1 /);
  assert.equal(store.activeGame(G).current_hole, 3, "progress must be untouched");
});

test('a non-ack reply after the table falls through to normal handling', () => {
  const { store, G } = roster9678();
  dispatch("แต้มต่อ", G, store);
  const out = dispatch("หลุม 1 แซม 5 หมวย 5 ติน 5 หนึ่ง 5 เรียว 5", G, store);
  assert.equal(out.action, "hole_scores");
  assert.equal(out.summary.complete, true);
});

test('ตกลง on its own (no table shown) is not treated as an ack', () => {
  const { store, G } = roster9678();
  const out = dispatch("ตกลง", G, store);
  assert.notEqual(out.action, "handicap_ack");
});

test('แต้มต่อ before the course is entered still accepts ตกลง', () => {
  const store = new GameStore();
  const G = "Gack6";
  dispatch("สร้างเกม 2 คน", G, store);
  store.join(G, { player: "A", scores: [92, 95, 90] });
  store.join(G, { player: "B", scores: [118, 120, 116] });
  dispatch("แต้มต่อ", G, store);
  const out = dispatch("ตกลง", G, store);
  assert.equal(out.action, "handicap_ack");
  assert.match(out.summary.message, /กรอกพาร์สนาม/);
});

// --- ยอดล่าสุด (live standings) ----------------------------------------------

/** Play `n` holes of the room-9678 roster, everyone on the same gross. */
function playHoles(store, G, n, gross = { แซม: 5, หมวย: 6, ติน: 6, หนึ่ง: 5, เรียว: 5 }) {
  for (let h = 1; h <= n; h++) {
    dispatch(
      `หลุม ${h} ` + Object.entries(gross).map(([n2, g]) => `${n2} ${g}`).join(" "),
      G,
      store
    );
  }
}

test("ยอดล่าสุด ranks players and shows how much round is left", () => {
  const { store, G } = roster9678();
  playHoles(store, G, 7);
  const out = dispatch("ยอดล่าสุด", G, store);
  assert.equal(out.action, "standings");
  assert.equal(out.summary.ok, true);
  assert.equal(out.summary.holes_counted, 7);
  assert.equal(out.summary.holes_left, 11);
  const m = out.summary.message;
  assert.match(m, /เล่นไปแล้ว 7\/18 หลุม/);
  assert.match(m, /เหลืออีก 11 หลุม/);
  assert.match(m, /^1\. /m);
  assert.match(m, /^5\. /m);
  // the leader must be listed first
  const leader = Object.entries(out.summary.per_player).sort((a, b) => b[1] - a[1])[0][0];
  assert.match(m.split("\n")[2], new RegExp(`^1\\. ${leader}`));
  assert.equal(Object.values(out.summary.per_player).reduce((a, b) => a + b, 0), 0);
});

test("ยอดล่าสุด flags turbo holes that have not been played yet", () => {
  const { store, G } = roster9678();
  const g = store.activeGame(G);
  g.turbo = true;
  g.turbo_holes = [9, 18];
  store.save(g);
  playHoles(store, G, 7);
  assert.match(dispatch("ยอดล่าสุด", G, store).summary.message, /ยังไม่เล่น: 9, 18/);
  playHoles(store, G, 10); // now holes 1-10, so turbo 9 is done
  const m = dispatch("ยอดล่าสุด", G, store).summary.message;
  assert.match(m, /ยังไม่เล่น: 18/);
  assert.doesNotMatch(m, /ยังไม่เล่น: 9/);
});

test("ยอดล่าสุด after 18 holes points at จบเกม instead of holes left", () => {
  const { store, G } = roster9678();
  playHoles(store, G, 18);
  const out = dispatch("ยอดล่าสุด", G, store);
  assert.equal(out.summary.holes_left, 0);
  assert.match(out.summary.message, /ครบ 18 หลุมแล้ว/);
  assert.doesNotMatch(out.summary.message, /เหลืออีก/);
});

test("ยอดล่าสุด before any score says so instead of printing an empty table", () => {
  const { store, G } = roster9678();
  const out = dispatch("ยอดล่าสุด", G, store);
  assert.equal(out.summary.ok, false);
  assert.equal(out.summary.holes_counted, 0);
  assert.match(out.summary.message, /ยังไม่มีสกอร์/);
});

test("ยอดล่าสุด does not steal the settle or end-game commands", () => {
  const { store, G } = roster9678();
  playHoles(store, G, 3);
  assert.equal(dispatch("รวม 18", G, store).action, "settle");
  assert.equal(dispatch("สรุปเงิน", G, store).action, "settle");
  assert.equal(dispatch("ยอดตอนนี้", G, store).action, "standings");
  assert.equal(dispatch("ใครนำ", G, store).action, "standings");
});

// --- automatic turn summary at hole 9 ----------------------------------------

test("finishing hole 9 posts the running total without being asked", () => {
  const { store, G } = roster9678();
  let out;
  for (let h = 1; h <= 9; h++) {
    out = dispatch(
      `หลุม ${h} แซม 5 หมวย 6 ติน 6 หนึ่ง 5 เรียว 5`,
      G,
      store
    );
  }
  assert.equal(out.summary.turn_summary, true);
  const m = out.summary.message;
  assert.match(m, /หลุม 9 ครบทุกคน/);
  assert.match(m, /จบ OUT \(หลุม 1-9\) · ยอดสะสม/);
  assert.match(m, /เหลืออีก 9 หลุม/);
  assert.match(m, /^1\. /m);
  assert.match(m, /หลุม 10 Par .* เริ่ม/); // still announces the next hole
});

test("no turn summary on any hole other than 9", () => {
  const { store, G } = roster9678();
  for (let h = 1; h <= 12; h++) {
    const out = dispatch(`หลุม ${h} แซม 5 หมวย 6 ติน 6 หนึ่ง 5 เรียว 5`, G, store);
    if (h === 9) continue;
    assert.notEqual(out.summary.turn_summary, true, `hole ${h} must stay quiet`);
    assert.doesNotMatch(out.summary.message, /ยอดสะสม/);
  }
});

test("hole 9 completed out of order still triggers the summary", () => {
  const { store, G } = roster9678();
  for (const h of [1, 3, 5, 7, 9]) {
    const out = dispatch(`หลุม ${h} แซม 5 หมวย 6 ติน 6 หนึ่ง 5 เรียว 5`, G, store);
    if (h === 9) assert.equal(out.summary.turn_summary, true);
  }
});

test("turn summary is skipped when there is no stake to total", () => {
  const store = new GameStore();
  const G = "Gnostake";
  dispatch("สร้างเกม 2 คน", G, store);
  store.join(G, { player: "A", scores: [92, 95, 90] });
  store.join(G, { player: "B", scores: [80, 82, 84] });
  dispatch("454354434 443535444", G, store);
  let out;
  for (let h = 1; h <= 9; h++) out = dispatch(`หลุม ${h} A 5 B 5`, G, store);
  assert.notEqual(out.summary.turn_summary, true);
  assert.doesNotMatch(out.summary.message, /ยอดสะสม/);
});

// --- OUT scorecard + back-nine re-handicap -----------------------------------

/** Play holes 1..9 with distinct scores so the OUT totals differ per player. */
function playFrontNine(store, G) {
  const gross = { แซม: 5, หมวย: 7, ติน: 6, หนึ่ง: 4, เรียว: 5 };
  for (let h = 1; h <= 9; h++) {
    dispatch(
      `หลุม ${h} ` + Object.entries(gross).map(([n, g]) => `${n} ${g}`).join(" "),
      G,
      store
    );
  }
  return gross;
}

test("hole 9 also prints every player's OUT scorecard", () => {
  const { store, G } = roster9678();
  playFrontNine(store, G);
  const out = dispatch("ยอดล่าสุด", G, store); // standings alone has no card
  assert.doesNotMatch(out.summary.message, /สกอร์ OUT/);
  const { store: s2, G: G2 } = roster9678();
  let last;
  for (let h = 1; h <= 9; h++) {
    last = dispatch(`หลุม ${h} แซม 5 หมวย 7 ติน 6 หนึ่ง 4 เรียว 5`, G2, s2);
  }
  const m = last.summary.message;
  assert.match(m, /📋 สกอร์ OUT \(หลุม 1-9 · พาร์ 36\)/);
  assert.match(m, /หนึ่ง\s+4 4 4 4 4 4 4 4 4 = 36 \(\+0\)/);
  assert.match(m, /หมวย\s+7 7 7 7 7 7 7 7 7 = 63 \(\+27\)/);
  // best OUT is listed first
  assert.ok(m.search(/หนึ่ง\s+4 4/) < m.search(/หมวย\s+7 7/));
});

test("hole 9 offers fresh back-nine handicaps with a preview", () => {
  const { store, G } = roster9678();
  let last;
  for (let h = 1; h <= 9; h++) {
    last = dispatch(`หลุม ${h} แซม 5 หมวย 7 ติน 6 หนึ่ง 4 เรียว 5`, G, store);
  }
  assert.match(last.summary.message, /9 หลุมหลังจะใช้แต้มต่อใหม่ไหมครับ/);
  assert.match(last.summary.message, /หนึ่ง 92 → 72/); // OUT 36 x 2
  assert.match(last.summary.message, /หมวย 112 → 126/); // OUT 63 x 2
});

test('"แต้มต่อใหม่" re-handicaps off OUT x 2 and never rewrites holes 1-9', () => {
  const { store, G } = roster9678();
  for (let h = 1; h <= 9; h++) {
    dispatch(`หลุม ${h} แซม 5 หมวย 7 ติน 6 หนึ่ง 4 เรียว 5`, G, store);
  }
  const before = dispatch("ยอดล่าสุด", G, store).summary.per_player;
  const out = dispatch("แต้มต่อใหม่", G, store);
  assert.equal(out.action, "back9_handicap");
  assert.equal(out.summary.changed, true);
  assert.equal(out.summary.after["หนึ่ง"], 72);
  assert.equal(out.summary.after["หมวย"], 126);
  assert.equal(store.activeGame(G).back9_handicap, true);
  // money already banked on the front nine must be untouched
  const after = dispatch("ยอดล่าสุด", G, store).summary.per_player;
  assert.deepEqual(after, before);
});

test('"แต้มต่อเดิม" keeps the original handicaps', () => {
  const { store, G } = roster9678();
  for (let h = 1; h <= 9; h++) {
    dispatch(`หลุม ${h} แซม 5 หมวย 7 ติน 6 หนึ่ง 4 เรียว 5`, G, store);
  }
  const out = dispatch("แต้มต่อเดิม", G, store);
  assert.equal(out.summary.changed, false);
  assert.match(out.summary.message, /ใช้แต้มต่อเดิม/);
  const g = store.activeGame(G);
  assert.equal(g.back9_handicap, false);
  assert.equal(g.players.find((p) => p.name === "หนึ่ง").handicap_index, 92);
});

test("re-handicapping is refused before the front nine is complete", () => {
  const { store, G } = roster9678();
  for (let h = 1; h <= 5; h++) {
    dispatch(`หลุม ${h} แซม 5 หมวย 7 ติน 6 หนึ่ง 4 เรียว 5`, G, store);
  }
  const out = dispatch("แต้มต่อใหม่", G, store);
  assert.equal(out.summary.ok, false);
  assert.match(out.summary.message, /ยังลงสกอร์ 9 หลุมแรกไม่ครบ/);
});

test("re-handicapping twice is refused", () => {
  const { store, G } = roster9678();
  for (let h = 1; h <= 9; h++) {
    dispatch(`หลุม ${h} แซม 5 หมวย 7 ติน 6 หนึ่ง 4 เรียว 5`, G, store);
  }
  dispatch("แต้มต่อใหม่", G, store);
  const again = dispatch("แต้มต่อใหม่", G, store);
  assert.equal(again.summary.ok, false);
  assert.match(again.summary.message, /ไปแล้ว/);
});

test("แต้มต่อใหม่ does not get swallowed by the plain แต้มต่อ table", () => {
  const { store, G } = roster9678();
  assert.equal(dispatch("แต้มต่อ", G, store).action, "handicap");
  assert.equal(dispatch("แต้มต่อใหม่", G, store).action, "back9_handicap");
  assert.equal(dispatch("แต้มต่อเดิม", G, store).action, "back9_handicap");
});
