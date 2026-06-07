import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateRoomCode,
  calculateHandicap,
  classifyHandicapLevel,
  buildGameStructure,
  strokesForHole,
  computeNet,
  validateCourse,
  HANDICAP_RULES_TABLE,
  settleHole,
  settleHoleHeadEatsTail,
  settleGame,
} from "../engine.js";

test("settleHole pays pairwise, ties pay nothing", () => {
  const res = settleHole(
    [{ name: "A", net: 4 }, { name: "B", net: 5 }, { name: "C", net: 4 }],
    20
  );
  assert.equal(res.A, 20); // beats B, ties C
  assert.equal(res.B, -40); // loses to A and C
  assert.equal(res.C, 20); // beats B, ties A
  assert.equal(res.A + res.B + res.C, 0); // zero-sum
});

test("settleHoleHeadEatsTail: 4 all-unique players", () => {
  // sorted: A(4) B(5) C(6) D(7) -> A vs D, B vs C -> both unique -> each wins
  const res = settleHoleHeadEatsTail(
    [{ name: "A", net: 4 }, { name: "B", net: 5 }, { name: "C", net: 6 }, { name: "D", net: 7 }],
    20
  );
  assert.equal(res.A, 20);
  assert.equal(res.B, 20);
  assert.equal(res.C, -20);
  assert.equal(res.D, -20);
  assert.equal(res.A + res.B + res.C + res.D, 0); // zero-sum
});

test("settleHoleHeadEatsTail: inner tie cancels inner pairing only (ชนตัดเจ๊า)", () => {
  // sorted: A(4) B(5) C(5) D(6)
  // A vs D: A unique (4 != null, 4 != 5), D unique (6 != 5, 6 != null) -> fires
  // B vs C: B not unique (5 == C's 5) -> void
  const res = settleHoleHeadEatsTail(
    [{ name: "A", net: 4 }, { name: "B", net: 5 }, { name: "C", net: 5 }, { name: "D", net: 6 }],
    20
  );
  assert.equal(res.A, 20);
  assert.equal(res.B, 0);
  assert.equal(res.C, 0);
  assert.equal(res.D, -20);
});

test("settleHoleHeadEatsTail: odd players -> middle รอด", () => {
  // 3 players: A(3) B(5) C(7) -> only pair is A vs C; B is middle -> 0
  const res = settleHoleHeadEatsTail(
    [{ name: "A", net: 3 }, { name: "B", net: 5 }, { name: "C", net: 7 }],
    20
  );
  assert.equal(res.A, 20);
  assert.equal(res.B, 0);
  assert.equal(res.C, -20);
});

test("settleHoleHeadEatsTail: head group ties each other but not tail -> position-1 still wins", () => {
  // sorted: A(2) B(2) C(2) D(2) E(4)
  // Pair i=0: A(2) vs E(4): different -> fires, A wins
  // Pair i=1: B(2) vs D(2): tied -> ชนตัดเจ๊า
  // C: middle รอด
  const res = settleHoleHeadEatsTail(
    [{ name: "A", net: 2 }, { name: "B", net: 2 }, { name: "C", net: 2 }, { name: "D", net: 2 }, { name: "E", net: 4 }],
    20
  );
  assert.equal(res.A, 20);
  assert.equal(res.B, 0);
  assert.equal(res.C, 0);
  assert.equal(res.D, 0);
  assert.equal(res.E, -20);
});

test("settleHoleHeadEatsTail: give_up treated as worst score", () => {
  // A(4) B(5) C=giveup: sorted A B C(Inf) -> A vs C: fires (4 != Inf)
  const res = settleHoleHeadEatsTail(
    [{ name: "A", net: 4 }, { name: "B", net: 5 }, { name: "C", give_up: true }],
    20
  );
  assert.equal(res.A, 20);
  assert.equal(res.B, 0);
  assert.equal(res.C, -20);
});

test("settleGame uses head_tail format when game.format set", () => {
  const game = {
    players: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
    stake: 20,
    turbo: false,
    turbo_holes: [],
    format: "head_tail",
    holes: {
      1: [
        { name: "A", net: 4 },
        { name: "B", net: 5 },
        { name: "C", net: 6 },
        { name: "D", net: 7 },
      ],
    },
  };
  const s = settleGame(game);
  assert.equal(s.perPlayer.A, 20);
  assert.equal(s.perPlayer.B, 20);
  assert.equal(s.perPlayer.C, -20);
  assert.equal(s.perPlayer.D, -20);
});

