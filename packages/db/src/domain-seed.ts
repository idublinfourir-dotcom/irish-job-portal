// The domain seed (Q13, #186): loads company email domains that someone has checked, with the evidence link, from a tab-separated file, as app_admin in
// one transaction. Only plain-node imports (with .ts), so domain-seed-cli.ts runs it directly. Every statement is a constant with parameters.
import type pg from "pg";
import { cleanName, inOneTransaction, lines, MAX_ERRORS } from "./dete.ts";
import { domainProblem } from "./domain-check.ts";

type Db = Pick<pg.Pool, "query" | "connect">;

export type DomainSeedRow = { line: number; displayName: string; domain: string; evidenceUrl: string };
export const MAX_DOMAIN_ROWS = 2_000;
const URL_OK = /^https:\/\/[^\s]{1,2000}$/;

/**
 * Reads display_name, domain, evidence_url, evidence_quote. A wrong header, a line without 4 columns or a file over MAX_DOMAIN_ROWS refuses the whole
 * file (errors). A line that fails a check (name, domain, https evidence link, a quote) is refused alone (refused) and the rest still load.
 */
export function parseDomainSeed(text: string): { rows: DomainSeedRow[]; refused: string[]; errors: string[] } {
  const body = lines(text, ["display_name", "domain", "evidence_url", "evidence_quote"]);
  if (typeof body === "string") return { rows: [], refused: [], errors: [body] };
  if (body.length > MAX_DOMAIN_ROWS) return { rows: [], refused: [], errors: [`the file has ${body.length} rows, over ${MAX_DOMAIN_ROWS}`] };
  const rows: DomainSeedRow[] = [], refused: string[] = [], errors: string[] = [];
  for (const { n, cells } of body) {
    if (cells.length !== 4) {
      if (errors.push(`line ${n}: expected 4 columns, found ${cells.length}`) >= MAX_ERRORS) break;
      continue;
    }
    const [rawName, domain, url, quote] = cells as [string, string, string, string];
    const displayName = cleanName(rawName);
    const why = domainProblem(domain);
    const no = (text: string) => refused.push(`line ${n} (${displayName ?? "?"} ${JSON.stringify(domain.slice(0, 80))}): ${text}`);
    if (displayName === null) no("the display name is empty, too long or has control characters");
    else if (why === "bad_domain") no("not a plain lower-case host name (no scheme, path, port, IP address, punycode or single label)");
    else if (why === "free_email_domain") no("a free email provider's domain");
    else if (!URL_OK.test(url)) no("the evidence link must be one https address");
    else if (cleanName(quote) === null) no("the evidence quote is empty, too long or has control characters");
    else rows.push({ line: n, displayName, domain, evidenceUrl: url });
  }
  return { rows, refused, errors };
}

// Exact display name, companies not merged away. Two companies with one name are refused, never guessed.
const SEED_ORGS = "select display_name, array_agg(id::text order by id) as ids from organisation where display_name = any($1::text[]) and merged_into_id is null group by display_name";
const SEED_LOCKS = "select pg_advisory_xact_lock(hashtext(d)) from unnest($1::text[]) d"; // DOMAIN_LOCK for every domain in the file, so no staff add races the seed
const SEED_EXISTING =
  "select d.domain, d.organisation_id::text as org, o.display_name from organisation_domain d join organisation o on o.id = d.organisation_id where d.domain = any($1::text[])";
// The rows and one audit row each (actor domain_seed, the evidence link in `after`), in one statement.
export const SEED_INSERT =
  "with d as (insert into organisation_domain(organisation_id, domain, source) select o, dm, 'seed' from unnest($1::bigint[], $2::text[]) t(o, dm) " +
  "on conflict (organisation_id, domain) do nothing returning organisation_id, domain) " +
  "insert into audit_event(kind, actor_system, action, object_type, object_id, changed_columns, after, reason_code) " +
  "select 'admin_action', 'domain_seed', 'organisation_domain.seed', 'organisation', d.organisation_id::text, '{domain}', " +
  "jsonb_build_object('domain', d.domain, 'source', 'seed', 'evidence_url', u.url), 'seed' from d join unnest($1::bigint[], $2::text[], $3::text[]) u(org, domain, url) " +
  "on u.org = d.organisation_id and u.domain = d.domain";

export type DomainSeedResult = { added: string[]; skipped: string[]; refused: string[] };

/** Loads the parsed rows in one transaction; `apply: false` (the dry run) reads only and writes nothing. Running the same file twice adds nothing. */
export async function seedDomains(db: Db, rows: DomainSeedRow[], opts: { apply: boolean }): Promise<DomainSeedResult> {
  return inOneTransaction(db, async (c) => {
    const added: string[] = [], skipped: string[] = [], refused: string[] = [];
    const domains = [...new Set(rows.map((r) => r.domain))].sort();
    const orgs = new Map((await c.query<{ display_name: string; ids: string[] }>(SEED_ORGS, [[...new Set(rows.map((r) => r.displayName))]])).rows.map((r) => [r.display_name, r.ids]));
    if (opts.apply && domains.length) await c.query(SEED_LOCKS, [domains]);
    const held = new Map((await c.query<{ domain: string; org: string; display_name: string }>(SEED_EXISTING, [domains])).rows.map((r) => [r.domain, r]));
    // A domain on lines for two different companies would depend on the order: every such line is refused.
    const companiesOf = new Map<string, Set<string>>();
    for (const r of rows) companiesOf.set(r.domain, (companiesOf.get(r.domain) ?? new Set()).add(r.displayName));
    const write: [string, string, string][] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const tag = `line ${r.line} (${r.displayName} ${r.domain})`;
      const ids = orgs.get(r.displayName) ?? [];
      const h = held.get(r.domain);
      if (ids.length === 0) refused.push(`${tag}: no company has this exact display name`);
      else if (ids.length > 1) refused.push(`${tag}: ${ids.length} companies have this display name (${ids.join(", ")}); staff merge or rename first`);
      else if (companiesOf.get(r.domain)!.size > 1) refused.push(`${tag}: the file gives this domain to more than one company`);
      else if (h && h.org !== ids[0]) refused.push(`${tag}: company ${h.org} (${h.display_name}) has this domain already`);
      else if (h || seen.has(r.domain)) skipped.push(`${tag}: the company has it already`);
      else {
        seen.add(r.domain);
        write.push([ids[0]!, r.domain, r.evidenceUrl]);
        added.push(tag);
      }
    }
    if (opts.apply && write.length) await c.query(SEED_INSERT, [0, 1, 2].map((i) => write.map((w) => w[i])));
    return { added, skipped, refused };
  });
}
