/* eslint-disable */
// @ts-nocheck
// Ported from schema-trial-3/30-two-person.mjs (test C2), close to as written. One `it` per trial check, same names.
// Run against the migrations, which already hold C2's fixes.
import { afterAll } from "vitest";
import { createTestDb, urlFor } from "./db";
import pg from "pg";
import { setup } from "./trial-compat";
import { known } from "./two-person-known";

const db = await createTestDb();
afterAll(() => db.drop());
const url = (role) => urlFor(db.name, role);
const DB = db.name;
const { P, su, id, R, line, rule, F } = setup(db, known);
// Test C2: the two-person rule (#104), staff identity, strikes and appeals (#44, #134, #135, #136), grants, #132.
// Usage: ./node.sh 30-two-person.mjs c2 [sections e.g. 1,2,3]   Every test runs as the real role. Fixtures that need the superuser say so.
// "must do" = ok step, "must not" = refuse step with the stated reason. Fixtures are fresh per test so a hole used in one test cannot help the next.
const RUN = Date.now().toString(36);
const DAY = 864e5, ago = (d) => new Date(Date.now() - d * DAY), ahead = (d) => new Date(Date.now() + d * DAY);

// ---- helpers: run as a role in one transaction, with the acting staff id set local
async function as(role, staff, fn) {
  const cl = await P[role].connect();
  try {
    await cl.query("begin");
    if (staff !== undefined && staff !== null) await cl.query("select set_config('app.staff_user_id', $1, true)", [staff]);
    const r = await fn((s, a) => cl.query(s, a));
    await cl.query("commit"); return r;
  } catch (e) { await cl.query("rollback").catch(() => {}); throw e; } finally { cl.release(); }
}
const q1 = async (role, staff, sql, args = []) => (await as(role, staff, (q) => q(sql, args))).rows[0];
const run = (role, staff, sql, args = []) => as(role, staff, (q) => q(sql, args));
const must = (c, m) => { if (!c) throw new Error("check failed: " + m); };
const near = (a, b, s = 5) => Math.abs(new Date(a) - new Date(b)) < s * 1000;

// ---- people: A, B administrators and C trust and safety and D account reviewer (seeded by the owner), E a login with no role
const S = {};
async function people() {
  for (const k of ["A", "B", "C", "D", "E"]) S[k] = await F.staff();
  await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,'administrator',true),($2,'administrator',true),($1,'trust_and_safety',true),($2,'trust_and_safety',true),($3,'trust_and_safety',true),($4,'account_reviewer',true)", [S.A, S.B, S.C, S.D]);
  S.X = await F.staff(); await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,'administrator',true)", [S.X]);
  await su("update staff_user set status='disabled' where id=$1", [S.X]); // holds a role but is disabled
}
let croN = 700000 + Math.floor(Math.random() * 90000);
const mkOrg = async (o = {}) => { const cro = o.cro === null ? null : String(++croN); const oid = await F.org({ cro, status: o.status || "verified" }); return { id: oid, cro }; };
const mkStrike = async (org, o = {}, by = S.A) => {
  const c = { organisation_id: org, case_kind: o.kind || "false_claim", reason_code: o.reason || "false_sponsorship", stage: o.stage || "decided", appeal_due_at: o.appeal_due === undefined ? ahead(6) : o.appeal_due, ...(o.extra || {}) };
  const k = Object.keys(c); return (await q1("app_admin", by, `insert into strike(${k}) values(${k.map((_, i) => "$" + (i + 1))}) returning id`, k.map((x) => c[x]))).id;
};
const reqP = async (kind, table, target, by = S.A, change = null) => (await q1("app_admin", by, "insert into approval_request(kind,target_table,target_id,change) values($1,$2,$3,$4) returning id", [kind, table, String(target), change ? JSON.stringify(change) : null])).id;
const confirm = (rid, by = S.B) => run("app_admin", by, "update approval_request set status='confirmed' where id=$1", [rid]);
const reqC = async (kind, table, target, prop = S.A, conf = S.B, change = null) => { const r = await reqP(kind, table, target, prop, change); await confirm(r, conf); return r; };
// strike 2 applied in one transaction by `by`
const applyS2 = (org, strike, req, by = S.A) => as("app_admin", by, async (q) => {
  await q("update strike set outcome='strike', level=2, approval_request_id=$2 where id=$1", [strike, req]);
  await q("update organisation set restricted_until = now() + interval '90 days' where id=$1", [org]);
  await q("update organisation set status='verified_restricted' where id=$1", [org]);
});
// strike 3 and ban applied in one transaction
const applyS3 = (org, strike, req, cro, by = S.A) => as("app_admin", by, async (q) => {
  await q("update strike set outcome='strike', level=3, approval_request_id=$2 where id=$1", [strike, req]);
  const b = (await q("insert into ban(cro_number, reason_code, strike_id, approval_request_id) values ($1,'strike_3',$2,$3) returning id", [cro, strike, req])).rows[0].id;
  await q("update organisation set claims_removed_at = now() where id=$1", [org]);
  await q("update organisation set status='banned' where id=$1", [org]);
  return b;
});
// a verified organisation that is mid-strike-2 (full legal path)
const s2org = async () => { const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_2", "strike", st); await applyS2(o.id, st, rq); return { ...o, st, rq }; };
// a banned organisation (strike 3 + ban)
const banned = async () => { const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_3", "strike", st); const ban = await applyS3(o.id, st, rq, o.cro); return { ...o, st, rq, ban }; };
const org = (oid) => su("select status, restricted_until, claims_removed_at from organisation where id=$1", [oid]).then((r) => r.rows[0]);
// fixtures that need the superuser to skip a trigger (to move time): run with triggers off for this session only
const replica = async (fn) => { const cl = await P.postgres.connect(); try { await cl.query("set session_replication_role = replica"); return await fn((s, a) => cl.query(s, a)); } finally { await cl.query("reset session_replication_role").catch(() => {}); cl.release(); } };

const sections = {};
// =====================================================================================================================================
sections[1] = async () => {
  const t = "approval_request";
  await rule(t, "must do: a proposal is born pending, proposer stamped from the acting id, nothing else set", { ok: async () => {
    const r = await q1("app_admin", S.A, "insert into approval_request(kind,target_table,target_id,reason) values ('ban','strike','" + RUN + "-1001','r') returning status, proposed_by_staff_user_id p, confirmed_by_staff_user_id c, decided_at, applied_at");
    must(r.status === "pending" && r.p === S.A && r.c === null && r.decided_at === null && r.applied_at === null, JSON.stringify(r)); } });
  await rule(t, "must not: app_admin names status, proposer or confirmer on insert (column grant)", { refuse: () => run("app_admin", S.A, "insert into approval_request(kind,target_table,target_id,status,confirmed_by_staff_user_id) values ('ban','strike','" + RUN + "-1002','confirmed',$1)", [S.B]), expect: "permission denied" });
  await rule(t, "must not: app_admin names proposed_by_staff_user_id (another person's name)", { refuse: () => run("app_admin", S.A, "insert into approval_request(kind,target_table,target_id,proposed_by_staff_user_id) values ('ban','strike','" + RUN + "-1003',$1)", [S.B]), expect: "permission denied" });
  await rule(t, "must not: even the owner cannot insert a born-confirmed request (trigger rewrites it to pending)", { ok: async () => {
    const r = await q1("portal_owner", S.A, "insert into approval_request(kind,target_table,target_id,status,proposed_by_staff_user_id,confirmed_by_staff_user_id,decided_at,applied_at) values ('ban','strike','" + RUN + "-1004','confirmed',$1,$2,now(),now()) returning status, proposed_by_staff_user_id p, confirmed_by_staff_user_id c, decided_at, applied_at",[S.B, S.A]);
    must(r.status === "pending" && r.p === S.A && r.c === null && r.decided_at === null && r.applied_at === null, JSON.stringify(r)); } });
  await rule(t, "must not: a proposal with no acting staff id", { refuse: () => run("app_admin", null, "insert into approval_request(kind,target_table,target_id) values ('ban','strike','" + RUN + "-1005')"), expect: "no acting staff" });
  await rule(t, "must not: a proposal from a staff login that holds no role (a second login)", { refuse: () => run("app_admin", S.E, "insert into approval_request(kind,target_table,target_id) values ('ban','strike','" + RUN + "-1006')"), expect: "holds no role" });
  await rule(t, "must not: a proposal from a disabled login that still holds a role", { refuse: () => run("app_admin", S.X, "insert into approval_request(kind,target_table,target_id) values ('ban','strike','" + RUN + "-1007')"), expect: "no acting staff" });
  await rule(t, "must not: a proposal naming an id that is no staff_user", { refuse: () => run("app_admin", "nobody", "insert into approval_request(kind,target_table,target_id) values ('ban','strike','" + RUN + "-1008')"), expect: "no acting staff" });
  await rule(t, "must not: an empty acting id (reused pooled connection)", { refuse: () => run("app_admin", "", "insert into approval_request(kind,target_table,target_id) values ('ban','strike','" + RUN + "-1009')"), expect: "no acting staff" });

  // no self-confirm
  const mk = () => reqP("ban", "strike", 2000 + Math.floor(Math.random() * 1e6), S.A);
  await rule(t, "no self-confirm: the proposer confirms own request", { refuse: async () => run("app_admin", S.A, "update approval_request set status='confirmed' where id=$1", [await mk()]), expect: "check constraint" });
  await rule(t, "no self-confirm: the proposer refuses own request", { refuse: async () => run("app_admin", S.A, "update approval_request set status='refused' where id=$1", [await mk()]), expect: "check constraint" });
  await rule(t, "must do: a different person confirms, stamped with their id and the time", { ok: async () => {
    const r = await mk(); await confirm(r, S.B); const x = await q1("app_admin", S.B, "select status, confirmed_by_staff_user_id c, decided_at from approval_request where id=$1", [r]);
    must(x.status === "confirmed" && x.c === S.B && x.decided_at, JSON.stringify(x)); } });
  await rule(t, "must not: a confirm with no acting id", { refuse: async () => run("app_admin", null, "update approval_request set status='confirmed' where id=$1", [await mk()]), expect: "no acting staff" });
  await rule(t, "must not: a confirm by a login that holds no role", { refuse: async () => run("app_admin", S.E, "update approval_request set status='confirmed' where id=$1", [await mk()]), expect: "holds no role" });
  await rule(t, "must not: app_admin writes confirmed_by_staff_user_id (names another person as confirmer)", { refuse: async () => run("app_admin", S.A, "update approval_request set confirmed_by_staff_user_id=$2 where id=$1", [await mk(), S.B]), expect: "permission denied" });

  // moving a decided request
  const refusedReq = async () => { const r = await mk(); await run("app_admin", S.B, "update approval_request set status='refused' where id=$1", [r]); return r; };
  await rule(t, "must do: pending to refused by another person stamps them; pending to withdrawn needs an acting id (PICK 4)", { ok: async () => {
    const r = await refusedReq(); const x = await q1("app_admin", S.B, "select status, confirmed_by_staff_user_id c from approval_request where id=$1", [r]); must(x.status === "refused" && x.c === S.B, JSON.stringify(x));
    const w = await mk(); await run("app_admin", S.A, "update approval_request set status='withdrawn' where id=$1", [w]);
    const n = await mk(); let refused = false; try { await run("app_admin", null, "update approval_request set status='withdrawn' where id=$1", [n]); } catch (e) { refused = /no acting staff/.test(String(e.message)); } must(refused, "a withdraw with no acting id was not refused"); } });
  await rule(t, "must not: the proposer turns a request the other person REFUSED into confirmed (RECHECK-2 failure 2)", { refuse: async () => run("app_admin", S.A, "update approval_request set status='confirmed' where id=$1", [await refusedReq()]), expect: "status changes only from pending" });
  await rule(t, "must not: the refuser turns it to confirmed", { refuse: async () => run("app_admin", S.B, "update approval_request set status='confirmed' where id=$1", [await refusedReq()]), expect: "status changes only from pending" });
  await rule(t, "must not: a withdrawn request becomes confirmed", { refuse: async () => { const r = await mk(); await run("app_admin", S.A, "update approval_request set status='withdrawn' where id=$1", [r]); await confirm(r, S.B); }, expect: "status changes only from pending" });
  await rule(t, "must not: a confirmed request goes back to pending", { refuse: async () => { const r = await mk(); await confirm(r); await run("app_admin", S.B, "update approval_request set status='pending' where id=$1", [r]); }, expect: "status changes only from pending" });
  await rule(t, "must not: a confirmed request is withdrawn (frees nothing, but is not allowed)", { refuse: async () => { const r = await mk(); await confirm(r); await run("app_admin", S.A, "update approval_request set status='withdrawn' where id=$1", [r]); }, expect: "status changes only from pending" });
  await rule(t, "must not: a refused request is refused again by the proposer's partner then confirmed through a second person C", { refuse: async () => run("app_admin", S.C, "update approval_request set status='confirmed' where id=$1", [await refusedReq()]), expect: "status changes only from pending" });

  // applied once
  await rule(t, "applied once: app_admin cannot write applied_at (column grant)", { refuse: async () => run("app_admin", S.A, "update approval_request set applied_at = now() where id=$1", [await mk()]), expect: "permission denied" });
  await rule(t, "applied once: the owner cannot empty applied_at on a used request, nor move it", { refuse: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_2", "strike", st); await applyS2(o.id, st, rq);
    await run("portal_owner", S.A, "update approval_request set applied_at = null where id=$1", [rq]); }, expect: "applied_at changes once" });
  await rule(t, "applied once: the owner cannot set a later applied_at on a used request", { refuse: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_2", "strike", st); await applyS2(o.id, st, rq);
    await run("portal_owner", S.A, "update approval_request set applied_at = now() where id=$1", [rq]); }, expect: "applied_at changes once" });
  await rule(t, "applied once: a used strike_2 request is used again on a second strike case", { refuse: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_2", "strike", st); await applyS2(o.id, st, rq);
    const st2 = await mkStrike(o.id); await run("app_admin", S.A, "update strike set outcome='strike', level=2, approval_request_id=$2 where id=$1", [st2, rq]); }, expect: "two-person rule" });
  await rule(t, "applied once: a used request cannot be applied again to the same case by changing level and back", { refuse: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_2", "strike", st); await applyS2(o.id, st, rq);
    await run("app_admin", S.A, "update strike set level=1 where id=$1", [st]);
    await run("app_admin", S.A, "update strike set level=2 where id=$1", [st]); }, expect: "already used" });
  // request must match
  const lvl2 = async (kind, makeTarget, status = "confirmed") => { const o = await mkOrg(); const st = await mkStrike(o.id); const tgt = makeTarget ? await makeTarget(o) : st;
    const r = await reqP(kind, "strike", tgt, S.A); if (status === "confirmed") await confirm(r); else if (status === "refused") await run("app_admin", S.B, "update approval_request set status='refused' where id=$1", [r]); else if (status === "withdrawn") await run("app_admin", S.A, "update approval_request set status='withdrawn' where id=$1", [r]);
    return () => run("app_admin", S.A, "update strike set outcome='strike', level=2, approval_request_id=$2 where id=$1", [st, r]); };
  await rule("strike", "strike 2 must not: a pending request", { refuse: async () => (await lvl2("strike_2", null, "pending"))(), expect: "is pending, not confirmed" });
  await rule("strike", "strike 2 must not: a refused request", { refuse: async () => (await lvl2("strike_2", null, "refused"))(), expect: "is refused, not confirmed" });
  await rule("strike", "strike 2 must not: a withdrawn request", { refuse: async () => (await lvl2("strike_2", null, "withdrawn"))(), expect: "is withdrawn, not confirmed" });
  await rule("strike", "strike 2 must not: a confirmed request of the wrong kind (ban)", { refuse: async () => (await lvl2("ban"))(), expect: "needs strike_2" });
  await rule("strike", "strike 2 must not: a confirmed request for another case", { refuse: async () => (await lvl2("strike_2", async () => 999999))(), expect: "is for" });
  await rule("strike", "strike 2 must not: no request at all (CHECK)", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id); await run("app_admin", S.A, "update strike set outcome='strike', level=2 where id=$1", [st]); }, expect: "two-person rule" }); // wording fixed after run 1: the approval trigger refuses before the CHECK is reached; both are a refusal
  await rule("strike", "strike 2 must not: inserted born at level 2 with a request that is not confirmed", { refuse: async () => { const o = await mkOrg(); const r = await reqP("strike_2", "strike", RUN + "-r1"); await mkStrike(o.id, { extra: { outcome: "strike", level: 2, approval_request_id: r } }); }, expect: "two-person rule" });
};

