// Step 15 Q5: staff link DETE employer names to companies (migration 0051). The suggestion list runs the R23 matcher (@portal/rules suggest.ts) with each
// company's names as the query and the DETE names no row of which is linked yet as the candidates, as prototype/employer_match.py matches an employer
// name to the DETE list. Best first, 50 a page. Link, unlink and reject are one database function each (role check, audit row and label refresh inside).
// Who: matrix 20c "First-time sponsor review (CRO lookup, DETE match)": the account reviewer acts; the trust and safety officer and administrator view.
import { buildNameMatcher, cleanEmployerName } from "@portal/rules";
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { cleanName } from "./dete";
import { companyRefusal } from "./merges";
import { validId } from "./search";

type Q = Pick<pg.Pool, "query">;

export const DETE_LINK_VIEWERS = ["account_reviewer", "trust_and_safety", "administrator"];
export const DETE_LINK_PAGE = 50;
export const DETE_LINK_MAX_PAGE = 1000;

// The DETE names none of whose rows is linked, with their permits over every year.
const UNLINKED = "select dete_name as name, sum(permits)::int as permits from dete_permit_count group by dete_name having count(organisation_name_id) = 0";
// Each company a link may point at (not merged away, not rejected or closed) with every name it has, its display name included.
const COMPANIES =
  "select o.id::text as id, o.display_name as display, array_agg(n.name) filter (where n.name is not null) || o.display_name as names " +
  "from organisation o left join organisation_name n on n.organisation_id = o.id " +
  "where o.merged_into_id is null and o.status not in ('rejected','closed') group by o.id";
const REJECTED = "select organisation_id::text as org, dete_name as name from dete_link_rejection";

export type DeteSuggestion = {
  deteName: string; permits: number; organisationId: string; organisation: string; matchedName: string; score: number; kind: "exact" | "suggested";
};
type Unlinked = { name: string; permits: number };
type Company = { id: string; display: string; names: string[] };

/** Pure: the best DETE name for each name of each company, one row per company and DETE name (its best score), less rejected pairs; best first. */
export function suggestLinks(unlinked: Unlinked[], companies: Company[], rejected: { org: string; name: string }[]): DeteSuggestion[] {
  const matcher = buildNameMatcher(unlinked.map((u) => u.name));
  const permits = new Map(unlinked.map((u) => [u.name, u.permits]));
  const no = new Map<string, Set<string>>();
  for (const r of rejected) no.set(r.org, (no.get(r.org) ?? new Set()).add(r.name));
  const best = new Map<string, DeteSuggestion>();
  for (const c of companies)
    for (const n of new Set(c.names)) {
      if (!cleanEmployerName(n)) continue; // "Ltd" alone would match every name that cleans to nothing
      const skip = no.get(c.id);
      const s = matcher.suggest(n, skip && ((cand) => skip.has(cand)));
      if (s.name === null || s.kind === "only generic words" || s.kind === "no candidate") continue;
      const key = `${c.id}\t${s.name}`;
      if ((best.get(key)?.score ?? -1) < s.score)
        best.set(key, { deteName: s.name, permits: permits.get(s.name) ?? 0, organisationId: c.id, organisation: c.display, matchedName: n, score: s.score, kind: s.kind });
    }
  return [...best.values()].sort((a, b) => b.score - a.score || b.permits - a.permits || (a.deteName < b.deteName ? -1 : a.deteName > b.deteName ? 1 : 0) || Number(a.organisationId) - Number(b.organisationId));
}

const staffCheck = async (db: Q, staff: string) => {
  try {
    await db.query("select private.companies_staff_check($1, $2::text[], 'NOT_DETE_LINK_VIEWER')", [staff, DETE_LINK_VIEWERS]);
  } catch (e) {
    companyRefusal(e);
  }
};

/** One page (1 based) of suggested links, best first, and how many there are in all. Four statements whatever the size. */
export async function deteLinkSuggestions(db: Q, staff: string, page: number): Promise<{ suggestions: DeteSuggestion[]; page: number; total: number }> {
  if (!Number.isInteger(page) || page < 1 || page > DETE_LINK_MAX_PAGE) throw new QueueRefused("bad_page");
  await staffCheck(db, staff);
  // ponytail: every request recomputes the list (about 24,000 DETE names and a few hundred companies, measured in dete-links-admin.test.ts); store it if that grows
  const unlinked = (await db.query<Unlinked>(UNLINKED)).rows;
  const companies = (await db.query<Company>(COMPANIES)).rows;
  const rejected = (await db.query<{ org: string; name: string }>(REJECTED)).rows;
  const all = suggestLinks(unlinked, companies, rejected);
  return { suggestions: all.slice((page - 1) * DETE_LINK_PAGE, page * DETE_LINK_PAGE), page, total: all.length };
}

const name = (raw: unknown) => {
  const n = typeof raw === "string" ? cleanName(raw) : null;
  if (n === null || n !== raw) throw new QueueRefused("bad_name");
  return n;
};
const call = async (db: Q, sql: string, args: unknown[]) => {
  try {
    return (await db.query<{ r: Record<string, unknown> }>(sql, args)).rows[0]!.r;
  } catch (e) {
    return companyRefusal(e);
  }
};

export type DeteLinked = { organisationId: string; organisationNameId: string; nameAdded: boolean; rowsLinked: number; labelsChanged: number; permitHistory: string };
/** Links a DETE name to a company. Refusals: bad_name, bad_input, not_active_staff, not_dete_link_staff, not_found, company_merged, name_not_found, linked_elsewhere, name_taken. */
export async function linkDeteName(db: Q, staff: string, deteName: unknown, organisationId: unknown): Promise<DeteLinked> {
  const n = name(deteName);
  if (!validId(organisationId)) throw new QueueRefused("bad_input");
  return (await call(db, "select private.dete_link($1, $2, $3::bigint) r", [staff, n, organisationId])) as DeteLinked;
}

export type DeteUnlinked = { rowsUnlinked: number; namesRemoved: number[]; labelsChanged: number; organisationIds: string[] };
/** Takes the link off every row of a DETE name and remembers the pair as rejected. Refusals: bad_name, not_active_staff, not_dete_link_staff, name_not_found, not_linked. */
export async function unlinkDeteName(db: Q, staff: string, deteName: unknown): Promise<DeteUnlinked> {
  const r = (await call(db, "select private.dete_unlink($1, $2) r", [staff, name(deteName)])) as DeteUnlinked;
  return { ...r, namesRemoved: r.namesRemoved.map(Number) };
}

/** Turns a suggestion down, so it is not suggested again. Refusals as linkDeteName, less linked_elsewhere and name_taken. */
export async function rejectDeteSuggestion(db: Q, staff: string, deteName: unknown, organisationId: unknown): Promise<{ organisationId: string; rejected: true }> {
  const n = name(deteName);
  if (!validId(organisationId)) throw new QueueRefused("bad_input");
  return (await call(db, "select private.dete_reject($1, $2, $3::bigint) r", [staff, n, organisationId])) as { organisationId: string; rejected: true };
}
