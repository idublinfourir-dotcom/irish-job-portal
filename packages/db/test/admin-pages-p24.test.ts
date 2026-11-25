/* eslint-disable @typescript-eslint/no-explicit-any */
// Step 16 pages P24 (wave 3): /reports and /ban-list, the pages' own server code on the real test database as app_admin with real staff sessions (the pattern of
// admin-pages-p29b.test.ts): every role, no role, a disabled login, a forged session and a visitor; hostile addresses; the second-officer rule walked through the real
// route and read on the page; statements and time. Fake people only, no network. The reads themselves are proved in trust-board.test.ts.
// Budget (measured 25 November 2026, printed by the last test): reports 12 statements (median 12.9 ms), ban list 8 (6.4 ms). Limits: plus 4 statements, 150 ms. Raise on purpose only.
import type pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { counted, median, ROLE_NAMES, staffHarness } from "./staff-routes-harness";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`REDIRECT:${to}`), { to }); },
  useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/",
}));
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const BUDGET = { reports: 16, banList: 12, ms: 150 };
type Params = Record<string, string | string[] | undefined>;
type Page = (a?: { searchParams: Promise<Params> }) => Promise<React.ReactElement>;
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool, reports: Page, banList: Page, CASES: any, reportId: string, caseId: string, reporter: string;
const pageModule = (name: string): Promise<{ default: Page }> => import(/* @vite-ignore */ `../../../apps/admin/app/${name}`);
const ROLE = (r: string) => `only_${r}`;
const NO_ACCESS = /This page is not for your roles/;
const SIGN_IN = "REDIRECT:/sign-in";

async function render(who: string | null, page: Page, p: Params = {}): Promise<string> {
  state.headers = new Headers(who ? { cookie: h.cookies[who]! } : {});
  try {
    return renderToStaticMarkup(await page({ searchParams: Promise.resolve(p) }));
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("REDIRECT:")) return e.message;
    throw e;
  }
}
const post = (who: string, body: unknown) => h.call(CASES, "/", who, body);

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  for (const r of ROLE_NAMES) await h.makeStaff(ROLE(r), [r]);
  for (const n of ["ts1", "ts2"]) await h.makeStaff(n, ["trust_and_safety"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("gone", ["trust_and_safety"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.gone]);
  reports = (await pageModule("reports/page")).default;
  banList = (await pageModule("ban-list/page")).default;
  CASES = await import("../../../apps/admin/app/api/trust-safety/cases/route");
  const org = (await su.query("insert into organisation(slug, display_name, kind, status) values ('fake-p24', 'Fake Reported Ltd', 'employer', 'verified') returning id::text")).rows[0].id;
  reporter = (await su.query("insert into candidate_user(id, name, email, email_verified) values ('p24-reporter', 'Fake Reporter', 'fake.p24.reporter@example.test', true) returning id")).rows[0].id;
  reportId = (await su.query("insert into report(target_kind, target_organisation_id, reporter_candidate_user_id, reason, evidence_text) values ('organisation', $1, $2, 'fake_company', '<img src=x onerror=alert(1)> proof') returning id::text", [org, reporter])).rows[0].id;
  const opened = await post("ts1", { action: "open", organisationId: org, caseKind: "instant_ban", reasonCode: "asks_for_money" });
  expect(opened.status).toBe(200);
  caseId = opened.json.caseId;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("who gets the pages (trust and safety only, no role stands in for another)", () => {
  for (const [name, page] of [["reports", () => reports], ["ban-list", () => banList]] as const) {
    it(`${name}: a visitor, a disabled login and a forged session go to sign in`, async () => {
      expect(await render(null, page())).toBe(SIGN_IN);
      expect(await render("gone", page())).toBe(SIGN_IN);
      state.headers = new Headers({ cookie: "better-auth.session_token=forged" });
      await expect(page()({ searchParams: Promise.resolve({}) })).rejects.toThrow(SIGN_IN);
    });
    it(`${name}: every role, and no role`, async () => {
      for (const role of ROLE_NAMES) {
        const html = await render(ROLE(role), page());
        expect(NO_ACCESS.test(html), role).toBe(role !== "trust_and_safety");
        if (role !== "trust_and_safety") expect(html, role).not.toMatch(/Fake Reported|proof/);
      }
      expect(await render("norole", page())).toMatch(NO_ACCESS);
    });
  }
});

describe("what the pages show", () => {
  it("a report: its evidence as text, never the reporter's id, name or email, and no staff id", async () => {
    const html = await render("ts1", reports, { id: `R-${reportId.padStart(4, "0")}` });
    expect(html).toContain("Fake Reported Ltd");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; proof");
    expect(html).not.toMatch(/<img src=x|Fake Reporter|fake\.p24|p24-reporter|better-auth/);
    for (const id of Object.values(h.staff)) expect(html).not.toContain(id);
  });
  it("a proposed ban: the proposer gets Withdraw and no Confirm, a second officer gets Confirm, and the route refuses the proposer", async () => {
    expect((await post("ts1", { action: "decide", caseId, outcome: "ban", conclusive: true })).status).toBe(200);
    const id = `C-${caseId.padStart(4, "0")}`;
    const mine = await render("ts1", reports, { id }), other = await render("ts2", reports, { id });
    expect(mine).toMatch(/Waiting for a second officer/);
    expect(mine).toMatch(/Withdraw/);
    expect(mine).not.toMatch(/>Confirm</);
    expect(other).toMatch(/>Confirm/);
    const own = await post("ts1", { action: "confirm", caseId });
    expect([own.status, JSON.stringify(own.json)]).toEqual([409, expect.stringContaining("same_person")]);
  });
  it("hostile addresses: an unknown tab, a made-up, long, repeated or injected id and cursor show the page, never an error or the text back", async () => {
    for (const p of [{ tab: "x" }, { tab: ["open", "closed"] }, { id: "R-1 or 1=1" }, { id: "Z-0001" }, { id: "C-99999999999999999999" }, { id: ["R-1", "R-2"] }, { after: "a".repeat(500) }, { after: "<script>alert(1)</script>" }] as Params[]) {
      const html = await render("ts1", reports, p);
      expect(html, JSON.stringify(p)).toContain("<h1");
      expect(html).not.toMatch(/<script>alert|or 1=1/);
    }
    for (const p of [{ after: "x" }, { wrc: "x" }, { after: ["1", "2"] }, { wrc: "a".repeat(500) }] as Params[]) expect(await render("ts1", banList, p), JSON.stringify(p)).toContain("<h1");
  });
});

describe("budgets", () => {
  it("statements and median time per page", async () => {
    const out: string[] = [];
    for (const [name, page, limit] of [["reports", reports, BUDGET.reports], ["ban-list", banList, BUDGET.banList]] as const) {
      const [, n] = await counted(() => render("ts1", page));
      const ms = await median(() => render("ts1", page));
      out.push(`${name} ${n} statements, median ${ms.toFixed(1)} ms`);
      expect(n, name).toBeLessThanOrEqual(limit);
      expect(ms, name).toBeLessThan(BUDGET.ms);
    }
    console.log(`P24 pages: ${out.join("; ")}`);
  });
});
