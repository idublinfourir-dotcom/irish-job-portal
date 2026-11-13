// The daily retention run on the real test database, as app_admin: rows past their period go, rows inside it stay, the loop stops, a second
// run does nothing, the cap holds, and other logins are refused. Fake data only. Periods are the starting values in `setting` (placeholders).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drain, main } from "../src/retention-cli.ts";
import { createTestDb, urlFor } from "./db";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let db: Awaited<ReturnType<typeof createTestDb>>;
let src: number;
const su = (sql: string, p?: unknown[]) => db.query("postgres", sql, p);
const count = async (table: string, id: string) => (await su(`select count(*)::int n from ${table} where id = $1`, [id])).rows[0].n;
const env = (role: string) => ({ RETENTION_ADMIN_DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" });
const runMain = async (role = "app_admin") => {
  const lines: string[] = [];
  return { code: await main([], env(role), (l) => lines.push(l)), lines };
};
const session = (id: string, user: string, expires: string) =>
  su("insert into candidate_session(id, expires_at, token, updated_at, user_id) values ($1, now() + $2::interval, $3, now(), $4)", [id, expires, `tok-${id}`, user]);
const candidate = (id: string, verified: boolean, age: string) =>
  su("insert into candidate_user(id, name, email, email_verified, created_at, updated_at, last_active_at) values ($1, 'Fake Person', $2, $3, now() - $4::interval, now(), now())", [id, `${id}@example.test`, verified, age]);

beforeAll(async () => {
  db = await createTestDb();
  src = (await su("insert into job_source(kind, board) values ('board','fakeboard') returning id")).rows[0].id;
  await candidate("c-keep", true, "40 days"); // verified: never an unverified-account target
  await candidate("c-old-unverified", false, "8 days"); // past 7 days
  await candidate("c-new-unverified", false, "2 days"); // inside 7 days
  await session("s-old", "c-keep", "-3 days"); // expired more than 1 day ago
  await session("s-fresh", "c-keep", "1 day");
  await session("s-just-expired", "c-keep", "-2 hours"); // expired, but inside the 1 day grace
  for (const age of ["13 months", "1 day"])
    await su("insert into fetch_run(job_source_id, started_at, finished_at) values ($1, now() - $2::interval, now())", [src, age]);
});
afterAll(() => db.drop());

describe("retention run against the real rules", () => {
  it("first run: rows past their period go, rows inside it stay (three rules), and it ends green", async () => {
    const r = await runMain();
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect(r.lines.at(-1)).toMatch(/^retention: \d+ rows handled$/);
    expect(r.lines.join("\n")).toMatch(/unverified_account \(candidate\): 1 done/);
    expect(r.lines.join("\n")).toMatch(/expired_login_rows \(candidate_session\): 1 done/);
    expect(r.lines.join("\n")).toMatch(/fetch_run: 1 done/);
    expect([await count("candidate_user", "c-old-unverified"), await count("candidate_session", "s-old")]).toEqual([0, 0]);
    expect((await su("select count(*)::int n from fetch_run where started_at < now() - interval '12 months'")).rows[0].n).toBe(0);
    expect([await count("candidate_user", "c-new-unverified"), await count("candidate_user", "c-keep"), await count("candidate_session", "s-fresh"), await count("candidate_session", "s-just-expired")]).toEqual([1, 1, 1, 1]);
    expect((await su("select count(*)::int n from fetch_run")).rows[0].n).toBe(1);
  });
  it("a second run does nothing", async () => {
    const r = await runMain();
    expect(r).toMatchObject({ code: 0, lines: ["retention: 0 rows handled"] });
  });
  it("the cap holds: with batch 1 and a cap of 2, three due rows leave one, and the run goes red", async () => {
    for (const i of [1, 2, 3]) await session(`s-cap-${i}`, "c-keep", "-5 days");
    const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
    await c.connect();
    const lines: string[] = [];
    try { expect(await drain(c, (l) => lines.push(l), 1, 2)).toBe(1); } finally { await c.end(); }
    expect(lines.at(-1)).toMatch(/cap of 2 calls/);
    expect((await su("select count(*)::int n from candidate_session where id like 's-cap-%'")).rows[0].n).toBe(1);
    expect((await runMain()).code).toBe(0); // the next full run finishes it
    expect((await su("select count(*)::int n from candidate_session where id like 's-cap-%'")).rows[0].n).toBe(0);
  });
  it("performance: one statement per rule that fires, plus the final empty call, and a loose time limit", async () => {
    for (const i of [1, 2, 3, 4, 5]) await session(`s-perf-${i}`, "c-keep", "-5 days");
    await candidate("c-perf-unverified", false, "9 days");
    await su("insert into fetch_run(job_source_id, started_at, finished_at) values ($1, now() - interval '14 months', now())", [src]);
    const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
    await c.connect();
    let statements = 0;
    const counting = { query: (...a: Parameters<pg.Client["query"]>) => (statements++, (c.query as (...x: unknown[]) => unknown)(...a)) } as never;
    const t0 = Date.now();
    try { expect(await drain(counting, () => {})).toBe(0); } finally { await c.end(); }
    expect(statements).toBe(4); // sessions, unverified candidate, fetch_run, then rule null
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

describe("retention security", () => {
  it("app_candidate and app_fetcher are refused and nothing is deleted", async () => {
    await session("s-sec", "c-keep", "-5 days");
    for (const role of ["app_candidate", "app_fetcher", "app_portal"]) {
      const r = await runMain(role);
      expect(r.code).toBe(1);
      expect(r.lines.join()).toMatch(/^refused: .*permission denied/);
    }
    expect(await count("candidate_session", "s-sec")).toBe(1);
  });
  it("a wrong password is refused without printing it", async () => {
    const lines: string[] = [];
    const url = urlFor(db.name, "app_admin").replace(/:[^:@/]*@/, ":wrongpw-xyz@");
    expect(await main([], { RETENTION_ADMIN_DATABASE_URL: url, DATABASE_SSL: "disable" }, (l) => lines.push(l))).toBe(1);
    expect(lines.join()).not.toMatch(/wrongpw-xyz/);
  });
  it("hostile arguments are refused before any connection", async () => {
    const lines: string[] = [];
    expect(await main(["--batch", "1; drop table candidate_user"], env("app_admin"), (l) => lines.push(l))).toBe(2);
    expect(await count("candidate_user", "c-keep")).toBe(1);
  });
});
