// Integration: pay floors from the employer portal (step 9, part 12b), end to end on the test database through the real /api/portal/pay-floors handlers,
// connected as app_portal, with real portal sessions (sign-up, confirm and sign-in through the real auth route). No test calls the real network. Fake people only.
// Companies, members and the big-company flag are written as postgres (every CHECK, foreign key and trigger still fires).
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { portalAnswers, seedSignupTerms } from "./better-auth-helper";
import { fixtures } from "./fixtures";
import { confirmedApproval, makeBig } from "./pay-floors-helpers";

// Statements counted on every pg.Client.query call, measured on 12 November 2026 (median of 9 calls, warm): a sign = requirePortal 3, rate count 1, current wording 1,
// insert 1 = 6 (the triggers run inside the insert); a list = requirePortal 3, wording 1, floors 1 = 5; a withdraw = requirePortal 3, rate count 1, update 1 = 5.
// Medians of 9 warm calls, two runs: sign 2.4 ms, list 1.4 ms, withdraw 1.2 to 1.4 ms. Limits are 6 to 12 times that, a floor for a busy laptop (the full check runs many files at once). Raise these only on purpose.
const BUDGET = { sign: 6, list: 5, withdraw: 5, signMs: 25, listMs: 15, withdrawMs: 15 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let authPOST: Handler, floorGET: Handler, floorPOST: Handler;
let mail: () => { pool: string; kind: string; to: string; link: string }[];
let F: { org(o?: object): Promise<number>; member(org: number, user: string | null, o?: object): Promise<number>; staff(): Promise<string>; text(p?: string): Promise<number> };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret });
  ({ POST: authPOST } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ GET: floorGET, POST: floorPOST } = await import("../../../apps/portal/app/api/portal/pay-floors/route"));
  ({ portalMail: mail } = await import("../../../apps/portal/lib/portal"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});
beforeEach(async () => { await su.query("delete from portal_rate_limit where key like 'floors:%'"); });

