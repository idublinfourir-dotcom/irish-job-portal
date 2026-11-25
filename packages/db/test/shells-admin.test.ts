// Step 16 wave 1 (P4): the staff sidebar read (apps/admin/lib/data.ts readSidebar) on the test database as app_admin with real staff sessions, and the rule that
// ties the sidebar to the backend: for each of the seven roles and each sidebar link, the link is shown exactly when the read behind the page lets that role in
// (the link is absent AND the page's read refuses). Only Next's request context is stood in (next/headers); no network. Fake people only.
// Budget (measured 23 November 2026, see the printed line): the sidebar read is 5 statements for a staff member (requireStaff 2, the name and roles, the roles
// again, the counts), 0 for a visitor; median under 25 ms.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ADMIN_NAV, ADMIN_ROLES, adminLinks, type AdminRole } from "../../ui/src/nav-links";
import { seedStaff } from "../src/staff-seed-cli";
import { makeAuth, answers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));

const BUDGET = { staffStatements: 5, visitorStatements: 0, medianMs: 25 };
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const BASE = "http://localhost:3002", PW = "Fake-reviewer-password-1";
let db: TestDb, su: pg.Pool;
let D: typeof import("../../../apps/admin/lib/data");
let AUTH: (r: Request) => Promise<Response>;
let F: { org(o?: object): Promise<string> };
const cookies: Record<string, string> = {}, ids: Record<string, string> = {};
let ipn = 10, candidateCookie: string;

