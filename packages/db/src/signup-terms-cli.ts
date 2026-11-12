// One-off command: puts the PLACEHOLDER sign-up wording in the database (#176) so candidates can sign up before the solicitor's text
// exists. It follows the two-person rule: one staff member proposes, a different one (an administrator) confirms, then the text is saved.
// Run from the repo root with the admin app's login (app_admin, the same DATABASE_URL the admin app uses), as that role's grants allow every step:
//   DATABASE_URL=... node packages/db/src/signup-terms-cli.ts <proposer staff id> <confirmer staff id>
// Safe to run twice: the second run finds the text and writes nothing. One transaction: all or nothing.
import pg from "pg";
import { sslOptions } from "./ssl.ts";

export const PLACEHOLDER_VERSION = "placeholder-2026-11-12";
export const PLACEHOLDER_BODY = "PLACEHOLDER TEXT. The terms and privacy notice are not written yet; this text stands in for them until the solicitor's wording replaces it. Do not rely on it.";
const STAFF_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Checks the command line: two different, plain staff ids. */
export function parseTermsArgs(argv: string[]): { ids?: [string, string]; error?: string } {
  if (argv.length !== 2) return { error: "usage: signup-terms-cli.ts <proposer staff id> <confirmer staff id>" };
  const [a, b] = argv as [string, string];
  if (!STAFF_ID.test(a) || !STAFF_ID.test(b)) return { error: "a staff id is 1 to 64 letters, digits, - or _" };
  if (a === b) return { error: "the proposer and the confirmer must be two different staff members" };
  return { ids: [a, b] };
}

/** Returns "made" or "already there". The database stays the final word: it checks both people, their roles and that the request is used once. */
export async function saveTerms(client: pg.ClientBase, proposer: string, confirmer: string): Promise<"made" | "already there"> {
  const target = `signup_terms:${PLACEHOLDER_VERSION}`;
  await client.query("begin");
  try {
    if ((await client.query("select 1 from consent_text where purpose='signup_terms' and version=$1", [PLACEHOLDER_VERSION])).rowCount) {
      await client.query("rollback");
      return "already there";
    }
    // The acting staff id is a transaction setting, which the approval_request trigger reads.
    await client.query("select set_config('app.staff_user_id', $1, true)", [proposer]);
    const { rows } = await client.query(
      "insert into approval_request(kind, target_table, target_id, reason) values ('terms_privacy_page', 'consent_text', $1, 'placeholder sign-up wording') returning id",
      [target],
    );
    await client.query("select set_config('app.staff_user_id', $1, true)", [confirmer]);
    await client.query("update approval_request set status='confirmed' where id=$1", [rows[0].id]);
    await client.query("insert into consent_text(purpose, version, body, approval_request_id) values ('signup_terms', $1, $2, $3)", [PLACEHOLDER_VERSION, PLACEHOLDER_BODY, rows[0].id]);
    await client.query("commit");
    return "made";
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const { ids, error } = parseTermsArgs(argv);
  if (!ids) return log(error!), 2;
  if (!env.DATABASE_URL) return log("DATABASE_URL is not set (the admin app's login, app_admin)"), 2;
  const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: sslOptions(env) });
  try {
    await client.connect();
    log((await saveTerms(client, ids[0], ids[1])) === "made" ? `saved the placeholder sign-up text (${PLACEHOLDER_VERSION})` : `the placeholder sign-up text (${PLACEHOLDER_VERSION}) is already there; nothing was written`);
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
