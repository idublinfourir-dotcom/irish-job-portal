// One-off command: gives a staff member a role through the two-person rule (#136 c, #137 b), until the staff screen exists (step 13).
// Run from the repo root with the admin app's login (app_admin, the same DATABASE_URL the admin app uses):
//   DATABASE_URL=... node packages/db/src/role-grant-cli.ts <proposer email> <confirmer email> <staff email> <role>
// The proposer holds any role; the confirmer holds administrator. The database checks both and that the request is used once.
// Safe to run twice: a staff member who already holds the role gets nothing written. One transaction: all or nothing.
import pg from "pg";
import { confirmGrant, proposeGrant } from "./role-grant.ts";
import { sslOptions } from "./ssl.ts";
import { PLAIN_EMAIL, STAFF_ROLES } from "./staff-seed-cli.ts";

const USAGE = "usage: role-grant-cli.ts <proposer email> <confirmer email> <staff email> <role>";

/** Checks the command line: three plain, lowercased emails (proposer and confirmer different) and a known role. */
export function parseGrantArgs(argv: string[]): { input?: { proposer: string; confirmer: string; staff: string; role: string }; error?: string } {
  if (argv.length !== 4) return { error: USAGE };
  const [proposer, confirmer, staff] = argv.slice(0, 3).map((e) => e.trim().toLowerCase()) as [string, string, string];
  const role = argv[3]!.trim();
  if ([proposer, confirmer, staff].some((e) => e.length > 254 || !PLAIN_EMAIL.test(e))) return { error: "an email is not a plain address" };
  if (!STAFF_ROLES.includes(role)) return { error: `unknown role: ${role.slice(0, 40)}; roles are ${STAFF_ROLES.join(", ")}` };
  if (proposer === confirmer) return { error: "the proposer and the confirmer must be two different staff members" };
  return { input: { proposer, confirmer, staff, role } };
}

/** Returns the new request id, or "already holds". The database stays the final word on roles, activity and one-time use. */
export async function grantRole(client: pg.ClientBase, i: { proposer: string; confirmer: string; staff: string; role: string }): Promise<string> {
  await client.query("begin");
  try {
    const { rows } = await client.query("select lower(email) as email, id from staff_user where lower(email) = any($1)", [[i.proposer, i.confirmer, i.staff]]);
    const id = (email: string) => rows.find((r) => r.email === email)?.id as string | undefined;
    const [p, c, s] = [id(i.proposer), id(i.confirmer), id(i.staff)];
    if (!p || !c || !s) throw new Error(`no staff member with the email ${[[i.proposer, p], [i.confirmer, c], [i.staff, s]].find(([, x]) => !x)![0]}`);
    if ((await client.query("select 1 from staff_role where staff_user_id=$1 and role=$2", [s, i.role])).rowCount) {
      await client.query("rollback");
      return "already holds";
    }
    const request = await proposeGrant(client, p, s, i.role);
    await confirmGrant(client, { confirmer: c, proposer: p, staff: s, role: i.role, request });
    await client.query("commit");
    return request;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const { input, error } = parseGrantArgs(argv);
  if (!input) return log(error!), 2;
  if (!env.DATABASE_URL) return log("DATABASE_URL is not set (the admin app's login, app_admin)"), 2;
  const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: sslOptions(env) });
  try {
    await client.connect();
    const done = await grantRole(client, input);
    log(done === "already holds" ? `${input.staff} already holds ${input.role}; nothing was written` : `granted ${input.role} to ${input.staff} (approval request ${done})`);
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