test("settleGame totals all holes with turbo doubling", () => {
  const game = {
    players: [{ name: "A" }, { name: "B" }],
    stake: 20,
    turbo: true,
    turbo_holes: [9],
    holes: {
      1: [{ name: "A", net: 4 }, { name: "B", net: 5 }], // A +20
      9: [{ name: "A", net: 5 }, { name: "B", net: 4 }], // turbo x2 -> B +40
    },
  };
  const s = settleGame(game);
  assert.equal(s.holesCounted, 2);
  assert.equal(s.perPlayer.A, -20); // +20 - 40
  assert.equal(s.perPlayer.B, 20);
  assert.equal(s.perHole[1].turbo, true); // hole 9 entry
  assert.equal(s.perHole[1].stake, 40);
});

test("generateRoomCode is a 4-digit string", () => {
  for (let i = 0; i < 50; i++) {
    const c = generateRoomCode();
    assert.match(c, /^\d{4}$/);
  }
});

test("calculateHandicap weights the best score double", () => {
  // best=90, (90*2 + 92 + 95)/4 = 367/4 = 91.75 -> 92
  const h = calculateHandicap([92, 95, 90]);
  assert.equal(h.best, 90);
  assert.equal(h.handicap_index, 92);
  assert.equal(h.avg_score, 92);
});

test("calculateHandicap rounds to nearest integer", () => {
  // best=80, (80*2+82+84)/4 = 326/4 = 81.5 -> 82
  assert.equal(calculateHandicap([82, 84, 80]).handicap_index, 82);
  // best=100,(100*2+101+102)/4 = 403/4 = 100.75 -> 101
  assert.equal(calculateHandicap([101, 102, 100]).handicap_index, 101);
});

test("calculateHandicap uses the last 3 when more are given", () => {
  const h = calculateHandicap([200, 92, 95, 90]); // 200 dropped
  assert.deepEqual(h.used, [92, 95, 90]);
  assert.equal(h.handicap_index, 92);
});

test("calculateHandicap rejects bad input", () => {
  assert.throws(() => calculateHandicap([90, 91]));
  assert.throws(() => calculateHandicap([90, 91, "x"]));
});

test("classifyHandicapLevel respects spec bands", () => {
  const cases = [
    [0, 0], [5, 0],
    [6, 1], [12, 1],
    [13, 2], [16, 2],
    [17, 3], [23, 3],
    [24, 4], [30, 4],
    [31, 5], [35, 5], [99, 5],
  ];
  for (const [diff, level] of cases) {
    assert.equal(classifyHandicapLevel(diff).handicap_level, level, `diff ${diff}`);
  }
});

test("classifyHandicapLevel clamps negative diff to 0", () => {
  assert.equal(classifyHandicapLevel(-4).handicap_level, 0);
});

test("level 2 rules match the spec example", () => {
  assert.deepEqual(classifyHandicapLevel(14).rules, { par3: 0, par4: 1, par5: 1 });
  assert.deepEqual(HANDICAP_RULES_TABLE[2], { par3: 0, par4: 1, par5: 1 });
});

test("strokesForHole reads the rules table by par", () => {
  const rules = { par3: 0, par4: 1, par5: 2 };
  assert.equal(strokesForHole(3, rules), 0);
  assert.equal(strokesForHole(4, rules), 1);
  assert.equal(strokesForHole(5, rules), 2);
  assert.equal(strokesForHole(6, rules), 0); // unknown par -> 0
});

test("computeNet subtracts strokes", () => {
  assert.equal(computeNet(5, 1), 4);
  assert.equal(computeNet(7), 7);
});

test("buildGameStructure computes diff + level for a group", () => {
  const g = buildGameStructure([
    { name: "A", scores: [92, 95, 90] }, // -> 92
    { name: "B", scores: [80, 82, 84] }, // -> 82
  ]);
  assert.equal(g.players[0].handicap_index, 92);
  assert.equal(g.players[1].handicap_index, 82);
  assert.equal(g.diff, 10);
  assert.equal(g.handicap_level, 1);
});

test("validateCourse flags wrong hole count", () => {
  const bad = validateCourse({ name: "X", holes: [{ hole: 1, par: 4 }] });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes("18 holes")));
});

test("validateCourse accepts a clean 18-hole card", () => {
  const holes = Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 4 }));
  const ok = validateCourse({ name: "Test CC", holes });
  assert.equal(ok.valid, true);
  assert.equal(ok.course.total_par, 72);
});
