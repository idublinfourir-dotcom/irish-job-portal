// Step 16 (B1, B5, B12): the reads the candidate pages need that no route had, each a Work of the public gate (public-read.ts) so a page and its
// route share the visitor read limit. Run as app_candidate. Pages reach them through apps/candidate/lib/data.ts.
import type pg from "pg";
import { REGISTRATION_BODIES, SOC2010_CODES, socSlug, socTitle } from "@portal/rules";
import { getGuide, getPermitNotice, listGuides, listHelp } from "./content";
import type { Work } from "./public-read";
import { getRules } from "./rules-data";
import { parseSearch, sectorCounts } from "./search";

type Db = Pick<pg.Pool, "query">;

// ===== B5: the minimums in force, with no occupation =====
// The earliest confirmed minimums version that starts after today (rules_version_in_force_idx), so a page can say "changes on 1 January".
export const NEXT_MINIMUMS = "select min(effective_from)::text as day from rules_version where kind = 'minimums' and effective_from > $1::date";

/** The minimums in force today (UTC, as getRules) and the day the next version starts (null when none is waiting). `nonList` is null when that route is off. */
export async function minimumsInForce(db: Db, now = Date.now()) {
  const [rules, next] = await Promise.all([getRules(db, now), db.query<{ day: string | null }>(NEXT_MINIMUMS, [new Date(now).toISOString().slice(0, 10)])]);
  const m = rules.minimums;
  return {
    criticalSkills: m.criticalSkills, graduate: m.graduate, graduateMonths: m.graduateMonths, nonList: m.nonListRoute ? m.nonList : null,
    general: m.general ?? null, generalLower: m.generalLower ?? null, generalLowerCodes: m.generalLowerCodes ?? [],
    minContractMonths: m.minContractMonths, rulesCheckedOn: m.checkedOn, nextVersionOn: next.rows[0]?.day ?? null,
  };
}

// ===== B12: every occupation a picker offers =====
export type PickerStatus = "critical-skills" | "ineligible" | "other";
export type PickerEntry = { code: string; title: string; slug: string; listStatus: PickerStatus };

/** Every SOC 2010 unit group with its title, its address slug and its list status ("critical-skills" like the checker when any entry is, else "ineligible", else "other"). */
export async function occupationPicker(db: Db): Promise<{ occupations: PickerEntry[] }> {
  const status = new Map<string, PickerStatus>();
  for (const e of (await getRules(db)).occupationLists) if (status.get(e.code) !== "critical-skills") status.set(e.code, e.list);
  return { occupations: [...SOC2010_CODES].sort().map((code) => ({ code, title: socTitle(code)!, slug: socSlug(code)!, listStatus: status.get(code) ?? "other" })) };
}

// The live jobs per sector for the search in the query (the job list's own filter keys; the sector filter itself is left out); no filter counts all live jobs.
export const sectorsRead: Work = async (db, q) => ({ sectors: await sectorCounts(db, parseSearch(q)) });
export const guideRead: Work = (db, q) => getGuide(db, q.get("slug") ?? "");
export const guidesRead: Work = (db) => listGuides(db); // B15: GET /api/guides
export const helpListRead: Work = (db) => listHelp(db); // B19: GET /api/help/list
export const permitNoticeRead: Work = (db) => getPermitNotice(db); // #291: GET /api/permit-notice; null (404) when staff have it off
export const minimumsRead: Work = (db) => minimumsInForce(db);
export const occupationsRead: Work = (db) => occupationPicker(db);

// ===== B39: the registration bodies, for the profile's dropdown =====
/** The bodies the profile may name (decision #269's code file), as id, name and the body's own page. The profile's `registrationBody` stays free text (max 120), so a value typed earlier still reads back. */
export const registrationBodiesRead: Work = async () => ({ bodies: Object.values(REGISTRATION_BODIES).map(({ id, name, url }) => ({ id, name, url })) });
