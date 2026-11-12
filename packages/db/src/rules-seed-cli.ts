// The owner's one-off command that copies today's rules into the database as version 1 of each kind (#229), effective from 2026-03-01 (the day
// EUR 40,904 came in). Run from the repo root with the owner's login, as for migrations:
//   DATABASE_URL_MIGRATE=... node packages/db/src/rules-seed-cli.ts
// The rows are seeded by the owner (seeded_by_owner), so they need no two-person request; app_admin cannot write that column, which is why this
// runs as the owner. One transaction: all or nothing. It refuses to run a second time. run_at is set, so the daily run does not treat version 1
// as a new minimum. The sources: packages/rules/src/thresholds.ts, the two name lists in packages/rules/src/employers/brand.ts (read as text:
// plain node cannot load that package) and the two JSON files the fetch reads.
import { readFileSync } from "node:fs";
import pg from "pg";
import * as T from "../../rules/src/thresholds.ts";
import { cleanData, RULES_KINDS, type BigName, type Minimums, type VersionData, type RulesKind } from "./rules-data.ts";
import { sslOptions } from "./ssl.ts";

export const SEED_FROM = "2026-03-01";
const here = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** One `export const NAME: readonly string[] = [ ... ];` list from brand.ts. Throws if the file's shape changed, rather than guessing. */
export function brandList(text: string, name: string): string[] {
  const m = text.match(new RegExp(`export const ${name}: readonly string\\[\\] = \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`brand.ts: ${name} not found`);
  const out = JSON.parse(`[${m[1]!.trim().replace(/,$/, "")}]`) as unknown;
  if (!Array.isArray(out) || out.length === 0 || !out.every((s) => typeof s === "string")) throw new Error(`brand.ts: ${name} is not a list of names`);
  return out;
}

// #150 (250 or more staff) names; every other name of BIG_COMPANY_LIST_150 passed #151 (a steady DETE sponsor). From step5/big-co/verdicts.tsv.
const STAFF_250 = new Set(["mccabes pharmacy", "mccauley", "chemist warehouse"]);

/** Today's values of every kind, from the files and constants, checked as a proposal would be. */
export function seedData(): Record<RulesKind, VersionData> {
  const minimums: Minimums = {
    criticalSkills: T.CRITICAL_SKILLS_MINIMUM, graduate: T.GRADUATE_MINIMUM, graduateMonths: T.GRADUATE_MONTHS, nonList: T.NON_LIST_MINIMUM,
    nonListRoute: T.NON_LIST_ROUTE, minContractMonths: T.MIN_CONTRACT_MONTHS, standardWeekHours: T.STANDARD_WEEK_HOURS, checkedOn: T.RULES_CHECKED_ON,
  };
  const occupations = JSON.parse(here("../../fetcher/data/occupation-lists.json")) as { list: string }[];
  const brand = here("../../rules/src/employers/brand.ts");
  const names: BigName[] = [
    ...brandList(brand, "BIG_COMPANY_BRANDS").map((name) => ({ name, test: "brand" as const, link: null, readOn: null, reviewOn: null })),
    ...brandList(brand, "BIG_COMPANY_LIST_150").map((name) => ({ name, test: STAFF_250.has(name) ? ("250_staff" as const) : ("dete_steady_sponsor" as const), link: null, readOn: null, reviewOn: null })),
  ];
  const raw: Record<RulesKind, unknown> = {
    minimums,
    critical_skills_list: occupations.filter((o) => o.list === "critical-skills"),
    ineligible_list: occupations.filter((o) => o.list === "ineligible"),
    public_pay_employers: JSON.parse(here("../../fetcher/data/L2/public_employers_candidates.json")),
    big_company_names: names,
  };
  return Object.fromEntries(RULES_KINDS.map((k) => [k, cleanData(k, raw[k])])) as Record<RulesKind, VersionData>;
}

export async function seedRules(client: pg.ClientBase, data = seedData()): Promise<string[]> {
  await client.query("begin");
  try {
    await client.query("set local role portal_owner").catch(() => {
      throw new Error("this command runs only as the database owner (DATABASE_URL_MIGRATE)");
    });
    if ((await client.query("select 1 from rules_version limit 1")).rowCount) throw new Error("the rules are already in the database; nothing was written");
    const ids: string[] = [];
    for (const kind of RULES_KINDS) {
      ids.push((await client.query<{ id: string }>(
        "insert into rules_version(kind, data, effective_from, seeded_by_owner, run_at) values ($1, $2::jsonb, $3::date, true, now()) returning id::text as id",
        [kind, JSON.stringify(data[kind]), SEED_FROM],
      )).rows[0]!.id);
    }
    await client.query(
      "insert into audit_event(kind, actor_system, action, object_type, object_id, after, source) values ('admin_action', 'rules-seed-cli by ' || session_user, 'rules.seed', 'rules_version', $1, $2, 'scheduled_job')",
      [ids.join(","), { kinds: RULES_KINDS, effective_from: SEED_FROM }],
    );
    await client.query("commit");
    return ids;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  if (argv.length) return log("usage: rules-seed-cli.ts (no arguments)"), 2;
  const url = env.DATABASE_URL_MIGRATE;
  if (!url) return log("DATABASE_URL_MIGRATE is not set (the owner's login, as for migrations)"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    const ids = await seedRules(client);
    log(`wrote version 1 of ${RULES_KINDS.join(", ")} (ids ${ids.join(", ")}), effective from ${SEED_FROM}`);
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
