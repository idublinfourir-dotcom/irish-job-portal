// The 9 rules listed under "Not covered yet" in docs/removed-tests.md. Every action under test runs as the real role
// (app_admin), with the acting staff id set local. Fixtures that need the superuser are inserted as postgres.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, race, rule, tx, type Role, type TestDb } from "./db";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(() => db.drop());

const uid = (p: string) => `${p}_${randomBytes(5).toString("hex")}`;
const su = (sql: string, args?: unknown[]) => db.query("postgres", sql, args);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const as = <T>(role: Role, staff: string | null, fn: (q: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>) =>
  tx(db.pool(role), async (c) => {
    if (staff !== null) await c.query("select set_config('app.staff_user_id', $1, true)", [staff]);
    return fn((s, a) => c.query(s, a));
  });
const run = (role: Role, staff: string | null, sql: string, args?: unknown[]) => as(role, staff, (q) => q(sql, args));

async function staff(...roles: string[]) {
  const i = uid("s");
  await su("insert into staff_user(id,name,email,email_verified,status) values($1,'Staff',$2,true,'active')", [i, `${i}@example.test`]);
  for (const r of roles) await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,$2,true)", [i, r]);
  return i;
}
const org = async (cro: string | null = null) =>
  (await su("insert into organisation(slug,display_name,kind,status,cro_number) values($1,'Org','employer','verified',$2) returning id", [uid("org"), cro])).rows[0].id as string;
const propose = async (kind: string, table: string, target: string, by: string, change?: object) =>
  (await run("app_admin", by, "insert into approval_request(kind,target_table,target_id,change) values($1,$2,$3,$4) returning id", [kind, table, target, change ? JSON.stringify(change) : null])).rows[0].id as string;
const decide = (rid: string, by: string, status = "confirmed") => run("app_admin", by, "update approval_request set status=$2 where id=$1", [rid, status]);
const mkStrike = async (o: string, by: string) =>
  (await run("app_admin", by, "insert into strike(organisation_id,case_kind,reason_code,stage,appeal_due_at) values($1,'false_claim','false_sponsorship','decided',now()+interval '6 days') returning id", [o])).rows[0].id as string;

// A (proposer) and B (second administrator, also decides), B2 (third administrator), T (trust and safety, confirms strikes and bans)
let A: string, B: string, B2: string, T: string;
beforeAll(async () => { A = await staff("administrator"); B = await staff("administrator"); B2 = await staff("administrator"); T = await staff("trust_and_safety"); });

// ---- [ban] unique cro_number / email_domain: a ban shares its strike case's request, applied with the ban row in one transaction
async function strike3(o: string, applyBan: (q: (sql: string, args?: unknown[]) => Promise<unknown>, strikeId: string, rq: string) => Promise<unknown>, confirmer = T, level3Request?: (st: string) => Promise<string>) {
  const st = await mkStrike(o, A);
  const rq = level3Request ? await level3Request(st) : await propose("strike_3", "strike", st, A);
  if (!level3Request) await decide(rq, confirmer);
  return as("app_admin", A, async (q) => {
    await q("update strike set outcome='strike', level=3, approval_request_id=$2 where id=$1", [st, rq]);
    return applyBan(q, st, rq);
  });
}
const banCro = (o: string, cro: string) => strike3(o, (q, st, rq) => q("insert into ban(cro_number, reason_code, strike_id, approval_request_id) values ($1,'strike_3',$2,$3)", [cro, st, rq]));
const banDomain = (o: string, d: string) => strike3(o, (q, st, rq) => q("insert into ban(email_domain, reason_code, strike_id, approval_request_id) values ($1,'strike_3',$2,$3)", [d, st, rq]));

test("[ban] unique cro_number where not null", async () => {
  const cro = String(800000 + Math.floor(Math.random() * 99999));
  const o1 = await org(cro), o2 = await org(String(900000 + Math.floor(Math.random() * 99999)));
  await rule({ ok: () => banCro(o1, cro) });
  await rule({ ok: async () => { await banCro(o2, (await su("select cro_number from organisation where id=$1", [o2])).rows[0].cro_number); } }); // a different number is fine
  await rule({ refuse: () => banCro(o1, cro), expect: "ban_cro_unique" }); // a second case on the same organisation, same number
});
test("[ban] unique email_domain where not null", async () => {
  const dom = `${uid("d")}.ie`, dom2 = `${uid("d")}.ie`;
  const o1 = await org(), o2 = await org();
  for (const [o, d] of [[o1, dom], [o2, dom2]]) await su("insert into organisation_domain(organisation_id,domain,source,created_at) values($1,$2,'seed',now() - interval '3 days')", [o, d]);
  await rule({ ok: () => banDomain(o1, dom) });
  await rule({ ok: () => banDomain(o2, dom2) }); // a different domain is fine
  await rule({ refuse: () => banDomain(o1, dom), expect: "ban_domain_unique" });
});

