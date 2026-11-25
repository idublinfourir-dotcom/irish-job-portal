// Step 16 pages P22 (rules data: /rules, /rules/pay-deal-employers, /rules/big-companies) and P25 (/manual-posting): the pages' own server code on the real test database as app_admin, with
// real staff sessions. Each page function is called as Next calls it (its search params in, its element out) and rendered to HTML, so what a role would be sent is what is asserted. All seven
// roles, a login with no role, a disabled login, a forged session and a signed-out visitor are tried on every page, and the writes go through the real routes (/api/rules, /api/manual-jobs,
// /api/manual-jobs/sponsor-confirmation). Only Next's request context is stood in (next/headers, next/navigation, server-only); the file store is memoryStore(). Fake people only, no network.
// Budget: see BUDGET (measured 25 November 2026): the statement limits are the measured counts plus 2 and the clock limit about 5 times the slowest median, with a floor for a busy laptop.
import type pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { memoryStore, setFileStore } from "../src/file-store";
import { PDF } from "../src/file-fixture";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { BASE, counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`REDIRECT:${to}`), { to }); },
  useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/",
}));
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
// measured: 9, 9 (ineligible tab, 21 ms), 13, 15, 9, 19 (account reviewer) and 13 statements, medians 8 to 21 ms
const BUDGET = { rules: 11, history: 15, payDeal: 17, big: 11, manual: 21, ms: 150 };

type Params = Record<string, string | string[] | undefined>;
type PageFn = (a: { searchParams: Promise<Params> }) => Promise<React.ReactElement | null>;
type R = Route & { POST: (r: Request) => Promise<Response> };
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool, today: string;
let rulesPage: PageFn, payPage: PageFn, bigPage: PageFn, manualPage: PageFn;
let RULES: R, MANUAL: R, SPONSOR: R;
let F: { org(o?: object): Promise<number>; portal(): Promise<string>; member(org: number, user: string, o?: object): Promise<number>; text(p: string): Promise<string> };
const ID = {} as { big: string; plain: string; care: string };
const pageModule = (name: string): Promise<unknown> => import(/* @vite-ignore */ `../../../apps/admin/app/${name}`);
const ROLE = (r: string) => `only_${r}`;
const SIGN_IN = "REDIRECT:/sign-in";
const NO_ACCESS = /This page is not for your roles/;
const ED = ROLE("rules_data_editor"), AD = ROLE("administrator"), AR = ROLE("account_reviewer"), TS = ROLE("trust_and_safety");
const one = async (sql: string, a: unknown[] = []) => (await su.query(sql, a)).rows[0];
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function render(who: string | null, page: () => Promise<React.ReactElement | null>, cookie?: string): Promise<string> {
  state.headers = new Headers(cookie ? { cookie } : who ? { cookie: h.cookies[who]! } : {});
  try {
    const el = await page();
    return el ? renderToStaticMarkup(el) : "";
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("REDIRECT:")) return e.message;
    throw e;
  }
}
const on = (f: () => PageFn) => (who: string | null, p: Params = {}) => render(who, () => f()({ searchParams: Promise.resolve(p) }));
const rules = on(() => rulesPage), pay = on(() => payPage), big = on(() => bigPage), manual = on(() => manualPage);
const call = (route: R, who: string | null, body: unknown) => h.call(route as never, "/", who, body);
const ALL = [...ROLE_NAMES.map(ROLE), "both"];
const MANUAL_VIEWERS = ["account_reviewer", "trust_and_safety", "administrator"];