// =====================================================================================================================================
sections[2] = async () => {
  // ---------- strike 2 (#44, #104)
  await rule("strike", "strike 2 must do: confirmed by B, applied by A in one transaction: restricted_until = applied_at + 90 days, status verified_restricted, decided_by A", { ok: async () => {
    const o = await s2org(); const x = await org(o.id); const s = await q1("app_admin", S.A, "select decided_by_staff_user_id d, a.applied_at from strike s join approval_request a on a.id=s.approval_request_id where s.id=$1", [o.st]);
    must(x.status === "verified_restricted" && s.d === S.A && near(x.restricted_until, new Date(+new Date(s.applied_at) + 90 * DAY)), JSON.stringify({ x, s })); } });
  await rule("organisation", "strike 2 must not: restricted_until set with no strike 2 case at all", { refuse: async () => { const o = await mkOrg(); await run("app_admin", S.A, "update organisation set restricted_until = now() + interval '90 days' where id=$1", [o.id]); }, expect: "only in the transaction" });
  await rule("organisation", "strike 2 must not: restricted_until set the day after, in a later transaction (the old request's applied_at is not now())", { refuse: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_2", "strike", st);
    await run("app_admin", S.A, "update strike set outcome='strike', level=2, approval_request_id=$2 where id=$1", [st, rq]);
    await run("app_admin", S.A, "update organisation set restricted_until = now() + interval '90 days' where id=$1", [o.id]); }, expect: "only in the transaction" });
  await rule("organisation", "strike 2 must not: 89 days instead of applied_at + 90", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_2", "strike", st);
    await as("app_admin", S.A, async (q) => { await q("update strike set outcome='strike', level=2, approval_request_id=$2 where id=$1", [st, rq]); await q("update organisation set restricted_until = now() + interval '89 days' where id=$1", [o.id]); }); }, expect: "applied_at plus 90" });
  await rule("organisation", "strike 2 must not: 3650 days instead of 90 in the applying transaction", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_2", "strike", st);
    await as("app_admin", S.A, async (q) => { await q("update strike set outcome='strike', level=2, approval_request_id=$2 where id=$1", [st, rq]); await q("update organisation set restricted_until = now() + interval '3650 days' where id=$1", [o.id]); }); }, expect: "applied_at plus 90" });
  await rule("organisation", "strike 2 must not: a second organisation restricted with the first case's request", { refuse: async () => { const o = await mkOrg(); const o2 = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_2", "strike", st);
    await as("app_admin", S.A, async (q) => { await q("update strike set outcome='strike', level=2, approval_request_id=$2 where id=$1", [st, rq]); await q("update organisation set restricted_until = now() + interval '90 days' where id=$1", [o2.id]); }); }, expect: "only in the transaction" });
  await rule("organisation", "strike 2 must not: restricted_until moved later on a running restriction (to 2099)", { refuse: async () => { const o = await s2org(); await run("app_admin", S.A, "update organisation set restricted_until = '2099-01-01' where id=$1", [o.id]); }, expect: "never changes once set" });
  await rule("organisation", "strike 2 must not: restricted_until moved earlier by one person", { refuse: async () => { const o = await s2org(); await run("app_admin", S.A, "update organisation set restricted_until = now() + interval '1 day' where id=$1", [o.id]); }, expect: "never changes once set" });
  await rule("organisation", "strike 2 must not: restricted_until cleared with no overturned case", { refuse: async () => { const o = await s2org(); await run("app_admin", S.A, "update organisation set restricted_until = null where id=$1", [o.id]); }, expect: "only when its strike 2 case is overturned" });
  await rule("organisation", "strike 2 must not: verified_restricted back to verified before the 90 days pass", { refuse: async () => { const o = await s2org(); await run("app_admin", S.A, "update organisation set status='verified' where id=$1", [o.id]); }, expect: "has not passed" });

  // ---------- strike 3 and ban
  await rule("strike", "strike 3 must do: confirmed, applied with the ban row, claims_removed_at = applied_at, organisation banned", { ok: async () => {
    const b = await banned(); const x = await org(b.id); const a = await q1("app_admin", S.A, "select applied_at from approval_request where id=$1", [b.rq]);
    must(x.status === "banned" && near(x.claims_removed_at, a.applied_at), JSON.stringify(x)); } });
  await rule("strike", "strike 3 must not: outcome strike level 3 with a strike_2 request", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_2", "strike", st); await run("app_admin", S.A, "update strike set outcome='strike', level=3, approval_request_id=$2 where id=$1", [st, rq]); }, expect: "needs strike_3" });
  await rule("strike", "strike 3 must not: one person (proposer) is also the confirmer", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id); const r = await reqP("strike_3", "strike", st, S.C); await run("app_admin", S.C, "update approval_request set status='confirmed' where id=$1", [r]); }, expect: "check constraint" });
  await rule("organisation", "strike 3 must not: claims_removed_at set with no strike 3 case", { refuse: async () => { const o = await mkOrg(); await run("app_admin", S.A, "update organisation set claims_removed_at = now() where id=$1", [o.id]); }, expect: "only in the transaction" });
  await rule("organisation", "strike 3 must not: claims_removed_at set a second time on a banned organisation", { refuse: async () => { const b = await banned(); await run("app_admin", S.A, "update organisation set claims_removed_at = now() + interval '1 day' where id=$1", [b.id]); }, expect: "never changes once set" });
  await rule("organisation", "strike 3 must not: claims_removed_at cleared with no overturn and no lifted ban", { refuse: async () => { const b = await banned(); await run("app_admin", S.A, "update organisation set claims_removed_at = null where id=$1", [b.id]); }, expect: "overturned or its ban lifted" });
  await rule("organisation", "ban must not: status banned with no ban row", { refuse: async () => { const o = await mkOrg(); await run("app_admin", S.A, "update organisation set status='banned' where id=$1", [o.id]); }, expect: "banned only while a ban row" });
  await rule("organisation", "ban must not: out of banned while the ban stands", { refuse: async () => { const b = await banned(); await run("app_admin", S.A, "update organisation set status='verified' where id=$1", [b.id]); }, expect: "once no ban row stands" });
  // instant ban
  await rule("ban", "instant ban must do: kind ban, outcome ban, ban row in the applying transaction", { ok: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id, { kind: "instant_ban", reason: "fake_company" }); const rq = await reqC("ban", "strike", st);
    await as("app_admin", S.A, async (q) => { await q("update strike set outcome='ban', approval_request_id=$2 where id=$1", [st, rq]); await q("insert into ban(cro_number,reason_code,strike_id,approval_request_id) values ($1,'fake_company',$2,$3)", [o.cro, st, rq]); await q("update organisation set status='banned' where id=$1", [o.id]); }); } });
  await rule("ban", "ban must not: a ban row for a case that is not decided as ban or level 3 (strike 2 case)", { refuse: async () => { const o = await s2org(); await run("app_admin", S.A, "insert into ban(cro_number,reason_code,strike_id,approval_request_id) values ($1,'strike_3',$2,$3)", [o.cro, o.st, o.rq]); }, expect: "outcome ban or level 3" });
  await rule("ban", "ban must not: a ban row with a different request from the case's", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_3", "strike", st); const other = await reqC("ban", "strike", st);
    await as("app_admin", S.A, async (q) => { await q("update strike set outcome='strike', level=3, approval_request_id=$2 where id=$1", [st, rq]); await q("insert into ban(cro_number,reason_code,strike_id,approval_request_id) values ($1,'strike_3',$2,$3)", [o.cro, st, other]); }); }, expect: "must use the strike case" });
  await rule("ban", "ban must not: a ban row inserted in a later transaction from the case's request (one officer, a day later)", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_3", "strike", st);
    await run("app_admin", S.A, "update strike set outcome='strike', level=3, approval_request_id=$2 where id=$1", [st, rq]);
    await run("app_admin", S.A, "insert into ban(cro_number,reason_code,strike_id,approval_request_id) values ($1,'strike_3',$2,$3)", [o.cro, st, rq]); }, expect: "not applied in this transaction" });
  await rule("ban", "ban must not: app_admin updates a standing ban's CRO (repoint, RECHECK-2 outside A) as app_admin", { refuse: async () => { const b = await banned(); await run("app_admin", S.A, "update ban set cro_number='1' where id=$1", [b.ban]); }, expect: "permission denied" });
  await rule("ban", "ban must not: the owner updates a ban row (trigger refuses every role)", { refuse: async () => { const b = await banned(); await run("portal_owner", S.A, "update ban set cro_number='2' where id=$1", [b.ban]); }, expect: "no role updates a ban" });
  await rule("ban", "ban must not: a superuser update either", { refuse: async () => { const b = await banned(); await run("postgres", S.A, "update ban set email_domain='x.example' where id=$1", [b.ban]); }, expect: "no role updates a ban" });
  await rule("ban", "ban probe: one ban confirmation covers a CRO number that is not the organisation's (the applying officer types the CRO)", { refuse: async () => {
    const o = await mkOrg(); const victim = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_3", "strike", st);
    await as("app_admin", S.A, async (q) => { await q("update strike set outcome='strike', level=3, approval_request_id=$2 where id=$1", [st, rq]); await q("insert into ban(cro_number,reason_code,strike_id,approval_request_id) values ($1,'strike_3',$2,$3)", [victim.cro, st, rq]); }); }, expect: "cro" });
  await rule("ban", "ban probe: a second ban row on the same case in the applying transaction (one confirmation, two bans)", { refuse: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id); const rq = await reqC("strike_3", "strike", st);
    await as("app_admin", S.A, async (q) => { await q("update strike set outcome='strike', level=3, approval_request_id=$2 where id=$1", [st, rq]);
      await q("insert into ban(cro_number,reason_code,strike_id,approval_request_id) values ($1,'strike_3',$2,$3)", [o.cro, st, rq]);
      await q("insert into ban(email_domain,reason_code,strike_id,approval_request_id) values ($1,'strike_3',$2,$3)", [`other-${id("d")}.example`, st, rq]); }); }, expect: "email_domain" }); // expect worded for the planned fix (a domain that is not the organisation's); the unfixed build accepts it either way

  await rule("ban", "ban must do: a ban by the organisation's own email domain (a public body with no CRO number)", { ok: async () => {
    const o = await mkOrg({ cro: null }); const dom = `own-${id("d")}.example`; await su("insert into organisation_domain(organisation_id, domain, source) values ($1,$2,'admin')", [o.id, dom]);
    const st = await mkStrike(o.id); const rq = await reqC("strike_3", "strike", st);
    await as("app_admin", S.A, async (q) => { await q("update strike set outcome='strike', level=3, approval_request_id=$2 where id=$1", [st, rq]); await q("insert into ban(email_domain,reason_code,strike_id,approval_request_id) values ($1,'strike_3',$2,$3)", [dom, st, rq]); }); } });
  // ---------- lifting a ban
  const liftReq = async (b, prop = S.A, conf = S.B) => reqC("ban_lift", "ban", b.ban, prop, conf);
  await rule("ban", "lift must do: confirmed ban_lift by another person, delete stamps strike.ban_lifted_at, organisation can leave banned, claims_removed_at can clear", { ok: async () => {
    const b = await banned(); await liftReq(b); await run("app_admin", S.A, "delete from ban where id=$1", [b.ban]);
    const s = await q1("app_admin", S.A, "select ban_lifted_at from strike where id=$1", [b.st]); must(s.ban_lifted_at, "ban_lifted_at not stamped");
    await as("app_admin", S.A, async (q) => { await q("update organisation set status='verified' where id=$1", [b.id]); await q("update organisation set claims_removed_at = null where id=$1", [b.id]); }); } });
  await rule("ban", "lift must not: delete with no ban_lift request", { refuse: async () => { const b = await banned(); await run("app_admin", S.A, "delete from ban where id=$1", [b.ban]); }, expect: "no confirmed ban_lift" });
  await rule("ban", "lift must not: delete with a pending ban_lift request", { refuse: async () => { const b = await banned(); await reqP("ban_lift", "ban", b.ban, S.A); await run("app_admin", S.A, "delete from ban where id=$1", [b.ban]); }, expect: "no confirmed ban_lift" });
  await rule("ban", "lift must not: delete with a refused ban_lift request", { refuse: async () => { const b = await banned(); const r = await reqP("ban_lift", "ban", b.ban, S.A); await run("app_admin", S.B, "update approval_request set status='refused' where id=$1", [r]); await run("app_admin", S.A, "delete from ban where id=$1", [b.ban]); }, expect: "no confirmed ban_lift" });
  await rule("ban", "lift must not: delete with the ban request that created it (wrong kind)", { refuse: async () => { const b = await banned(); await run("app_admin", S.A, "delete from ban where id=$1", [b.ban]); }, expect: "no confirmed ban_lift" });
  await rule("ban", "lift must not: another ban's lift request", { refuse: async () => { const b = await banned(); const b2 = await banned(); await liftReq(b2); await run("app_admin", S.A, "delete from ban where id=$1", [b.ban]); }, expect: "no confirmed ban_lift" });
  await rule("ban", "lift must not: delete with no acting staff id is still a two-person lift, so the lift itself needs the confirmer to hold a role", { refuse: async () => { const b = await banned(); await reqP("ban_lift", "ban", b.ban, S.A); await run("app_admin", S.E, "update approval_request set status='confirmed' where target_table='ban' and target_id=$1", [String(b.ban)]); }, expect: "holds no role" });
  await rule("ban", "lift must not: re-insert the same ban after the lift (one officer undoing a two-person lift)", { refuse: async () => {
    const b = await banned(); await liftReq(b); await run("app_admin", S.A, "delete from ban where id=$1", [b.ban]);
    await run("app_admin", S.A, "insert into ban(cro_number,reason_code,strike_id,approval_request_id) values ($1,'strike_3',$2,$3)", [b.cro, b.st, b.rq]); }, expect: "not applied in this transaction" });
  await rule("organisation", "lift must not: set status banned again after the lift (no ban row)", { refuse: async () => {
    const b = await banned(); await liftReq(b); await run("app_admin", S.A, "delete from ban where id=$1", [b.ban]);
    await as("app_admin", S.A, async (q) => { await q("update organisation set status='verified' where id=$1", [b.id]); await q("update organisation set status='banned' where id=$1", [b.id]); }); }, expect: "banned only while a ban row" });
  await rule("strike", "lift must not: write ban_lifted_at by hand to start the evidence clock (column grant)", { refuse: async () => { const b = await banned(); await run("app_admin", S.A, "update strike set ban_lifted_at = now() where id=$1", [b.st]); }, expect: "permission denied" });
  await rule("ban", "lift must do: the lift request is marked applied (used once) by the delete", { ok: async () => {
    const b = await banned(); const r = await liftReq(b); await run("app_admin", S.A, "delete from ban where id=$1", [b.ban]);
    const x = await q1("app_admin", S.A, "select applied_at from approval_request where id=$1", [r]); must(x.applied_at, "applied_at empty"); } });
};

