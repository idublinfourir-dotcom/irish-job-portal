// Step 11 part 11a: the job alert routes, end to end on the test database. Real sign-up and sign-in through the real auth route, then the real route handlers of
// apps/candidate (alerts, pause, resume, unsubscribe) with Requests. Fake people only; no outside service (the candidate login uses its fake mail sender).
// Budgets measured on 13 November 2026 (warm, 9 calls each, see the console lines), with room of about 3 to 4 times.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, seedSignupTerms } from "./better-auth-helper";
import * as alerts from "../src/alerts";

const BUDGET = {
  create: { statements: 9, medianMs: 60 }, // measured 7: 2 session + rate limit + begin, gate, insert, commit
  list: { statements: 4, medianMs: 40 },
  edit: { statements: 5, medianMs: 40 },
  resume: { statements: 9, medianMs: 60 },
  unsubscribeAll: { statements: 2, medianMs: 40 },
  unsubscribeOne: { statements: 2, medianMs: 40 },
};
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
type Handler = (r: Request) => Promise<Response>;
type Route = Partial<Record<"GET" | "POST" | "PUT" | "DELETE", Handler>>;
let db: TestDb, su: pg.Pool;
let AUTH: Handler;
const R = {} as Record<"alerts" | "pause" | "resume" | "unsub", Route>;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_candidate"), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: BASE, CANDIDATE_AUTH_SECRET: secret });
  ({ POST: AUTH } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  R.alerts = await import("../../../apps/candidate/app/api/candidate/alerts/route");
  R.pause = await import("../../../apps/candidate/app/api/candidate/alerts/pause/route");
  R.resume = await import("../../../apps/candidate/app/api/candidate/alerts/resume/route");
  R.unsub = await import("../../../apps/candidate/app/api/alerts/unsubscribe/route");
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const uid = (p: string) => `${p}${++n}${Date.now().toString(36)}`;
async function login(o: { suspended?: boolean; unverified?: boolean } = {}) {
  const email = `${uid("fake.")}@example.test`, password = "Fake-password-12345";
  const ip = `198.51.100.${(n % 200) + 10}`;
  const h = { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip };
  const up = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...answers }) }));
  expect(up.status).toBe(200);
  await su.query("update candidate_user set email_verified=true where email=$1", [email]);
  const r = await AUTH(new Request(`${BASE}/api/auth/candidate/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const id = (await su.query("select id from candidate_user where email=$1", [email])).rows[0].id as string;
  if (o.suspended) await su.query("update candidate_user set suspended_at=now() where id=$1", [id]);
  if (o.unverified) await su.query("update candidate_user set email_verified=false where id=$1", [id]);
  return { cookie, id };
}
type P = Awaited<ReturnType<typeof login>>;
type Opts = { cookie?: string; origin?: string | null; raw?: string; headers?: Record<string, string> };
async function call(route: Route, method: keyof Route, body: unknown, o: Opts = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers };
  if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? BASE;
  const init: RequestInit = { method, headers };
  if (method !== "GET") init.body = o.raw ?? JSON.stringify(body);
  const res = await route[method]!(new Request(`${BASE}/api/candidate/alerts`, init));
  const json = JSON.parse(await res.text()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, json, code: json.code as string | undefined };
}
// The unsubscribe route as a mail provider's server calls it: no cookie, no Origin.
async function unsub(method: "GET" | "POST", query: string, body?: string, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers };
  if (body !== undefined) { init.body = body; init.headers = { "content-type": "application/x-www-form-urlencoded", ...headers }; }
  const res = await R.unsub[method]!(new Request(`${BASE}/api/alerts/unsubscribe${query}`, init));
  return { status: res.status, json: JSON.parse(await res.text()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let c = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), c]; } finally { pg.Client.prototype.query = q; }
}
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows;
const good = { occupationCode: "2111", sector: "IT", county: "Dublin", salaryMin: 40000, badge: "sponsor_confirmed", frequency: "daily" };
const create = async (p: P, body: object = { frequency: "daily" }) => (await call(R.alerts, "POST", body, p)).json.alert.id as string;
const tokenOf = async (id: string) => (await one("select unsubscribe_token t from alert where id=$1", [id]))[0].t as string;
const status = async (id: string) => (await one("select status, pause_reason from alert where id=$1", [id]))[0] as { status: string; pause_reason: string | null };

describe("the candidate's own alerts", () => {
  it("creates with every filter, lists, edits (a key left out becomes any), pauses, resumes and deletes", async () => {
    const p = await login();
    const c = await call(R.alerts, "POST", good, p);
    expect(c.status).toBe(200);
    expect(c.json.alert).toMatchObject({ ...good, status: "active", pauseReason: null, lastSentAt: null });
    const id = c.json.alert.id as string;
    expect(await one("select search_text, status from alert where id=$1", [id])).toEqual([{ search_text: null, status: "active" }]);
    const list = (await call(R.alerts, "GET", null, p)).json.alerts as Record<string, unknown>[];
    expect(list.map((a) => a.id)).toEqual([id]);
    expect(list[0]).not.toHaveProperty("unsubscribeToken");
    expect(JSON.stringify(list)).not.toContain(await tokenOf(id));
    const e = await call(R.alerts, "PUT", { id, frequency: "weekly", county: "Cork" }, p);
    expect(e.json.alert).toMatchObject({ occupationCode: null, sector: null, county: "Cork", salaryMin: null, badge: null, frequency: "weekly", status: "active" });
    expect((await call(R.pause, "POST", { id }, p)).json.alert).toMatchObject({ status: "paused", pauseReason: "candidate" });
    expect(await status(id)).toEqual({ status: "paused", pause_reason: "candidate" });
    expect((await call(R.resume, "POST", { id }, p)).json.alert).toMatchObject({ status: "active", pauseReason: null });
    expect(await call(R.alerts, "DELETE", { id }, p)).toMatchObject({ status: 200, json: { ok: true } });
    expect((await call(R.alerts, "GET", null, p)).json).toEqual({ alerts: [] });
  });
  it("gives each alert its own random token of at least 32 characters, and accepts salary 0 and 1,000,000", async () => {
    const p = await login();
    const ids = [await create(p), await create(p, { frequency: "weekly", salaryMin: 0 }), await create(p, { frequency: "daily", salaryMin: 1_000_000 })];
    const tokens = await Promise.all(ids.map(tokenOf));
    expect(new Set(tokens).size).toBe(3);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });
  it("refuses a bad filter, a missing or bad frequency, free text, unknown fields and control characters, and stores nothing", async () => {
    const p = await login();
    const bad: object[] = [
      { occupationCode: "9999" }, { occupationCode: 2111 }, { sector: "mining" }, { sector: "it" }, { county: "Atlantis" }, { county: "dublin" },
      { salaryMin: -1 }, { salaryMin: 1_000_001 }, { salaryMin: 1.5 }, { salaryMin: "100" }, { badge: "critical_skills_eligible" }, { badge: true },
      { frequency: "hourly" }, { frequency: undefined }, { searchText: "nurse" }, { search_text: "nurse" }, { q: "nurse" }, { status: "paused" }, { id: "1" },
      { candidateUserId: "x" }, { unsubscribeToken: "a".repeat(40) }, { county: "Dub\u0000lin" }, { county: "Dub‮lin" }, { sector: "IT​" },
    ];
    for (const b of bad) expect(await call(R.alerts, "POST", { frequency: "daily", ...b }, p), JSON.stringify(b)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await call(R.alerts, "POST", {}, p)).toMatchObject({ status: 400 });
    expect(await one("select count(*)::int c from alert where candidate_user_id=$1", [p.id])).toEqual([{ c: 0 }]);
    const id = await create(p);
    for (const b of [{ id, searchText: "x" }, { id }, { id: "x", frequency: "daily" }, { id: "0x1", frequency: "daily" }, { id, frequency: "daily", status: "active" }])
      expect((await call(R.alerts, "PUT", b, p)).status, JSON.stringify(b)).toBe(400);
  });
  it("holds at most 10 per candidate (every row counts), a delete frees a slot, and 15 at once make exactly 10", async () => {
    const p = await login(), q = await login();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await create(p));
    await su.query("update alert set status='unsubscribed' where id=$1", [ids[0]]);
    expect(await call(R.alerts, "POST", { frequency: "daily" }, p)).toMatchObject({ status: 409, code: "ALERT_LIMIT" });
    expect((await call(R.alerts, "DELETE", { id: ids[0] }, p)).status).toBe(200);
    expect((await call(R.alerts, "POST", { frequency: "daily" }, p)).status).toBe(200);
    expect((await call(R.alerts, "POST", { frequency: "daily" }, q)).status).toBe(200); // another candidate has their own 10
    const r = await login();
    const codes = (await Promise.all(Array.from({ length: 15 }, () => call(R.alerts, "POST", { frequency: "daily" }, r)))).map((x) => x.status).sort();
    expect(codes.filter((c) => c === 200).length).toBe(10);
    expect(await one("select count(*)::int c from alert where candidate_user_id=$1", [r.id])).toEqual([{ c: 10 }]);
  });
  it("an unverified candidate can neither create nor resume; a Stamp 4 candidate can neither, and the pause stays", async () => {
    const u = await login({ unverified: true });
    expect(await call(R.alerts, "POST", { frequency: "daily" }, u)).toMatchObject({ status: 403, code: "EMAIL_NOT_VERIFIED" });
    await su.query("insert into alert(candidate_user_id, frequency, status, pause_reason, unsubscribe_token) values ($1,'daily','paused','candidate',$2) returning id", [u.id, uid("tok")]);
    const uid1 = (await one("select id::text i from alert where candidate_user_id=$1", [u.id]))[0].i as string;
    expect(await call(R.resume, "POST", { id: uid1 }, u)).toMatchObject({ status: 403, code: "EMAIL_NOT_VERIFIED" });
    expect((await call(R.alerts, "GET", null, u)).status).toBe(200); // reading and deleting stay open
    expect((await call(R.pause, "POST", { id: uid1 }, u)).status).toBe(200);

    const s = await login();
    const id = await create(s);
    await su.query("insert into candidate_profile(candidate_user_id, location_kind, current_stamp) values ($1,'ireland','4')", [s.id]);
    await su.query("update alert set status='paused', pause_reason='stamp_4' where id=$1", [id]);
    expect(await call(R.resume, "POST", { id }, s)).toMatchObject({ status: 409, code: "STAMP_4" });
    expect(await call(R.alerts, "POST", { frequency: "daily" }, s)).toMatchObject({ status: 409, code: "STAMP_4" });
    expect(await status(id)).toEqual({ status: "paused", pause_reason: "stamp_4" });
    await su.query("update candidate_profile set current_stamp='1G' where candidate_user_id=$1", [s.id]);
    expect((await call(R.resume, "POST", { id }, s)).status).toBe(200);
  });
  it("resumes from unsubscribed (D6) and starts 'new' again at the resume; an active alert keeps its last_sent_at; pausing a non-active alert changes nothing", async () => {
    const p = await login();
    const id = await create(p);
    await su.query("update alert set status='unsubscribed', last_sent_at = now() - interval '30 days' where id=$1", [id]);
    expect((await call(R.pause, "POST", { id }, p)).json.alert).toMatchObject({ status: "unsubscribed", pauseReason: null });
    expect((await call(R.resume, "POST", { id }, p)).json.alert).toMatchObject({ status: "active" });
    expect((await one("select now() - last_sent_at < interval '1 minute' as fresh from alert where id=$1", [id]))[0].fresh).toBe(true);
    await su.query("update alert set last_sent_at = now() - interval '2 days' where id=$1", [id]);
    await call(R.resume, "POST", { id }, p);
    expect((await one("select now() - last_sent_at > interval '1 day' as old from alert where id=$1", [id]))[0].old).toBe(true);
  });
});

describe("security: another candidate's alerts", () => {
  it("never readable or writable: every signed-in action on another candidate's alert id is a 404 and changes nothing", async () => {
    const a = await login(), b = await login();
    const id = await create(a, good);
    const before = await one("select * from alert where id=$1", [id]);
    expect((await call(R.alerts, "GET", null, b)).json).toEqual({ alerts: [] });
    expect(await call(R.alerts, "PUT", { id, frequency: "weekly" }, b)).toMatchObject({ status: 404, code: "ALERT_NOT_FOUND" });
    for (const r of [R.alerts, R.pause, R.resume]) expect(await call(r, r === R.alerts ? "DELETE" : "POST", { id }, b)).toMatchObject({ status: 404, code: "ALERT_NOT_FOUND" });
    expect(await one("select * from alert where id=$1", [id])).toEqual(before);
    expect(await call(R.alerts, "DELETE", { id: "999999999" }, b)).toMatchObject({ status: 404 });
  });
  it("no session, a junk cookie, a suspended and a deleted candidate are refused on every route", async () => {
    const s = await login({ suspended: true }), d = await login();
    await su.query("update candidate_user set deleted_at=now() where id=$1", [d.id]);
    const every: [Route, keyof Route, unknown][] = [[R.alerts, "GET", null], [R.alerts, "POST", good], [R.alerts, "PUT", { id: "1", frequency: "daily" }], [R.alerts, "DELETE", { id: "1" }], [R.pause, "POST", { id: "1" }], [R.resume, "POST", { id: "1" }]];
    for (const [route, method, body] of every) {
      expect(await call(route, method, body), `${method} none`).toMatchObject({ status: 401, code: "NO_SESSION" });
      expect((await call(route, method, body, { cookie: "better-auth.session_token=junk" })).status, `${method} junk`).toBe(401);
      expect((await call(route, method, body, s)).status, `${method} suspended`).toBe(403);
      expect((await call(route, method, body, d)).status, `${method} deleted`).toBeOneOf([401, 403]);
    }
    expect(await one("select count(*)::int c from alert where candidate_user_id = any($1)", [[s.id, d.id]])).toEqual([{ c: 0 }]);
  });
  it("every write refuses a foreign or missing Origin, an oversized body, bad JSON and unknown fields", async () => {
    const p = await login();
    const id = await create(p);
    const writes: [Route, keyof Route, object][] = [[R.alerts, "POST", good], [R.alerts, "PUT", { id, frequency: "daily" }], [R.alerts, "DELETE", { id }], [R.pause, "POST", { id }], [R.resume, "POST", { id }]];
    for (const [route, method, body] of writes) {
      expect((await call(route, method, body, { ...p, origin: "https://evil.example" })).code, "origin").toBe("BAD_ORIGIN");
      expect((await call(route, method, body, { ...p, origin: null })).code, "no origin").toBe("BAD_ORIGIN");
      expect((await call(route, method, body, { ...p, raw: JSON.stringify({ ...body, pad: "x".repeat(3000) }) })).code, "big").toBe("BODY_TOO_LARGE");
      expect((await call(route, method, body, { ...p, headers: { "content-length": "999999" } })).code, "length").toBe("BODY_TOO_LARGE");
      for (const raw of ["not json", "[]", "null", "5", JSON.stringify({ ...body, userId: "other", candidate_user_id: "other" })])
        expect((await call(route, method, body, { ...p, raw })).code, `${raw}`).toBe("BAD_REQUEST");
    }
    expect(await one("select count(*)::int c from alert where candidate_user_id=$1", [p.id])).toEqual([{ c: 1 }]);
  });
  it("a body that carries SQL is only data", async () => {
    const p = await login();
    for (const b of [{ county: "x'; delete from alert; --" }, { occupationCode: "2111'; drop table alert;--" }]) expect((await call(R.alerts, "POST", { frequency: "daily", ...b }, p)).status).toBe(400);
    expect((await call(R.alerts, "DELETE", { id: "1; delete from alert" }, p)).status).toBe(400);
  });
  it("the portal and fetcher logins cannot touch the alert functions or the table", async () => {
    const a = await login();
    const id = await create(a);
    for (const role of ["app_portal", "app_fetcher"] as const) {
      const pool = db.pool(role);
      await expect(alerts.listAlerts(pool, a.id), role).rejects.toMatchObject({ code: "42501" });
      await expect(alerts.deleteAlert(pool, a.id, { id }), role).rejects.toMatchObject({ code: "42501" });
      await expect(alerts.unsubscribe(pool, { token: await tokenOf(id), scope: "all" }), role).rejects.toMatchObject({ code: "42501" });
    }
    expect(await status(id)).toEqual({ status: "active", pause_reason: null });
  });
  it("writes trip the shared rate limit at 60 in ten minutes, per login", async () => {
    const p = await login(), q = await login();
    const id = await create(p);
    const codes: number[] = [];
    for (let i = 0; i < 60; i++) codes.push((await call(R.pause, "POST", { id }, p)).status); // 1 create + 60 = 61
    expect(codes.slice(0, 59).every((c) => c === 200)).toBe(true);
    expect(codes[59]).toBe(429);
    expect((await call(R.alerts, "POST", { frequency: "daily" }, q)).status).toBe(200);
    expect((await call(R.alerts, "GET", null, p)).status).toBe(200);
  });
});

describe("unsubscribe by token (no sign-in)", () => {
  it("GET changes nothing and shows the filters in words and the scope", async () => {
    const p = await login();
    const id = await create(p, good);
    const t = await tokenOf(id);
    const g = await unsub("GET", `?token=${t}&scope=one`);
    expect(g.status).toBe(200);
    expect(g.json).toEqual({
      scope: "one",
      alert: { filters: [expect.stringContaining("Occupation: "), "Sector: IT", "County: Dublin", "Pay from EUR 40,000 a year", "Sponsor confirmed jobs only"], frequency: "daily", status: "active" },
    });
    expect(g.json.alert.filters[0]).toMatch(/\(2111\)$/);
    expect((await unsub("GET", `?token=${t}&scope=all`)).json.scope).toBe("all");
    expect(await status(id)).toEqual({ status: "active", pause_reason: null });
    expect((await unsub("GET", `?token=${t}&scope=all`, undefined, { origin: "https://evil.example" })).status).toBe(200);
  });
  it("POST with the RFC 8058 body, no Origin and no cookie, unsubscribes one alert only", async () => {
    const p = await login();
    const a1 = await create(p), a2 = await create(p, { frequency: "weekly" });
    const r = await unsub("POST", `?token=${await tokenOf(a1)}&scope=one`, "List-Unsubscribe=One-Click");
    expect(r).toEqual({ status: 200, json: { ok: true, scope: "one" } });
    expect((await status(a1)).status).toBe("unsubscribed");
    expect((await status(a2)).status).toBe("active");
    expect((await unsub("POST", `?token=${await tokenOf(a1)}&scope=one`, "List-Unsubscribe=One-Click")).status).toBe(200); // twice is fine
  });
  it("scope=all unsubscribes every alert of that candidate, paused ones too, and no one else's", async () => {
    const p = await login(), q = await login();
    const ids = [await create(p), await create(p), await create(p)];
    await su.query("update alert set status='paused', pause_reason='stamp_4' where id=$1", [ids[2]]);
    const other = await create(q);
    expect((await unsub("POST", `?token=${await tokenOf(ids[0]!)}&scope=all`, "List-Unsubscribe=One-Click")).json).toEqual({ ok: true, scope: "all" });
    for (const id of ids) expect((await status(id)).status).toBe("unsubscribed");
    expect((await status(other)).status).toBe("active");
    expect((await one("select count(*)::int c from alert where candidate_user_id=$1", [p.id]))[0].c).toBe(3); // nothing deleted
  });
  it("an unknown token answers the same shape without filters, never a 500, and changes nothing", async () => {
    const p = await login();
    const id = await create(p);
    const unknown = "A".repeat(43);
    expect(await unsub("GET", `?token=${unknown}&scope=one`)).toEqual({ status: 200, json: { scope: "one", alert: null } });
    expect(await unsub("POST", `?token=${unknown}&scope=all`, "List-Unsubscribe=One-Click")).toEqual({ status: 200, json: { ok: true, scope: "all" } });
    expect((await status(id)).status).toBe("active");
  });
  it("refuses a token of the wrong length or with odd characters, and a bad scope, before any query", async () => {
    const good43 = "A".repeat(43);
    const queries = [
      "", "?scope=one", `?token=${good43}`, `?token=${good43}&scope=two`, `?token=${good43}&scope=`, `?token=&scope=one`, `?token=${"A".repeat(31)}&scope=one`,
      `?token=${"A".repeat(65)}&scope=one`, `?token=${"A".repeat(40)}%27%3B%20drop&scope=one`, `?token=${"A".repeat(40)}%00AA&scope=one`, `?token=${"A".repeat(40)}%E2%80%AEAA&scope=one`,
      `?token=${"A".repeat(40)}%20AA&scope=one`
    ];
    for (const q of queries)
      for (const method of ["GET", "POST"] as const) {
        const [r, statements] = await counted(() => unsub(method, q, method === "POST" ? "List-Unsubscribe=One-Click" : undefined));
        expect([r.status, r.json.code, statements], `${method} ${q}`).toEqual([400, "BAD_REQUEST", 0]);
      }
  });
  it("refuses a big POST body, and a token cannot be used to read another alert", async () => {
    const p = await login();
    const id = await create(p);
    const t = await tokenOf(id);
    expect((await unsub("POST", `?token=${t}&scope=one`, "x".repeat(500))).status).toBe(413);
    expect((await unsub("POST", `?token=${t}&scope=one`, "List-Unsubscribe=One-Click", { "content-length": "999999" })).status).toBe(413);
    expect((await status(id)).status).toBe("active");
  });
});

describe("performance", () => {
  async function measure(name: keyof typeof BUDGET, make: () => Promise<() => Promise<{ status: number }>>) {
    const times: number[] = []; let statements = 0;
    for (let i = 0; i < 9; i++) {
      const go = await make();
      const t = performance.now();
      const [r, c] = await counted(go);
      times.push(performance.now() - t);
      expect(r.status).toBe(200);
      statements = Math.max(statements, c);
    }
    const median = [...times].sort((a, b) => a - b)[4]!;
    console.log(`alerts-routes ${name}: ${statements} statements, median ${median.toFixed(1)} ms`);
    expect(statements).toBeLessThanOrEqual(BUDGET[name].statements);
    expect(median).toBeLessThan(BUDGET[name].medianMs);
  }
  it("create, list, edit, resume and the two unsubscribes stay inside their budgets", async () => {
    const p = await login();
    await measure("create", async () => { await su.query("delete from alert where candidate_user_id=$1", [p.id]); return () => call(R.alerts, "POST", good, p); });
    const id = await create(p);
    await measure("list", async () => () => call(R.alerts, "GET", null, p));
    await measure("edit", async () => () => call(R.alerts, "PUT", { id, ...good }, p));
    await measure("resume", async () => { await su.query("update alert set status='paused' where id=$1", [id]); return () => call(R.resume, "POST", { id }, p); });
    const t = await tokenOf(id);
    await measure("unsubscribeOne", async () => () => unsub("POST", `?token=${t}&scope=one`, "List-Unsubscribe=One-Click"));
    await measure("unsubscribeAll", async () => () => unsub("POST", `?token=${t}&scope=all`, "List-Unsubscribe=One-Click"));
  });
  it("on 30,000 alerts, both unsubscribe updates and the list read use an index and no sequential scan of the alert table", async () => {
    const p = await login();
    await su.query(
      `insert into alert(candidate_user_id, frequency, unsubscribe_token) select $1, 'daily', 'bulk' || lpad(g::text, 40, '0') from generate_series(1, 30000) g`, [p.id]);
    await su.query("analyze alert");
    const t = await tokenOf(await create(await login()));
    const plans = [
      ["update alert set status='unsubscribed' where status <> 'unsubscribed' and unsubscribe_token = $1", [t]],
      ["update alert set status='unsubscribed' where status <> 'unsubscribed' and candidate_user_id = (select candidate_user_id from alert where unsubscribe_token = $1)", [t]],
      ["select id from alert where candidate_user_id = $1 order by id desc limit 10", [p.id]],
    ] as const;
    for (const [sql, args] of plans) {
      const client = await su.connect();
      try {
        await client.query("begin");
        const plan = (await client.query(`explain (analyze, buffers) ${sql}`, [...args])).rows.map((r) => r["QUERY PLAN"]).join("\n");
        await client.query("rollback");
        expect(plan, sql).not.toMatch(/Seq Scan on alert/);
      } finally { client.release(); }
    }
  });
});