async function signIn(email: string) {
  const res = await AUTH(new Request(`${BASE}/api/auth/staff/sign-in/email`, { method: "POST", body: JSON.stringify({ email, password: PW }), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${ipn++}` } }));
  expect(res.status, email).toBe(200);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function makeStaff(name: string, roles: string[]) {
  const c = await su.connect();
  try { ids[name] = await seedStaff(c, { email: `${name}@example.test`, name: `Fake ${name}`, roles: roles.length ? roles : ["content_editor"] }, PW); } finally { c.release(); }
  if (roles.length === 0) await su.query("delete from staff_role where staff_user_id = $1", [ids[name]]);
  cookies[name] = await signIn(`${name}@example.test`);
}
beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable", STAFF_AUTH_URL: BASE, STAFF_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: AUTH } = await import("../../../apps/admin/app/api/auth/staff/[...all]/route"));
  D = await import("../../../apps/admin/lib/data");
  for (const r of ADMIN_ROLES) await makeStaff(`only${r.replaceAll("_", "")}`, [r]);
  await makeStaff("norole", []);
  await makeStaff("two", ["account_reviewer", "content_editor"]);
  await makeStaff("disabled", ["administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [ids.disabled]); // after sign-in: the open session must give the bare page
  const cand = makeAuth("candidate", db.pool("app_candidate"));
  const h = { "content-type": "application/json", origin: "http://localhost:3000", "x-vercel-forwarded-for": "198.51.100.250" };
  const body = { email: "fake.candidate.shell@example.test", password: "Fake-password-12345", name: "Fake" };
  expect((await cand.handler(new Request("http://localhost:3000/api/auth/candidate/sign-up/email", { method: "POST", headers: h, body: JSON.stringify({ ...body, ...answers }) }))).status).toBe(200);
  await su.query("update candidate_user set email_verified = true where email = $1", [body.email]);
  const r = await cand.handler(new Request("http://localhost:3000/api/auth/candidate/sign-in/email", { method: "POST", headers: h, body: JSON.stringify({ email: body.email, password: body.password }) }));
  candidateCookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const as = <T>(cookie: string | undefined, fn: () => Promise<T>): Promise<T> => {
  state.headers = new Headers({ ...(cookie ? { cookie } : {}), "x-vercel-forwarded-for": "203.0.113.9" });
  return fn();
};
const key = (r: string) => `only${r.replaceAll("_", "")}`;

describe("P4: the staff sidebar read", () => {
  it("gives a staff member its name, its sorted roles and its queue counts", async () => {
    for (let i = 0; i < 2; i++) await su.query("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'fake')", [await F.org()]);
    const s = await as(cookies.two, () => D.readSidebar());
    expect(s).toMatchObject({ name: "Fake two", roles: ["account_reviewer", "content_editor"] });
    expect(s!.counts["Account reviews"]).toBe(2);
    expect(s!.counts["Fetched jobs"]).toBe(0);
    expect(s!.counts["Reports and strikes"]).toBeUndefined(); // a count its roles do not cover is not shown
  });
  it("gives a visitor, a disabled login, a candidate's cookie and a made-up cookie nothing (the bare page)", async () => {
    for (const [who, c] of [["visitor", undefined], ["disabled", cookies.disabled], ["candidate", candidateCookie], ["made up", "staff.session_token=abc"], ["huge", "staff.session_token=" + "x".repeat(5000)]] as const)
      expect(await as(c, () => D.readSidebar()), who).toBeNull();
  });
  it("a login with no role has only the links every staff member may open", async () => {
    const s = (await as(cookies.norole, () => D.readSidebar()))!;
    expect(s.roles).toEqual([]);
    expect(adminLinks(s.roles as AdminRole[]).flatMap((g) => g.links.map((l) => l.label))).toEqual(["Overview", "Rules data", "Audit log", "Figures", "My data"]);
  });
  it("stays within the statement and time budget", async () => {
    await as(cookies.two, () => D.readSidebar());
    const q = (await import("pg")).default.Client.prototype.query;
    const Client = (await import("pg")).default.Client;
    let c = 0;
    Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
    let staff = 0, visitor = 0;
    try {
      await as(cookies.two, () => D.readSidebar()); staff = c; c = 0;
      await as(undefined, () => D.readSidebar()); visitor = c;
    } finally { Client.prototype.query = q; }
    const t: number[] = [];
    for (let i = 0; i < 21; i++) { const s = performance.now(); await as(cookies.two, () => D.readSidebar()); t.push(performance.now() - s); }
    const median = t.sort((x, y) => x - y)[10]!;
    console.log(`P4 sidebar read: staff ${staff} statements, visitor ${visitor}, median ${median.toFixed(1)} ms`);
    expect(staff).toBeLessThanOrEqual(BUDGET.staffStatements);
    expect(visitor).toBeLessThanOrEqual(BUDGET.visitorStatements);
    expect(median).toBeLessThan(BUDGET.medianMs);
  });
});

// The read each sidebar link's page makes first (admin.yaml: the page's GET). A link with no `roles` is open to any staff member.
const PAGE_READ: Record<string, () => Promise<unknown>> = {
  Overview: () => D.readCounts(),
  "Account reviews": () => D.readAccountReviews(),
  "Fetched jobs": () => D.readFetchedJobs(),
  "Reports and strikes": () => D.readReports(),
  "Services cases": () => D.readServiceCases(),
  "Contact messages": () => D.readContactMessages(),
  "Held jobs": () => D.readEmployerJob("1"),
  "Pay floor checks": () => D.readFloorChecks(),
  "Company seed": () => D.readCompanySeed(),
  Accounts: () => D.readCandidateMerges(),
  "Rules data": () => D.readRules(),
  "Big-company list": () => D.readCompanySeed(),
  "DETE name links": () => D.readDeteLinks(1),
  "Name merges": () => D.readCompanyPreview(["1"]),
  "Ban list": () => D.readStrikeCases(),
  "Manual posting": () => D.readManualPosts(),
  "Content editor": () => D.readContentPages(),
  "Audit log": () => D.readAudit(),
  "Staff and roles": () => D.readStaff(),
  Figures: () => D.readSignupNoCounts(), // the block every staff member reads; the page's other blocks each check their own roles
  Settings: () => D.readSettings(),
  "Legal texts": () => D.readLegal(),
  "Data requests": () => D.readDataRequests(),
  Solicitors: () => D.readSolicitors(),
  "My data": () => D.readMe(),
};
describe("P4: a sidebar link is shown exactly when the page's read lets the role in", () => {
  const links = ADMIN_NAV.flatMap((g) => g.links);
  it("every link has a page read here", () => expect(links.map((l) => l.label).sort()).toEqual(Object.keys(PAGE_READ).sort()));
  for (const link of links) {
    it(`${link.label}: shown to a role if and only if its read accepts that role`, async () => {
      const outcome: Record<string, string> = {};
      for (const role of ADMIN_ROLES) {
        const shown = adminLinks([role]).some((g) => g.links.some((l) => l.label === link.label));
        let result = "accepted";
        try { await as(cookies[key(role)], () => PAGE_READ[link.label]!()); } catch (e) { result = `refused: ${(e as { why?: string }).why ?? (e as Error).message}`; }
        outcome[role] = `${shown ? "shown" : "hidden"}, ${result === "accepted" ? "accepted" : "refused"}`;
        expect(result.startsWith("refused"), `${link.label} as ${role} (${shown ? "shown" : "hidden"}): ${result}`).toBe(!shown);
      }
    });
  }
  it("a visitor and a disabled login are refused by every read before any role check", async () => {
    for (const c of [undefined, cookies.disabled, candidateCookie]) for (const [label, read] of Object.entries(PAGE_READ)) await expect(as(c, read), label).rejects.toThrow();
  });
});
