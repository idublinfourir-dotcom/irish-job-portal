/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// Ported from schema-trial-2/06-better-auth.mjs: Better Auth 1.7.17 through its HTTP handler, connected as
// app_candidate, app_portal and app_admin, never as owner. One `it` per trial check, same names, same order;
// the steps share state (cookies, ids), so they must run in order.
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import pg from "pg";
import { createTestDb, urlFor } from "./db";
import { makeAuth, mail } from "./better-auth-helper";

// Statements one getSession sends, measured on 10 November 2026 with the cookie cache off: 2 per request (session by
// token, then user by id), plus 2 more the first time an instance runs (Better Auth reads the column list once).
// Raise these only on purpose.
const SESSION_SQL_BUDGET = { first: 4, next: 2 };

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const roles = { candidate: "app_candidate", portal: "app_portal", staff: "app_admin" };
let db, pools, auths, su;
beforeAll(async () => {
  db = await createTestDb();
  pools = {}; auths = {};
  for (const [n, r] of Object.entries(roles)) { pools[n] = db.pool(r); auths[n] = makeAuth(n, pools[n]); }
  su = db.pool("postgres");
});
afterAll(() => db.drop());
// a failed check throws its detail, like the trial's FAIL line
const rec = (pass, detail = "") => { if (!pass) throw new Error(String(detail)); };