// ---- job helpers (portal side)
let jobSrc;
const getSrc = async () => (await q1("app_fetcher", null, "insert into job_source(kind, board) values ('employer','portal') on conflict (kind, board) do update set kind = excluded.kind returning id")).id;
const portalJob = async (orgId, o = {}) => {
  jobSrc ??= await getSrc();
  return (await q1("app_portal", null, `insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status${o.pay === false ? "" : ", salary_low"}) values ($1,'employer',$2,'Job','Acme','x','general', now() + interval '5 days','https://acme.test/j','draft'${o.pay === false ? "" : ", 1"}) returning id`, [orgId, jobSrc])).id;
};
const goLive = (jid) => q1("app_portal", null, "update job set status='live', search_vector = to_tsvector('x') where id=$1 returning status, posted_at", [jid]);
// restricted_until in the past (time has passed): superuser fixture with triggers off, after a full legal strike 2
const aged = async () => { const o = await s2org(); await replica((q) => q("update organisation set restricted_until = now() - interval '1 day' where id=$1", [o.id])); return o; };
const ipart = (o) => o.slice(0, 0);

// =====================================================================================================================================
sections[3] = async () => {
  // ---------- the strike 2 clock (#44) and its end
  await rule("organisation", "clock must do: 90 days passed, back to verified", { ok: async () => { const o = await aged(); await run("app_admin", S.A, "update organisation set status='verified' where id=$1", [o.id]); must((await org(o.id)).status === "verified", "status"); } });
  await rule("organisation", "clock must not: a new restricted_until set on an organisation whose old one has passed (8 months later, one officer)", { refuse: async () => { const o = await aged(); await run("app_admin", S.A, "update organisation set restricted_until = now() + interval '365 days' where id=$1", [o.id]); }, expect: "organisation: restricted_until" }); // expect widened before any fix: after the planned fix this same refusal comes from the request check, not the never-changes check
  await rule("organisation", "clock must do: a NEW, confirmed strike 2 (14 months after the first, whose 90 days passed) sets restricted_until again", { ok: async () => {
    const o = await aged(); const st = await mkStrike(o.id); const rq = await reqC("strike_2", "strike", st); await applyS2(o.id, st, rq);
    const x = await org(o.id); must(x.status === "verified_restricted" && new Date(x.restricted_until) > new Date(), JSON.stringify(x)); } });
  await rule("organisation", "clock must not: verified_restricted on an organisation with no running restriction", { refuse: async () => { const o = await mkOrg(); await run("app_admin", S.A, "update organisation set status='verified_restricted' where id=$1", [o.id]); }, expect: "verified_restricted only while" });
  await rule("job", "clock must do: while restricted a draft sent live goes to in_review; a post_strike_job_review item is queued", { ok: async () => {
    const o = await s2org(); const j = await portalJob(o.id); const r = await goLive(j); const rq = await q1("app_admin", S.A, "select queue from review_item where job_id=$1", [j]);
    must(r.status === "in_review" && rq?.queue === "post_strike_job_review", JSON.stringify({ r, rq })); } });
  await rule("job", "clock must not: sponsor_confirmed badge while restricted", { refuse: async () => { const o = await s2org(); const j = await portalJob(o.id); await run("app_portal", null, "update job set badge='sponsor_confirmed' where id=$1", [j]); }, expect: "restricted" });
  await rule("job", "clock must do: once the 90 days passed a draft goes straight to live and the badge is allowed again (review ends with the badge, #44)", { ok: async () => {
    const o = await aged(); const j = await portalJob(o.id); await run("app_portal", null, "update job set badge='sponsor_confirmed' where id=$1", [j]); // test wording fixed after run 1: a live job with the badge also needs a sponsorship statement (deferred check), so the badge is set on the draft
    const j2 = await portalJob(o.id); const r = await goLive(j2); must(r.status === "live", "status " + r.status); } });
  await rule("job", "clock must not: the portal moves a job to live from in_review itself (to dodge the review)", { refuse: async () => { const o = await s2org(); const j = await portalJob(o.id); await goLive(j); await run("app_portal", null, "update job set status='live' where id=$1", [j]); }, expect: "may not move" });
  await rule("organisation", "clock must not: nothing changes the badge of the restricted company's jobs by hand to sponsor_confirmed via app_admin on a job of a restricted company", { refuse: async () => { const o = await s2org(); const j = await portalJob(o.id); await run("app_admin", S.A, "update job set badge='sponsor_confirmed' where id=$1", [j]); }, expect: "restricted" });

  // ---------- overturn (#134): one staff member, not a second confirmation
  const portalAppeal = (st) => run("portal_owner", null, "update strike set appeal_text='unfair' where id=$1", [st]); // 0017: the portal appeals through private.status_write, which runs as portal_owner
  await rule("strike", "overturn must do: employer appeals in the portal, a different person (C) overturns alone; restricted_until clears; back to verified", { ok: async () => {
    const o = await s2org(); await portalAppeal(o.st); await run("app_admin", S.C, "update strike set stage='overturned' where id=$1", [o.st]);
    const s = await q1("app_admin", S.C, "select appeal_decided_by_staff_user_id d, appealed_at, appeal_entered_by_staff_user_id e from strike where id=$1", [o.st]);
    must(s.d === S.C && s.appealed_at && s.e === null, JSON.stringify(s));
    must((await org(o.id)).restricted_until === null, "restricted_until still set");
    await run("app_admin", S.A, "update organisation set status='verified' where id=$1", [o.id]); } });
  await rule("strike", "overturn must not: the original decider overturns own decision", { refuse: async () => { const o = await s2org(); await portalAppeal(o.st); await run("app_admin", S.A, "update strike set stage='overturned' where id=$1", [o.st]); }, expect: "check constraint" });
  await rule("strike", "overturn must not: no appeal on record (one officer ends strike 2 early, CHECK-FIXES 1)", { refuse: async () => { const o = await s2org(); await run("app_admin", S.C, "update strike set stage='overturned' where id=$1", [o.st]); }, expect: "check constraint" });
  await rule("strike", "overturn must not: no appeal on record, upheld", { refuse: async () => { const o = await s2org(); await run("app_admin", S.C, "update strike set stage='upheld' where id=$1", [o.st]); }, expect: "check constraint" });
  await rule("strike", "overturn must not: appealed_at written by hand to fake an appeal (column grant)", { refuse: async () => { const o = await s2org(); await run("app_admin", S.C, "update strike set appealed_at = now(), stage='overturned' where id=$1", [o.st]); }, expect: "permission denied" });
  await rule("strike", "overturn must not: appeal_decided_by written by hand (column grant)", { refuse: async () => { const o = await s2org(); await portalAppeal(o.st); await run("app_admin", S.C, "update strike set appeal_decided_by_staff_user_id=$2, stage='overturned' where id=$1", [o.st, S.D]); }, expect: "permission denied" });
  await rule("strike", "overturn must not: the appeal decision is changed later (upheld to overturned by the first decider)", { refuse: async () => { const o = await s2org(); await portalAppeal(o.st); await run("app_admin", S.C, "update strike set stage='upheld' where id=$1", [o.st]); await run("app_admin", S.A, "update strike set stage='overturned' where id=$1", [o.st]); }, expect: "never moves out" });
  await rule("strike", "overturn must not: outcome changed after the appeal is decided", { refuse: async () => { const o = await s2org(); await portalAppeal(o.st); await run("app_admin", S.C, "update strike set stage='upheld' where id=$1", [o.st]); await run("app_admin", S.A, "update strike set outcome='cleared', level=null where id=$1", [o.st]); }, expect: "frozen" });
  await rule("strike", "upheld must do: restricted_until stays after an upheld appeal and still cannot be cleared by one person", { refuse: async () => { const o = await s2org(); await portalAppeal(o.st); await run("app_admin", S.C, "update strike set stage='upheld' where id=$1", [o.st]); must((await org(o.id)).restricted_until, "cleared by upheld"); await run("app_admin", S.A, "update organisation set restricted_until=null where id=$1", [o.id]); }, expect: "only when its strike 2 case is overturned" });
  await rule("strike", "overturn probe: a later strike 2 on an organisation whose earlier strike 2 was overturned: one officer clears the running restriction", { refuse: async () => {
    const o = await mkOrg(); const st1 = await mkStrike(o.id); const r1 = await reqC("strike_2", "strike", st1); await applyS2(o.id, st1, r1);
    await portalAppeal(st1); await run("app_admin", S.C, "update strike set stage='overturned' where id=$1", [st1]); await run("app_admin", S.A, "update organisation set status='verified' where id=$1", [o.id]);
    const st2 = await mkStrike(o.id); const r2 = await reqC("strike_2", "strike", st2); await applyS2(o.id, st2, r2);
    must((await org(o.id)).restricted_until, "second strike 2 not applied");
    await run("app_admin", S.A, "update organisation set restricted_until=null where id=$1", [o.id]); }, expect: "only when its strike 2 case is overturned" });
  await rule("strike", "overturn must do: strike 3 overturned on appeal by one person clears claims_removed_at; the ban row stays until a confirmed ban_lift (#134)", { ok: async () => {
    const b = await banned(); await portalAppeal(b.st); await run("app_admin", S.C, "update strike set stage='overturned' where id=$1", [b.st]);
    const x = await org(b.id); const bn = await su("select 1 from ban where id=$1", [b.ban]);
    must(x.claims_removed_at === null && x.status === "banned" && bn.rowCount === 1, JSON.stringify({ x, ban: bn.rowCount })); } });
  await rule("strike", "decider stamp: a later change of outcome by another person re-stamps decided_by (RECHECK-2 failure 4), so that person cannot decide the appeal", { refuse: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id, { extra: { outcome: "cleared" } }, S.B);
    await run("app_admin", S.A, "update strike set outcome='strike', level=1 where id=$1", [st]);
    const d = await q1("app_admin", S.A, "select decided_by_staff_user_id d from strike where id=$1", [st]); must(d.d === S.A, "decided_by is " + d.d);
    await portalAppeal(st); await run("app_admin", S.A, "update strike set stage='overturned' where id=$1", [st]); }, expect: "check constraint" });
  await rule("strike", "decider stamp: decided_by is stamped on insert from the acting id, never from input (column grant)", { refuse: async () => { const o = await mkOrg(); await run("app_admin", S.A, "insert into strike(organisation_id,case_kind,reason_code,decided_by_staff_user_id) values ($1,'false_claim','false_sponsorship',$2)", [o.id, S.B]); }, expect: "permission denied" });

  // ---------- employer appeal in the portal and the staff-entered appeal (#135)
  await rule("strike", "portal appeal must do: before appeal_due_at; appealed_at stamped; no staff id; received date empty", { ok: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: ahead(3) }); await portalAppeal(st);
    const s = await q1("app_admin", S.A, "select appealed_at, appeal_entered_by_staff_user_id e, appeal_received_at r from strike where id=$1", [st]); must(s.appealed_at && s.e === null && s.r === null, JSON.stringify(s)); } });
  await rule("strike", "portal appeal must not: after appeal_due_at", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: ago(1) }); await run("app_portal", null, "update strike set appeal_text='unfair' where id=$1", [st]); }, expect: "permission denied" }); // 0017: no direct write; status_write checks the window
  await rule("strike", "portal appeal must not: appeal_due_at is empty", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: null }); await run("app_portal", null, "update strike set appeal_text='unfair' where id=$1", [st]); }, expect: "permission denied" });
  await rule("strike", "portal appeal must not: sets its own received date or entered-by (column grant)", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: ahead(3) }); await run("app_portal", null, "update strike set appeal_text='x', appeal_received_at = now() - interval '9 days' where id=$1", [st]); }, expect: "permission denied" });
  await rule("strike", "portal appeal must not: after the appeal is decided", { refuse: async () => { const o = await s2org(); await portalAppeal(o.st); await run("app_admin", S.C, "update strike set stage='upheld' where id=$1", [o.st]); await run("portal_owner", null, "update strike set appeal_text='again' where id=$1", [o.st]); }, expect: "appeal is decided" });
  await rule("strike", "staff-entered appeal must do: received date set, entered_by stamped, appealed_at = now", { ok: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: ahead(3) }); await run("app_admin", S.C, "update strike set appeal_text='by post', appeal_received_at = now() - interval '1 day' where id=$1", [st]);
    const s = await q1("app_admin", S.A, "select appeal_entered_by_staff_user_id e, appealed_at, appeal_received_at r from strike where id=$1", [st]); must(s.e === S.C && near(s.appealed_at, new Date()) && s.r, JSON.stringify(s)); } });
  const entered = async () => { const o = await s2org(); await run("app_admin", S.C, "update strike set appeal_text='by email', appeal_received_at = now() - interval '1 day' where id=$1", [o.st]); return o; };
  await rule("strike", "staff-entered appeal must not: decided by the person who entered it (#135)", { refuse: async () => { const o = await entered(); await run("app_admin", S.C, "update strike set stage='overturned' where id=$1", [o.st]); }, expect: "check constraint" });
  await rule("strike", "staff-entered appeal must not: decided by the original decider (#134)", { refuse: async () => { const o = await entered(); await run("app_admin", S.A, "update strike set stage='overturned' where id=$1", [o.st]); }, expect: "check constraint" });
  await rule("strike", "staff-entered appeal must do: decided by a third person (D); strike 2 ends", { ok: async () => { const o = await entered(); await run("app_admin", S.D, "update strike set stage='overturned' where id=$1", [o.st]); must((await org(o.id)).restricted_until === null, "not cleared"); } });
  await rule("strike", "staff-entered appeal must not: entered by writing appeal_entered_by under another name (column grant)", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: ahead(3) }); await run("app_admin", S.C, "update strike set appeal_text='x', appeal_received_at=now(), appeal_entered_by_staff_user_id=$2 where id=$1", [st, S.D]); }, expect: "permission denied" });
  await rule("strike", "stamp on every write: a staff write over a portal appeal stamps the staff member (RECHECK-2 failure 8; since 0017 the portal cannot write over a staff entry)", { ok: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: ahead(3) });
    await run("app_admin", S.C, "update strike set appeal_text='by post', appeal_received_at = now() - interval '1 day' where id=$1", [st]);
    await run("app_portal", null, "update strike set appeal_text='unfair' where id=$1", [st]).then(() => must(false, "portal wrote the strike"), (e) => must(/permission denied/.test(e.message), e.message));
    await run("app_admin", S.D, "update strike set appeal_text='staff words', appeal_received_at = now() - interval '2 days' where id=$1", [st]);
    const b = await q1("app_admin", S.A, "select appeal_entered_by_staff_user_id e from strike where id=$1", [st]); must(b.e === S.D, "after staff " + JSON.stringify(b)); } });
};

