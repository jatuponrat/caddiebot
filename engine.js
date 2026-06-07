// engine.js
// Deterministic golf-game logic for Caddiebot.
// NO money settlement here (spec rule #8): we only structure data for the backend.

/* ----------------------------------------------------------------------------
 * HANDICAP RULES TABLE  (strokes given per hole type, by game handicap level)
 *
 * ⚠️ ONLY level 2 is defined by the spec ({par4:1, par5:1, par3:0}).
 *    Levels 0,1,3,4,5 below are a SENSIBLE DEFAULT and must be confirmed by you.
 *    Edit this table — it is the single source of truth for stroke allocation.
 * -------------------------------------------------------------------------- */
export const HANDICAP_RULES_TABLE = {
  0: { par3: 0, par4: 0, par5: 0 }, // diff <= 5  -> even game
  1: { par3: 0, par4: 1, par5: 0 }, // diff 6-12
  2: { par3: 0, par4: 1, par5: 1 }, // diff 13-16
  3: { par3: 1, par4: 1, par5: 1 }, // diff 17-23
  4: { par3: 1, par4: 2, par5: 1 }, // diff 24-30
  5: { par3: 1, par4: 2, par5: 2 }, // diff 31+
};

// Level thresholds keyed by the UPPER bound of each band (spec rule #5).
// diff <= 5 -> 0, 6..12 -> 1, 13..16 -> 2, 17..23 -> 3, 24..30 -> 4, 31+ -> 5.
const LEVEL_BANDS = [
  { max: 5, level: 0 },
  { max: 12, level: 1 },
  { max: 16, level: 2 },
  { max: 23, level: 3 },
  { max: 30, level: 4 },
  { max: Infinity, level: 5 },
];

/**
 * Generate a 4-digit room code as a string ("0000"-"9999").
 * Uniqueness is the backend's job (spec rule #2) — this only proposes one.
 */
export function generateRoomCode() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

/**
 * Handicap from the last 3 rounds (spec rule #4).
 *   best = lowest score; weighted = (best*2 + other two) / 4, rounded.
 * Algebraically that equals (sum + best) / 4.
 *
 * @param {number[]} scores - exactly 3 round scores (extra are truncated to last 3)
 * @returns {{avg_score:number, handicap_index:number, best:number, used:number[]}}
 */
export function calculateHandicap(scores) {
  if (!Array.isArray(scores)) throw new TypeError("scores must be an array");
  const used = scores.slice(-3).map(Number);
  if (used.length !== 3 || used.some((n) => !Number.isFinite(n))) {
    throw new RangeError("calculateHandicap requires 3 numeric scores");
  }
  const best = Math.min(...used);
  const sum = used.reduce((a, b) => a + b, 0);
  const weighted = (best * 2 + (sum - best)) / 4; // == (sum + best) / 4
  const value = Math.round(weighted);
  // Spec uses one number for both fields; we expose both names it references.
  return { avg_score: value, handicap_index: value, best, used };
}

/**
 * Classify the game handicap level from the diff between best & worst players
 * (spec rule #5). Negative/zero diff -> level 0.
 *
 * @param {number} diff - (highest handicap_index) - (lowest handicap_index)
 * @returns {{handicap_level:number, rules:{par3:number,par4:number,par5:number}}}
 */
export function classifyHandicapLevel(diff) {
  const d = Math.max(0, Math.round(Number(diff) || 0));
  const band = LEVEL_BANDS.find((b) => d <= b.max);
  const level = band.level;
  return { handicap_level: level, rules: { ...HANDICAP_RULES_TABLE[level] } };
}

/**
 * Convenience: compute each player's handicap, the diff, and the level/rules
 * in one call. Pure structuring — no settlement.
 *
 * @param {{name:string, scores:number[]}[]} players
 */
export function buildGameStructure(players) {
  const computed = players.map((p) => {
    const h = calculateHandicap(p.scores);
    return { name: p.name, scores: p.scores.slice(-3), handicap_index: h.handicap_index };
  });
  const indices = computed.map((p) => p.handicap_index);
  const diff = indices.length ? Math.max(...indices) - Math.min(...indices) : 0;
  return { players: computed, diff, ...classifyHandicapLevel(diff) };
}

const PAR_KEY = { 3: "par3", 4: "par4", 5: "par5" };

/**
 * Strokes a stroke-receiving player gets on a hole of the given par,
 * looked up from a rules object (e.g. from classifyHandicapLevel).
 * Unknown pars (par 6, etc.) -> 0 unless present in rules.
 */
export function strokesForHole(par, rules) {
  if (!rules) return 0;
  const key = PAR_KEY[Number(par)] ?? `par${Number(par)}`;
  return Number(rules[key]) || 0;
}

/**
 * NET = GROSS - strokes received (spec rule #6: only when handicap context given).
 * Never returns below 0 strokes; net itself may be any integer.
 */
export function computeNet(gross, strokes = 0) {
  return Number(gross) - (Number(strokes) || 0);
}

/**
 * Validate an extracted course (spec rule #1). Returns {valid, errors, course}.
 * Expects 18 holes with sane par values. Does not throw.
 */
export function validateCourse(course) {
  const errors = [];
  if (!course || typeof course !== "object") {
    return { valid: false, errors: ["course missing or not an object"], course: null };
  }
  const holes = Array.isArray(course.holes) ? course.holes : [];
  if (holes.length !== 18) errors.push(`expected 18 holes, got ${holes.length}`);
  holes.forEach((h, i) => {
    const num = Number(h?.hole);
    const par = Number(h?.par);
    if (num !== i + 1) errors.push(`hole[${i}].hole should be ${i + 1}, got ${h?.hole}`);
    if (!Number.isInteger(par) || par < 3 || par > 6) {
      errors.push(`hole ${num || i + 1}: par ${h?.par} out of range (3-6)`);
    }
  });
  const totalPar = holes.reduce((a, h) => a + (Number(h?.par) || 0), 0);
  return {
    valid: errors.length === 0,
    errors,
    course: { name: course.name ?? "", holes, total_par: totalPar },
  };
}