// ---- [staff_role] unique (staff_user_id, role)
test("[staff_role] unique (staff_user_id, role)", async () => {
  const z = await staff();
  const grant = async (role: string) => {
    const rq = await propose("grant_role", "staff_role", z, A, { role });
    await decide(rq, B);
    return run("app_admin", A, "insert into staff_role(staff_user_id, role, approval_request_id) values ($1,$2,$3)", [z, role, rq]);
  };
  await rule({ ok: () => grant("content_editor") });
  await rule({ ok: () => grant("account_reviewer") }); // another role for the same person is fine
  await rule({ refuse: () => grant("content_editor"), expect: "staff_role_staff_user_id_role_key" });
});

// ---- [approval_request] target_id is required (natural key) and the two CONCURRENT rules
const insReq = (by: string, target: string | null) =>
  run("app_admin", by, target === null ? "insert into approval_request(kind,target_table) values ('threshold','setting')" : "insert into approval_request(kind,target_table,target_id) values ('threshold','setting',$1) returning id", target === null ? [] : [target]);

test("[approval_request] target_id is required, so a new row's request has a natural key (build 17)", async () => {
  await rule({ refuse: () => insReq(A, null), expect: "target_id" });
  await rule({ ok: () => insReq(A, uid("rule")) });
});
test("[approval_request] CONCURRENT: two pending requests for the same new row (same natural key): one is refused", async () => {
  const key = uid("general");
  const t = await race(2, (i) => insReq(i ? B : A, key));
  expect(t.ok.length).toBe(1);
  expect(t.errors[0]).toContain("approval_request_pending_unique");
  expect((await su("select count(*)::int n from approval_request where target_table='setting' and target_id=$1 and status='pending'", [key])).rows[0].n).toBe(1);
});
test("[approval_request] CONCURRENT: two people decide one request, one wins", async () => {
  const rq = await propose("threshold", "setting", uid("rule"), A);
  const t = await race(2, (i) =>
    run("app_admin", i ? B2 : B, "update approval_request set status=$2 where id=$1 and status='pending' returning id", [rq, i ? "refused" : "confirmed"]));
  expect(t.bad.length).toBe(0);
  expect(t.values.filter((v) => v.rowCount === 1).length).toBe(1);
  const r = (await su("select status, confirmed_by_staff_user_id c from approval_request where id=$1", [rq])).rows[0];
  expect(r.c).toBe(r.status === "confirmed" ? B : B2);
});

// ---- [sponsorship_statement] admin_on_behalf: the request is the administrator's, file key required, no signer, used once
async function adminJob() {
  const o = await org();
  const src = (await su("insert into job_source(kind,board) values ('portal',$1) returning id", [uid("b")])).rows[0].id;
  const job = (await su("insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url) values ($1,'admin_manual',$2,'Cook','Org','it','critical_skills','draft',now()+interval '20 days','https://example.test/a') returning id", [o, src])).rows[0].id as string;
  const ct = (await su("insert into consent_text(purpose,version,body) values ('sponsorship_statement',$1,'Wording') returning id", [uid("v")])).rows[0].id as string;
  return { o, job, ct };
}
const admin = async (x: { o: string; job: string; ct: string }, extra: Record<string, unknown> = {}) => {
  const c = { job_id: x.job, organisation_id: x.o, consent_text_id: x.ct, kind: "admin_on_behalf", confirmation_file_key: "f", entered_by_staff_id: A, ...extra };
  const k = Object.keys(c);
  return run("app_admin", A, `insert into sponsorship_statement(${k}) values (${k.map((_, i) => "$" + (i + 1))}) returning id`, k.map((n) => (c as Record<string, unknown>)[n]));
};
const jobRequest = async (job: string) => { const r = await propose("manual_post_sponsor_confirmed", "sponsorship_statement", job, A); await decide(r, B); return r; };

test("[sponsorship_statement] admin_on_behalf requires confirmation_file_key and approval_request_id and no signer", async () => {
  const x = await adminJob();
  const rq = await jobRequest(x.job);
  const mem = (await su("insert into portal_user(id,name,email,email_verified) values ($1,'M',$2,true) returning id", [uid("p"), `${uid("m")}@example.test`])).rows[0].id;
  const m = (await su("insert into membership(organisation_id,portal_user_id,role,status,is_signer) values ($1,$2,'recruiter','active',true) returning id", [x.o, mem])).rows[0].id;
  await rule({ refuse: () => admin(x, { approval_request_id: rq, confirmation_file_key: null }), expect: "check constraint" }); // no file key
  await rule({ refuse: () => admin(x), expect: "check constraint" }); // no approval_request_id named
  await rule({ refuse: () => admin(x, { approval_request_id: rq, signer_membership_id: m }), expect: "check constraint" }); // a signer
  await rule({ ok: () => admin(x, { approval_request_id: rq }) });
});
test("[sponsorship_statement] admin_on_behalf: the used request cannot be used again for the same job", async () => {
  const x = await adminJob();
  const rq = await jobRequest(x.job);
  await rule({ ok: () => admin(x, { approval_request_id: rq }) });
  await run("app_admin", A, "update sponsorship_statement set superseded_at = now() where job_id = $1", [x.job]);
  await rule({ refuse: () => admin(x, { approval_request_id: rq, confirmation_file_key: "f2" }), expect: "already used" });
});

