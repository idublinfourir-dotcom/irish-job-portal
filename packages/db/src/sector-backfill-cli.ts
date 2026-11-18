// #257 (P6): the one-off sector backfill. Jobs saved before care and hospitality existed carry "other" for those codes; this gives them the
// sector the rules chain gives now (packages/rules/src/chain/sectors.ts). Only "other" rows move: a pharma employer's job keeps
// "pharma and science", as the chain's employer rule still wins. Every status, so closed jobs read the same as new ones. Run from the repo root
// with the app_admin login:
//   SECTOR_ADMIN_DATABASE_URL=... node packages/db/src/sector-backfill-cli.ts           (dry run: counts only, writes nothing)
//   SECTOR_ADMIN_DATABASE_URL=... node packages/db/src/sector-backfill-cli.ts --apply   (one statement)
// Running it again moves nothing: the moved rows are no longer "other". Fetched adverts store no sector, so only job is touched.
import pg from "pg";
import { CARE_CODES, HOSPITALITY_CODES } from "../../rules/src/chain/sectors.ts";
import { sslOptions } from "./ssl.ts";

const NEW = "case when occupation_code = any($1::text[]) then 'care' else 'hospitality' end";
const WHERE = "sector = 'other' and occupation_code = any($1::text[] || $2::text[])";
export const COUNT = `select ${NEW} as sector, count(*)::int as n from job where ${WHERE} group by 1`;
export const APPLY = `with u as (update job set sector = ${NEW} where ${WHERE} returning sector) select sector, count(*)::int as n from u group by 1`;
export const PARAMS = [CARE_CODES, HOSPITALITY_CODES];

export async function backfillSectors(db: Pick<pg.ClientBase, "query">, opts: { apply: boolean }): Promise<{ care: number; hospitality: number }> {
  const r = await db.query<{ sector: "care" | "hospitality"; n: number }>(opts.apply ? APPLY : COUNT, PARAMS);
  const n = { care: 0, hospitality: 0 };
  for (const x of r.rows) n[x.sector] = x.n;
  return n;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const apply = argv.length === 1 && argv[0] === "--apply";
  if (argv.length > 1 || (argv.length === 1 && !apply)) return log("usage: sector-backfill-cli.ts [--apply]"), 2;
  const url = env.SECTOR_ADMIN_DATABASE_URL;
  if (!url) return log("SECTOR_ADMIN_DATABASE_URL is not set (the app_admin login)"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    const r = await backfillSectors(client, { apply });
    log(apply ? `${r.care} jobs moved to care, ${r.hospitality} to hospitality` : `dry run, nothing written: ${r.care} jobs would move to care, ${r.hospitality} to hospitality (add --apply to write)`);
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