// =====================================================================================================================================
sections[4] = async () => {
  // ---------- #136 a and b: late staff entry within the grace; staff-entered replies decided by someone else
  // fixture change (0004, M2): each value change gets its confirmed setting request, A proposes and B confirms
  const set = async (key, value) => {
    const r = await q1("app_admin", S.A, "insert into approval_request(kind,target_table,target_id,change) values('setting','setting',$1,$2) returning id", [key, JSON.stringify({ value })]);
    await run("app_admin", S.B, "update approval_request set status='confirmed' where id=$1", [r.id]);
    return q1("app_admin", S.A, "update setting set value=$2 where key=$1 returning value", [key, value]);
  };
  const grace0 = (await su("select value from setting where key='staff_entry_grace'")).rows[0].value;
  const lateAppeal = async (dueAgo, recvAgo, text = "late by post") => { const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: dueAgo === null ? null : ago(dueAgo) });
    const recv = recvAgo === null ? null : (recvAgo < 0 ? ahead(-recvAgo) : ago(recvAgo));
    await run("app_admin", S.C, "update strike set appeal_text=$2, appeal_received_at=$3 where id=$1", [st, text, recv]); return st; };
  await rule("strike", "late appeal must do: due 3 days ago, arrived 4 days ago (before the deadline), entered now (inside the 7 day grace)", { ok: async () => {
    const st = await lateAppeal(3, 4); const s = await q1("app_admin", S.A, "select appealed_at, appeal_received_at r, appeal_entered_by_staff_user_id e from strike where id=$1", [st]); must(s.appealed_at && s.e === S.C, JSON.stringify(s)); } });
  await rule("strike", "late appeal must not: deadline 8 days ago (beyond the grace), arrived before it", { refuse: () => lateAppeal(8, 9), expect: "appeal window" });
  await rule("strike", "late appeal must not: it arrived 1 day ago, after the deadline 3 days ago", { refuse: () => lateAppeal(3, 1), expect: "appeal window" });
  await rule("strike", "late appeal must not: received date in the future", { refuse: () => lateAppeal(3, -2), expect: "appeal window" });
  await rule("strike", "late appeal must not: no received date at all", { refuse: () => lateAppeal(3, null), expect: "appeal window" });
  await rule("strike", "late appeal must not: appeal_due_at empty", { refuse: () => lateAppeal(null, 4), expect: "appeal window" });
  await rule("strike", "late appeal must not: the received date typed in a separate update from the text", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: ago(3) }); await run("app_admin", S.C, "update strike set appeal_received_at = now() - interval '4 days' where id=$1", [st]); }, expect: "same update" });
  await rule("strike", "late appeal must not: the portal enters one late (due 3 days ago)", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: ago(3) }); await run("app_portal", null, "update strike set appeal_text='x' where id=$1", [st]); }, expect: "permission denied" });
  await rule("strike", "late appeal setting: staff_entry_grace is read, not fixed: with 2 days, due 3 days ago is too late; with empty it is 0", { ok: async () => {
    try { await set("staff_entry_grace", 2); let refused = false; try { await lateAppeal(3, 4); } catch (e) { refused = /appeal window/.test(e.message); } must(refused, "2-day grace accepted a 3-day-late entry");
      await set("staff_entry_grace", null); refused = false; try { await lateAppeal(1, 2); } catch (e) { refused = /appeal window/.test(e.message); } must(refused, "empty grace accepted a late entry");
      await set("staff_entry_grace", 7); await lateAppeal(3, 4); } finally { await su("update setting set value=$1 where key='staff_entry_grace'", [grace0]); } } });
  // replies
  const lateReply = async (dueAgo, recvAgo) => { const o = await mkOrg(); const st = await mkStrike(o.id, { stage: "reply_window", extra: { reply_due_at: ago(dueAgo) } });
    await run("app_admin", S.C, "update strike set employer_reply='by post', reply_received_at=$2 where id=$1", [st, recvAgo === null ? null : ago(recvAgo)]); return st; };
  await rule("strike", "late reply must do: due 3 days ago, arrived 4 days ago, entered now: replied_at and reply_entered_by stamped", { ok: async () => { const st = await lateReply(3, 4); const s = await q1("app_admin", S.A, "select replied_at, reply_entered_by_staff_user_id e from strike where id=$1", [st]); must(s.replied_at && s.e === S.C, JSON.stringify(s)); } });
  await rule("strike", "late reply must not: deadline 8 days ago", { refuse: () => lateReply(8, 9), expect: "reply window" });
  await rule("strike", "late reply must not: arrived after the deadline", { refuse: () => lateReply(3, 1), expect: "reply window" });
  await rule("strike", "late reply must not: no received date", { refuse: () => lateReply(3, null), expect: "reply window" });
  await rule("strike", "late reply must not: the portal replies after reply_due_at", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id, { stage: "reply_window", extra: { reply_due_at: ago(1) } }); await run("app_portal", null, "update strike set employer_reply='x' where id=$1", [st]); }, expect: "permission denied" });
  await rule("strike", "late reply must not: any reply once the case is decided (staff or portal)", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id, { stage: "reply_window", extra: { reply_due_at: ahead(2), outcome: "cleared" } }, S.B); await run("portal_owner", null, "update strike set employer_reply='too late' where id=$1", [st]); }, expect: "decided, no reply" });
  await rule("strike", "staff-entered reply must not: the person who entered it decides the case (#136 b)", { refuse: async () => { const st = await lateReply(1, 2); await run("app_admin", S.C, "update strike set outcome='strike', level=1 where id=$1", [st]); }, expect: "check constraint" });
  await rule("strike", "staff-entered reply must do: someone else (B) decides the case", { ok: async () => { const st = await lateReply(1, 2); await run("app_admin", S.B, "update strike set outcome='strike', level=1 where id=$1", [st]); } });
  await rule("strike", "staff-entered reply must not: entered under another name (column grant)", { refuse: async () => { const st = await lateReply(1, 2); await run("app_admin", S.C, "update strike set reply_entered_by_staff_user_id=$2 where id=$1", [st, S.D]); }, expect: "permission denied" });
  await rule("strike", "stamp on every write: the portal cannot write over a staff-entered reply (0017: no direct write)", { refuse: async () => { const o = await mkOrg(); const st = await mkStrike(o.id, { stage: "reply_window", extra: { reply_due_at: ahead(2) } });
    await run("app_admin", S.C, "update strike set employer_reply='post', reply_received_at=now() - interval '1 day' where id=$1", [st]);
    await run("app_portal", null, "update strike set employer_reply='portal words' where id=$1", [st]); }, expect: "permission denied" });
  // ---------- the deadline columns app_admin can write (fix 5 noticed, not closed)
  await rule("strike", "HOLE a: one officer moves a spent appeal_due_at later in one update, then enters a late appeal in the next", { refuse: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: ago(40) });
    await run("app_admin", S.C, "update strike set appeal_due_at = now() + interval '1 day' where id=$1", [st]);
    await run("app_admin", S.C, "update strike set appeal_text='very late', appeal_received_at = now() - interval '39 days' where id=$1", [st]); }, expect: "appeal" });
  await rule("strike", "HOLE b: the same, for a spent reply_due_at and a late reply", { refuse: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id, { stage: "reply_window", extra: { reply_due_at: ago(40) } });
    await run("app_admin", S.C, "update strike set reply_due_at = now() + interval '1 day' where id=$1", [st]);
    await run("app_admin", S.C, "update strike set employer_reply='very late', reply_received_at = now() - interval '39 days' where id=$1", [st]); }, expect: "reply" });
  await rule("strike", "HOLE c: one officer sets a far-future appeal_due_at on insert (no 7 day limit)", { refuse: async () => { const o = await mkOrg(); await mkStrike(o.id, { appeal_due: ahead(3650) }); }, expect: "appeal_due_at" });
  await rule("strike", "HOLE d: a case decided 300 days ago has an empty appeal_due_at; one officer sets it to tomorrow and enters a very late appeal (fixture first aimed at an undecided case, which no database rule can bound; retargeted to a decided one)", { refuse: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: null, extra: { outcome: "strike", level: 1 } }); await replica((q) => q("update strike set decided_at = now() - interval '300 days' where id=$1", [st]));
    await run("app_admin", S.C, "update strike set appeal_due_at = now() + interval '1 day' where id=$1", [st]);
    await run("app_admin", S.C, "update strike set appeal_text='very late', appeal_received_at = now() - interval '300 days' where id=$1", [st]); }, expect: "appeal" });
  await rule("strike", "HOLE e: officer pulls a deadline earlier on the employer's open window (kills a live appeal)", { refuse: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id, { appeal_due: ahead(5) });
    await run("app_admin", S.C, "update strike set appeal_due_at = now() - interval '1 minute' where id=$1", [st]); }, expect: "appeal_due_at" });
};