let ipn = 10; const freshIp = () => `198.51.100.${ipn++}`;
async function call(pool, path, body, cookie, ip = freshIp(), extra = {}) {
  const res = await auths[pool].handler(new Request(`http://localhost:3000/api/auth/${pool}/${path}`, {
    method: body ? "POST" : "GET", headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-vercel-forwarded-for": ip, ...extra, ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined }));
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  const set = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, json, cookie: set.map((c) => c.split(";")[0]).join("; "), text, location: res.headers.get("location") };
}
const email = "same.person@example.test";
const pw = (n) => `Password-${n}-123456`;
const cookies = {};
const ids = {};

describe("better auth", () => {
  // 1. sign-up and email verification in the two open pools
  for (const n of ["candidate", "portal"]) {
    it(`sign up in ${n} pool as ${roles[n]}, same email`, async () => {
      const up = await call(n, "sign-up/email", { email, password: pw(n), name: `Fake ${n}` });
      rec(up.status === 200, `status ${up.status} ${up.json?.message ?? ""}`);
    });
    it(`${n}: sign-in refused before the email is verified (#54)`, async () => {
      const early = await call(n, "sign-in/email", { email, password: pw(n) });
      rec(early.status === 403, `status ${early.status} ${early.json?.code ?? ""}`);
    });
    it(`${n}: verification link sets email_verified as ${roles[n]} (column grant)`, async () => {
      const link = mail.filter((m) => m.pool === n && m.kind === "verify" && m.email === email).at(-1);
      const v = await call(n, `verify-email?${new URL(link.url).searchParams.toString()}`);
      rec(v.status < 400, `status ${v.status}`);
    });
    it(`sign in to ${n} pool`, async () => {
      const inn = await call(n, "sign-in/email", { email, password: pw(n) });
      rec(inn.status === 200, `status ${inn.status}`);
      cookies[n] = inn.cookie;
    });
    it(`session works in ${n} pool`, async () => {
      const ses = await call(n, "get-session", null, cookies[n]);
      rec(ses.json?.user?.email === email, `user ${ses.json?.user?.email}`);
    });
  }
  // 2. staff: sign-up refused, and a working way to create a login with sign-up off
  it("staff pool: a walk-in sign-up is refused (disableSignUp)", async () => {
    const walk = await call("staff", "sign-up/email", { email: "walk.in@example.test", password: pw("walkin"), name: "Stranger" });
    rec(walk.status === 400, `status ${walk.status} ${walk.json?.message ?? ""}`);
  });
  it("staff pool: the server call auth.api.signUpEmail is refused too, so it cannot be the admin path", async () => {
    const server = await auths.staff.api.signUpEmail({ body: { email: "server.call@example.test", password: pw("server"), name: "Server" } }).then(() => "created", (e) => `${e.status ?? ""} ${e.message}`);
    rec(server !== "created", server);
  });
  it("staff pool: an administrator creates a login with sign-up off ($context.internalAdapter + password.hash), and it signs in", async () => {
    // The admin panel path: Better Auth's own internal adapter and password hasher, through app_admin.
    const ctx = await auths.staff.$context;
    const user = await ctx.internalAdapter.createUser({ email, name: "Fake staff", emailVerified: true });
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(pw("staff")) });
    const inn = await call("staff", "sign-in/email", { email, password: pw("staff") });
    rec(inn.status === 200, `status ${inn.status}`);
    cookies.staff = inn.cookie;
  });
  it("session works in staff pool, same email as the other two pools", async () => {
    const ses = await call("staff", "get-session", null, cookies.staff);
    rec(ses.json?.user?.email === email, `user ${ses.json?.user?.email}`);
  });
  // 3. uniqueness inside a pool, and separation between pools
  for (const n of ["candidate", "portal"])
    it(`same email twice, and in capitals, makes no second row in ${n} pool (Better Auth answers 200 so the address is not revealed)`, async () => {
      const d = await call(n, "sign-up/email", { email, password: "Another-Password-123456", name: "Dup" });
      const c = await call(n, "sign-up/email", { email: "SAME.PERSON@EXAMPLE.TEST", password: "Another-Password-123456", name: "Case" });
      const rows = (await su.query(`select count(*)::int n from ${n}_user where lower(email)=$1`, [email])).rows[0].n;
      rec(rows === 1, `statuses ${d.status} and ${c.status}, rows with this email: ${rows}`);
    });
  it("candidate's password refused in the portal pool", async () => {
    const wrong = await call("portal", "sign-in/email", { email, password: pw("candidate") });
    rec(wrong.status !== 200, `status ${wrong.status}`);
  });
  it("candidate cookie is no session in the portal pool", async () => {
    const cross = await call("portal", "get-session", null, cookies.candidate);
    rec(!cross.json?.user, `body ${cross.text.slice(0, 40)}`);
  });
  // 4. Better Auth's own writes under the column grants
  it("candidate: update-user works under the column grant (name, updated_at)", async () => {
    const upd = await call("candidate", "update-user", { name: "Fake renamed" }, cookies.candidate);
    const nm = (await su.query("select name from candidate_user where email=$1", [email])).rows[0].name;
    rec(upd.status === 200 && nm === "Fake renamed", `status ${upd.status}, name ${nm}`);
  });
  it("candidate: change-password works (account table)", async () => {
    const chg = await call("candidate", "change-password", { currentPassword: pw("candidate"), newPassword: pw("candidate2"), revokeOtherSessions: false }, cookies.candidate);
    rec(chg.status === 200, `status ${chg.status} ${chg.json?.message ?? ""}`);
  });
  it("portal: password reset through the verification table, then sign-in with the new password", async () => {
    const req = await call("portal", "request-password-reset", { email, redirectTo: "http://localhost:3000/reset" });
    const link = mail.filter((m) => m.pool === "portal" && m.kind === "reset").at(-1);
    const token = link ? new URL(link.url).pathname.split("/").at(-1) : null;
    const rows = (await su.query("select count(*)::int n from portal_verification")).rows[0].n;
    const reset = token ? await call("portal", "reset-password", { newPassword: pw("portal2"), token }) : { status: "no link" };
    const again = await call("portal", "sign-in/email", { email, password: pw("portal2") });
    rec(req.status === 200 && reset.status === 200 && again.status === 200, `request ${req.status}, verification rows ${rows}, reset ${reset.status}, sign-in ${again.status}`);
    cookies.portal = again.cookie || cookies.portal;
  });
  // 5. the added status columns: the session hook refuses, and suspension deletes open sessions
  let candBefore;
  it("app_admin: suspension and session delete in one transaction", async () => {
    for (const n of Object.keys(roles)) ids[n] = (await su.query(`select id from ${n}_user where email=$1`, [email])).rows[0].id;
    candBefore = await call("candidate", "get-session", null, cookies.candidate);
    // the admin app's suspension: one transaction, set the flag and delete the sessions (app_admin: select(id,user_id), delete)
    const cl = await pools.staff.connect();
    try { await cl.query("begin"); await cl.query("update candidate_user set suspended_at=now() where id=$1", [ids.candidate]);
      const d = await cl.query("delete from candidate_session where user_id=$1", [ids.candidate]); await cl.query("commit");
      rec(d.rowCount >= 1, `${d.rowCount} sessions deleted`); }
    catch (e) { await cl.query("rollback"); throw e; } finally { cl.release(); }
  });
  it("suspended candidate's open session stops working", async () => {
    const after = await call("candidate", "get-session", null, cookies.candidate);
    rec(candBefore.json?.user && !after.json?.user, `before ${candBefore.json?.user?.email}, after ${after.json?.user?.email ?? "none"}`);
  });
  it("suspended candidate cannot sign in (session hook, APIError)", async () => {
    const s1 = await call("candidate", "sign-in/email", { email, password: pw("candidate2") });
    rec(s1.status === 403, `status ${s1.status} ${s1.json?.message ?? ""}`);
  });
  let portalBefore;
  it("a blocked portal user's open session still works if the sessions are not deleted (why the design deletes them)", async () => {
    portalBefore = await call("portal", "get-session", null, cookies.portal);
    await pools.staff.query("update portal_user set status='blocked', blocked_at=now(), blocked_reason_code='fake' where id=$1", [ids.portal]);
    const still = await call("portal", "get-session", null, cookies.portal);
    rec(!!still.json?.user, `session ${still.json?.user?.email ?? "none"}: Better Auth reads only its own columns`);
  });
  it("blocked portal user's sessions deleted by app_admin, open session stops working", async () => {
    const d = await pools.staff.query("delete from portal_session where user_id=$1", [ids.portal]);
    const after = await call("portal", "get-session", null, cookies.portal);
    rec(portalBefore.json?.user && !after.json?.user && d.rowCount >= 1, `${d.rowCount} deleted`);
  });
  it("blocked portal user cannot sign in (session hook)", async () => {
    const s2 = await call("portal", "sign-in/email", { email, password: pw("portal2") });
    rec(s2.status === 403, `status ${s2.status} ${s2.json?.message ?? ""}`);
  });
  it("blocked person's address cannot sign up again (no second row; the blocked row stays)", async () => {
    const s3 = await call("portal", "sign-up/email", { email, password: pw("back"), name: "Back again" });
    const rows = (await su.query("select count(*)::int n from portal_user where lower(email)=$1", [email])).rows[0].n;
    rec(rows === 1, `status ${s3.status}, rows ${rows}`);
  });
  it("disabled staff member: sessions deleted and sign-in refused", async () => {
    await pools.staff.query("update staff_user set status='disabled' where id=$1", [ids.staff]);
    const d = await pools.staff.query("delete from staff_session where user_id=$1", [ids.staff]);
    const after = await call("staff", "get-session", null, cookies.staff);
    const s4 = await call("staff", "sign-in/email", { email, password: pw("staff") });
    rec(!after.json?.user && s4.status === 403 && d.rowCount >= 1, `deleted ${d.rowCount}, sign-in ${s4.status}`);
  });
  it("a deletion request (deleted_at, as app_candidate) signs the person out and refuses sign-in", async () => {
    const e2 = "deleting.person@example.test";
    await call("candidate", "sign-up/email", { email: e2, password: pw("del"), name: "Deleting" });
    const link = mail.filter((m) => m.pool === "candidate" && m.kind === "verify" && m.email === e2).at(-1);
    await call("candidate", `verify-email?${new URL(link.url).searchParams.toString()}`);
    const s = await call("candidate", "sign-in/email", { email: e2, password: pw("del") });
    const uid = (await su.query("select id from candidate_user where email=$1", [e2])).rows[0].id;
    const cl = await pools.candidate.connect();
    try { await cl.query("begin"); await cl.query("update candidate_user set deleted_at=now() where id=$1", [uid]); await cl.query("delete from candidate_session where user_id=$1", [uid]); await cl.query("commit"); } finally { cl.release(); }
    const after = await call("candidate", "get-session", null, s.cookie), again = await call("candidate", "sign-in/email", { email: e2, password: pw("del") });
    rec(s.status === 200 && !after.json?.user && again.status === 403, `first ${s.status}, session after ${after.json?.user?.email ?? "none"}, sign-in ${again.status}`);
  });
  // 6. the database rate limit store
  const bad = { email: "nobody@example.test", password: "Wrong-password-123456" };
  const ip = freshIp();
  it("rate limit: 5 sign-in tries per minute per address, then 429 (storage: database)", async () => {
    const seq = [];
    for (let i = 0; i < 7; i++) seq.push((await call("candidate", "sign-in/email", bad, null, ip)).status);
    rec(seq.slice(0, 5).every((s) => s === 401) && seq.slice(5).every((s) => s === 429), seq.join(","));
  });
  it("rate limit row lands in candidate_rate_limit with the lowercase last_request column", async () => {
    const row = (await su.query("select key, count, last_request from candidate_rate_limit where key like $1", [`%${ip}%`])).rows[0];
    rec(row?.count === 5 && Number(row?.last_request) > 0, JSON.stringify(row));
  });
  it("rate limit under 12 parallel requests: exactly 5 get through", async () => {
    const ip2 = freshIp();
    const par = await Promise.all(Array.from({ length: 12 }, () => call("candidate", "sign-in/email", bad, null, ip2)));
    const allowed = par.filter((p) => p.status !== 429).length;
    const row2 = (await su.query("select count from candidate_rate_limit where key like $1", [`%${ip2}%`])).rows[0];
    rec(allowed === 5, `${allowed} got through, ${12 - allowed} got 429, stored count ${row2?.count}`);
  });
  it("rate limit keys on the configured header, so a changing X-Forwarded-For does not get round it", async () => {
    const ip3 = freshIp();
    const spoof = [];
    for (let i = 0; i < 7; i++) spoof.push((await call("candidate", "sign-in/email", bad, null, ip3, { "x-forwarded-for": `203.0.113.${i}` })).status);
    rec(spoof.at(-1) === 429, spoof.join(","));
  });
  it("rate limit: Better Auth deletes old rate-limit rows itself when a window resets", async () => {
    // Better Auth's own pruning: on a window reset it deletes rows older than its longest window
    await su.query("insert into candidate_rate_limit(id, key, count, last_request) values ('old-row', 'old|/sign-in/email', 1, $1)", [Date.now() - 864e5]);
    await su.query("update candidate_rate_limit set last_request = $2 where key like $1", [`%${ip}%`, Date.now() - 120e3]);
    await call("candidate", "sign-in/email", bad, null, ip);
    await new Promise((f) => setTimeout(f, 300));
    const old = (await su.query("select count(*)::int n from candidate_rate_limit where id='old-row'")).rows[0].n;
    rec(old === 0, `old row ${old ? "still there" : "deleted"}`);
  });
  it("rate limit rows also land in portal_rate_limit and staff_rate_limit", async () => {
    const portalRl = (await su.query("select count(*)::int n from portal_rate_limit")).rows[0].n, staffRl = (await su.query("select count(*)::int n from staff_rate_limit")).rows[0].n;
    rec(portalRl > 0 && staffRl > 0, `portal ${portalRl}, staff ${staffRl}`);
  });
  // 7. column names and the portal role
  it("every column is lowercase, including last_request in the three rate-limit tables", async () => {
    const camel = (await su.query("select table_name||'.'||column_name c from information_schema.columns where table_schema='public' and column_name<>lower(column_name)")).rows.map((r) => r.c);
    rec(camel.length === 0, camel.join(", ") || "none");
  });
  it("portal role cannot read candidate_user", async () => {
    const r = await pools.portal.query("select email from candidate_user limit 1").then(() => "read it", (e) => e.message);
    rec(r.includes("permission denied"), r);
  });
  it("signed-out session stops working", async () => {
    const e3 = "signout@example.test";
    await call("candidate", "sign-up/email", { email: e3, password: pw("so"), name: "So" });
    const link = mail.filter((m) => m.pool === "candidate" && m.email === e3).at(-1); await call("candidate", `verify-email?${new URL(link.url).searchParams.toString()}`);
    const s = await call("candidate", "sign-in/email", { email: e3, password: pw("so") });
    const o = await call("candidate", "sign-out", {}, s.cookie); const a = await call("candidate", "get-session", null, s.cookie);
    rec(o.status === 200 && !a.json?.user, `sign-out ${o.status}`);
  });
  // 8. cost: every signed-in page pays for one getSession, so its statement count has a budget
  it("getSession on a signed-in request costs at most 2 statements (4 on an instance's first request)", async () => {
    const e4 = "counted@example.test";
    await call("candidate", "sign-up/email", { email: e4, password: pw("ct"), name: "Ct" });
    const link = mail.filter((m) => m.pool === "candidate" && m.email === e4).at(-1); await call("candidate", `verify-email?${new URL(link.url).searchParams.toString()}`);
    const s = await call("candidate", "sign-in/email", { email: e4, password: pw("ct") });
    const counting = new pg.Pool({ connectionString: urlFor(db.name, "app_candidate"), max: 1 });
    let n = 0;
    counting.on("connect", (c) => { const q = c.query.bind(c); c.query = (...a) => { n++; return q(...a); }; });
    try {
      const counted = makeAuth("candidate", counting);
      const get = () => counted.api.getSession({ headers: new Headers({ cookie: s.cookie }) });
      const first = await get(), nFirst = n;
      n = 0;
      const next = await get();
      rec(first?.user?.email === e4 && next?.user?.email === e4 && nFirst <= SESSION_SQL_BUDGET.first && n <= SESSION_SQL_BUDGET.next,
        `user ${next?.user?.email ?? "none"}, ${nFirst} then ${n} statements (budget ${SESSION_SQL_BUDGET.first} then ${SESSION_SQL_BUDGET.next})`);
    } finally { await counting.end(); }
  });
});
