// Integration: the pay scales on the employer side (#269, #67; step 15 S7) on the real test database through the real portal routes (connected as
// app_portal, real sessions): the grade picker read, the public pay check on a post and a dry-run check, and the job page's scale line. The version
// is written here as the owner's fixture before any route reads the rules (pay-scales.test.ts proves the two-person route). No network: the sign-up
// mail goes to the existing fake. Fake people only.
import { pressed } from "./confirm-link";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayScale } from "@portal/rules";
import { createManualPost } from "../src/manual-posting";
import { QueueRefused } from "../src/admin-queue";
import { getJob } from "../src/search";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { counted, median } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
// Statements on every pg.Client.query call, measured 19 November 2026: the grade read is requirePortal's 3 (the rules are cached per process, so
// a warm read adds none), median under 3 ms; the job page stays at its 2 (the job, the DETE count: the scale comes from the same cached rules).
const BUDGET = { grades: 3, gradesMs: 15, jobPage: 2 };
const V1 = JSON.parse(readFileSync(new URL("../../rules/data/pay-scales-v1.json", import.meta.url), "utf8")) as PayScale[];
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let authPOST: Handler, authGET: Handler, gradesGET: Handler, postPOST: Handler, checkPOST: Handler;
let mail: () => { kind: string; to: string; link: string }[];
let F: { org(o?: object): Promise<number>; member(org: string, user: string | null, o?: object): Promise<number> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  const c = await su.connect();
  try {
    await c.query("begin");
    await c.query("set local role portal_owner");
    await c.query("insert into rules_version(kind, data, effective_from, seeded_by_owner) values ('pay_scales', $1::jsonb, '2026-06-01', true)", [JSON.stringify(V1)]);
    await c.query("commit");
  } finally { c.release(); }
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  ({ POST: authPOST, GET: authGET } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ GET: gradesGET } = await import("../../../apps/portal/app/api/portal/jobs/grades/route"));
  ({ POST: postPOST } = await import("../../../apps/portal/app/api/portal/jobs/route"));
  ({ POST: checkPOST } = await import("../../../apps/portal/app/api/portal/jobs/check/route"));
  ({ portalMail: mail } = await import("../../../apps/portal/lib/portal"));
  mail = pressed(mail, "portal");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit where key like 'jobs%'"); });

