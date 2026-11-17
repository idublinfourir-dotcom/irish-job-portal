// The company seed (D2, #246): load companies staff have already checked, with their brand names and DETE legal names, so a fetched job from
// one of them lands on a company that already has permit history. Read the file, then load it as app_admin in one transaction.
// Every statement is a constant with parameters; no value is ever put into SQL text. Run: src/company-seed-cli.ts.
import type pg from "pg";
import { cleanName, inOneTransaction as inTransaction, lines, MAX_COMPANY_NAME as MAX_NAME, MAX_ERRORS, type Parsed } from "./dete.ts";

type Db = Pick<pg.Pool, "query" | "connect">;

export const KINDS = ["employer", "public_body", "agency"] as const;
export type SeedRow = { line: number; displayName: string; kind: (typeof KINDS)[number]; brandNames: string[]; deteNames: string[] };
export const MAX_ROWS = 2_000;
const MAX_NAMES = 50; // in one cell
const SPLIT = " ;; ";

/** The slug base register_organisation builds (0002_functions.sql:913): the letters and digits of the name, lower-case, joined by hyphens. */
export const slugBase = (displayName: string) => displayName.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "");

/** Reads display_name, kind, brand_names, dete_names (names split by " ;; "). Any error means the whole file is refused. */
export function parseSeed(text: string): Parsed<SeedRow> {
  const body = lines(text, ["display_name", "kind", "brand_names", "dete_names"]);
  if (typeof body === "string") return { rows: [], errors: [body] };
  if (body.length > MAX_ROWS) return { rows: [], errors: [`the file has ${body.length} rows, over ${MAX_ROWS}`] };
  const rows: SeedRow[] = [];
  const errors: string[] = [];
  const deteLine = new Map<string, number>();
  for (const { n, cells } of body) {
    if (errors.length >= MAX_ERRORS) break;
    const bad = (why: string) => errors.push(`line ${n}: ${why}`);
    if (cells.length !== 4) { bad(`expected 4 columns, found ${cells.length}`); continue; }
    const [rawDisplay, kind, brands, detes] = cells as [string, string, string, string];
    const displayName = cleanName(rawDisplay);
    // A name must keep a letter or digit, or its normalised form is empty and nothing can ever match it.
    const names = (cell: string) => (cell.trim() ? cell.split(SPLIT).map((x) => cleanName(x)) : []);
    const brandNames = names(brands);
    const deteNames = names(detes);
    const all = [...brandNames, ...deteNames];
    if (displayName === null || !slugBase(displayName)) bad(`the display name is empty, over ${MAX_NAME} characters, has control characters or no letter or digit`);
    else if (!(KINDS as readonly string[]).includes(kind)) bad(`kind must be ${KINDS.join(", ")}, found "${kind}"`);
    else if (!brandNames.length) bad("at least one brand name is needed");
    else if (brandNames.length > MAX_NAMES || deteNames.length > MAX_NAMES) bad(`over ${MAX_NAMES} names in one cell`);
    else if (all.some((x) => x === null || !/[a-z0-9]/i.test(x))) bad(`a name is empty, over ${MAX_NAME} characters, has control characters or no letter or digit (names are split by "${SPLIT}")`);
    else {
      const dup = deteNames.find((x) => deteLine.has(x!) && deteLine.get(x!) !== n);
      if (dup) bad(`the DETE name "${dup}" is also on line ${deteLine.get(dup)}`);
      else {
        for (const x of deteNames) deteLine.set(x!, n);
        rows.push({ line: n, displayName, kind: kind as SeedRow["kind"], brandNames: [...new Set(brandNames as string[])], deteNames: [...new Set(deteNames as string[])] });
      }
    }
  }
  return { rows, errors };
}

