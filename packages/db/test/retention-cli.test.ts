// The daily retention run on the real test database, as app_admin: rows past their period go, rows inside it stay, the loop stops, a second
// run does nothing, the cap holds, and other logins are refused. Fake data only. Periods are the starting values in `setting` (placeholders).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/file-store.ts";
import { drain, main, REFERENCED, sweep } from "../src/retention-cli.ts";
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

describe("retention removes stored files", () => {
  const consent = async (who: string) => (await su("insert into consent_record(candidate_user_id, consent_text_id) values ($1, (select id from consent_text limit 1)) returning id", [who])).rows[0].id;
  const drainWith = async (store: ReturnType<typeof memoryStore>) => {
    const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
    await c.connect();
    const lines: string[] = [];
    try { return { code: await drain(c, (l) => lines.push(l), undefined, undefined, () => store), lines }; } finally { await c.end(); }
  };
  beforeAll(async () => {
    await su("insert into consent_text(purpose, version, body) values ('services_request', 'v-files', 'Fake wording')");
  });
  it("a due erase (a deleted account's CV) and a due case copy return their keys, and the run removes exactly those objects", async () => {
    await candidate("c-files-gone", true, "90 days");
    await su("update candidate_user set deleted_at = now() - interval '40 days' where id = 'c-files-gone'");
    await su("insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes) values ('c-files-gone', 'cv/gone', 'a.pdf', 'pdf', 10)");
    await candidate("c-files-case", true, "1 day");
    const sc = (await su("insert into services_case(candidate_user_id, consent_record_id, status, closed_at, close_reason) values ('c-files-case', $1, 'closed', now() - interval '40 days', 'withdrawn') returning id", [await consent("c-files-case")])).rows[0].id;
    const doc = (await su("insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id) values ($1, 'case/old', 'p.pdf', 'pdf', 10, 'c-files-case') returning id", [sc])).rows[0].id;
    const store = memoryStore();
    for (const k of ["cv/gone", "case/old", "cv/keep"]) await store.put(k, new Uint8Array([1]), "application/pdf");
    const r = await drainWith(store);
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect([...store.objects.keys()]).toEqual(["cv/keep"]);
    expect(r.lines.join("\n")).toMatch(/deleted_account_grace \(candidate\): 1 done/);
    expect(r.lines.join("\n")).toMatch(/services_case_copy: 1 done/);
    expect(r.lines.at(-1)).toBe("stored files: 2 removed, 0 failed");
    expect(r.lines.join("\n")).not.toMatch(/cv\/gone|case\/old/);
    expect((await su("select storage_key, copy_deleted_at is not null gone from case_document where id = $1", [doc])).rows[0]).toEqual({ storage_key: null, gone: true });
  });
  it("a failed removal makes the run red and prints a count, never the key", async () => {
    await candidate("c-files-fail", true, "90 days");
    await su("update candidate_user set deleted_at = now() - interval '40 days' where id = 'c-files-fail'");
    await su("insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes) values ('c-files-fail', 'cv/fail', 'a.pdf', 'pdf', 10)");
    const store = memoryStore();
    store.failNext();
    const r = await drainWith(store);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe("not removed (file store: fake failure): 1 files, the weekly orphan sweep removes them");
    expect(r.lines.join()).not.toContain("cv/fail");
    expect((await runMain()).code).toBe(0); // the row went with the erase: tomorrow's run has nothing left to remove
  });
});

