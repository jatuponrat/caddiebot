// courseStore.js
// A library of user-added courses. Kept in memory for instant lookup and mirrored
// to the database (when enabled) so courses persist and grow over time.

import { parseParString } from "./parser.js";
import { saveCourse as dbSaveCourse, listCourses as dbListCourses } from "./db.js";

const custom = new Map(); // key: normalized name -> { name, holes, total }

const key = (name) => String(name || "").toLowerCase().replace(/\s+/g, "");
const holesToPars = (holes) => holes.map((h) => h.par).join("");

/** Remember a course (in memory + DB) so its name loads the pars next time. */
export function rememberCourse(name, holes, total) {
  if (!name || !Array.isArray(holes)) return;
  custom.set(key(name), { name, holes, total });
  dbSaveCourse(name, holesToPars(holes), total).catch(() => {}); // fire-and-forget
}

/** Look up a saved course by (fuzzy) name. Returns {ok, holes, total, name} or null. */
export function findCustomCourse(name) {
  const k = key(name);
  if (!k) return null;
  if (custom.has(k)) return { ok: true, ...custom.get(k) };
  // allow a typed name to contain the saved key (e.g. "kbsc golf" -> "kbsc")
  for (const [ck, v] of custom) {
    if (ck.length >= 3 && (k === ck || k.includes(ck))) return { ok: true, ...v };
  }
  return null;
}

/** Load all saved courses from the DB into memory (call once at startup). */
export async function loadCoursesFromDb() {
  const rows = await dbListCourses();
  let n = 0;
  for (const r of rows) {
    const pp = parseParString(r.pars);
    if (pp.ok) {
      custom.set(key(r.name), { name: r.name, holes: pp.holes, total: pp.total });
      n++;
    }
  }
  return n;
}