// The normalised form, with the exact expression of the fetcher's FIND_EMPLOYER (packages/fetcher/src/store.ts), computed in SQL, never in TypeScript.
const NORMS = "select n as name, btrim(regexp_replace(lower(n), '[^a-z0-9]+', ' ', 'g')) as norm from unnest($1::text[]) as n";
// The names already stored under those forms, with the company each belongs to (the survivor when it was merged away, as FIND_EMPLOYER does).
const EXISTING =
  "select n.normalised_name as norm, n.id::text, coalesce(o.merged_into_id, o.id)::text as target, t.kind, t.display_name " +
  "from organisation_name n left join organisation o on o.id = n.organisation_id left join organisation t on t.id = coalesce(o.merged_into_id, o.id) " +
  "where n.normalised_name = any($1::text[])";
// Each DETE name that is in dete_permit_count, and the company each of its rows is linked to (null: not linked).
const DETE_STATE =
  "select distinct d.dete_name, coalesce(o.merged_into_id, o.id)::text as target from dete_permit_count d " +
  "left join organisation_name n on n.id = d.organisation_name_id left join organisation o on o.id = n.organisation_id where d.dete_name = any($1::text[])";
const SLUGS = "select slug from organisation where slug = any($1::text[]) or slug like any($2::text[])";
const INSERT_ORGS =
  "insert into organisation(slug, display_name, kind, signup_path) select s, d, k, 'admin' from unnest($1::text[], $2::text[], $3::text[]) as t(s, d, k) returning id::text, slug";
const INSERT_NAMES =
  "insert into organisation_name(organisation_id, name, normalised_name, kind, source) select * from unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[]) " +
  "returning id::text, organisation_id::text, normalised_name";
// Only rows that are not linked yet: a DETE name linked to any name is never re-pointed by the seed (dete-cli link moves a link on purpose).
const LINK =
  "update dete_permit_count d set organisation_name_id = l.id from unnest($1::bigint[], $2::text[]) as l(id, name) where d.dete_name = l.name and d.organisation_name_id is null";
const REFRESH = "select private.refresh_permit_history() as changed";

export type SeedResult = { created: number; found: number; namesAdded: number; deteRowsLinked: number; labelsChanged: number; refused: string[]; deteNotFound: string[]; notes: string[] };