beforeAll(async () => {
  db = await createTestDb();
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  h = await staffHarness(db);
  su = h.su;
  setFileStore(memoryStore());
  for (const r of ROLE_NAMES) await h.makeStaff(ROLE(r), [r]);
  await h.makeStaff("both", ["rules_data_editor", "administrator"]);
  await h.makeStaff("admin2", ["administrator"]);
  await h.makeStaff("ar2", ["account_reviewer"]);
  await h.makeStaff("ar_ad", ["account_reviewer", "administrator"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("gone", ["rules_data_editor", "account_reviewer", "administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.gone]); // after sign-in: its open session must be refused too
  today = (await one("select current_date::text d")).d;
  ID.big = String(await F.org({ name: "Pfizer Ireland Pharmaceuticals" }));
  ID.plain = String(await F.org({ name: "Fake Plain Bakery" }));
  ID.care = String(await F.org({ name: "Fake Care Homes Ltd" }));
  await F.text("sponsorship_statement");
  ({ default: rulesPage } = (await pageModule("rules/page")) as { default: PageFn });
  ({ default: payPage } = (await pageModule("rules/pay-deal-employers/page")) as { default: PageFn });
  ({ default: bigPage } = (await pageModule("rules/big-companies/page")) as { default: PageFn });
  ({ default: manualPage } = (await pageModule("manual-posting/page")) as { default: PageFn });
  RULES = await import("../../../apps/admin/app/api/rules/route");
  MANUAL = await import("../../../apps/admin/app/api/manual-jobs/route");
  SPONSOR = await import("../../../apps/admin/app/api/manual-jobs/sponsor-confirmation/route");
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("P22 rules data pages: who sees what", () => {
  it("every role, and a login with none, opens all three pages; a visitor, a disabled login and a forged session are sent to sign in", async () => {
    for (const who of [...ALL, "norole"]) {
      expect(await rules(who), who).toMatch(/Rules data/);
      expect(await pay(who), who).toMatch(/pay-deal employers/i);
      expect(await big(who), who).toMatch(/Big-company list/);
    }
    for (const page of [rules, pay, big]) {
      expect(await page(null)).toBe(SIGN_IN);
      expect(await page("gone")).toBe(SIGN_IN);
      expect(await render(null, () => rulesPage({ searchParams: Promise.resolve({}) }), "better-auth.session_token=forged")).toBe(SIGN_IN);
    }
  });
  it("the forms and the Edit buttons are the rules data editor's only: an administrator, who confirms, does not stand in for it", async () => {
    for (const who of [...ALL, "norole"]) {
      const edits = who === ED || who === "both";
      expect((await rules(who)).includes("Add a future value"), `${who} minimums`).toBe(edits);
      expect((await rules(who, { tab: "critical" })).includes(">Remove<"), `${who} list`).toBe(edits);
      expect((await pay(who)).includes("Add employer"), `${who} pay deal`).toBe(edits);
      expect((await big(who)).includes("Flag one company as big"), `${who} big`).toBe(edits);
    }
  });
  it("the pages show what is in force, read from the database: minimums with the hourly figure, the seeded brands, the seeded pay-deal list; no sample data and no staff email", async () => {
    const mins = (await one("select data from rules_version where kind = 'minimums' and effective_from <= current_date order by effective_from desc, id desc limit 1")).data;
    const p = await rules(ED);
    expect(p).toContain(`€${mins.criticalSkills.toLocaleString("en-IE")}`); expect(p).toMatch(/\/h/); expect(p).toMatch(/Not entered/);
    expect(await rules(ED, { tab: "critical" })).toMatch(/Critical Skills list/);
    expect(await rules(ED, { tab: "ineligible" })).toMatch(/Ineligible list/);
    expect(await rules(ED, { tab: "quotas" })).toMatch(/Quota/);
    expect(await big(ED)).toMatch(/pfizer/i);
    expect(await pay(ED)).toMatch(/health service executive/i);
    for (const page of [await rules(AD), await pay(AD), await big(AD)]) expect(page).not.toMatch(/@example\.test|Sample|undefined|\[object|[\u2013\u2014]/);
  });
  it("a hostile tab, kind, cursor or employer falls back to the first view and reaches no read", async () => {
    for (const p of [{ tab: "<script>x</script>" }, { tab: ["minimums", "history"] }, { tab: "history", kind: "'; drop table rules_version;--" }, { tab: "history", kind: ["a", "b"] }, { tab: "history", after: "garbage" }, { tab: "history", after: "x".repeat(5000) }]) {
      const html = await rules(AD, p as Params);
      expect(html, JSON.stringify(p).slice(0, 40)).toMatch(/Rules data/); expect(html).not.toMatch(/<script>x/);
    }
    for (const employer of ["<script>x</script>", "nobody", "x".repeat(3000)]) expect(await pay(AD, { employer })).toMatch(/pay-deal employers/i);
    expect(await pay(AD, { employer: ["a", "b"] })).toMatch(/pay-deal employers/i);
  });
});

describe("P22 two people: propose, wait, confirm", () => {
  it("a proposed minimum shows as waiting with its change; its proposer sees Withdraw, another administrator Confirm; once confirmed it is a labelled next value, not the current one", async () => {
    const cur = (await one("select data from rules_version where kind = 'minimums' and effective_from <= current_date order by effective_from desc, id desc limit 1")).data;
    const start = addDays(today, 10), next = { ...cur, criticalSkills: cur.criticalSkills + 1000 };
    const p = await h.ok(call(RULES, ED, { action: "propose", kind: "minimums", effectiveFrom: start, data: next }));
    const asEditor = await rules(ED);
    expect(asEditor).toMatch(/Waiting for a different administrator/); expect(asEditor).toMatch(/Proposed by you/); expect(asEditor).toMatch(/Changed Critical Skills minimum/); expect(asEditor).toMatch(/>Withdraw</); expect(asEditor).not.toMatch(/>Confirm</);
    const asBoth = await rules("both"); // an editor who is also an administrator proposed nothing here
    expect(asBoth).toMatch(/Proposed by Fake only_rules_data_editor/); expect(asBoth).toMatch(/>Confirm</); expect(asBoth).toMatch(/>Refuse</); expect(asBoth).not.toMatch(/>Withdraw</);
    expect(await rules(ROLE("account_reviewer"))).not.toMatch(/<button[^>]*>Confirm/); // a role that cannot decide is offered nothing
    expect(await rules(ED, { tab: "quotas" })).toMatch(/Waiting for a different administrator/); // the quotas tab shows the minimums proposal too
    expect(await rules(ED, { tab: "critical" })).not.toMatch(/Waiting for a different administrator/); // another kind's page does not
    await h.no(h.call(RULES as never, "/", "both", { action: "propose", kind: "minimums", effectiveFrom: start, data: next }), 409, "decision_pending");
    await h.no(h.call(RULES as never, "/", ED, { action: "confirm", requestId: p.requestId }), 403, "not_administrator");
    await h.ok(h.call(RULES as never, "/", AD, { action: "confirm", requestId: p.requestId }));
    const after = await rules(ED);
    expect(after).not.toMatch(/Waiting for a different administrator/); expect(after).toMatch(/has not started yet/); expect(after).toContain(`€${next.criticalSkills.toLocaleString("en-IE")}`);
    const row = after.slice(after.indexOf("<tbody"), after.indexOf("</tbody>"));
    const firstCells = row.split("</tr>")[0]!.split("</td>").map((c) => c.replace(/<[^>]+>/g, ""));
    expect(firstCells[2]).toContain(cur.criticalSkills.toLocaleString("en-IE")); expect(firstCells[5]).toContain(next.criticalSkills.toLocaleString("en-IE")); // now vs next
    const hist = await rules(AD, { tab: "history", kind: "minimums" });
    expect(hist).toMatch(/In force/); expect(hist).toMatch(/The first version/);
  });
  it("the same person never confirms their own proposal (the route refuses; the page does not offer it)", async () => {
    const names = (await one("select data from rules_version where kind = 'big_company_names' and effective_from <= current_date order by effective_from desc, id desc limit 1")).data as object[];
    const p = await h.ok(call(RULES, "both", { action: "propose", kind: "big_company_names", effectiveFrom: addDays(today, 5), data: [...names, { name: "fake newco", test: "brand", link: "https://example.test/pay", readOn: today, reviewOn: addDays(today, 300) }] }));
    const mine = await big("both");
    expect(mine).toMatch(/Added fake newco/); expect(mine).toMatch(/Proposed by you/); expect(mine).not.toMatch(/>Confirm</); expect(mine).toMatch(/>Withdraw</);
    await h.no(h.call(RULES as never, "/", "both", { action: "confirm", requestId: p.requestId }), 409, "same_person");
    expect(await big("admin2")).toMatch(/>Confirm</);
    await h.ok(h.call(RULES as never, "/", "both", { action: "withdraw", requestId: p.requestId }));
    expect(await big("admin2")).not.toMatch(/fake newco/);
  });
  it("the big-company flag: proposed for a company whose name matches, waiting on the big-company page, confirmed by another administrator", async () => {
    await h.no(h.call(RULES as never, "/", ED, { action: "propose_flag", organisationId: ID.plain }), 409, "no_name_match");
    const p = await h.ok(call(RULES, ED, { action: "propose_flag", organisationId: ID.big }));
    const view = await big(AD);
    expect(view).toMatch(/Flag Pfizer Ireland Pharmaceuticals as a big company/); expect(view).toMatch(/>Confirm</);
    await h.ok(h.call(RULES as never, "/", AD, { action: "confirm", requestId: p.requestId }));
    expect(await big(AD)).not.toMatch(/Flag Pfizer/);
  });
  it("a pay-deal entry proposed as the page sends it (the list as read, one entry changed) is confirmed and then shown with its evidence and counts", async () => {
    const data = (await one("select data from rules_version where kind = 'public_pay_employers' and effective_from <= current_date order by effective_from desc, id desc limit 1")).data;
    const entry = { tier: 2, bodyType: "section_38", evidence: { kind: "published_pay_policy", link: "https://example.test/pay-policy", file: null }, note: "Fake note" };
    const p = await h.ok(call(RULES, ED, { action: "propose", kind: "public_pay_employers", effectiveFrom: today, data: { ...data, "fake hospital group": entry } }));
    expect(await pay(AD)).toMatch(/Waiting for a different administrator/);
    await h.ok(h.call(RULES as never, "/", AD, { action: "confirm", requestId: p.requestId }));
    const view = await pay(ED, { employer: "fake hospital group" });
    expect(view).toMatch(/fake hospital group/i); expect(view).toMatch(/Section 38/); expect(view).toMatch(/Published pay policy/); expect(view).toMatch(/Fake note/); expect(view).toMatch(/Fake only_rules_data_editor/); expect(view).toMatch(/Live jobs/);
    expect(view.split("<tr").find((r) => r.includes("fake hospital group"))).not.toMatch(/Evidence missing/); // its own row has evidence
    // an entry that is on with no evidence is refused with its detail, not saved
    const r = await call(RULES, ED, { action: "propose", kind: "public_pay_employers", effectiveFrom: today, data: { ...data, "fake hospital group": entry, "fake voluntary body": { tier: 2, bodyType: "section_39" } } });
    expect([r.status, r.json.error]).toEqual([400, "bad_data"]); expect(r.json.detail).toMatch(/fake voluntary body/);
  });
  it("a wrong role is refused by the route behind each button, with a word the page shows", async () => {
    for (const who of ROLE_NAMES.filter((r) => r !== "rules_data_editor").map(ROLE)) await h.no(h.call(RULES as never, "/", who, { action: "propose_flag", organisationId: ID.big }), 403, "not_rules_editor");
    await h.no(h.call(RULES as never, "/", null, { action: "confirm", requestId: "1" }), 401, "no_session");
    const cur = (await one("select data from rules_version where kind = 'minimums' and effective_from <= current_date order by effective_from desc, id desc limit 1")).data;
    await h.no(h.call(RULES as never, "/", AD, { action: "propose", kind: "minimums", effectiveFrom: addDays(today, 3), data: { ...cur, criticalSkills: cur.criticalSkills + 5 } }), 403, "not_rules_editor"); // an administrator does not stand in for the editor
  });
});

describe("P25 manual posting", () => {
  const desc = "We are hiring a software engineer to build our payments platform in Dublin. Full sponsorship offered.";
  const post = (org: string, o: object = {}) => ({ organisationId: org, title: "Fake Software Engineer", description: desc, county: "Dublin", occupationCode: "2136", contractMonths: null, salaryLow: 60000, salaryHigh: null, weeklyHours: 39,
    closesOn: addDays(today, 20), applyUrl: "https://careers.example.ie/jobs/1", ...o });
  const upload = async (who: string, job: string) => {
    const f = new FormData(); f.append("file", new Blob([PDF as Uint8Array<ArrayBuffer>]), "letter.pdf");
    const res = await SPONSOR.POST(new Request(`${BASE}/api/manual-jobs/sponsor-confirmation?jobId=${job}`, { method: "POST", headers: { cookie: h.signedIn(who), origin: BASE }, body: f }));
    return { status: res.status, json: await res.json() };
  };
  it("the three viewing roles open it; every other role, no role, a visitor, a disabled login and a forged session do not", async () => {
    for (const r of ROLE_NAMES) {
      const p = await manual(ROLE(r));
      if (MANUAL_VIEWERS.includes(r)) expect(p, r).toMatch(/Manual posting/); else { expect(p, r).toMatch(NO_ACCESS); expect(p, r).not.toMatch(/Fake Software|Sponsor confirmed/); }
    }
    expect(await manual("norole")).toMatch(NO_ACCESS);
    expect(await manual(null)).toBe(SIGN_IN); expect(await manual("gone")).toBe(SIGN_IN);
    expect(await render(null, () => manualPage({ searchParams: Promise.resolve({}) }), "better-auth.session_token=forged")).toBe(SIGN_IN);
  });
  it("only an account reviewer gets the form; the occupations and the weekly hours come from the rules read; staff create no company", async () => {
    const p = await manual(AR);
    expect(p).toMatch(/>Publish</); expect(p).toMatch(/Run the checks/); expect(p).toMatch(/2136 · /); expect(p).toMatch(/Critical Skills Employment Permit/); expect(p).toMatch(/max="\d{4}-\d\d-\d\d"/);
    expect(p).not.toMatch(/Create a company|Named person|Save draft|Sample/);
    for (const who of [TS, AD]) { const x = await manual(who); expect(x).not.toMatch(/>Publish</); expect(x).toMatch(/Only an account reviewer posts a job/); }
  });
  it("a post made through the route is in its poster's own list, with Close; another reviewer's list does not hold it; trust and safety and an administrator see all", async () => {
    const mine = await h.ok(call(MANUAL, AR, { action: "create", ...post(ID.care) }));
    expect(mine.status).toBe("live");
    const other = await h.ok(call(MANUAL, "ar2", { action: "create", ...post(ID.care, { title: "Fake Other Post" }) }));
    const asMine = await manual(AR);
    expect(asMine).toMatch(/Your posts/); expect(asMine).toMatch(/Fake Software Engineer/); expect(asMine).not.toMatch(/Fake Other Post/); expect(asMine).toMatch(/Close this post/);
    for (const who of [TS, AD]) { const x = await manual(who); expect(x).toMatch(/Fake Software Engineer/); expect(x).toMatch(/Fake Other Post/); expect(x).not.toMatch(/Close this post/); }
    const draft = await h.ok(call(MANUAL, AR, { action: "create", ...post(ID.care, { title: "Fake Cheap Post", salaryLow: 20000 }) }));
    expect(draft.status).toBe("draft");
    const d = await manual(AR); expect(d).toMatch(/Draft, not listed/); expect(d).toMatch(/Not listed: The pay is below the minimum/); expect(d).not.toMatch(/pay_below_minimum/);
    await h.no(h.call(MANUAL as never, "/", "ar2", { action: "close", jobId: mine.jobId }), 403, "not_poster");
    await h.ok(h.call(MANUAL as never, "/", AR, { action: "close", jobId: mine.jobId }));
    expect(await manual(AR)).toMatch(/Closed/);
    void other;
  });
  it("Sponsor confirmed is two people: the uploader sees Withdraw and never Confirm, another administrator Confirm and Refuse, and the route refuses the same person", async () => {
    const live = await h.ok(call(MANUAL, "ar_ad", { action: "create", ...post(ID.care, { title: "Fake Sponsor Post" }) }));
    expect(await manual("ar_ad")).toMatch(/Employer.{0,6}s written confirmation/);
    const up = await upload("ar_ad", live.jobId);
    expect(up.status).toBe(200);
    const own = await manual("ar_ad");
    expect(own).toMatch(/waits for a different administrator/); expect(own).toMatch(/You cannot confirm your own upload/); expect(own).toMatch(/>Withdraw</); expect(own).not.toMatch(/>Confirm</);
    await h.no(h.call(SPONSOR as never, "/", "ar_ad", { action: "confirm", requestId: up.json.requestId }), 409, "same_person");
    const other = await manual("admin2");
    expect(other).toMatch(/Uploaded by Fake ar_ad/); expect(other).toMatch(/requestId=/); expect(other).toMatch(/>Confirm</); expect(other).toMatch(/>Refuse</); expect(other).not.toMatch(/>Withdraw</);
    expect(await manual(TS)).not.toMatch(/<button[^>]*>Confirm/); expect(await manual(AR)).not.toMatch(/<button[^>]*>Confirm/);
    await h.ok(h.call(SPONSOR as never, "/", "admin2", { action: "confirm", requestId: up.json.requestId }));
    const done = await manual("ar_ad"); expect(done).toMatch(/Sponsor confirmed/); expect(done).not.toMatch(/waits for a different administrator/);
  });
  it("the refusal codes a page can meet are in words; hostile page links and queries do not break the page", async () => {
    for (const after of ["garbage", "x".repeat(5000), ["1", "2"]]) expect(await manual(AR, { after: after as string }), String(after).slice(0, 10)).toMatch(/Manual posting/);
    await h.no(h.call(MANUAL as never, "/", AR, { action: "create", ...post(ID.care, { county: "Atlantis" }) }), 400, "bad_county");
    await h.no(h.call(MANUAL as never, "/", AR, { action: "create", ...post(ID.care), badge: "sponsor_confirmed" }), 400, "bad_body");
    for (const who of ROLE_NAMES.filter((r) => r !== "account_reviewer").map(ROLE)) await h.no(h.call(MANUAL as never, "/", who, { action: "create", ...post(ID.care) }), 403, "not_account_reviewer");
  });
});

describe("performance: statements and time of one page render", () => {
  const budget = async (who: string, page: () => Promise<string>, max: number, name: string) => {
    await page(); // warm
    const [, n] = await counted(page);
    const m = await median(page);
    console.log(`${name}: ${n} statements, median ${m.toFixed(1)} ms`);
    expect(n, `${name} statements`).toBeLessThanOrEqual(max);
    expect(m, `${name} median ms`).toBeLessThan(BUDGET.ms);
    state.headers = new Headers({ cookie: h.cookies[who]! });
  };
  it("each page for the role that works it", async () => {
    await budget(ED, () => rules(ED), BUDGET.rules, "rules minimums");
    await budget(ED, () => rules(ED, { tab: "ineligible" }), BUDGET.rules, "rules ineligible list");
    await budget(AD, () => rules(AD, { tab: "history", kind: "minimums" }), BUDGET.history, "rules history");
    await budget(ED, () => pay(ED), BUDGET.payDeal, "pay-deal employers");
    await budget(ED, () => big(ED), BUDGET.big, "big companies");
    await budget(AR, () => manual(AR), BUDGET.manual, "manual posting, account reviewer");
    await budget(AD, () => manual(AD), BUDGET.manual, "manual posting, administrator");
  });
});