let ipn = 0, n = 0;
const freshIp = () => `10.8.${Math.floor(ipn / 250)}.${ipn++ % 250}`;
const json = async (res: Response) => ({ status: res.status, json: await res.json().catch(() => null), cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
const auth = (path: string, body: unknown) => authPOST(new Request(`${BASE}/api/auth/portal/${path}`, {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": freshIp() } })).then(json);
async function login(): Promise<{ cookie: string; id: string }> {
  const p = { email: `fake.ps${++n}@elsewhere.example.test`, password: `Fake-ps${n}-password-1`, name: `Fake PS${n}`, ...portalAnswers };
  expect((await auth("sign-up/email", p)).status).toBe(200);
  await authGET(new Request(mail().filter((m) => m.to === p.email && m.kind === "verify").at(-1)!.link, { headers: { "x-vercel-forwarded-for": freshIp() }, redirect: "manual" }));
  const r = await auth("sign-in/email", { email: p.email, password: p.password });
  expect(r.status).toBe(200);
  return { cookie: r.cookie, id: (await su.query("select id from portal_user where email = $1", [p.email])).rows[0].id };
}
async function owner(name: string): Promise<string> {
  const org = String(await F.org({ name }));
  const l = await login();
  await F.member(org, l.id, { role: "account_owner", signer: true });
  return l.cookie;
}
const grades = (cookie?: string, q = "") => gradesGET(new Request(`${BASE}/api/portal/jobs/grades${q}`, { headers: cookie ? { cookie } : {} })).then(json);
const send = (h: Handler, path: string, cookie: string, body: unknown) =>
  h(new Request(`${BASE}/api/portal/jobs${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, cookie } })).then(json);
// A staff nurse post on a Critical Skills list role (2231): pay below the EUR 40,904 minimum, so only the public pay route (#67) can pass it.
const nurse = (o: Record<string, unknown> = {}) => ({ status: "live", title: "Staff Nurse", description: "We are hiring a staff nurse for our hospital in Dublin. Full sponsorship offered.",
  county: "Dublin", occupationCode: "2231", contractType: "permanent", salaryLow: 39000, salaryHigh: null, payGrade: "2135", ownPageUrl: "https://careers.example.ie/jobs/1", ...o });

let hse: string, privateCo: string;
beforeAll(async () => {
  hse = await owner("HSE Dublin and Midlands");
  privateCo = await owner("Fake Private Clinic Limited");
});

describe("GET /api/portal/jobs/grades", () => {
  it("lists the 40 grades in force with their scale, to any signed-in portal login", async () => {
    const r = await grades(privateCo);
    expect(r.status).toBe(200);
    expect(r.json.grades).toHaveLength(40);
    expect(r.json.grades[2]).toEqual({ code: "2135", title: "Staff Nurse", firstEur: 38166, lastEur: 56592, note: expect.stringMatching(/^Placeholder/) });
    expect(r.json.grades.find((g: { code: string }) => g.code === "1012")).toEqual({ code: "1012", title: "Senior House Officer", firstEur: 55292, lastEur: 75623, note: null });
    expect(Object.keys(r.json.grades[0]).sort()).toEqual(["code", "firstEur", "lastEur", "note", "title"]); // no source fields, nothing else
  });
  it("refuses no session, a forged or a staff-style cookie, and any query key", async () => {
    expect(await grades()).toMatchObject({ status: 401, json: { code: "NO_SESSION" } });
    for (const cookie of ["better-auth.session_token=forged", "staff.session_token=x", "__Secure-better-auth.session_token=' or 1=1 --"]) expect((await grades(cookie)).status, cookie).toBe(401);
    for (const q of ["?x=1", "?code=2135", "?code=%27%3Bdrop%20table%20job"]) expect(await grades(hse, q), q).toMatchObject({ status: 400, json: { code: "BAD_REQUEST" } });
  });
});

describe("the public pay check with a listed grade (#67)", () => {
  it("a public pay employer passes when the stated pay sits anywhere on the grade's scale, and is refused off it", async () => {
    for (const body of [nurse(), nurse({ salaryLow: 38166 }), nurse({ salaryLow: 38166, salaryHigh: 40000 }), nurse({ salaryLow: null })])
      expect(await send(checkPOST, "/check", hse, body), JSON.stringify(body)).toMatchObject({ status: 200, json: { ok: true, passRoute: "public_pay" } });
    for (const body of [nurse({ salaryLow: 38165 }), nurse({ salaryLow: 30000, salaryHigh: 39000 }), nurse({ payGrade: "1012" }), nurse({ payGrade: "1012", salaryLow: 40000, salaryHigh: 40900 })])
      expect(await send(checkPOST, "/check", hse, body), JSON.stringify(body)).toMatchObject({ status: 422, json: { code: "PAY_NOT_ON_SCALE" } });
    // pay over the minimum passes as stated pay whatever the grade, as before
    expect(await send(checkPOST, "/check", hse, nurse({ payGrade: "1012", salaryLow: 45000 }))).toMatchObject({ status: 200, json: { passRoute: "stated_pay" } });
  });
  it("a grade typed as free text, or not on the list, passes as before; a private employer still needs the minimum", async () => {
    for (const payGrade of ["Staff Nurse scale", "9999", "2135' or 1=1 --"])
      expect(await send(checkPOST, "/check", hse, nurse({ payGrade, salaryLow: 20000 })), payGrade).toMatchObject({ status: 200, json: { passRoute: "public_pay" } });
    expect(await send(checkPOST, "/check", privateCo, nurse())).toMatchObject({ status: 422, json: { code: "PAY_BELOW_MINIMUM" } });
    for (const payGrade of ["x".repeat(101), "21\u000035", "2135‮", 2135, ["2135"]])
      expect((await send(checkPOST, "/check", hse, nurse({ payGrade }))).status, String(payGrade)).toBe(400);
  });
  it("a real post goes live on the public route, and its page shows the grade's scale; a free-text grade's page shows none", async () => {
    const listed = await send(postPOST, "", hse, nurse());
    expect(listed).toMatchObject({ status: 200, json: { status: "live", passRoute: "public_pay" } });
    expect(await send(postPOST, "", hse, nurse({ salaryLow: 30000 }))).toMatchObject({ status: 422, json: { code: "PAY_NOT_ON_SCALE" } });
    const free = await send(postPOST, "", hse, nurse({ payGrade: "Staff Nurse scale", title: "Staff Nurse (Night)" }));
    const page = await getJob(db.pool("app_candidate"), listed.json.jobId);
    expect(page!.payScale).toEqual({ code: "2135", title: "Staff Nurse", firstEur: 38166, lastEur: 56592, line: "Pay scale for this grade: EUR 38,166 to 56,592" });
    expect((await getJob(db.pool("app_candidate"), free.json.jobId))!.payScale).toBeNull();
    const [, statements] = await counted(() => getJob(db.pool("app_candidate"), listed.json.jobId));
    expect(statements).toBe(BUDGET.jobPage);
    // a renewal that finds the pay off the scale stores the code as the Under review reason (0055 widens the check); an unknown code is still refused
    await su.query("update job set status = 'under_review', under_review_reason = 'PAY_NOT_ON_SCALE' where id = $1", [listed.json.jobId]);
    await expect(su.query("update job set status = 'under_review', under_review_reason = 'PAY_NOT_ON_SCALES' where id = $1", [free.json.jobId])).rejects.toThrow(/under_review_reason_check/);
    expect((await su.query("select under_review_reason r from job where id = $1", [listed.json.jobId])).rows[0].r).toBe("PAY_NOT_ON_SCALE");
  });
});

describe("the staff manual post applies the same scale rule (#269, #232)", () => {
  const ROLES = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "content_editor", "administrator"];
  const staff: Record<string, string> = {};
  let hseOrg: string, privOrg: string;
  beforeAll(async () => {
    for (const r of ROLES) {
      const id = (await su.query("insert into staff_user(id, name, email, email_verified, created_at, updated_at) values ($1, 'Fake Staff', $1 || '@example.test', true, now(), now()) returning id", [`s7-${r}`])).rows[0].id;
      await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, $2, true)", [id, r]);
      staff[r] = id;
    }
    hseOrg = String(await F.org({ name: "HSE South West", status: "verified" }));
    privOrg = String(await F.org({ name: "Fake Private Hospital Limited", status: "verified" }));
  });
  const manual = (org: string, o: Record<string, unknown> = {}, who = "account_reviewer") => createManualPost(db.pool("app_admin"), staff[who]!, {
    organisationId: org, title: "Staff Nurse", description: "We are hiring a staff nurse for our hospital in Cork. Full sponsorship offered.", county: "Cork", occupationCode: "2231",
    contractMonths: null, salaryLow: 39000, salaryHigh: null, payGrade: "2135", weeklyHours: 39, closesOn: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10),
    applyUrl: "https://careers.example.ie/jobs/2", ...o,
  });
  it("on the scale is live on the public route; off it is a draft with pay_not_on_scale; free text and no stated pay pass as before", async () => {
    for (const o of [{}, { salaryLow: 38166, salaryHigh: 40000 }, { salaryLow: null }, { payGrade: "Staff Nurse scale", salaryLow: 20000 }])
      expect(await manual(hseOrg, o), JSON.stringify(o)).toMatchObject({ status: "live", passRoute: "public_pay", reason: null });
    for (const o of [{ salaryLow: 38165 }, { salaryLow: 30000, salaryHigh: 39000 }, { payGrade: "1012" }]) {
      const r = await manual(hseOrg, o);
      expect([r.status, r.passRoute, r.reason], JSON.stringify(o)).toEqual(["draft", null, { code: "pay_not_on_scale" }]);
      expect((await su.query("select reason_code from audit_event where action = 'job.manual_post' and object_id = $1", [r.jobId])).rows[0].reason_code).toBe("pay_not_on_scale");
    }
    expect(await manual(hseOrg, { payGrade: "1012", salaryLow: 45000 })).toMatchObject({ status: "live", passRoute: "stated_pay" }); // over the minimum: stated pay, as before
  });
  it("a private employer is unchanged: below the minimum is pay_below_minimum whatever the grade; only an account reviewer posts", async () => {
    for (const payGrade of ["2135", "Staff Nurse scale"]) expect((await manual(privOrg, { payGrade })).reason).toEqual({ code: "pay_below_minimum" });
    expect(await manual(privOrg, { salaryLow: 41000 })).toMatchObject({ status: "live", passRoute: "stated_pay" });
    for (const r of ROLES.filter((x) => x !== "account_reviewer")) await expect(manual(hseOrg, {}, r), r).rejects.toSatisfy((e) => e instanceof QueueRefused && e.why === "not_account_reviewer");
  });
});

describe("performance", () => {
  it("the grade read stays inside its statement and time budget", async () => {
    await grades(hse);
    const [, statements] = await counted(() => grades(hse));
    expect(statements).toBe(BUDGET.grades);
    const ms = await median(() => grades(hse));
    console.log(`grade read: median ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(BUDGET.gradesMs);
  });
});