// =====================================================================================================================================
sections[5] = async () => {
  // ---------- posted_at: the portal reads it, cannot write it (CHECK-FIXES 4, RECHECK 4)
  await rule("job", "posted_at must do: the portal reads posted_at and sorts by it (the job list)", { ok: async () => {
    const o = await mkOrg(); const j = await portalJob(o.id); const r = await run("app_portal", null, "select id, posted_at from job where organisation_id=$1 order by posted_at desc, id desc limit 5", [o.id]); must(r.rows.length === 1 && r.rows[0].posted_at, "no row"); } });
  await rule("job", "posted_at must do: the candidate side reads posted_at too", { ok: async () => run("app_candidate", null, "select posted_at from job limit 1") });
  await rule("job", "posted_at must not: the portal updates posted_at (year ahead, sits first in newest first)", { refuse: async () => { const o = await mkOrg(); const j = await portalJob(o.id); await run("app_portal", null, "update job set posted_at = now() + interval '1 year' where id=$1", [j]); }, expect: "permission denied" });
  await rule("job", "posted_at must not: the portal inserts a job with posted_at", { refuse: async () => { const o = await mkOrg(); jobSrc ??= await getSrc();
    await run("app_portal", null, "insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, closes_at, own_page_url, status, salary_low, posted_at) values ($1,'employer',$2,'J','A','x','general', now()+interval '5 days','https://a.test','draft',1, now()+interval '1 year')", [o.id, jobSrc]); }, expect: "permission denied" });
  await rule("job", "posted_at must not: the fetcher updates posted_at", { refuse: () => run("app_fetcher", null, "update job set posted_at = now() + interval '1 year' where id = -1"), expect: "permission denied" });
  await rule("job", "posted_at must do: draft to live by the portal sets posted_at to now()", { ok: async () => { const o = await mkOrg(); const j = await portalJob(o.id); await su("update job set posted_at = now() - interval '1 year' where id=$1", [j]); const r = await goLive(j); must(near(r.posted_at, new Date()), r.posted_at); } });
  await rule("job", "posted_at must not: admin approves in_review to live while sending a posted_at a year ahead (guard sets now())", { ok: async () => {
    const o = await s2org(); const j = await portalJob(o.id); await goLive(j);
    await run("app_admin", S.A, "update job set status='live', posted_at = now() + interval '1 year', search_vector = to_tsvector('x') where id=$1", [j]);
    const r = await q1("app_admin", S.A, "select posted_at from job where id=$1", [j]); must(near(r.posted_at, new Date()), "posted_at " + r.posted_at); } });
  await rule("job", "posted_at must not: the portal reads a column outside its list (quota_full)", { refuse: () => run("app_portal", null, "select quota_full from job limit 1"), expect: "permission denied" });

  // ---------- strike columns: staff read the reply, nobody writes the stamped columns, the portal reads no staff ids
  const rich = async () => { const o = await mkOrg(); const st = await mkStrike(o.id, { stage: "reply_window", extra: { reply_due_at: ahead(2) } });
    await run("portal_owner", null, "update strike set employer_reply='we deny it', appeal_text='unfair' where id=$1", [st]); return st; };
  await rule("strike", "strike grants must do: staff read the employer's reply, reply and appeal times, deciders (select *)", { ok: async () => {
    const st = await rich(); const r = await q1("app_admin", S.A, "select * from strike where id=$1", [st]); must(r.employer_reply === "we deny it" && r.replied_at && r.appeal_text === "unfair" && r.appealed_at, JSON.stringify(r));
    await q1("app_admin", S.A, "select employer_reply, replied_at, appealed_at, ban_lifted_at, decided_by_staff_user_id, appeal_decided_by_staff_user_id from strike where id=$1", [st]); } });
  await rule("strike", "strike grants must do: staff update returning * works (the case screen)", { ok: async () => { const st = await rich(); const r = await q1("app_admin", S.A, "update strike set notice_summary='checked' where id=$1 returning *", [st]); must(r.employer_reply === "we deny it", "reply not returned"); } });
  for (const c of ["replied_at", "appealed_at", "ban_lifted_at", "decided_by_staff_user_id", "decided_at", "reply_entered_by_staff_user_id", "appeal_entered_by_staff_user_id", "appeal_decided_by_staff_user_id", "appeal_decided_at"]) {
    const v = c.endsWith("_at") ? "now()" : `'${S.B}'`;
    await rule("strike", `strike grants must not: app_admin updates ${c}`, { refuse: async () => { const st = await rich(); await run("app_admin", S.A, `update strike set ${c} = ${v} where id=$1`, [st]); }, expect: "permission denied" });
  }
  await rule("strike", "strike grants must not: app_admin inserts replied_at", { refuse: async () => { const o = await mkOrg(); await run("app_admin", S.A, "insert into strike(organisation_id,case_kind,reason_code,replied_at) values ($1,'false_claim','false_sponsorship', now())", [o.id]); }, expect: "permission denied" });
  await rule("strike", "strike grants must not: the portal reads staff ids (decided_by_staff_user_id)", { refuse: () => run("app_portal", null, "select decided_by_staff_user_id from strike limit 1"), expect: "permission denied" });
  await rule("strike", "strike grants must not: the portal reads report_id (the reporter)", { refuse: () => run("app_portal", null, "select report_id from strike limit 1"), expect: "permission denied" });
  await rule("strike", "strike grants must not: the portal reads approval_request_id", { refuse: () => run("app_portal", null, "select approval_request_id from strike limit 1"), expect: "permission denied" });
  await rule("strike", "strike grants must not: select * as the portal", { refuse: () => run("app_portal", null, "select * from strike limit 1"), expect: "permission denied" });
  await rule("strike", "strike grants must not: the portal reads strike columns directly (0017: only its own cases, through private.status_page)", { refuse: () => run("app_portal", null, "select id, organisation_id, stage, outcome, level, reply_due_at, employer_reply, replied_at, appeal_due_at, appeal_text, appealed_at, decided_at, appeal_decided_at from strike limit 1"), expect: "permission denied" });
  for (const c of ["outcome", "stage", "decided_at", "level"]) await rule("strike", `strike grants must not: the portal updates ${c}`, { refuse: async () => { const st = await rich(); await run("app_portal", null, `update strike set ${c} = ${c === "stage" ? "'decided'" : c === "outcome" ? "'cleared'" : c === "level" ? "1" : "now()"} where id=$1`, [st]); }, expect: "permission denied" });
  await rule("strike", "strike grants must not: the candidate side has no grant at all", { refuse: () => run("app_candidate", null, "select 1 from strike limit 1"), expect: "permission denied" });
  await rule("ban", "ban grants must not: the portal and the candidate side read the ban list", { refuse: async () => { await run("app_portal", null, "select 1 from ban limit 1"); }, expect: "permission denied" });
  await rule("approval_request", "approval grants must not: the portal cannot read or write approval_request", { refuse: () => run("app_portal", null, "select 1 from approval_request limit 1"), expect: "permission denied" });
  await rule("approval_request", "approval grants must not: app_admin deletes a used request (erases the trail)", { refuse: () => run("app_admin", S.A, "delete from approval_request where applied_at is not null"), expect: "permission denied" });
  await rule("approval_request", "approval grants must not: app_admin truncates approval_request", { refuse: () => run("app_admin", S.A, "truncate approval_request"), expect: "permission denied" });

  // ---------- #132: the last member of a verified organisation leaves
  const orgWithOwner = async () => { const o = await mkOrg(); const pu = await F.portal(); const m = await F.member(o.id, pu, { role: "account_owner", signer: true }); await su("update membership set joined_at=now() where id=$1", [m]); const j = await portalJob(o.id); await goLive(j); return { ...o, pu, m, j }; };
  await rule("organisation", "#132 must do: the last (only) member leaves: the organisation stays verified and its jobs stay live", { ok: async () => {
    const x = await orgWithOwner(); await su("update membership set status='removed', removed_at=now() where id=$1", [x.m]);
    const o = await org(x.id); const j = await su("select status from job where id=$1", [x.j]); const m = await su("select count(*)::int c from membership where organisation_id=$1 and status<>'removed'", [x.id]);
    must(o.status === "verified" && j.rows[0].status === "live" && m.rows[0].c === 0, JSON.stringify({ o, j: j.rows[0], m: m.rows[0] })); } });
  await rule("organisation", "#132 must do: the last member is erased (erase_portal_user): organisation stays verified, jobs stay live", { ok: async () => {
    const x = await orgWithOwner(); const r = await q1("app_admin", S.A, "select private.erase_portal_user($1, true) r", [x.pu]); must(r.r.erased === true, JSON.stringify(r.r));
    const o = await org(x.id); const j = await su("select status from job where id=$1", [x.j]); must(o.status === "verified" && j.rows[0].status === "live", JSON.stringify({ o, j: j.rows[0] })); } });
  await rule("organisation", "#132 must do: an administrator reassigns the orphan organisation to a new owner (after the 20b checks, outside the database)", { ok: async () => {
    const x = await orgWithOwner(); await su("update membership set status='removed', removed_at=now() where id=$1", [x.m]); const p2 = await F.portal();
    await run("app_admin", S.A, "insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values ($1,$2,'account_owner','active',true,now())", [x.id, p2]); } });
  await rule("organisation", "#132 must not: the portal can still not move its own organisation to unclaimed (status is not in the portal's grant)", { refuse: async () => { const x = await orgWithOwner(); await run("app_portal", null, "update organisation set status='unclaimed' where id=$1", [x.id]); }, expect: "permission denied" });

  // ---------- CHECK-FIXES 5: a rejected new organisation does not keep its claimant; the unclaimed path closes draft and in_review jobs
  await rule("organisation", "reject must do: rejecting a new organisation removes its memberships, so the claimant can register or join elsewhere (one_company_per_login)", { ok: async () => {
    const o = await mkOrg({ status: "pending_review" }); const pu = await F.portal(); const m = await F.member(o.id, pu, { role: "account_owner", status: "active" });
    await run("app_admin", S.A, "update organisation set status='rejected' where id=$1", [o.id]);
    const r = await su("select status, removed_at, invited_email from membership where id=$1", [m]); must(r.rows[0].status === "removed" && r.rows[0].removed_at, JSON.stringify(r.rows[0]));
    const o2 = await mkOrg(); await F.member(o2.id, pu, { role: "account_owner", status: "active" }); } });
  await rule("organisation", "unclaimed must do: back to unclaimed removes memberships, empties claim columns, closes draft and in_review jobs (draft with no pay included, Finding A)", { ok: async () => {
    const x = await orgWithOwner(); const dNoPay = await portalJob(x.id, { pay: false }); const inRev = await portalJob(x.id); await run("app_portal", null, "update job set status='in_review' where id=$1", [inRev]);
    await run("app_admin", S.A, "update organisation set status='unclaimed' where id=$1", [x.id]);
    const j = await su("select id, status, close_reason from job where organisation_id=$1 order by id", [x.id]); const o = await su("select claimed_at, signup_path from organisation where id=$1", [x.id]);
    const live = j.rows.find((r) => r.id == x.j);
    must(j.rows.filter((r) => r.id != x.j).every((r) => r.status === "closed" && r.close_reason === "removed") && live.status === "live" && o.rows[0].claimed_at === null, JSON.stringify({ j: j.rows, o: o.rows[0] })); } });
};

