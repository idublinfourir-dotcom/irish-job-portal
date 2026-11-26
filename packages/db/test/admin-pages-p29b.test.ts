/* eslint-disable @typescript-eslint/no-explicit-any */
// Step 16 pages P29b (wave 3): /figures, /settings, /legal-texts, /data-requests, /solicitors and /me, and the sign-in page's `next`: the pages' own server code on the real
// test database as app_admin with real staff sessions, as admin-pages-w5.test.ts does. Each page function is called as Next calls it and its element is rendered to HTML,
// so what a role would be sent is what is asserted. Every role, a login with no role, a disabled login, a forged session and a visitor are tried; the two-person rule is walked
// through the real routes (/api/settings, /api/legal-texts) and the page is read after each step. Only Next's request context is stood in. Fake people only, no network.
// Budget (measured 25 November 2026, two runs, printed by the last test; each read starts with requireStaff, 2 statements): an administrator's figures page 31 statements (median 22.7 to 23.7 ms,
// seven reads), settings 8 (16.6 to 17.2 ms), legal texts 8 (7.0 to 8.3 ms), data requests 8 (6.9 to 11.2 ms), solicitors 7 (8.2 to 9.1 ms), my data 3 (3.0 to 5.1 ms). Limits: the measured
// statements plus 4, and a clock limit of about 8 times the slowest median. Raise on purpose only.
import { existsSync } from "node:fs";
import { join } from "node:path";
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

