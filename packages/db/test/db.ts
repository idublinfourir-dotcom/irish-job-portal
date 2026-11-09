// Helpers for tests that need a real Postgres. Each test file gets its own copy of the migrated
// template database, so files run in parallel without touching each other. Fake data only.
import { randomBytes } from "node:crypto";
import pg from "pg";

export const ROLES = ["portal_owner", "app_candidate", "app_portal", "app_admin", "app_fetcher"] as const;
// anon and authenticated come from Supabase's image. They cannot log in, so we connect as postgres and switch role.
export type Role = (typeof ROLES)[number] | "postgres" | "anon" | "authenticated";

// One id per test run (set by the global setup, inherited by the workers), so parallel runs never share database names.
export const RUN = (process.env.PORTAL_TEST_RUN ??= String(process.pid));
export const TEMPLATE = `portal_template_${RUN}`;
const BASE = process.env.TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:54329/postgres";

export function urlFor(database: string, user = "postgres"): string {
  const url = new URL(BASE);
  url.pathname = `/${database}`;
  url.username = user;
  return url.toString();
}
export const testPassword = () => decodeURIComponent(new URL(BASE).password);

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;

export async function createTestDb() {
  const name = `portal_test_${RUN}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  await admin.query(`create database ${name} template ${TEMPLATE}`);
  await admin.end();

  const pools = new Map<Role, pg.Pool>();
  // One small pool per role, made when first asked for. Use pool("app_portal") to act as the portal app.
  const pool = (role: Role): pg.Pool => {
    let p = pools.get(role);
    if (!p) {
      const switched = role === "anon" || role === "authenticated";
      p = new pg.Pool({
        connectionString: urlFor(name, switched ? "postgres" : role),
        ...(switched ? { options: `-c role=${role}` } : {}),
        max: 4,
      });
      pools.set(role, p);
    }
    return p;
  };

  return {
    name,
    pool,
    query: (role: Role, sql: string, params?: unknown[]) => pool(role).query(sql, params),
    // Only closes connections. DROP DATABASE forces a checkpoint, and many at once took over 10 s; the global setup drops this run's databases at the end.
    async drop() {
      await Promise.all([...pools.values()].map((p) => p.end()));
    },
  };
}

type Step = () => Promise<unknown>;
const text = (e: unknown) => {
  const x = e as { code?: string; message?: string };
  return `${x.code ?? ""} ${x.message ?? String(e)}`.trim();
};

// Steps run in the order written. `refuse` must fail, and if `expect` is given the error text (code or
// message) must contain it. `ok` must succeed. Throws on the first step that does not behave.
export async function rule(spec: { ok?: Step; refuse?: Step; expect?: string }): Promise<void> {
  for (const step of Object.keys(spec)) {
    if (step === "ok") await spec.ok!();
    if (step === "refuse") {
      let error: unknown;
      try {
        await spec.refuse!();
      } catch (e) {
        error = e;
      }
      if (error === undefined) throw new Error("the bad action was accepted");
      if (spec.expect && !text(error).toLowerCase().includes(spec.expect.toLowerCase()))
        throw new Error(`refused, but not as expected (wanted "${spec.expect}"): ${text(error)}`);
    }
  }
}

// Runs fn `count` times at once. Every call finishes before this returns.
export async function race<T>(count: number, fn: (i: number) => Promise<T>) {
  const results = await Promise.allSettled(Array.from({ length: count }, (_, i) => fn(i)));
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  return { ok, bad, values: ok.map((r) => r.value), errors: bad.map((r) => text(r.reason)) };
}

// One transaction on one connection: commit if fn returns, roll back if it throws.
export async function tx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Like tx, but always rolls back, so a test can create things and look at them without leaving anything behind.
export async function scratch<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}