// =====================================================================================================================================
sections[6] = async () => {
  // ---------- every staff role grant is two-person (#136 c), creating a staff login
  const ROLES = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "content_editor", "administrator"];
  const kindOf = (r) => (r === "administrator" ? "grant_administrator" : "grant_role");
  const gReq = (z, role, by = S.A, conf = S.B) => reqC(kindOf(role), "staff_role", z, by, conf, role === "administrator" ? null : { role });
  const ins = (by, z, role, rid) => run("app_admin", by, "insert into staff_role(staff_user_id, role, granted_by_staff_user_id, approval_request_id) values ($1,$2,$3,$4)", [z, role, by, rid ?? null]);
  for (const role of ROLES) {
    await rule("staff_role", `${role} must do: a confirmed ${kindOf(role)} request from another person; request marked applied`, { ok: async () => { const z = await F.staff(); const rid = await gReq(z, role); await ins(S.A, z, role, rid);
      const a = await su("select applied_at from approval_request where id=$1", [rid]); must(a.rows[0].applied_at, "not applied"); } });
    await rule("staff_role", `${role} must not: granted with no request (even by an administrator)`, { refuse: async () => ins(S.A, await F.staff(), role, null), expect: "two-person rule" });
    await rule("staff_role", `${role} must not: granted on a pending request`, { refuse: async () => { const z = await F.staff(); const rid = await reqP(kindOf(role), "staff_role", z, S.A, role === "administrator" ? null : { role }); await ins(S.A, z, role, rid); }, expect: "is pending" });
    await rule("staff_role", `${role} must not: the proposer is also the confirmer`, { refuse: async () => { const z = await F.staff(); const rid = await reqP(kindOf(role), "staff_role", z, S.A, role === "administrator" ? null : { role }); await run("app_admin", S.A, "update approval_request set status='confirmed' where id=$1", [rid]); }, expect: "check constraint" });
    await rule("staff_role", `${role} must not: a used request is used again for the same person after the role is deleted`, { refuse: async () => { const z = await F.staff(); const rid = await gReq(z, role); await ins(S.A, z, role, rid); await run("app_admin", S.A, "delete from staff_role where staff_user_id=$1 and role=$2", [z, role]); await ins(S.A, z, role, rid); }, expect: "already used" });
    await rule("staff_role", `${role} must not: one person's request used to grant the role to someone else`, { refuse: async () => { const z = await F.staff(); const z2 = await F.staff(); const rid = await gReq(z, role); await ins(S.A, z2, role, rid); }, expect: "is for" });
  }
  await rule("staff_role", "wrong kind: administrator granted on a grant_role request", { refuse: async () => { const z = await F.staff(); const rid = await reqC("grant_role", "staff_role", z, S.A, S.B, { role: "administrator" }); await ins(S.A, z, "administrator", rid); }, expect: "needs grant_administrator" });
  await rule("staff_role", "wrong kind: content_editor granted on a grant_administrator request", { refuse: async () => { const z = await F.staff(); const rid = await reqC("grant_administrator", "staff_role", z); await ins(S.A, z, "content_editor", rid); }, expect: "needs grant_role" });
  await rule("staff_role", "wrong role: grant_role request names account_reviewer, row is trust_and_safety", { refuse: async () => { const z = await F.staff(); const rid = await gReq(z, "account_reviewer"); await ins(S.A, z, "trust_and_safety", rid); }, expect: "does not name the role" });
  await rule("staff_role", "wrong role: grant_role request names no role at all", { refuse: async () => { const z = await F.staff(); const rid = await reqC("grant_role", "staff_role", z); await ins(S.A, z, "content_editor", rid); }, expect: "does not name the role" });
  await rule("staff_role", "wrong person: lookup with no request id finds nothing for a person with no request", { refuse: async () => ins(S.B, await F.staff(), "account_reviewer", null), expect: "no confirmed" });
  await rule("staff_role", "request id left empty: refused by the CHECK (the trigger does not fill it in, so the admin app must name the request; test first assumed it would infer it, wrong assumption, rewritten)", { refuse: async () => { const z = await F.staff(); await gReq(z, "content_editor"); await run("app_admin", S.A, "insert into staff_role(staff_user_id, role) values ($1,'content_editor')", [z]); }, expect: "check constraint" });
  await rule("staff_role", "must not: app_admin sets seeded_by_owner (column grant), the owner-only route", { refuse: async () => { const z = await F.staff(); await run("app_admin", S.A, "insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,'administrator',true)", [z]); }, expect: "permission denied" });
  await rule("staff_role", "must not: app_admin updates a role row in place (self-promotion)", { refuse: () => run("app_admin", S.A, "update staff_role set role='administrator' where staff_user_id=$1", [S.D]), expect: "permission denied" });
  await rule("staff_role", "must do: the owner seeds a first administrator (seeded_by_owner)", { ok: async () => { const z = await F.staff(); await run("portal_owner", null, "insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,'administrator',true)", [z]); } });
  // creating a staff login
  await rule("staff_user", "login must do: an administrator creates a staff login (Better Auth createUser path: insert staff_user and staff_account)", { ok: async () => {
    const i = id("newstaff"); await run("app_admin", S.A, "insert into staff_user(id, name, email, email_verified) values ($1,'New Staff',$2,true)", [i, i + "@x.test"]); await run("app_admin", S.A, "insert into staff_account(id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1,$2,'credential',$2,'hash',now(),now())", [id("acc"), i]); } });
  await rule("staff_role", "login must not: the new login holds no role, so it cannot propose", { refuse: async () => { const i = id("newstaff"); await run("app_admin", S.A, "insert into staff_user(id, name, email, email_verified) values ($1,'N',$2,true)", [i, i + "@x.test"]); await run("app_admin", i, "insert into approval_request(kind,target_table,target_id) values ('ban','strike',$1)", [id('t')]); }, expect: "holds no role" });
  await rule("staff_role", "login must not: one administrator creates a second login Y and has Y confirm A's own grant of a role to Y", { refuse: async () => {
    const y = id("second"); await run("app_admin", S.A, "insert into staff_user(id, name, email, email_verified) values ($1,'Y',$2,true)", [y, y + "@x.test"]);
    const rid = await reqP("grant_administrator", "staff_role", y, S.A); await run("app_admin", y, "update approval_request set status='confirmed' where id=$1", [rid]); }, expect: "holds no role" });
  await rule("staff_role", "login must not: one administrator grants the second login a role with no second person", { refuse: async () => { const y = id("second"); await run("app_admin", S.A, "insert into staff_user(id, name, email, email_verified) values ($1,'Y',$2,true)", [y, y + "@x.test"]); await ins(S.A, y, "administrator", null); }, expect: "two-person rule" });
  await rule("staff_role", "login must do: the second login gets its role with B's confirmation, and then can act", { ok: async () => {
    const y = id("second"); await run("app_admin", S.A, "insert into staff_user(id, name, email, email_verified) values ($1,'Y',$2,true)", [y, y + "@x.test"]);
    const rid = await gReq(y, "trust_and_safety"); await ins(S.A, y, "trust_and_safety", rid); await run("app_admin", y, "insert into approval_request(kind,target_table,target_id) values ('ban','strike',$1)", [id('t')]); } });
  // NOTE design: a request is confirmed by anyone who holds any role (a content editor can confirm a ban); the design says 'holds at least one staff_role row'. An account_reviewer confirming a strike_3 request is accepted, as designed.
  // NOTE design: app_admin may delete any staff_role row (granted select, delete); one administrator can remove another's role, no second person needed.
};

