import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage, handleCourse, emptyEnvelope } from "../handler.js";

test("emptyEnvelope has the standard backend shape", () => {
  const e = emptyEnvelope();
  assert.deepEqual(Object.keys(e).sort(), [
    "action", "course", "handicap_level", "hole",
    "players", "room_code", "rules", "scores", "summary",
  ].sort());
});

test("create_game returns a room code and expected players", () => {
  const out = handleMessage("สร้างเกม 4 คน");
  assert.equal(out.action, "create_game");
  assert.match(out.room_code, /^\d{4}$/);
  assert.equal(out.summary.status, "waiting_players");
  assert.equal(out.summary.expected_players, 4);
});

test("join computes handicap inline", () => {
  const out = handleMessage("เข้าร่วม 4821 ชื่อ A 92,95,90");
  assert.equal(out.action, "join");
  assert.equal(out.room_code, "4821");
  assert.equal(out.players[0].name, "A");
  assert.equal(out.players[0].handicap_index, 92);
  assert.equal(out.summary.ok, true);
});

test("join flags incomplete input", () => {
  const out = handleMessage("join 4821 name A 92");
  assert.equal(out.summary.ok, false);
});

test("hole_scores without context: gross only, no net", () => {
  const out = handleMessage("หลุม 1 A 5 B 6 C 5 D 7");
  assert.equal(out.action, "hole_scores");
  assert.equal(out.hole, 1);
  assert.equal(out.summary.net_computed, false);
  assert.deepEqual(out.players[0], { name: "A", gross: 5 });
  assert.equal("net" in out.players[0], false);
});

test("hole_scores WITH context computes net for receivers only", () => {
  const ctx = {
    course: { holes: [{ hole: 1, par: 4 }] },
    rules: { par3: 0, par4: 1, par5: 1 }, // level 2
    receivers: ["B", "D"],
  };
  const out = handleMessage("หลุม 1 A 5 B 6 C 5 D 7", ctx);
  assert.equal(out.summary.net_computed, true);
  assert.equal(out.summary.par, 4);
  const byName = Object.fromEntries(out.players.map((p) => [p.name, p]));
  assert.equal(byName.A.net, 5); // no stroke
  assert.equal(byName.B.net, 5); // 6 - 1
  assert.equal(byName.C.net, 5); // no stroke
  assert.equal(byName.D.net, 6); // 7 - 1
});

test("hole_scores accepts explicit strokesByPlayer", () => {
  const out = handleMessage("หลุม 5 A 4 B 6", {
    strokesByPlayer: { B: 2 },
  });
  const byName = Object.fromEntries(out.players.map((p) => [p.name, p]));
  assert.equal(byName.A.net, 4);
  assert.equal(byName.B.net, 4); // 6 - 2
});

test("course JSON is validated", () => {
  const holes = Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 4 }));
  const out = handleCourse(JSON.stringify({ course: { name: "CC", holes } }));
  assert.equal(out.action, "extract_course");
  assert.equal(out.summary.ok, true);
  assert.equal(out.course.total_par, 72);
});

test("unknown message is handled gracefully", () => {
  const out = handleMessage("สวัสดีครับ");
  assert.equal(out.action, "unknown");
  assert.equal(out.summary.ok, false);
});
