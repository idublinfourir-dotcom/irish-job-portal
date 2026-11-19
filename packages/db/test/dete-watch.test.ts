// Integration: the weekly DETE watcher (src/dete-watch-cli.ts) through its real command on the real test database as app_admin, with DETE's
// site always a fake serving the pages saved on 19 Nov 2026 (fixtures/dete-watch). No network.
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main, WATCH } from "../src/dete-watch-cli";
import { createTestDb, urlFor, type TestDb } from "./db";
import { counted, median } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// Statements per run: one read of the stored rows and one write per address fetched (5 addresses: 6). Measured 19 Nov 2026 on the test
// database: about 15 ms a run with the fake site; limit 200 ms.
const BUDGET = { statements: 1 + WATCH.length, ms: 200 };

const fx = (f: string) => readFileSync(new URL(`./fixtures/dete-watch/${f}`, import.meta.url));
const LATEST = fx("latest-updates.html").toString("utf8");
const DOC = fx("critical-skills-occupations-list.docx");
type Reply = { body: string | Buffer; etag?: string; status?: number } | "throw";
const pages = (): Record<string, Reply> => ({
  "latest-updates": { body: LATEST },
  "csol-page": { body: fx("csol.html") },
  "iol-page": { body: fx("iol.html") },
  "csol-docx": { body: DOC, etag: "639299183439230000" },
  "iol-docx": { body: Buffer.concat([DOC, Buffer.from("iol")]), etag: "639299183096030000" },
});

/** A fake DETE site: one reply per watched id; records each address asked for and checks the fetch options. */
function site(replies: Record<string, Reply>) {
  const asked: string[] = [];
  const get = (async (url: string, init?: RequestInit) => {
    asked.push(url);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const r = replies[WATCH.find((w) => w.address === url)!.id]!;
    if (r === "throw") throw new TypeError("fetch failed");
    return new Response(new Uint8Array(Buffer.from(r.body)), { status: r.status ?? 200, headers: r.etag ? { etag: r.etag } : {} });
  }) as unknown as typeof fetch;
  return { get, asked };
}

let db: TestDb, su: pg.Pool;
const ENV = (role = "app_admin") => ({ DETE_WATCH_ADMIN_DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" });
const run = async (replies: Record<string, Reply>, env: Record<string, string | undefined> = ENV()) => {
  const out: string[] = [];
  const s = site(replies);
  return { code: await main([], env, (l) => out.push(l), { fetch: s.get }), out: out.join("\n"), asked: s.asked };
};
const items = async () => (await su.query("select reason, detail, status from review_item where queue = 'scheduled_check' and reason = 'dete_page_changed' order by id")).rows;
const watch = async () => (await su.query("select address, fingerprint, titles, checked_at, changed_at from dete_watch order by address")).rows;
// A new dated item at the top of the notices, as DETE writes them.
const withNewItem = (title: string) => LATEST.replace("<h2>2027 Seasonal", `<h2>${title}</h2><p><strong>18 November 2026</strong></p><p>Text.</p><h2>2027 Seasonal`);

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
});
afterAll(() => db.drop());

