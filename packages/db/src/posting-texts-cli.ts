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
export async function savePostingTexts(client: pg.ClientBase): Promise<string[]> {
  await client.query("begin");
  try {
    const made: string[] = [];
    for (const [purpose, body] of Object.entries(POSTING_TEXTS)) {
      if ((await client.query("select 1 from consent_text where purpose = $1", [purpose])).rowCount) continue;
      await client.query("insert into consent_text(purpose, version, body) values ($1, $2, $3)", [purpose, POSTING_TEXT_VERSION, body]);
      made.push(purpose);
    }
    await client.query("commit");
    return made;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  if (argv.length) return log("usage: posting-texts-cli.ts (no arguments)"), 2;
  if (!env.DATABASE_URL) return log("DATABASE_URL is not set (the admin app's login, app_admin)"), 2;
  const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: sslOptions(env) });
  try {
    await client.connect();
    const made = await savePostingTexts(client);
    log(made.length ? `saved the placeholder ${made.join(" and ")} text (${POSTING_TEXT_VERSION})` : "both texts are already there; nothing was written");
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
