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
  pairGap,
  pairStrokeRules,
  buildStrokeMatrix,
  strokesBetween,
} from "../engine.js";

// Real room-9678 roster — the game that exposed the flat-allocation bug.
const ROSTER_9678 = [
  { name: "หนึ่ง", handicap_index: 92 },
  { name: "เรียว", handicap_index: 94 },
  { name: "แซม", handicap_index: 97 },
  { name: "หมวย", handicap_index: 112 },
  { name: "ติน", handicap_index: 119 },
];
// CascataDA: 443545344 434544534 — a standard par 72 (4x par3, 10x par4, 4x par5)
const CASCATA = "443545344434544534".split("").map((p, i) => ({ hole: i + 1, par: Number(p) }));
const roundTotal = (rules) =>
  CASCATA.reduce((s, h) => s + strokesForHole(h.par, rules), 0);

test("pairGap: only the higher handicap receives", () => {
  assert.equal(pairGap(92, 119), 0);
  assert.equal(pairGap(92, 92), 0);
  assert.equal(pairGap(119, 92), 27);
});

test("the eight bands cover every gap and never go backwards", () => {
  let prev = -1;
  for (let gap = 0; gap < 60; gap++) {
    const { handicap_level, rules } = classifyHandicapLevel(gap);
    const total = roundTotal(rules);
    assert.ok(total >= prev, `gap ${gap}: total must not drop (${prev} -> ${total})`);
    assert.ok(handicap_level >= 0 && handicap_level <= 7);
    prev = total;
  }
});

test("band boundaries land exactly where the group agreed", () => {
  const lv = (g) => classifyHandicapLevel(g).handicap_level;
  assert.deepEqual([lv(0), lv(2), lv(3), lv(6)], [0, 0, 1, 1]);
  assert.deepEqual([lv(7), lv(12), lv(13), lv(16)], [2, 2, 3, 3]);
  assert.deepEqual([lv(17), lv(20), lv(21), lv(24)], [4, 4, 5, 5]);
  assert.deepEqual([lv(25), lv(30), lv(31), lv(99)], [6, 6, 7, 7]);
});

test("round totals on a par-72 card are 0,4,10,14,18,22,28,32", () => {
  const totals = [0, 3, 7, 13, 17, 21, 25, 31].map((g) =>
    roundTotal(classifyHandicapLevel(g).rules)
  );
  assert.deepEqual(totals, [0, 4, 10, 14, 18, 22, 28, 32]);
});

test("no boundary jumps more than 6 strokes (the old table jumped 10)", () => {
  let worst = 0;
  let prev = roundTotal(classifyHandicapLevel(0).rules);
  for (let gap = 1; gap < 40; gap++) {
    const total = roundTotal(classifyHandicapLevel(gap).rules);
    worst = Math.max(worst, total - prev);
    prev = total;
  }
  assert.equal(worst, 6);
});

test("stroke matrix is per-pair, not field-relative (room 9678 regression)", () => {
  const m = buildStrokeMatrix(ROSTER_9678);
  assert.equal(m["เรียว"]["หนึ่ง"], 2);
  assert.equal(m["แซม"]["หนึ่ง"], 5);
  assert.equal(m["ติน"]["หนึ่ง"], 27);
  assert.equal(m["หมวย"]["ติน"], 0, "reverse direction gives nothing");
  // gap 5 used to be worth nothing; the finer bands now pay it on the par 5s
  assert.equal(strokesBetween(m, "แซม", "หนึ่ง", { par: 5 }), 1);
  assert.equal(strokesBetween(m, "แซม", "หนึ่ง", { par: 4 }), 0);
  // gap 2 is still an even game
  assert.equal(strokesBetween(m, "เรียว", "หนึ่ง", { par: 5 }), 0);
  // gap 27 -> level 6
  assert.deepEqual(pairStrokeRules(119, 92), { par3: 1, par4: 2, par5: 1 });
  // gap 22 (ติน vs แซม) -> level 5, two strokes on the par 5s
  assert.deepEqual(pairStrokeRules(119, 97), { par3: 1, par4: 1, par5: 2 });
});

test("settleHole with pair context settles on that pair's own strokes", () => {
  const m = buildStrokeMatrix(ROSTER_9678);
  const rows = ROSTER_9678.map((p) => ({ name: p.name, gross: 5, net: 5 }));
  const res = settleHole(rows, 20, { par: 4, matrix: m });
  assert.equal(Object.values(res).reduce((a, b) => a + b, 0), 0);
  assert.ok(res["ติน"] > 0 && res["หมวย"] > 0);
  assert.ok(res["หนึ่ง"] < 0);
});

test("settleHole without context keeps the old net-based behaviour", () => {
  const rows = ROSTER_9678.map((p) => ({ name: p.name, gross: 5, net: 5 }));
  const res = settleHole(rows, 20);
  assert.deepEqual(Object.values(res), [0, 0, 0, 0, 0]);
});