/** Loads the rows. A row is refused (nothing of it written) when its names reach two companies, a company another row reaches, a name with no company, or a DETE name linked to another company. */
export async function seedCompanies(db: Db, rows: SeedRow[]): Promise<SeedResult> {
  return inTransaction(db, async (c) => {
    const allNames = [...new Set(rows.flatMap((r) => [...r.brandNames, ...r.deteNames]))];
    const allDete = rows.flatMap((r) => r.deteNames);
    const norm = new Map((await c.query<{ name: string; norm: string }>(NORMS, [allNames])).rows.map((r) => [r.name, r.norm]));
    const existing = new Map<string, { norm: string; id: string; target: string | null; kind: string | null; display_name: string | null }[]>();
    for (const e of (await c.query(EXISTING, [[...new Set(norm.values())]])).rows) existing.set(e.norm, [...(existing.get(e.norm) ?? []), e]);
    const dete = new Map<string, (string | null)[]>();
    for (const d of (await c.query<{ dete_name: string; target: string | null }>(DETE_STATE, [allDete])).rows) dete.set(d.dete_name, [...(dete.get(d.dete_name) ?? []), d.target]);

    const refused: string[] = [];
    const notes: string[] = [];
    const deteNotFound = allDete.filter((x) => !dete.has(x)).map((x) => `DETE name not found: ${x}`);
    // A normalised form on two rows, or two rows on one company, would make the outcome depend on the order: both rows are refused.
    const rowsOf = new Map<string, Set<number>>();
    const add = (key: string, line: number) => rowsOf.set(key, (rowsOf.get(key) ?? new Set()).add(line));
    const norms = (r: SeedRow) => [...new Set([...r.deteNames, ...r.brandNames].map((x) => norm.get(x)!))];
    for (const r of rows) for (const k of norms(r)) add(`n:${k}`, r.line);
    const plan = rows.map((r) => {
      const hits = norms(r).flatMap((k) => existing.get(k) ?? []);
      const targets = [...new Set(hits.map((h) => h.target))];
      const org = targets[0] ?? null;
      if (org) add(`o:${org}`, r.line);
      return { r, hits, targets, org };
    });
    const accepted = plan.filter(({ r, hits, targets, org }) => {
      const why = (text: string) => (refused.push(`line ${r.line} (${r.displayName}): ${text}`), false);
      const shared = norms(r).find((k) => rowsOf.get(`n:${k}`)!.size > 1);
      if (shared !== undefined) return why(`the name form "${shared}" is also on line ${[...rowsOf.get(`n:${shared}`)!].find((l) => l !== r.line)}`);
      if (targets.includes(null)) return why("a name is stored with no company; staff fix that name first");
      if (targets.length > 1) return why(`its names belong to ${targets.length} companies (${hits.map((h) => `${h.display_name} ${h.target}`).filter((x, i, a) => a.indexOf(x) === i).join(", ")}); staff merge them first`);
      if (org && rowsOf.get(`o:${org}`)!.size > 1) return why(`another line reaches the same company ${org} (${hits[0]!.display_name}); put them on one line`);
      const elsewhere = r.deteNames.find((x) => (dete.get(x) ?? []).some((t) => t !== null && t !== org));
      if (elsewhere) return why(`the DETE name "${elsewhere}" is linked to another company; staff move it with dete-cli link if it is wrong`);
      if (org && hits[0]!.kind !== r.kind) notes.push(`line ${r.line} (${r.displayName}): company ${org} is ${hits[0]!.kind}, the file says ${r.kind}; kind not changed`);
      return true;
    });

    // New companies, with the slug register_organisation would give: -2, -3 on a clash, here also with the slugs this file adds.
    const fresh = accepted.filter((p) => !p.org);
    if (fresh.length) {
      const bases = fresh.map((p) => slugBase(p.r.displayName));
      const taken = new Set((await c.query<{ slug: string }>(SLUGS, [bases, bases.map((b) => `${b}-%`)])).rows.map((x) => x.slug));
      const slugs = bases.map((b) => {
        let s = b;
        for (let i = 2; taken.has(s); i++) s = `${b}-${i}`;
        taken.add(s);
        return s;
      });
      const ids = new Map((await c.query<{ id: string; slug: string }>(INSERT_ORGS, [slugs, fresh.map((p) => p.r.displayName), fresh.map((p) => p.r.kind)])).rows.map((x) => [x.slug, x.id]));
      fresh.forEach((p, i) => (p.org = ids.get(slugs[i]!)!));
    }

    // Names: a DETE name first (legal, from dete), then each brand name (alias, from admin), skipping a form the company already has.
    const nameId = new Map<string, string>(); // `${org} ${norm}` to its name row
    for (const p of accepted) for (const h of p.hits) nameId.set(`${p.org} ${h.norm}`, h.id);
    const added = new Map<string, [string, string, string, string, string]>();
    for (const p of accepted)
      for (const [list, kind, source] of [[p.r.deteNames, "legal", "dete"], [p.r.brandNames, "alias", "admin"]] as const)
        for (const x of list) {
          const key = `${p.org} ${norm.get(x)}`;
          if (!nameId.has(key) && !added.has(key)) added.set(key, [p.org!, x, norm.get(x)!, kind, source]);
        }
    const add2 = [...added.values()];
    if (add2.length) {
      const r = await c.query<{ id: string; organisation_id: string; normalised_name: string }>(INSERT_NAMES, [0, 1, 2, 3, 4].map((i) => add2.map((a) => a[i])));
      for (const x of r.rows) nameId.set(`${x.organisation_id} ${x.normalised_name}`, x.id);
    }

    const links = accepted.flatMap((p) => p.r.deteNames.filter((x) => dete.has(x)).map((x) => [nameId.get(`${p.org} ${norm.get(x)}`)!, x] as const));
    const linked = links.length ? (await c.query(LINK, [links.map((l) => l[0]), links.map((l) => l[1])])).rowCount ?? 0 : 0;
    const labelsChanged = (await c.query<{ changed: number }>(REFRESH)).rows[0]!.changed;
    return { created: fresh.length, found: accepted.length - fresh.length, namesAdded: add2.length, deteRowsLinked: linked, labelsChanged, refused, deteNotFound, notes };
  });
}