// Audit OPS-3: the weekly orphan sweep, as the read-only app_backup login, with the store fake.
describe("the orphan sweep (retention-cli.ts sweep)", () => {
  const DAY = 24 * 60 * 60_000;
  const sweepEnv = (role = "app_backup") => ({ SWEEP_BACKUP_DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" });
  const runSweep = async (store: ReturnType<typeof memoryStore>, role?: string) => {
    const lines: string[] = [];
    return { code: await main(["sweep"], sweepEnv(role), (l) => lines.push(l), () => store), lines };
  };
  const put = async (store: ReturnType<typeof memoryStore>, key: string, ageMs: number) => {
    await store.put(key, new Uint8Array([1]), "application/pdf");
    store.times.set(key, new Date(Date.now() - ageMs));
  };

  it("an erase while the store fails leaves an orphan; the sweep removes it and keeps every key a row names, fresh uploads and rules/ files", async () => {
    // the erase: a deleted account past its grace, its CV removal fails, the row goes anyway
    await candidate("c-sweep-gone", true, "90 days");
    await su("update candidate_user set deleted_at = now() - interval '40 days' where id = 'c-sweep-gone'");
    await su("insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes) values ('c-sweep-gone', 'cv/sweep-gone', 'a.pdf', 'pdf', 10)");
    const store = memoryStore();
    await put(store, "cv/sweep-gone", 3 * DAY);
    store.failNext();
    const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
    await c.connect();
    try { expect(await drain(c, () => {}, undefined, undefined, () => store)).toBe(1); } finally { await c.end(); }
    expect(store.objects.has("cv/sweep-gone")).toBe(true);
    expect((await su("select count(*)::int n from candidate_cv where storage_key = 'cv/sweep-gone'")).rows[0].n).toBe(0);
    // live rows that name old files: a CV, an application's CV copy, a case document, a pending sponsor confirmation
    await candidate("c-sweep-live", true, "90 days");
    await su("insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes) values ('c-sweep-live', 'cv/sweep-live', 'a.pdf', 'pdf', 10)");
    const staff = `s-sweep-${Date.now()}`;
    await su("insert into staff_user(id, name, email, email_verified, created_at, updated_at) values ($1, 'Fake Staff', $2, true, now(), now())", [staff, `${staff}@example.test`]);
    const t = await db.pool("postgres").connect();
    try {
      await t.query("begin");
      await t.query("set local session_replication_role = replica"); // the guard triggers want a full staff session; this test only needs the row
      await t.query("insert into approval_request(kind, target_table, target_id, proposed_by_staff_user_id, change) values ('manual_post_sponsor_confirmed', 'sponsorship_statement', '1', $1, $2)", [staff, { key: "sponsor/wait.pdf" }]);
      await t.query("commit");
    } catch (e) { await t.query("rollback"); throw e; } finally { t.release(); }
    for (const k of ["cv/sweep-live", "sponsor/wait.pdf", "rules/old.pdf", "case/orphan-old", "logo/orphan.png"]) await put(store, k, 3 * DAY);
    await put(store, "case/in-flight", 60_000); // an upload whose row is not written yet: under 24 hours, kept
    await put(store, "cv/23h", DAY - 60 * 60_000);
    const r = await runSweep(store);
    expect(r.code, r.lines.join("\n")).toBe(0);
    expect([...store.objects.keys()].sort()).toEqual(["case/in-flight", "cv/23h", "cv/sweep-live", "rules/old.pdf", "sponsor/wait.pdf"]);
    expect(r.lines).toEqual(["sweep: 5 files older than 24 hours, 2 still named by a row, 3 orphans removed (cv/ 1, case/ 1, authority/ 0, logo/ 1, sponsor/ 0, evidence/ 0), 0 failed"]);
    expect(r.lines.join()).not.toMatch(/sweep-gone|orphan-old|orphan\.png/); // counts only: the run log of a public repo is public
    // a second run finds nothing to remove
    expect((await runSweep(store)).lines[0]).toMatch(/2 still named by a row, 0 orphans removed/);
  });
  it("a failed listing or a failed query removes nothing and is red; a failed removal is red with a count", async () => {
    const store = memoryStore();
    await put(store, "cv/never-named", 3 * DAY);
    store.failNext();
    const l = await runSweep(store);
    expect([l.code, l.lines[0]]).toEqual([1, "refused: file store: fake failure"]);
    const q = await runSweep(store, "app_candidate"); // a login that cannot read the key columns: the query fails, nothing removed
    expect(q.code).toBe(1);
    expect(q.lines[0]).toMatch(/^refused: permission denied/);
    expect(store.objects.has("cv/never-named")).toBe(true);
    const c = new pg.Client({ connectionString: urlFor(db.name, "app_backup") });
    await c.connect();
    const lines: string[] = [];
    let first = true;
    const failing = { ...store, remove: async (k: string) => { if (first) { first = false; throw new Error("fake"); } return store.remove(k); } };
    try { expect(await sweep(c, (x) => lines.push(x), () => failing)).toBe(1); } finally { await c.end(); }
    expect(lines[0]).toMatch(/0 orphans removed .*, 1 failed$/);
  });
  it("more orphans than the cap: nothing removed, red (a wrong database must not empty the bucket)", async () => {
    const store = memoryStore();
    for (let i = 0; i < 4; i++) await put(store, `case/cap-${i}`, 3 * DAY);
    const c = new pg.Client({ connectionString: urlFor(db.name, "app_backup") });
    await c.connect();
    const lines: string[] = [];
    try { expect(await sweep(c, (x) => lines.push(x), () => store, Date.now(), 3)).toBe(1); } finally { await c.end(); }
    expect(store.objects.size).toBe(4);
    expect(lines).toEqual(["sweep: 4 orphans of 4 older files, over the cap (3, or half of them past 5): nothing removed, check the database login"]);
  });
  it("more than 5 orphans that are over half the older files: nothing removed, red, whatever the cap", async () => {
    const store = memoryStore();
    for (let i = 0; i < 6; i++) await put(store, `case/half-${i}`, 3 * DAY);
    const c = new pg.Client({ connectionString: urlFor(db.name, "app_backup") });
    await c.connect();
    const lines: string[] = [];
    try { expect(await sweep(c, (x) => lines.push(x), () => store)).toBe(1); } finally { await c.end(); }
    expect(store.objects.size).toBe(6);
    expect(lines[0]).toMatch(/^sweep: 6 orphans of 6 older files, over the cap/);
  });
  it("security: app_backup reads every key column with no new privilege and still cannot write; a hostile key is only a value", async () => {
    const all = (await su("select array_agg(r.rolname::text order by 1) m from pg_auth_members a join pg_roles r on r.oid = a.roleid where a.member = 'app_backup'::regrole")).rows[0].m;
    expect(all).toEqual(["pg_read_all_data"]);
    await expect(db.query("app_backup", "delete from candidate_cv")).rejects.toThrow(/permission denied/);
    const store = memoryStore();
    await put(store, "cv/x'); delete from candidate_cv; --", 3 * DAY);
    const r = await runSweep(store);
    expect(r.code).toBe(0);
    expect(store.objects.size).toBe(0);
    expect((await su("select count(*)::int n from candidate_cv where storage_key = 'cv/sweep-live'")).rows[0].n).toBe(1);
  });
  it("performance: one statement for every listed key, and its pages stay within budget with 2,000 keys", async () => {
    const { measurePages, assertPageBudget } = await import("./perf/pages");
    const keys = Array.from({ length: 2000 }, (_, i) => `cv/perf-${i}`);
    const c = new pg.Client({ connectionString: urlFor(db.name, "app_backup") });
    await c.connect();
    try {
      const costs = await measurePages(c, [{ text: REFERENCED, values: [keys] }]);
      assertPageBudget("orphan sweep query", costs, 100);
      let statements = 0;
      const counting = { query: (sql: string, p?: unknown[]) => (statements++, c.query(sql, p)) };
      const store = memoryStore();
      for (const k of keys.slice(0, 50)) await put(store, k, 3 * DAY);
      await sweep(counting as never, () => {}, () => store, Date.now(), 100);
      expect(statements).toBe(1);
    } finally { await c.end(); }
  });
});