describe("the weekly DETE watch", () => {
  it("is refused without the login or with arguments", async () => {
    expect((await run(pages(), {})).code).toBe(2);
    const out: string[] = [];
    expect(await main(["x"], ENV(), (l) => out.push(l), { fetch: site(pages()).get })).toBe(2);
  });

  it("the first run stores the baseline and raises nothing; the same content again (new __VIEWSTATE) raises nothing", async () => {
    const r = await run(pages());
    expect(r.code).toBe(0);
    expect(r.asked).toEqual(WATCH.map((w) => w.address)); // each address once
    expect(r.out.match(/baseline stored/g)).toHaveLength(5);
    expect(await items()).toEqual([]);
    const before = await watch();
    expect(before).toHaveLength(5);
    const p = pages();
    p["latest-updates"] = { body: LATEST.replace(/(__VIEWSTATE" value=")[^"]*/, "$1other").replace(/Elapsed time: [\d.]+/, "Elapsed time: 1.5") };
    const again = await run(p);
    expect(again.out.match(/unchanged/g)).toHaveLength(5);
    expect(await items()).toEqual([]);
    const after = await watch();
    expect(after.map((w) => [w.fingerprint, w.changed_at])).toEqual(before.map((w) => [w.fingerprint, w.changed_at]));
    expect(after[0].checked_at.getTime()).toBeGreaterThan(before[0].checked_at.getTime());
  });

  it("a new dated item raises one item naming it; a second run writes nothing new", async () => {
    const p = pages();
    p["latest-updates"] = { body: withNewItem("Update on quota for test role") };
    const r = await run(p);
    expect(r.out).toMatch(/Latest employment permits notices: changed, review item written \(new: Update on quota for test role\)/);
    expect(await items()).toEqual([{ reason: "dete_page_changed", status: "open", detail: { key: expect.stringMatching(/^dete_page_changed:latest-updates:/), role: "rules_data_editor", name: "Latest employment permits notices", address: WATCH[0].address, newTitles: "Update on quota for test role" } }]);
    await run(p);
    expect(await items()).toHaveLength(1);
  });

  it("a changed Word file ETag raises one item for that file only", async () => {
    const p = pages();
    p["latest-updates"] = { body: withNewItem("Update on quota for test role") };
    p["csol-docx"] = { body: DOC, etag: "639399999999999999" };
    await run(p);
    const all = await items();
    expect(all).toHaveLength(2);
    expect(all[1].detail).toEqual({ key: expect.stringMatching(/^dete_page_changed:csol-docx:/), role: "rules_data_editor", name: "Critical Skills Occupations List (Word file)", address: WATCH[3].address });
  });

  it("one address failing raises nothing for it and the others still work; every address failing turns the step red", async () => {
    const p = pages();
    p["csol-docx"] = { body: DOC, etag: "639399999999999999" };
    p["iol-page"] = { body: "gone", status: 404 };
    p["csol-page"] = { body: "<html>maintenance</html>" }; // no main text
    p["iol-docx"] = "throw";
    p["latest-updates"] = { body: withNewItem("Another new notice") };
    const before = (await watch()).find((w) => w.address === WATCH[2].address);
    const r = await run(p);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Ineligible Occupations List page: fetch failed, nothing raised: HTTP 404/);
    expect(r.out).toMatch(/Critical Skills Occupations List page: fetch failed, nothing raised: the page has no main text/);
    expect(r.out).toMatch(/Ineligible Occupations List \(Word file\): fetch failed, nothing raised: fetch failed/);
    expect((await items()).map((i) => i.detail.newTitles ?? null)).toEqual(["Update on quota for test role", null, "Another new notice"]);
    expect((await watch()).find((w) => w.address === WATCH[2].address)).toEqual(before); // a failed address is not touched
    const red = await run(Object.fromEntries(WATCH.map((w) => [w.id, "throw" as const])));
    expect(red.code).toBe(1);
    expect(red.out).toMatch(/every address failed/);
  });

  it("hostile page content: huge text, control characters and script tags are cut and stored as plain text", async () => {
    const evil = `<h2><script>steal()</script><img src=x onerror=alert(1)>Evil\u0000\u001b[31m${"A".repeat(100_000)}</h2>`;
    await run(pages());
    const p = pages();
    p["latest-updates"] = { body: LATEST.replace("<h2>2027 Seasonal", `${evil}<h2>2027 Seasonal`) };
    await run(p);
    const last = (await items()).at(-1)!;
    expect(last.detail.newTitles).toMatch(/^Evil \[31mA+$/);
    expect(last.detail.newTitles.length).toBeLessThanOrEqual(200);
    const titles: string[] = (await watch()).find((w) => w.address === WATCH[0].address)!.titles;
    expect(titles.every((t) => t.length <= 200 && !/[<>\u0000-\u001f]/.test(t))).toBe(true);
    const big = pages();
    big["latest-updates"] = { body: Buffer.alloc(11 * 1024 * 1024, 0x41) };
    expect((await run(big)).out).toMatch(/Latest employment permits notices: fetch failed, nothing raised: over 10485760 bytes/);
  });

  it("the database refuses a row off DETE's site or with an oversized value, even from app_admin; other logins cannot read it", async () => {
    const a = db.pool("app_admin");
    await expect(a.query("insert into dete_watch(address, fingerprint) values ('https://evil.example/', 'x')")).rejects.toThrow(/check constraint/);
    await expect(a.query("insert into dete_watch(address, fingerprint) values ('https://enterprise.gov.ie/x', $1)", ["x".repeat(201)])).rejects.toThrow(/check constraint/);
    await expect(a.query("delete from dete_watch")).rejects.toThrow(/permission denied/);
    for (const role of ["app_portal", "app_candidate", "app_fetcher", "anon", "authenticated"] as const)
      await expect(db.pool(role).query("select 1 from dete_watch")).rejects.toThrow(/permission denied/);
  });

  it("performance: one read and one write per address, under the time budget", async () => {
    const [r, n] = await counted(() => run(pages()));
    expect(r.code).toBe(0);
    expect(n).toBe(BUDGET.statements);
    expect(await median(() => run(pages()))).toBeLessThan(BUDGET.ms);
  });
});