// =====================================================================================================================================
sections[7] = async () => {
  // ---------- staff identity: the ways round, tried as app_admin with only its grants
  const t = "staff identity";
  await rule(t, "stamped: strike decided_by comes from the acting id, even when the app names another person in the data", { ok: async () => {
    const o = await mkOrg(); const st = await mkStrike(o.id, { extra: { outcome: "cleared" } }, S.D); const s = await q1("app_admin", S.A, "select decided_by_staff_user_id d from strike where id=$1", [st]); must(s.d === S.D, s.d); } });
  await rule(t, "app_admin cannot switch the triggers off: set session_replication_role = replica", { refuse: () => run("app_admin", S.A, "set local session_replication_role = replica"), expect: "permission denied" });
  await rule(t, "app_admin cannot disable a trigger (alter table strike disable trigger strike_guard)", { refuse: () => run("app_admin", S.A, "alter table strike disable trigger strike_guard"), expect: "must be owner" });
  await rule(t, "app_admin cannot drop a trigger", { refuse: () => run("app_admin", S.A, "drop trigger approval_request_guard on approval_request"), expect: "must be owner" });
  await rule(t, "app_admin cannot become the owner (set role portal_owner)", { refuse: () => run("app_admin", S.A, "set role portal_owner"), expect: "permission denied" });
  await rule(t, "app_admin cannot call the approval helper directly (private.use_approval)", { refuse: () => run("app_admin", S.A, "select private.use_approval(1,'ban','strike','1')"), expect: "permission denied" });
  await rule(t, "app_admin cannot replace a trigger function (create or replace function private.approval_check)", { refuse: () => run("app_admin", S.A, "create or replace function private.approval_check() returns trigger language plpgsql as $f$ begin return new; end $f$"), expect: "" });
  await rule(t, "app_admin cannot create objects in schema public (a shadow table or function)", { refuse: () => run("app_admin", S.A, "create table public.approval_request_shadow(id int)"), expect: "permission denied" });
  await rule(t, "app_admin cannot write the audit trail in someone else's name away from the app (no update or delete on audit_event)", { refuse: () => run("app_admin", S.A, "delete from audit_event"), expect: "permission denied" });
  // the acting id is a plain setting
  // NOTE the acting id can name any active staff member (design section 2: 'The database trusts the admin app'); the two-person rule therefore rests on the admin app setting it from the verified session.
  // NOTE a plain set (not local) on a pooled connection leaks the acting id into later transactions.
  // 3: alter role app_admin set app.staff_user_id: a default for every new connection
  await rule(t, "app_admin cannot give itself a default acting id for every new connection (alter role app_admin set app.staff_user_id)", { refuse: async () => {
    try { await run("app_admin", S.A, `alter role app_admin set app.staff_user_id = '${S.B}'`);
      const c = new pg.Client({ connectionString: url("app_admin", DB) }); await c.connect();
      try { const r = await c.query("insert into approval_request(kind,target_table,target_id) values ('ban','strike',$1) returning proposed_by_staff_user_id p", [RUN + "-roledefault"]); throw new Error("accepted: a fresh connection with no set local was stamped as " + (r.rows[0].p === S.B ? "B" : r.rows[0].p)); } finally { await c.end(); }
    } finally { await su("alter role app_admin reset app.staff_user_id"); } }, expect: "permission denied" });
  // 4: reactivating a disabled login that holds a role
  await rule(t, "app_admin cannot reactivate a disabled staff login that holds a role (re-enable a leaver and act as them)", { refuse: async () => {
    try { await run("app_admin", S.A, "update staff_user set status='active' where id=$1", [S.X]); await run("app_admin", S.X, "insert into approval_request(kind,target_table,target_id) values ('ban','strike',$1)", [RUN + "-leaver"]); }
    finally { await su("update staff_user set status='disabled' where id=$1", [S.X]); } }, expect: "turned back on" }); // expect set after fix 5 was written: the baseline run showed the write accepted
  await rule(t, "app_admin cannot rename a staff id that stamps and approvals already point to (test first aimed at an unreferenced login, vacuous, retargeted to A)", { refuse: async () => run("app_admin", S.A, "update staff_user set id = id || '-x' where id=$1", [S.A]), expect: "violates foreign key" });
};