/* ----------------------------------------------------------------------------
 * MONEY — two settlement modes
 *
 * "all_vs_all"  (กินกันทุกคน): every PAIR compares NET; lower net wins the
 *               stake from the higher. Equal net = no payment.
 *
 * "head_tail"   (หัวกินหาง): players ranked by net (ascending = better).
 *               Pair position-1 vs position-N, 2 vs N-1, … Ties with an
 *               adjacent position cancel the pairing ("ชนตัดเจ๊า").
 *               Middle player in odd-count group pays nothing (รอด).
 *
 * Both are game tallies only — never real transfers.
 * -------------------------------------------------------------------------- */

/**
 * Settle ONE hole pairwise among rows that have a numeric `net`.
 * @param {{name:string, net?:number}[]} rows
 * @param {number} stake - money per pairwise win on this hole (turbo already applied)
 * @returns {Object<string, number>} name -> amount won(+)/lost(-) this hole
 */
export function settleHole(rows, stake) {
  const res = {};
  const valid = (rows || []).filter((r) => r && (r.give_up || r.net != null));
  valid.forEach((r) => (res[r.name] = 0));
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i];
      const b = valid[j];
      // give up (g) = loses to everyone; two give-ups tie
      if (a.give_up && b.give_up) continue;
      if (a.give_up) {
        res[a.name] -= stake;
        res[b.name] += stake;
        continue;
      }
      if (b.give_up) {
        res[b.name] -= stake;
        res[a.name] += stake;
        continue;
      }
      if (a.net < b.net) {
        res[a.name] += stake;
        res[b.name] -= stake;
      } else if (b.net < a.net) {
        res[b.name] += stake;
        res[a.name] -= stake;
      } // equal net -> no payment (split)
    }
  }
  return res;
}

/**
 * Settle ONE hole head-eats-tail (หัวกินหาง).
 * Players ranked by net ascending (lower = better); give_up treated as Infinity.
 * Pair index-0 (head) vs index-N-1 (tail), index-1 vs index-N-2, …
 * A pairing fires only when BOTH players are "unique" — their net differs from
 * the player immediately above and below them in the ranking.
 * Tied adjacent players cancel the pairing ("ชนตัดเจ๊า").
 *
 * @param {{name:string, net?:number, give_up?:boolean}[]} rows
 * @param {number} stake - money per pair win (turbo already applied)
 * @returns {Object<string, number>} name -> amount won(+)/lost(-) this hole
 */
export function settleHoleHeadEatsTail(rows, stake) {
  const res = {};
  const valid = (rows || []).filter((r) => r && (r.give_up || r.net != null));
  valid.forEach((r) => (res[r.name] = 0));
  if (valid.length < 2) return res;

  // Sort ascending by net; give_up players go to the tail (worst)
  const sorted = [...valid].sort((a, b) => {
    if (a.give_up && b.give_up) return 0;
    if (a.give_up) return 1;
    if (b.give_up) return -1;
    return a.net - b.net;
  });

  const n = sorted.length;
  const netOf = (i) => (sorted[i].give_up ? Infinity : sorted[i].net);

  const isUnique = (index) => {
    const cur = netOf(index);
    const prev = index > 0 ? netOf(index - 1) : null;
    const next = index < n - 1 ? netOf(index + 1) : null;
    return cur !== prev && cur !== next;
  };

  for (let i = 0; i < Math.floor(n / 2); i++) {
    const headIdx = i;
    const tailIdx = n - 1 - i;
    if (isUnique(headIdx) && isUnique(tailIdx)) {
      res[sorted[headIdx].name] += stake; // head (lower net) wins
      res[sorted[tailIdx].name] -= stake; // tail (higher net) loses
    }
  }

  return res;
}

/** Emoji for a hole result vs par (gross == null means gave up). */
export function scoreEmoji(gross, par) {
  if (gross == null || par == null) return "🏳️"; // give up / unknown
  const d = gross - par;
  if (d <= -2) return "🦅"; // eagle or better
  if (d === -1) return "🐦"; // birdie
  if (d === 0) return "⚪"; // par
  if (d === 1) return "🚂"; // bogey
  return "😭"; // double bogey or worse
}

/**
 * Settle the whole game (all recorded holes). Turbo holes use double stake.
 * Uses settleHoleHeadEatsTail when game.format === "head_tail", else settleHole.
 * @returns {{perPlayer:Object<string,number>, perHole:Array, holesCounted:number}}
 */
export function settleGame(game) {
  const totals = {};
  (game.players || []).forEach((p) => (totals[p.name] = 0));
  const perHole = [];
  const nums = Object.keys(game.holes || {})
    .map(Number)
    .sort((a, b) => a - b);
  const settleFn = game.format === "head_tail" ? settleHoleHeadEatsTail : settleHole;
  for (const hole of nums) {
    const mult = game.turbo && (game.turbo_holes || []).includes(hole) ? 2 : 1;
    const stake = (game.stake || 0) * mult;
    const results = settleFn(game.holes[hole], stake);
    for (const name in results) if (name in totals) totals[name] += results[name];
    perHole.push({ hole, turbo: mult > 1, stake, results });
  }
  return { perPlayer: totals, perHole, holesCounted: nums.length };
}
