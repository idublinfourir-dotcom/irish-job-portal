// B58: the staff search behind the admin shell's search box and /search. One text, at most one statement per kind the signed-in member's roles may search, each
// limited to SEARCH_LIMIT rows (one more is read to say "there are more"), no page numbers. Runs as app_admin, which already reads these tables: no grant changes.
// Who searches what (no role stands in for another, #104; a kind a role may not search is left out of the answer, never answered empty):
//   organisations and jobs: the five company viewers of the merge preview (MERGE_VIEWERS: account reviewer, fetched-job reviewer, rules data editor, trust and safety, administrator).
//   services cases: services case handler and administrator (S-Q11), by case id only, with the same columns as the services board list (no requester name or contact).
// A staff member whose roles match nothing (content editor, no role) gets an answer with no kind in it. A disabled or unknown login is not_active_staff.
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { MERGE_VIEWERS } from "./merges";
import { validId } from "./search";
import { staffRoles } from "./staff-admin";

type Q = Pick<pg.Pool, "query">;

export const SEARCH_MIN = 3;
export const SEARCH_MAX = 100;
export const SEARCH_LIMIT = 10;
export const COMPANY_SEARCHERS = MERGE_VIEWERS;
export const CASE_SEARCHERS = ["services_case_handler", "administrator"];

/** The text to search for: trimmed, 3 to 100 characters, no control character (a null byte would break Postgres text). Else QueueRefused("bad_query"). */
export function checkSearchText(q: unknown): string {
  const t = typeof q === "string" ? q.trim() : "";
  if (t.length < SEARCH_MIN || t.length > SEARCH_MAX || /\p{Cc}/u.test(t)) throw new QueueRefused("bad_query");
  return t;
}
/** A LIKE pattern that finds `t` as plain text: % _ and the escape character itself lose their meaning. */
export const like = (t: string, where: "inside" | "start") => (where === "inside" ? "%" : "") + t.replace(/[\\%_]/g, "\\$&") + "%";

// Organisations by name (inside it) or CRO number (from its start). Merged-away companies are left out. ponytail: a scan of organisation (a few thousand rows at 10x);
// organisation_name aliases are not searched. Add a trigram index on display_name, or the alias join, when the table passes about 50,000 rows or staff ask.
export const SEARCH_ORGANISATIONS =
  "select id::text as id, display_name, cro_number, kind, status from organisation " +
  `where merged_into_id is null and (display_name ilike $1 escape '\\' or cro_number like $2 escape '\\') order by display_name, id limit ${SEARCH_LIMIT + 1}`;
// Jobs by title or employer name (inside it) or by id (all digits). Drafts are an employer's unsent work and stay out. No advert text, pay or badge columns.
// ponytail: a scan of job (about 30 ms at 100,000 rows); add a trigram index on title when it passes that.
export const SEARCH_JOBS =
  "select id::text as id, title, employer_name, county, status from job " +
  `where status <> 'draft' and (title ilike $1 escape '\\' or employer_name ilike $1 escape '\\' or id = $2::bigint) order by posted_at desc, id desc limit ${SEARCH_LIMIT + 1}`;
export const SEARCH_CASES = "select id::text as id, status, permit_type, created_at::text as created_at from services_case where id = $1::bigint";

export type SearchKind<T> = { items: T[]; more: boolean };
export type StaffSearch = {
  organisations?: SearchKind<{ id: string; displayName: string; croNumber: string | null; kind: string; status: string }>;
  jobs?: SearchKind<{ id: string; title: string; employerName: string; county: string | null; status: string }>;
  cases?: SearchKind<{ id: string; status: string; permitType: string; createdAt: string }>;
};
const cut = <T>(rows: T[]): SearchKind<T> => ({ items: rows.slice(0, SEARCH_LIMIT), more: rows.length > SEARCH_LIMIT });

/** The matches of `q` for this staff member, one entry per kind their roles may search. Throws bad_query (the text) or not_active_staff. */
export async function searchStaff(db: Q, staff: string, q: string): Promise<StaffSearch> {
  const t = checkSearchText(q);
  const roles = await staffRoles(db, staff);
  const may = (any: readonly string[]) => any.some((r) => roles.includes(r));
  const id = validId(t) ? t : null; // all digits: also a job id or a case id
  const out: StaffSearch = {};
  await Promise.all([
    may(COMPANY_SEARCHERS) && db.query(SEARCH_ORGANISATIONS, [like(t, "inside"), like(t, "start")]).then((r) => {
      out.organisations = cut(r.rows.map((x) => ({ id: x.id, displayName: x.display_name, croNumber: x.cro_number, kind: x.kind, status: x.status })));
    }),
    may(COMPANY_SEARCHERS) && db.query(SEARCH_JOBS, [like(t, "inside"), id]).then((r) => {
      out.jobs = cut(r.rows.map((x) => ({ id: x.id, title: x.title, employerName: x.employer_name, county: x.county, status: x.status })));
    }),
    may(CASE_SEARCHERS) && (id === null ? Promise.resolve({ rows: [] }) : db.query(SEARCH_CASES, [id])).then((r) => {
      out.cases = cut(r.rows.map((x) => ({ id: x.id, status: x.status, permitType: x.permit_type, createdAt: x.created_at })));
    }),
  ]);
  return out;
}