let ipn = 0;
const freshIp = () => `10.9.${Math.floor(ipn / 250)}.${ipn++ % 250}`;
type Reply = { status: number; json: Record<string, any> | null; text: string; cookie: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function reply(res: Response): Promise<Reply> {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
const authCall = async (path: string, body: unknown) => reply(await authPOST(new Request(`${BASE}/api/auth/portal/${path}`, {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": freshIp() } })));
const click = async (link: string) => reply(await (await import("../../../apps/portal/app/api/auth/portal/[...all]/route")).GET(new Request(link, { headers: { "x-vercel-forwarded-for": freshIp() }, redirect: "manual" })));
// A POST. origin: null sends no Origin header.
async function post(cookie: string | undefined, body: unknown, o: { origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(cookie ? { cookie } : {}) };
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  return reply(await floorPOST(new Request(`${BASE}/api/portal/pay-floors`, { method: "POST", body: o.raw ?? JSON.stringify(body), headers })));
}
const list = async (cookie?: string) => reply(await floorGET(new Request(`${BASE}/api/portal/pay-floors`, { headers: cookie ? { cookie } : {} })));
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}
const median = async (fn: () => Promise<unknown>) => {
  const ms = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[4]!;
};
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];

let n = 0;
type Login = { email: string; cookie: string; id: string; name: string };
async function login(domain = "elsewhere.example.test"): Promise<Login> {
  const p = { email: `fake.f${++n}@${domain}`, password: `Fake-f${n}-password-1`, name: `Fake F${n}`, ...portalAnswers };
  expect((await authCall("sign-up/email", p)).status).toBe(200);
  await click(mail().filter((m) => m.to === p.email && m.kind === "verify").at(-1)!.link);
  const r = await authCall("sign-in/email", { email: p.email, password: p.password });
  expect(r.status, r.text).toBe(200);
  return { email: p.email, cookie: r.cookie, id: (await one("select id from portal_user where email=$1", [p.email])).id, name: p.name };
}
type Member = Login & { mem: number };
const member = async (org: number, o: { role?: string; signer?: boolean } = {}): Promise<Member> => {
  const l = await login();
  return { ...l, mem: Number(await F.member(org, l.id, { role: o.role ?? "recruiter", signer: o.signer ?? false })) };
};
/** A big-company employer: the flag needs a confirmed, unused big_company_entry request, made by two fake staff. */
async function bigCompany(o: { status?: string; kind?: string } = {}) {
  const org = Number(await F.org({ status: o.status ?? "verified", kind: o.kind ?? "employer" }));
  await makeBig(su, F.staff, org);
  return org;
}
type Company = { org: number; owner: Member; signer: Member; poster: Member; recruiter: Member; viewer: Member };
async function company(): Promise<Company> {
  const org = await bigCompany();
  const owner = await login();
  return {
    org,
    owner: { ...owner, mem: Number(await F.member(org, owner.id, { role: "account_owner", signer: true })) },
    signer: await member(org, { role: "poster", signer: true }),
    poster: await member(org, { role: "poster" }),
    recruiter: await member(org, { role: "recruiter" }),
    viewer: await member(org, { role: "viewer" }),
  };
}

let textId: string;
const sign = (cookie: string | undefined, o: object = {}) => post(cookie, { action: "sign", roleFamily: "2134", floorEur: 45000, consentTextId: textId, ...o });
const floors = (org: number) => su.query("select id, status, role_family, floor_eur, signer_name, signer_title, signer_membership_id, consent_text_id, valid_until > now() + interval '11 months 28 days' and valid_until < now() + interval '12 months 2 days' as year from pay_floor where organisation_id = $1 order by id", [org]).then((r) => r.rows);

describe("before a wording is published", () => {
  it("refuses to sign (NO_CONSENT_TEXT) and lists no wording", async () => {
    const c = await company();
    const r = await sign(c.owner.cookie, { consentTextId: "1" });
    expect([r.status, r.json]).toEqual([409, { code: "NO_CONSENT_TEXT" }]);
    expect(await floors(c.org)).toEqual([]);
    expect((await list(c.owner.cookie)).json).toEqual({ text: null, floors: [] });
    textId = String(await F.text("pay_floor"));
  });
});

describe("GET", () => {
  it("is 401 without a session and empty for a login with no company", async () => {
    expect((await list()).status).toBe(401);
    const l = await login();
    const r = await list(l.cookie);
    expect([r.status, r.json!.floors]).toEqual([200, []]);
  });
  it("shows the wording and the company's own floors to every active member, never another company's", async () => {
    const c = await company(), other = await company();
    expect((await sign(c.owner.cookie)).status).toBe(200);
    expect((await sign(other.owner.cookie, { roleFamily: "2230" })).status).toBe(200);
    for (const m of [c.owner, c.signer, c.poster, c.recruiter, c.viewer]) {
      const r = await list(m.cookie);
      expect(r.status).toBe(200);
      expect(r.json!.text).toMatchObject({ id: textId, body: "Fake wording" });
      expect(r.json!.floors.map((f: { roleFamily: string }) => f.roleFamily)).toEqual(["2134"]);
      expect(Object.keys(r.json!.floors[0]).sort()).toEqual(["endedAt", "floorEur", "id", "roleFamily", "signedAt", "signerName", "signerTitle", "status", "validUntil"]);
    }
    expect((await list(other.viewer.cookie)).json!.floors.map((f: { roleFamily: string }) => f.roleFamily)).toEqual(["2230"]);
  });
});

describe("POST sign", () => {
  it("lets the owner sign: pending, 12 months, the signer's name and title, queued for the staff check", async () => {
    const c = await company();
    const r = await sign(c.owner.cookie);
    expect(r.status, r.text).toBe(200);
    expect(Object.keys(r.json!).sort()).toEqual(["id", "validUntil"]);
    const f = (await floors(c.org))[0];
    expect(f).toMatchObject({ status: "pending_check", role_family: "2134", floor_eur: 45000, signer_name: c.owner.name, signer_title: "Account owner", signer_membership_id: String(c.owner.mem), consent_text_id: textId, year: true });
    expect(await one("select count(*)::int n from review_item where queue='pay_floor_check' and pay_floor_id=$1 and status='open'", [f.id])).toEqual({ n: 1 });
  });
  it("lets a poster with the signer switch sign, and refuses a poster without it, a recruiter without it and a viewer", async () => {
    const c = await company();
    const ok = await sign(c.signer.cookie, { roleFamily: "3434" });
    expect(ok.status, ok.text).toBe(200);
    expect((await floors(c.org))[0]).toMatchObject({ signer_title: "Poster", signer_membership_id: String(c.signer.mem) });
    for (const who of [c.poster, c.recruiter, c.viewer]) {
      const r = await sign(who.cookie, { roleFamily: "3435" });
      expect([r.status, r.json]).toEqual([403, { code: "NOT_SIGNER" }]);
    }
    expect((await floors(c.org)).length).toBe(1);
  });
  it("refuses an agency (even flagged big), an employer off the list, and a login with no company", async () => {
    const agency = await bigCompany({ kind: "agency" }), small = Number(await F.org({}));
    for (const org of [agency, small]) {
      const o = await login();
      await F.member(org, o.id, { role: "account_owner", signer: true });
      const r = await sign(o.cookie);
      expect([r.status, r.json], String(org)).toEqual([403, { code: "NOT_BIG_COMPANY" }]);
      expect(await floors(org)).toEqual([]);
    }
    const nobody = await login();
    const r = await sign(nobody.cookie);
    expect([r.status, r.json]).toEqual([403, { code: "REFUSED" }]);
  });
  it("refuses a company that is not verified", async () => {
    for (const status of ["pending_review", "needs_info", "suspended", "banned", "unclaimed"]) {
      const org = await bigCompany({ status });
      const o = await login();
      await F.member(org, o.id, { role: "account_owner", signer: true });
      const r = await sign(o.cookie);
      expect(r.status, status).toBe(403);
      expect(await floors(org), status).toEqual([]);
    }
  });
  it("a restricted company (strike 2) may still sign: staff check the floor", async () => {
    const org = await bigCompany({ status: "verified_restricted" });
    const o = await login();
    await F.member(org, o.id, { role: "account_owner", signer: true });
    expect((await sign(o.cookie)).status).toBe(200);
  });
  it("refuses a second pending floor for the same family, but not a different family", async () => {
    const c = await company();
    expect((await sign(c.owner.cookie, { roleFamily: "3434" })).status).toBe(200);
    const r = await sign(c.owner.cookie, { roleFamily: "3434" });
    expect([r.status, r.json]).toEqual([409, { code: "ALREADY_PENDING" }]);
    expect((await sign(c.owner.cookie, { roleFamily: "3435" })).status).toBe(200);
    expect((await floors(c.org)).map((f) => f.role_family)).toEqual(["3434", "3435"]);
  });
  it("refuses a family that is not a four-digit code or is on the Ineligible list (#231)", async () => {
    const c = await company();
    for (const f of ["chef", "Chef", " 2134", "2134 ", "213", "21345", "2.34", "٢١٣٤", "2134;", "0000x"]) {
      const r = await sign(c.owner.cookie, { roleFamily: f });
      expect([r.status, r.json], f).toEqual([400, { code: "BAD_REQUEST" }]);
    }
    const ineligible = "1225"; // on the Ineligible list only, in packages/fetcher/data/occupation-lists.json
    const r = await sign(c.owner.cookie, { roleFamily: ineligible });
    expect([r.status, r.json], ineligible).toEqual([400, { code: "BAD_REQUEST" }]);
    expect(await floors(c.org)).toEqual([]);
  });
  it("lets a company sign again for a family that has an active floor (re-sign before expiry), and each company has its own", async () => {
    const c = await company(), other = await company();
    expect((await sign(c.owner.cookie)).status).toBe(200);
    expect((await sign(other.owner.cookie)).status).toBe(200); // the same family name in another company is a different floor
    const f = (await floors(c.org))[0];
    const a = await confirmedApproval(su, F.staff, "pay_floor", "pay_floor", f.id);
    await su.query("update pay_floor set status='active', approval_request_id=$2 where id=$1", [f.id, a]);
    expect((await sign(c.owner.cookie, { floorEur: 47000 })).status).toBe(200);
    expect((await floors(c.org)).map((x) => x.status)).toEqual(["active", "pending_check"]);
  });
  it("needs the wording the signer saw: a newer wording makes the old id TEXT_CHANGED", async () => {
    const c = await company();
    const old = textId;
    textId = String(await F.text("pay_floor"));
    const r = await sign(c.owner.cookie, { consentTextId: old });
    expect([r.status, r.json]).toEqual([409, { code: "TEXT_CHANGED" }]);
    expect((await sign(c.owner.cookie)).status).toBe(200);
    expect((await floors(c.org))[0].consent_text_id).toBe(textId);
  });
  it("a hostile family never reaches the database", async () => {
    const c = await company();
    const r = await sign(c.owner.cookie, { roleFamily: "x'); drop table pay_floor; --" });
    expect([r.status, r.json]).toEqual([400, { code: "BAD_REQUEST" }]);
    expect((await one("select count(*)::int n from pay_floor")).n).toBeGreaterThan(-1);
    await expect(su.query("insert into pay_floor(organisation_id, role_family, floor_eur, consent_text_id, signer_membership_id, valid_until) values ($1,'chef',1,$2,$3, now() + interval '1 day')",
      [c.org, textId, c.owner.mem])).rejects.toThrow(/pay_floor_role_family_check/);
  });

  it("is 401 without a session, 403 with a foreign or missing Origin, 413 for a big body, 400 for bad JSON", async () => {
    const c = await company();
    expect((await sign(undefined)).json).toEqual({ code: "NO_SESSION" });
    expect((await post(c.owner.cookie, { action: "sign" }, { origin: "https://evil.example.test" })).json).toEqual({ code: "BAD_ORIGIN" });
    expect((await post(c.owner.cookie, {}, { origin: null })).json).toEqual({ code: "BAD_ORIGIN" });
    expect((await post(c.owner.cookie, {}, { raw: "x".repeat(5000) })).status).toBe(413);
    for (const raw of ["", "{", "null", "[]", '"sign"']) expect((await post(c.owner.cookie, {}, { raw })).status, raw).toBe(400);
  });
  it("refuses unknown fields and bad values, and nothing is written", async () => {
    const c = await company();
    const base = { action: "sign", roleFamily: "3434", floorEur: 45000, consentTextId: textId };
    const bad: object[] = [
      { ...base, organisationId: 1 }, { ...base, status: "active" }, { ...base, signerMembershipId: 1 }, { ...base, approvalRequestId: 1 }, { ...base, validUntil: "2099-01-01" },
      { ...base, floorEur: 0 }, { ...base, floorEur: -5 }, { ...base, floorEur: 1.5 }, { ...base, floorEur: "45000" }, { ...base, floorEur: 1_000_001 }, { ...base, floorEur: null },
      { ...base, roleFamily: "" }, { ...base, roleFamily: "chef‮" }, { ...base, roleFamily: "ch​ef" }, { ...base, roleFamily: "chef\u0000" }, { ...base, roleFamily: "a".repeat(200) }, { ...base, roleFamily: 5 },
      { ...base, consentTextId: "abc" }, { ...base, consentTextId: 7 }, { ...base, consentTextId: "0" }, { action: "approve", floorId: 1 }, { action: "activate", floorId: 1 }, { action: "sign" }, {},
    ];
    for (const b of bad) {
      const r = await post(c.owner.cookie, b);
      expect([r.status, r.json], JSON.stringify(b)).toEqual([400, { code: "BAD_REQUEST" }]);
    }
    expect(await floors(c.org)).toEqual([]);
  });
  it("limits one login to 10 calls in 10 minutes", async () => {
    const c = await company();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await sign(c.owner.cookie, { roleFamily: String(4000 + i) })).status;
    expect(last).toBe(429);
    expect((await floors(c.org)).length).toBe(10);
  });
});

describe("POST withdraw", () => {
  const withdraw = (cookie: string | undefined, floorId: number) => post(cookie, { action: "withdraw", floorId });
  it("lets a signer withdraw a pending floor, once, and stamps ended_at", async () => {
    const c = await company();
    await sign(c.owner.cookie);
    const id = Number((await floors(c.org))[0].id);
    const r = await withdraw(c.signer.cookie, id);
    expect([r.status, r.json]).toEqual([200, { ok: true }]);
    expect(await one("select status, ended_at is not null e from pay_floor where id=$1", [id])).toEqual({ status: "withdrawn", e: true });
    const again = await withdraw(c.owner.cookie, id);
    expect([again.status, again.json]).toEqual([409, { code: "NOT_WITHDRAWABLE" }]);
  });
  it("lets a signer withdraw an active floor too", async () => {
    const c = await company();
    await sign(c.owner.cookie);
    const id = (await floors(c.org))[0].id;
    await su.query("update pay_floor set status='active', approval_request_id=$2 where id=$1", [id, await confirmedApproval(su, F.staff, "pay_floor", "pay_floor", id)]);
    expect((await withdraw(c.owner.cookie, Number(id))).status).toBe(200);
    expect((await one("select status from pay_floor where id=$1", [id])).status).toBe("withdrawn");
  });
  it("refuses a member who may not sign, and the floor stays", async () => {
    const c = await company();
    await sign(c.owner.cookie);
    const id = Number((await floors(c.org))[0].id);
    for (const who of [c.poster, c.recruiter, c.viewer]) {
      const r = await withdraw(who.cookie, id);
      expect([r.status, r.json]).toEqual([403, { code: "NOT_SIGNER" }]);
    }
    expect((await one("select status from pay_floor where id=$1", [id])).status).toBe("pending_check");
  });
  it("never touches another company's floor: NOT_FOUND, even for its own owner, and the floor stays", async () => {
    const c = await company(), other = await company();
    await sign(other.owner.cookie);
    const id = Number((await floors(other.org))[0].id);
    for (const who of [c.owner, c.signer]) {
      const r = await withdraw(who.cookie, id);
      expect([r.status, r.json]).toEqual([404, { code: "NOT_FOUND" }]);
    }
    expect((await withdraw(c.owner.cookie, 987654321)).status).toBe(404);
    expect((await one("select status from pay_floor where id=$1", [id])).status).toBe("pending_check");
  });
  it("cannot reinstate or change a floor staff already decided", async () => {
    const c = await company();
    await sign(c.owner.cookie);
    const id = (await floors(c.org))[0].id;
    await su.query("update pay_floor set status='found_false' where id=$1", [id]);
    const r = await withdraw(c.owner.cookie, Number(id));
    expect([r.status, r.json]).toEqual([409, { code: "NOT_WITHDRAWABLE" }]);
    expect((await one("select status from pay_floor where id=$1", [id])).status).toBe("found_false");
  });
  it("refuses a login with no company, a bad id and no session", async () => {
    const l = await login();
    expect((await withdraw(l.cookie, 1)).json).toEqual({ code: "REFUSED" });
    expect((await withdraw(undefined, 1)).status).toBe(401);
    const c = await company();
    for (const floorId of [0, -1, 1.5, "1", null]) expect((await post(c.owner.cookie, { action: "withdraw", floorId })).status, String(floorId)).toBe(400);
  });
});

describe("what the database holds even if a route were wrong", () => {
  it("app_portal cannot activate a floor, change an amount, or sign for another company", async () => {
    const c = await company(), other = await company();
    await sign(c.owner.cookie);
    const f = (await floors(c.org))[0];
    const portal = db.pool("app_portal");
    await expect(portal.query("update pay_floor set status='active' where id=$1", [f.id])).rejects.toThrow();
    await expect(portal.query("update pay_floor set floor_eur=1 where id=$1", [f.id])).rejects.toThrow();
    await expect(portal.query("insert into pay_floor(organisation_id, role_family, floor_eur, consent_text_id, signer_membership_id, valid_until) values ($1,'x',1,$2,$3, now() + interval '1 year')", [other.org, textId, c.owner.mem])).rejects.toThrow();
    expect((await floors(c.org))[0].status).toBe("pending_check");
  });
});

describe("performance", () => {
  it("sign, list and withdraw stay inside their statement and time budgets", async () => {
    const c = await company();
    let i = 0;
    const [r, signN] = await counted(() => sign(c.owner.cookie, { roleFamily: String(5000 + i++) }));
    expect(r.status).toBe(200);
    const [, listN] = await counted(() => list(c.owner.cookie));
    const id = Number((await floors(c.org))[0].id);
    const [w, withdrawN] = await counted(() => post(c.owner.cookie, { action: "withdraw", floorId: id }));
    expect(w.status).toBe(200);
    expect([signN, listN, withdrawN]).toEqual([6, 5, 5]);
    expect(signN).toBeLessThanOrEqual(BUDGET.sign);
    expect(listN).toBeLessThanOrEqual(BUDGET.list);
    expect(withdrawN).toBeLessThanOrEqual(BUDGET.withdraw);
    expect(await median(() => sign(c.owner.cookie, { roleFamily: String(6000 + i++) }))).toBeLessThan(BUDGET.signMs);
    expect(await median(() => list(c.owner.cookie))).toBeLessThan(BUDGET.listMs);
    const ids = (await floors(c.org)).filter((f) => f.status === "pending_check").map((f) => Number(f.id));
    let k = 0;
    expect(await median(() => post(c.owner.cookie, { action: "withdraw", floorId: ids[k++] }))).toBeLessThan(BUDGET.withdrawMs);
  });
});