test("settleGame threads par + matrix through to each hole", () => {
  const game = {
    players: ROSTER_9678,
    stroke_matrix: buildStrokeMatrix(ROSTER_9678),
    course: { holes: CASCATA },
    stake: 20,
    format: "all_vs_all",
    holes: Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => [
        i + 1,
        ROSTER_9678.map((p) => ({ name: p.name, gross: 5, net: 5 })),
      ])
    ),
  };
  const s = settleGame(game);
  assert.equal(s.holesCounted, 18);
  assert.equal(Object.values(s.perPlayer).reduce((a, b) => a + b, 0), 0);
  assert.ok(s.perPlayer["ติน"] > s.perPlayer["หมวย"]);
});

test("legacy games with the old par-band matrix still settle", () => {
  const legacy = { B: { A: { par3: 0, par4: 1, par5: 1 } }, A: { B: null } };
  const rows = [{ name: "A", gross: 5, net: 5 }, { name: "B", gross: 5, net: 5 }];
  const res = settleHole(rows, 20, { par: 4, matrix: legacy });
  assert.equal(res.B, 20);
  assert.equal(res.A, -20);
});

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

test("settleHoleHeadEatsTail: a tied head voids the pairing (ชนตัดเจ๊า)", () => {
  // A B C D all shoot 2, E shoots 4. Nobody has a unique best score, so no
  // pairing fires. Previously the money went to whoever was TYPED first — the
  // same hole paid A or B depending on the order the names were entered.
  const rows = [
    { name: "A", net: 2 }, { name: "B", net: 2 }, { name: "C", net: 2 },
    { name: "D", net: 2 }, { name: "E", net: 4 },
  ];
  const res = settleHoleHeadEatsTail(rows, 20);
  assert.deepEqual(res, { A: 0, B: 0, C: 0, D: 0, E: 0 });
});

test("settleHoleHeadEatsTail does not depend on the order names were typed", () => {
  // A(1) B(3) C(3) D(5): head and tail are both unique -> A eats D.
  // The middle pair B/C ties -> ชนตัดเจ๊า, and that does not touch A vs D.
  const rows = [
    { name: "A", net: 1 }, { name: "B", net: 3 },
    { name: "C", net: 3 }, { name: "D", net: 5 },
  ];
  const forwards = settleHoleHeadEatsTail(rows, 20);
  const backwards = settleHoleHeadEatsTail([...rows].reverse(), 20);
  assert.deepEqual(forwards, backwards);
  assert.equal(forwards.A, 20);
  assert.equal(forwards.D, -20);
  assert.equal(forwards.B, 0);
  assert.equal(forwards.C, 0);
  assert.equal(Object.values(forwards).reduce((a, b) => a + b, 0), 0);
});

test("settleHoleHeadEatsTail: a player with no score sits the hole out", () => {
  // "give up" no longer exists — a player with no net simply is not in the
  // hole, so head-vs-tail runs between the two who did post a score.
  const res = settleHoleHeadEatsTail(
    [{ name: "A", net: 4 }, { name: "B", net: 5 }, { name: "C" }],
    20
  );
  assert.equal(res.A, 20);
  assert.equal(res.B, -20);
  assert.equal(res.C ?? 0, 0);
  assert.equal(Object.values(res).reduce((a, b) => a + b, 0), 0);
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

test("classifyHandicapLevel respects the agreed bands", () => {
  const cases = [
    [0, 0], [2, 0],
    [3, 1], [6, 1],
    [7, 2], [12, 2],
    [13, 3], [16, 3],
    [17, 4], [20, 4],
    [21, 5], [24, 5],
    [25, 6], [30, 6],
    [31, 7], [99, 7],
  ];
  for (const [diff, level] of cases) {
    assert.equal(classifyHandicapLevel(diff).handicap_level, level, `diff ${diff}`);
  }
});

test("classifyHandicapLevel clamps negative diff to 0", () => {
  assert.equal(classifyHandicapLevel(-4).handicap_level, 0);
});

test("level 3 rules match the spec example", () => {
  assert.deepEqual(classifyHandicapLevel(14).rules, { par3: 0, par4: 1, par5: 1 });
  assert.deepEqual(HANDICAP_RULES_TABLE[3], { par3: 0, par4: 1, par5: 1 });
});

test("strokesForHole reads the rules table by par", () => {
  const rules = { par3: 0, par4: 1, par5: 2 };
  assert.equal(strokesForHole(3, rules), 0);
  assert.equal(strokesForHole(4, rules), 1);
  assert.equal(strokesForHole(5, rules), 2);
  assert.equal(strokesForHole(6, rules), 2); // par 6 takes the par-5 allowance
  assert.equal(strokesForHole(7, rules), 0); // genuinely unknown par -> 0
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
  assert.equal(g.handicap_level, 2);
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