// ---- [strike] level 3: a refused request and a confirmed request for another case (level 2 states both; level 3 shares the branch)
test("[strike] approval trigger at level 3: a refused request and a confirmed request for another case are refused; the case's own confirmed request works", async () => {
  const o = await org(), other = await org();
  const st = await mkStrike(o, A), stOther = await mkStrike(other, A);
  const apply = (rq: string) => run("app_admin", A, "update strike set outcome='strike', level=3, approval_request_id=$2 where id=$1", [st, rq]);
  const refused = await propose("strike_3", "strike", st, A);
  await decide(refused, T, "refused");
  const wrongCase = await propose("strike_3", "strike", stOther, A);
  await decide(wrongCase, T);
  await rule({ refuse: () => apply(refused), expect: "is refused, not confirmed" });
  await rule({ refuse: () => apply(wrongCase), expect: "is for strike/" + stOther });
  const good = await propose("strike_3", "strike", st, A); // the refused one no longer holds the pending slot
  await decide(good, T);
  await rule({ ok: () => apply(good) });
  expect((await su("select level, approval_request_id::text r from strike where id=$1", [st])).rows[0]).toMatchObject({ level: 3, r: good });
});

// ---- [14 pseudonymise] after erasure, no column of any table holds the person's id or email (the old check allowed one sent email row; it now holds a stand-in)
async function fullCandidate() {
  const c = uid("c"), email = `${c}@example.test`;
  await su("insert into candidate_user(id,name,email,email_verified) values ($1,'Pat Person',$2,true)", [c, email]);
  await su("insert into candidate_account(id,account_id,provider_id,user_id,updated_at) values ($1,$2,'credential',$3,now())", [uid("a"), c, c]);
  await su("insert into candidate_session(id,expires_at,token,updated_at,user_id) values ($1,now()+interval '1 day',$2,now(),$3)", [uid("ss"), uid("t"), c]);
  await su("insert into candidate_verification(id,identifier,value,expires_at) values ($1,$2,$3,now()+interval '1 day')", [uid("v"), email, uid("tok")]);
  await su("insert into candidate_profile(candidate_user_id,full_name,phone) values ($1,'Pat Person','0851234567')", [c]);
  await su("insert into notification(candidate_user_id,category,template_key,params) values ($1,'account','welcome',$2)", [c, JSON.stringify({ email })]);
  await su("insert into contact_message(surface,candidate_user_id,from_name,from_email,topic,body) values ('candidate_site',$1,'Pat',$2,'general','Hello')", [c, email]);
  const ct = (await su("insert into consent_text(purpose,version,body) values ('application',$1,'W') returning id", [uid("v")])).rows[0].id;
  await su("insert into consent_record(candidate_user_id,consent_text_id,details) values ($1,$2,$3)", [c, ct, JSON.stringify({ email })]);
  await su("insert into email_outbox(template,candidate_user_id,params,status) values ('welcome',$1,$2,'pending'),('welcome',$1,$2,'sent')", [c, JSON.stringify({ email })]);
  const other = uid("c");
  await su("insert into candidate_user(id,name,email,email_verified) values ($1,'Other',$2,true)", [other, `${other}@example.test`]);
  await su("insert into report(target_kind,target_candidate_user_id,reporter_candidate_user_id,reason,status) values ('profile',$1,$2,'other','open')", [other, c]);
  await su("insert into audit_event(kind,actor_candidate_user_id,subject_candidate_user_id,object_id,action,object_type,before,reason_text) values ('security',$1,$1,$1,'security.email_change','candidate_user',$2,$3)", [c, JSON.stringify({ email }), email]);
  return { c, email };
}
test("[14 pseudonymise] after erasure, a scan of every column of every table finds the person's id or email nowhere", async () => {
  const x = await fullCandidate(), y = await fullCandidate();
  const r = (await run("app_admin", null, "select private.erase_candidate($1, true) r", [x.c])).rows[0].r;
  expect(r.erased).toBe(true);
  const tables = (await su("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")).rows.map((t) => t.table_name as string);
  const scan = async (who: { c: string; email: string }) => {
    const hits: string[] = [];
    for (const t of tables) {
      const n = (await su(`select count(*)::int n from "${t}" x where x::text like $1 or x::text ilike $2`, [`%${who.c}%`, `%${who.email}%`])).rows[0].n;
      if (n) hits.push(`${t}: ${n}`);
    }
    return hits;
  };
  expect(await scan(x)).toEqual([]);
  expect((await scan(y)).length).toBeGreaterThan(5); // the scan does see a person who was not erased
});