// =====================================================================================================================================
sections[8] = async () => {
  // ---------- evidence for every strike a ban rests on (#136 d, #133), and #132 through run_retention. Time is moved with triggers off (fixture only).
  const loop = async () => { let last; for (let i = 0; i < 200; i++) { const r = (await q1("app_admin", S.A, "select private.run_retention(1000) r")).r; if (!r.rule) return last; last = r; } return "loop did not end"; };
  const exists = async (ids) => { const r = await su("select id from strike where id = any($1::bigint[])", [ids]); return new Set(r.rows.map((x) => String(x.id))); };
  const backdate = (st, months) => replica((q) => q("update strike set decided_at = now() - make_interval(months => $2), appeal_decided_at = case when appeal_decided_at is null then null else now() - make_interval(months => $2) end where id=$1", [st, months]));
  // an organisation with: strike 1 (earlier), strike 2 not overturned (earlier), strike 2 overturned (earlier), strike 3 + ban, a strike 1 decided later; and another organisation's strike 1
  const o = await mkOrg(); const other = await mkOrg();
  const s1 = await mkStrike(o.id, { extra: { outcome: "strike", level: 1 } });
  const s2 = await mkStrike(o.id); const r2 = await reqC("strike_2", "strike", s2); await applyS2(o.id, s2, r2);
  const s2o = await mkStrike(o.id); const r2o = await reqC("strike_2", "strike", s2o); await run("app_admin", S.A, "update strike set outcome='strike', level=2, approval_request_id=$2 where id=$1", [s2o, r2o]);
  await run("portal_owner", null, "update strike set appeal_text='no' where id=$1", [s2o]); await run("app_admin", S.C, "update strike set stage='overturned' where id=$1", [s2o]);
  const s3 = await mkStrike(o.id); const r3 = await reqC("strike_3", "strike", s3); const ban = await applyS3(o.id, s3, r3, o.cro);
  const sLater = await mkStrike(o.id, { extra: { outcome: "strike", level: 1 } });
  const sOther = await mkStrike(other.id, { extra: { outcome: "strike", level: 1 } });
  const sOtherC = await mkStrike(other.id, { extra: { outcome: "cleared" } });
  for (const [st, m] of [[s1, 20], [s2, 19], [s2o, 19], [s3, 18], [sLater, 17], [sOther, 20], [sOtherC, 20]]) await backdate(st, m);
  const all = [s1, s2, s2o, s3, sLater, sOther, sOtherC]; const ids = (...x) => x.map(String);
  await loop();
  let left = await exists(all);
  await rule("strike", "evidence must do: while the ban stands, the banned case AND the earlier strikes 1 and 2 behind it are kept (#136 d)", { ok: async () => { for (const x of [s1, s2, s3]) must(left.has(String(x)), "deleted while the ban stands: strike " + x); } });
  await rule("strike", "evidence must do: the overturned strike 2, a strike decided after the ban and another organisation's cases go at 12 months as before", { ok: async () => { for (const x of [s2o, sLater, sOther, sOtherC]) must(!left.has(String(x)), "kept: strike " + x); } });
  // lift the ban
  await liftReq0(ban);
  async function liftReq0(b) { const r = await reqC("ban_lift", "ban", b, S.A, S.B); await run("app_admin", S.A, "delete from ban where id=$1", [b]); return r; }
  await replica((q) => q("update strike set ban_lifted_at = now() - interval '1 month' where id=$1", [s3]));
  await loop(); left = await exists(all);
  await rule("strike", "evidence must do: 1 month after the lift the three cases are still kept (12 months run from ban_lifted_at)", { ok: async () => { for (const x of [s1, s2, s3]) must(left.has(String(x)), "deleted 1 month after the lift: strike " + x); } });
  await replica((q) => q("update strike set ban_lifted_at = now() - interval '13 months' where id=$1", [s3]));
  await loop(); left = await exists(all);
  await rule("strike", "evidence must do: 13 months after the lift the case and the strikes behind it go (ban_evidence)", { ok: async () => { for (const x of [s1, s2, s3]) must(!left.has(String(x)), "kept 13 months after the lift: strike " + x); } });
  // an instant ban case alone
  const o3 = await mkOrg(); const sb = await mkStrike(o3.id, { kind: "instant_ban", reason: "fake_company" }); const rb = await reqC("ban", "strike", sb);
  await as("app_admin", S.A, async (q) => { await q("update strike set outcome='ban', approval_request_id=$2 where id=$1", [sb, rb]); await q("insert into ban(cro_number,reason_code,strike_id,approval_request_id) values ($1,'fake_company',$2,$3)", [o3.cro, sb, rb]); await q("update organisation set status='banned' where id=$1", [o3.id]); });
  await backdate(sb, 30); await loop();
  await rule("strike", "evidence must do: an instant-ban case is kept while its ban stands, however old", { ok: async () => { must((await exists([sb])).has(String(sb)), "deleted"); } });
  await rule("strike", "evidence must not: one officer writes ban_lifted_at to start the clock early (column grant)", { refuse: () => run("app_admin", S.A, "update strike set ban_lifted_at = now() - interval '13 months' where id=$1", [sb]), expect: "permission denied" });

  // ---------- #132 through the retention loop: the sole member left 13 months ago, is erased by the rule, the organisation stays
  const org132 = await mkOrg(); const pu = await F.portal(); const m = await F.member(org132.id, pu, { role: "account_owner", signer: true }); await su("update membership set joined_at = now() - interval '2 years' where id=$1", [m]);
  const j = await portalJob(org132.id); await goLive(j);
  await su("update membership set status='removed', removed_at=now() where id=$1", [m]);
  await su("update membership set removed_at = now() - interval '13 months' where id=$1", [m]);
  await loop();
  await rule("organisation", "#132 retention: after the rule erases the removed last member, the organisation is still verified with its live job, and does not go to unclaimed", { ok: async () => {
    const gone = await su("select 1 from portal_user where id=$1", [pu]); const x = await org(org132.id); const jj = await su("select status from job where id=$1", [j]);
    must(gone.rowCount === 0 && x.status === "verified" && jj.rows[0].status === "live", JSON.stringify({ erased: gone.rowCount === 0, x, job: jj.rows[0] })); } });
};

// =====================================================================================================================================
sections[9] = async () => {
  // extra probes: the confirmation is for a case id; what can the applying officer still change after the confirmation?
  await rule("strike", "probe: after B confirms strike 2 for a case of organisation 1, A moves the case to organisation 2 in the applying transaction (restricts the wrong company)", { refuse: async () => {
    const o1 = await mkOrg(), o2 = await mkOrg(); const st = await mkStrike(o1.id); const rq = await reqC("strike_2", "strike", st);
    await as("app_admin", S.A, async (q) => { await q("update strike set organisation_id=$3, outcome='strike', level=2, approval_request_id=$2 where id=$1", [st, rq, o2.id]);
      await q("update organisation set restricted_until = now() + interval '90 days' where id=$1", [o2.id]); }); }, expect: "organisation" });
  await rule("strike", "probe: after a strike 2 is applied, A moves the decided case to another organisation (rewrites who was struck)", { refuse: async () => {
    const o1 = await mkOrg(), o2 = await mkOrg(); const st = await mkStrike(o1.id); const rq = await reqC("strike_2", "strike", st); await applyS2(o1.id, st, rq);
    await run("app_admin", S.A, "update strike set organisation_id=$2 where id=$1", [st, o2.id]); }, expect: "organisation" });
};

sections[10] = async () => {
  // more probes on who may end a restriction or a claims removal (same family as the section 3 overturn probe)
  const portalAppeal = (st) => run("portal_owner", null, "update strike set appeal_text='unfair' where id=$1", [st]); // 0017: the portal appeals through private.status_write, which runs as portal_owner
  await rule("organisation", "probe: strike 2 case 1 ended long ago, strike 2 case 2 is running; case 1 is overturned late: case 2's restriction must stay", { ok: async () => {
    const o = await mkOrg(); const st1 = await mkStrike(o.id); const r1 = await reqC("strike_2", "strike", st1); await applyS2(o.id, st1, r1);
    await replica((q) => q("update organisation set restricted_until = now() - interval '1 day', status='verified' where id=$1", [o.id]));
    const st2 = await mkStrike(o.id); const r2 = await reqC("strike_2", "strike", st2); await applyS2(o.id, st2, r2);
    await portalAppeal(st1); await run("app_admin", S.C, "update strike set stage='overturned' where id=$1", [st1]);
    must((await org(o.id)).restricted_until, "the running restriction of case 2 was cleared by overturning case 1"); } });
  await rule("organisation", "probe: first strike 3 lifted, second strike 3 and ban applied; one officer clears claims_removed_at (old case has ban_lifted_at)", { refuse: async () => {
    const b = await banned(); const lr = await reqC("ban_lift", "ban", b.ban); await run("app_admin", S.A, "delete from ban where id=$1", [b.ban]);
    await as("app_admin", S.A, async (q) => { await q("update organisation set status='verified' where id=$1", [b.id]); await q("update organisation set claims_removed_at = null where id=$1", [b.id]); });
    const st2 = await mkStrike(b.id); const rq2 = await reqC("strike_3", "strike", st2); await applyS3(b.id, st2, rq2, b.cro);
    must((await org(b.id)).claims_removed_at, "second strike 3 not applied");
    await run("app_admin", S.A, "update organisation set claims_removed_at = null where id=$1", [b.id]); }, expect: "overturned or its ban lifted" });
  await rule("organisation", "must do: the legal clear still works after the fix: strike 2 case overturned clears its own restriction; strike 3 ban lifted clears its own claims removal", { ok: async () => {
    const o = await s2org(); await portalAppeal(o.st); await run("app_admin", S.C, "update strike set stage='overturned' where id=$1", [o.st]); must((await org(o.id)).restricted_until === null, "level 2 not cleared");
    const b = await banned(); await reqC("ban_lift", "ban", b.ban); await run("app_admin", S.A, "delete from ban where id=$1", [b.ban]);
    await as("app_admin", S.A, async (q) => { await q("update organisation set status='verified' where id=$1", [b.id]); await q("update organisation set claims_removed_at = null where id=$1", [b.id]); }); } });
};

const todo = Object.keys(sections);
await people();
for (const k of todo) { try { await sections[k](); } catch (e) { line("section " + k, "section crashed", false, false, e.stack || e.message); } }
