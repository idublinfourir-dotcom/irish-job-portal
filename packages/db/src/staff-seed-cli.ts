// The owner's one-off command that makes the first staff logins (#170). Run from the repo root with the owner's login, as for migrations:
//   DATABASE_URL_MIGRATE=... node packages/db/src/staff-seed-cli.ts <email> "<name>" <role>[,<role>...]
// It asks for the password twice and does not show it. The roles are seeded by the owner (seeded_by_owner), so they need no
// two-person request; app_admin cannot write that column, which is why this runs as the owner. One transaction: all or nothing.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { hashPassword } from "better-auth/crypto";
import { sslOptions } from "./ssl.ts";

// The roles in staff_role's CHECK (migration 0001). The CHECK is still the final word.
export const STAFF_ROLES = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "content_editor", "administrator"];

export type SeedInput = { email: string; name: string; roles: string[] };

/** Checks the command line. Emails are stored lowercased, as Better Auth looks them up. */
export function parseSeedArgs(argv: string[]): { input?: SeedInput; error?: string } {
  if (argv.length !== 3) return { error: 'usage: staff-seed-cli.ts <email> "<name>" <role>[,<role>...]' };
  const email = argv[0]!.trim().toLowerCase(), name = argv[1]!.trim();
  const roles = [...new Set(argv[2]!.split(",").map((r) => r.trim()))];
  if (email.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) return { error: "the email is not a plain address" };
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return { error: "the name must be 1 to 100 characters, with no control characters" };
  const unknown = roles.filter((r) => !STAFF_ROLES.includes(r));
  if (unknown.length || !roles.length) return { error: `unknown role: ${unknown.join(", ") || "(none)"}; roles are ${STAFF_ROLES.join(", ")}` };
  return { input: { email, name, roles } };
}

/** At least 12 characters; at most 128, Better Auth's own maximum, so the person can sign in with it. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return "the password must be at least 12 characters";
  if (password.length > 128) return "the password must be at most 128 characters";
  return null;
}

export async function seedStaff(client: pg.ClientBase, input: SeedInput, password: string): Promise<string> {
  const id = randomUUID(), hash = await hashPassword(password);
  await client.query("begin");
  try {
    // Only the owner can take this role; app_admin and the other app roles are refused here.
    await client.query("set local role portal_owner").catch(() => {
      throw new Error("this command runs only as the database owner (DATABASE_URL_MIGRATE)");
    });
    const taken = await client.query("select 1 from staff_user where lower(email) = $1", [input.email]);
    if (taken.rowCount) throw new Error("a staff login with this email already exists; nothing was written");
    await client.query("insert into staff_user(id, name, email, email_verified, status) values ($1, $2, $3, true, 'active')", [id, input.name, input.email]);
    await client.query("insert into staff_account(id, account_id, provider_id, user_id, password, updated_at) values ($1, $2, 'credential', $2, $3, now())", [randomUUID(), id, hash]);
    await client.query("insert into staff_role(staff_user_id, role, seeded_by_owner) select $1, unnest($2::text[]), true", [id, input.roles]);
    // Same source as the owner's erase functions, which a named person also runs by hand.
    await client.query(
      "insert into audit_event(kind, actor_system, action, object_type, object_id, after, source) values ('admin_action', 'staff-seed-cli by ' || session_user, 'staff.seed', 'staff_user', $1, $2, 'scheduled_job')",
      [id, { roles: input.roles }],
    );
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

// Reads one line from the terminal without showing it. Piped input (the tests) is read as is, first line only.
async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let all = "";
    for await (const chunk of stdin) all += chunk;
    return all.split(/\r?\n/)[0]!;
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  return new Promise((done, fail) => {
    let s = "";
    const finish = () => (stdin.setRawMode(false), stdin.pause(), stdin.off("data", on), process.stderr.write("\n"));
    const on = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") return finish(), done(s);
        if (c === "\u0003") return finish(), fail(new Error("cancelled"));
        s = c === "\u007f" ? s.slice(0, -1) : s + c;
      }
    };
    stdin.on("data", on).resume();
  });
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void, read = readHidden): Promise<number> {
  const { input, error } = parseSeedArgs(argv);
  if (!input) return log(error!), 2;
  const url = env.DATABASE_URL_MIGRATE;
  if (!url) return log("DATABASE_URL_MIGRATE is not set (the owner's login, as for migrations)"), 2;
  const password = await read("Password (not shown): ");
  const problem = passwordProblem(password);
  if (problem) return log(problem), 2;
  if (process.stdin.isTTY && (await read("Same password again: ")) !== password) return log("the two passwords differ"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    log(`made staff login ${await seedStaff(client, input, password)} for ${input.email} with roles ${input.roles.join(", ")}`);
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
