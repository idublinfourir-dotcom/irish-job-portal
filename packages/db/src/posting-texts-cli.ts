// One-off command: puts the PLACEHOLDER wording an employer signs for a sponsorship statement and for a pay floor in the database, so posting
// works before the solicitor's text exists. The CHECK on consent_text needs no approval for these two purposes (only the sign-up and privacy
// texts go through the two-person rule, migration 0012), so app_admin inserts them directly. Run from the repo root with the admin login:
//   DATABASE_URL=... node packages/db/src/posting-texts-cli.ts
// Safe to run twice: a purpose that already has any text (the placeholder or the real one) is left alone. One transaction: all or nothing.
import pg from "pg";
import { sslOptions } from "./ssl.ts";

export const POSTING_TEXT_VERSION = "placeholder-2026-11-12";
export const POSTING_TEXTS = {
  sponsorship_statement: "PLACEHOLDER TEXT. The sponsorship statement wording is not written yet; this text stands in for it until the solicitor's wording replaces it. Do not rely on it.",
  pay_floor: "PLACEHOLDER TEXT. The pay floor statement wording is not written yet; this text stands in for it until the solicitor's wording replaces it. Do not rely on it.",
} as const;

/** Returns the purposes it saved now (empty when both already had a text). */
export const savePostingTexts = (client: pg.ClientBase) => saveTexts(client, POSTING_TEXTS, POSTING_TEXT_VERSION);

/** Saves each purpose's text unless the purpose already has one; one transaction. Also the services texts (services-texts-cli.ts). */
export async function saveTexts(client: pg.ClientBase, texts: Record<string, string>, version: string): Promise<string[]> {
  await client.query("begin");
  try {
    const made: string[] = [];
    for (const [purpose, body] of Object.entries(texts)) {
      if ((await client.query("select 1 from consent_text where purpose = $1", [purpose])).rowCount) continue;
      await client.query("insert into consent_text(purpose, version, body) values ($1, $2, $3)", [purpose, version, body]);
      made.push(purpose);
    }
    await client.query("commit");
    return made;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

export const main = (argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void) => runSeed("posting-texts-cli.ts", savePostingTexts, POSTING_TEXT_VERSION, argv, env, log);

/** The command line of a text seed: no arguments, the admin login in DATABASE_URL, then `save`. */
export async function runSeed(name: string, save: (c: pg.ClientBase) => Promise<string[]>, version: string, argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  if (argv.length) return log(`usage: ${name} (no arguments)`), 2;
  if (!env.DATABASE_URL) return log("DATABASE_URL is not set (the admin app's login, app_admin)"), 2;
  const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: sslOptions(env) });
  try {
    await client.connect();
    const made = await save(client);
    log(made.length ? `saved the placeholder ${made.join(" and ")} text (${version})` : "both texts are already there; nothing was written");
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
