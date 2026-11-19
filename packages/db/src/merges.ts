// Company name merges (step 13 part 13c; #234 D1): an account reviewer or a fetched-job reviewer merges one company into another. The work is one database
// function (private.merge_organisations, migration 0022): it checks the staff member's role itself, sets merged_into_id first, moves the names (with their DETE
// links) and the jobs, and writes one audit row with every moved id. No suggestions and no undo route (the audit row is how a merge is reversed by hand).
// The three functions here only turn the database's refusals into short codes. The same turning serves manual-posting.ts and owner-reassign.ts.
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { validId } from "./search";

type Q = Pick<pg.Pool, "query">;

/** A refusal raised by the 0022 functions ("<what> refused: CODE detail") as a QueueRefused with the code in lower case; anything else is thrown as it is. */
export function companyRefusal(e: unknown): never {
  const { code, message = "" } = (e ?? {}) as { code?: string; message?: string };
  const m = code === "P0001" ? /^[a-z ]+ refused: ([A-Z_]+)\b/.exec(message) : null;
  if (m) throw new QueueRefused(m[1]!.toLowerCase());
  throw e;
}

export type Merged = { absorbed: string; survivor: string; names: number; jobs: number };

/** Merges `absorbed` into `survivor`. Refusal codes: not_active_staff, not_company_staff, not_found, same_company, already_merged, target_merged, not_mergeable, kind_mismatch, active_members, has_applications, open_reports (0056). */
export async function mergeCompanies(db: Q, staff: string, absorbed: string, survivor: string): Promise<Merged> {
  if (!validId(absorbed) || !validId(survivor)) throw new QueueRefused("bad_input");
  try {
    const r = (await db.query<{ r: Merged }>("select private.merge_organisations($1, $2::bigint, $3::bigint) r", [staff, absorbed, survivor])).rows[0]!.r;
    return { absorbed: String(r.absorbed), survivor: String(r.survivor), names: r.names, jobs: r.jobs };
  } catch (e) {
    return companyRefusal(e);
  }
}

// What a staff member sees when picking the two companies. Matrix 20c "Company name merges": the two reviewers approve, the rules data editor, trust and safety
// officer and administrator view; the services case handler and content editor have no access. No person's data: names, kind, status and counts.
export const MERGE_VIEWERS = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "administrator"];
export const MERGE_PREVIEW =
  "select o.id::text as id, o.slug, o.display_name, o.kind, o.status, o.cro_number, o.merged_into_id::text as merged_into_id, " +
  "(select count(*)::int from membership m where m.organisation_id = o.id and m.status = 'active') as active_members, " +
  "(select count(*)::int from job j where j.organisation_id = o.id) as jobs, (select count(*)::int from organisation_name n where n.organisation_id = o.id) as names " +
  "from organisation o where o.id = any($1::bigint[]) order by o.id";
export type CompanyPreview = {
  id: string; slug: string; display_name: string; kind: string; status: string; cro_number: string | null; merged_into_id: string | null;
  active_members: number; jobs: number; names: number;
};

/** The companies with these ids (at most 2), with the counts a merge would move. */
export async function previewCompanies(db: Q, staff: string, ids: string[]): Promise<CompanyPreview[]> {
  if (ids.length === 0 || ids.length > 2 || !ids.every(validId)) throw new QueueRefused("bad_input");
  try {
    await db.query("select private.companies_staff_check($1, $2::text[], 'NOT_COMPANY_VIEWER')", [staff, MERGE_VIEWERS]);
  } catch (e) {
    return companyRefusal(e);
  }
  return (await db.query<CompanyPreview>(MERGE_PREVIEW, [ids])).rows;
}