const BUDGET = { figuresAdmin: 35, settings: 12, legal: 12, data: 12, solicitors: 11, me: 7, ms: 200 };
type Params = Record<string, string | string[] | undefined>;
type Page = (a?: { searchParams: Promise<Params> }) => Promise<React.ReactElement>;
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool;
let figures: Page, settings: Page, legal: Page, data: Page, solicitors: Page, me: Page, signIn: Page;
let SETTINGS: any, LEGAL: any, SOL: any;
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
const blocks = (html: string) => [...html.matchAll(/<section id="([\w-]+)"/g)].map((m) => m[1]!);
const call = (route: any, who: string | null, body?: unknown, o: Parameters<typeof h.call>[4] = {}) => h.call(route, "/", who, body, o);
const age = (who: string) => su.query("update staff_session set created_at = now() - interval '11 minutes' where user_id = $1", [h.staff[who]]);

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  su = h.su;
  for (const r of ROLE_NAMES) await h.makeStaff(ROLE(r), [r]);
  for (const n of ["admin1", "admin2"]) await h.makeStaff(n, ["administrator"]);
  await h.makeStaff("editor2", ["content_editor"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("gone", ["administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.gone]);
  const g = async (name: string) => (await pageModule(name)).default;
  figures = await g("figures/page"); settings = await g("settings/page"); legal = await g("legal-texts/page"); data = await g("data-requests/page");
  solicitors = await g("solicitors/page"); me = await g("me/page"); signIn = await g("(auth)/sign-in/page");
  SETTINGS = await import("../../../apps/admin/app/api/settings/route");
  LEGAL = await import("../../../apps/admin/app/api/legal-texts/route");
  SOL = await import("../../../apps/admin/app/api/services/solicitors/route");
  await su.query("insert into signup_no_count(day, count) values (current_date, 7), (current_date - 1, 3)");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("every page turns a visitor, a disabled login and a forged session to the sign-in page", () => {
  for (const [name, page] of [["figures", () => figures], ["settings", () => settings], ["legal-texts", () => legal], ["data-requests", () => data], ["solicitors", () => solicitors], ["me", () => me]] as const)
    it(name, async () => {
      expect(await render(null, page())).toBe(SIGN_IN);
      expect(await render("gone", page())).toBe(SIGN_IN);
      state.headers = new Headers({ cookie: "better-auth.session_token=forged" });
      expect(await render(null, page())).toBe(SIGN_IN);
    });
});

describe("who gets which page (the roles of each GET in admin.yaml)", () => {
  const WANT: Record<string, { settings: boolean; legal: boolean; data: boolean; solicitors: boolean }> = {
    account_reviewer: { settings: false, legal: false, data: false, solicitors: false }, fetched_job_reviewer: { settings: false, legal: false, data: false, solicitors: false },
    rules_data_editor: { settings: false, legal: false, data: false, solicitors: false }, trust_and_safety: { settings: false, legal: false, data: false, solicitors: false },
    services_case_handler: { settings: false, legal: false, data: false, solicitors: true }, content_editor: { settings: false, legal: true, data: false, solicitors: false },
    administrator: { settings: true, legal: true, data: true, solicitors: true },
  };
  for (const role of ROLE_NAMES)
    it(role, async () => {
      for (const [key, page, title] of [["settings", settings, "Settings"], ["legal", legal, "Legal texts"], ["data", data, "Data requests"], ["solicitors", solicitors, "Solicitors"]] as const) {
        const html = await render(ROLE(role), page);
        expect(NO_ACCESS.test(html), `${role} ${key}`).toBe(!WANT[role]![key]);
        expect(html, `${role} ${key}`).toContain(`<h1`);
        if (!WANT[role]![key]) {
          expect(html, `${role} ${key}`).not.toMatch(/Draft job|PLACEHOLDER|Add a firm|Open requests/);
          expect(html).toContain(title);
        }
      }
    });
  it("a login with no role gets the 'not for your roles' page for all four and still opens /me", async () => {
    for (const page of [settings, legal, data, solicitors]) expect(await render("norole", page)).toMatch(NO_ACCESS);
    expect(await render("norole", me)).toMatch(/No role yet/);
  });
  it("/me names the login and its roles and nobody else's, for every role", async () => {
    for (const role of ROLE_NAMES) {
      const html = await render(ROLE(role), me);
      expect(html).toContain(`Fake ${ROLE(role)}`);
      expect(html).toMatch(/Download my data/);
      expect(html).not.toContain(h.staff[ROLE(role)]!);
      expect(html).not.toMatch(/example\.test/);
    }
  });
});

describe("/figures shows each block only to the roles its own read lets in", () => {
  const ANY = ["signup-no", "permit-rises"];
  const WANT: Record<string, string[]> = {
    account_reviewer: ["targets"], fetched_job_reviewer: ["targets", "scheduled-checks", "accuracy-sample", "decisions"], rules_data_editor: ["targets", "scheduled-checks", "accuracy-sample", "decisions"],
    trust_and_safety: ["targets", "accuracy-sample"], services_case_handler: ["targets"], content_editor: ["targets"],
    administrator: ["targets", "overdue", "scheduled-checks", "accuracy-sample", "decisions"],
  };
  for (const role of ROLE_NAMES)
    it(role, async () => {
      expect(blocks(await render(ROLE(role), figures)).sort()).toEqual([...ANY, ...WANT[role]!].sort());
    });
  it("a login with no role gets only the two blocks every staff member reads, with the seeded sign-up counts", async () => {
    const html = await render("norole", figures);
    expect(blocks(html).sort()).toEqual([...ANY].sort());
    expect(html).toMatch(/10 in the last 2 days shown/);
  });
  it("no staff id, email or cookie reaches the page, and a hostile page cursor falls back to the first page", async () => {
    for (const p of [{}, { after: "x" }, { after: "a".repeat(500) }, { after: ["1", "2"] }, { after: "1 or 1=1" }, { after: "<script>alert(1)</script>" }, { after: "99999999999999999999" }, { after: "１２" }]) {
      const html = await render(ROLE("administrator"), figures, p as Params);
      expect(html, JSON.stringify(p)).toMatch(/Fetched-job decisions/);
      expect(html).not.toMatch(/<script>alert|example\.test|better-auth|session_token/);
      for (const id of Object.values(h.staff)) expect(html).not.toContain(id);
    }
  });
});

describe("settings: the two-person rule through the real route, read on the page after each step", () => {
  it("shows the settings; a proposal by admin1 shows Withdraw to admin1 and Confirm to admin2; admin1's own confirm is refused; admin2 confirm writes it", async () => {
    const first = await render("admin1", settings);
    expect(first).toMatch(/Propose this value/);
    const key = /<h2[^>]*>([^<]+)<\/h2><p class="text-\[22px\] font-semibold">([^<]+)<\/p>/.exec(first)!;
    const row = (await su.query("select key, value, unit from setting order by key limit 1")).rows[0];
    expect(key[1]!.toLowerCase().replaceAll(" ", "_")).toBe(row.key);
    const next = (row.value ?? 0) + 5;
    const proposed = await h.ok(call(SETTINGS, "admin1", { action: "propose", key: row.key, value: next }));
    expect(await render("admin1", settings)).toMatch(/proposed by you[\s\S]*Withdraw my change/);
    expect(await render("admin1", settings)).not.toMatch(/Confirm the change/);
    const other = await render("admin2", settings);
    expect(other).toMatch(/proposed by another administrator/);
    expect(other).toMatch(/Confirm the change/);
    await h.no(call(SETTINGS, "admin1", { action: "confirm", requestId: proposed.requestId }), 409, "same_person");
    await h.ok(call(SETTINGS, "admin2", { action: "confirm", requestId: proposed.requestId }));
    const done = await render("admin1", settings);
    expect(done).not.toMatch(/Waiting for a second administrator/);
    expect(done).toContain(`${next}`);
  });
  it("another role cannot reach the route either, and bad values are refused", async () => {
    for (const role of ROLE_NAMES.filter((r) => r !== "administrator")) await h.no(call(SETTINGS, ROLE(role), { action: "propose", key: "x", value: 1 }), 403, "not_administrator");
    for (const value of [-1, 100001, 1.5, "7"]) expect((await call(SETTINGS, "admin1", { action: "propose", key: "draft_job", value })).status, String(value)).toBe(400);
  });
});

describe("legal texts: propose, confirm and refuse through the real route, read on the page", () => {
  const propose = (who: string, version: string, body: string) => call(LEGAL, who, { action: "propose", purpose: "privacy_notice", version, body });
  it("a content editor proposes; the editor sees Withdraw, an administrator sees Confirm and publish; the editor's own confirm is refused; admin1 publishes it", async () => {
    const body = "PLACEHOLDER \"x\" & 3 < 4 more\nline two"; // B16: a tag is refused on propose (legal-texts.test.ts); escaping is still shown here
    const r = await h.ok(propose(ROLE("content_editor"), "p29b-1", body));
    const editor = await render(ROLE("content_editor"), legal);
    expect(editor).toMatch(/Withdraw my proposal/);
    expect(editor).not.toMatch(/Publish it|Confirm and publish/);
    expect(editor).toContain("PLACEHOLDER &quot;x&quot; &amp; 3 &lt; 4 more");
    const admin = await render("admin1", legal);
    expect(admin).toMatch(/Confirm and publish/);
    expect(admin).not.toMatch(/Propose this version/); // an administrator is not a content editor
    await h.no(call(LEGAL, ROLE("content_editor"), { action: "confirm", requestId: r.requestId }), 403, "not_administrator");
    await h.ok(call(LEGAL, "admin1", { action: "confirm", requestId: r.requestId }));
    const after = await render("admin2", legal);
    expect(after).toMatch(/In force: version p29b-1/);
    expect(after).not.toMatch(/Confirm and publish/);
  });
  it("a second proposal for the same text while one waits, and a used label, are refused with their codes", async () => {
    const two = await h.ok(propose(ROLE("content_editor"), "p29b-2", "TEXT TWO"));
    await h.no(propose("editor2", "p29b-3", "TEXT"), 409, "decision_pending");
    await h.ok(call(LEGAL, ROLE("content_editor"), { action: "refuse", requestId: two.requestId })); // the proposer withdraws
    await h.no(propose("editor2", "p29b-1", "TEXT"), 409, "version_taken");
  });
  it("a stale sign-in is told to sign in again for propose and confirm, but may still refuse (C4)", async () => {
    const r = await h.ok(propose(ROLE("content_editor"), "p29b-4", "TEXT FOUR"));
    await age("admin2");
    await h.no(call(LEGAL, "admin2", { action: "confirm", requestId: r.requestId }), 403, "reauth_required");
    await h.ok(call(LEGAL, "admin2", { action: "refuse", requestId: r.requestId }));
    await age(ROLE("content_editor"));
    await h.no(propose(ROLE("content_editor"), "p29b-5", "TEXT"), 403, "reauth_required");
  });
  it("hostile text is refused by the route: control and bidi characters, blank, too long, a bad label", async () => {
    for (const body of ["a‮b", "a​b", "   ", "x".repeat(100001)]) expect((await propose("editor2", "p29b-9", body)).json.error, JSON.stringify(body.slice(0, 4))).toBe("bad_body_text");
    for (const v of ["Bad Label", "", "-x", "a".repeat(65)]) expect((await propose("editor2", v, "TEXT")).json.error, v).toBe("bad_version");
  });
});

describe("solicitors", () => {
  it("an administrator adds a firm and sees the controls; a services case handler sees the firm and no control", async () => {
    await h.ok(call(SOL, "admin1", { action: "add", firm: "Fake Solicitors <b>LLP</b>", contact: "fake.firm@example.test" }));
    const admin = await render("admin1", solicitors);
    expect(admin).toContain("Fake Solicitors &lt;b&gt;LLP&lt;/b&gt;");
    expect(admin).toMatch(/Add a firm/);
    expect(admin).toMatch(/Deactivate/);
    const handler = await render(ROLE("services_case_handler"), solicitors);
    expect(handler).toContain("fake.firm@example.test");
    expect(handler).not.toMatch(/Add a firm|Deactivate|Save/);
    await h.no(call(SOL, ROLE("services_case_handler"), { action: "add", firm: "X", contact: "y" }), 403, "not_administrator");
  });
});

describe("data requests", () => {
  it("an open request shows its email and no control that is not proved; a visitor's request cannot be proposed for erase", async () => {
    await su.query("insert into contact_message(surface, from_name, from_email, topic, body) values ('candidate_site', 'Fake Sender', 'fake.sender@example.test', 'data_request', 'Please erase my data')");
    const html = await render("admin1", data);
    expect(html).toContain("fake.sender@example.test");
    expect(html).toMatch(/Candidate site/);
    expect(html).toMatch(/No link has been sent/);
    expect(html).not.toMatch(/Propose an erase/);
    expect(html).not.toContain("Please erase my data"); // the message body is not shown
    for (const id of Object.values(h.staff)) expect(html).not.toContain(id);
  });
});

describe("the sign-in page's return address and the sidebar links", () => {
  it("a signed-in staff member with an own path goes there; anything else goes to the overview; a visitor sees the form", async () => {
    expect(await render("admin1", signIn, { next: "/me" })).toBe("REDIRECT:/me");
    expect(await render("admin1", signIn, { next: "/legal-texts?x=1" })).toBe("REDIRECT:/legal-texts?x=1");
    for (const next of ["//evil.example", "/\\evil.example", "https://evil.example", "/%2Fevil.example", "/%2fevil.example", "/%5Cevil.example", "javascript:alert(1)", "/sign-in", "/api/staff/me", "/\t/evil.example", "/" + "a".repeat(1100), ["/me", "/settings"], "", "me"])
      expect(await render("admin1", signIn, { next } as Params), JSON.stringify(next)).toBe("REDIRECT:/");
    expect(await render(null, signIn, { next: "/me" })).toMatch(/Staff[\s\S]*sign in/);
  });
  it("every sidebar link of these pages has a page behind it", () => {
    for (const p of ["figures", "settings", "legal-texts", "data-requests", "solicitors", "me"]) expect(existsSync(join(__dirname, `../../../apps/admin/app/${p}/page.tsx`)), p).toBe(true);
  });
});

describe("budgets (statements and time of each page's reads, as admin)", () => {
  it("stays within the budget", async () => {
    const out: string[] = [];
    for (const [name, page, limit] of [["figures", figures, BUDGET.figuresAdmin], ["settings", settings, BUDGET.settings], ["legal", legal, BUDGET.legal], ["data", data, BUDGET.data], ["solicitors", solicitors, BUDGET.solicitors], ["me", me, BUDGET.me]] as const) {
      const [, n] = await counted(() => render("admin1", page));
      const ms = await median(() => render("admin1", page));
      out.push(`${name} ${n} statements, median ${ms.toFixed(1)} ms`);
      expect(n, name).toBeLessThanOrEqual(limit);
      expect(ms, name).toBeLessThan(BUDGET.ms);
    }
    console.log(`P29b pages: ${out.join("; ")}`);
  });
});
