// Performance (P3, P12, P13): the pages and time of private.company_edit and private.company_close (as app_portal) and private.member_limit_set (as app_admin),
// on a table of 500 companies, 10,000 jobs and 5,000 members, where the company closed has 200 open jobs, 20 active members and 5 pending invites.
// Pages are counted with EXPLAIN (ANALYZE, BUFFERS) of the one select that calls each function (the function's own statements count in it), inside a
// rolled-back transaction, warm pass then measured pass. Fake data only; the email stays in the outbox.
import type { ClientBase } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../db";
import { costOf } from "./pages";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
// Measured on 18 Nov 2026: edit 47 pages 0.51 ms, close 6,443 pages 13.8 ms, limit 41 pages 0.5 ms. Page limits are about 1.5 times that, time limits about 10 times.
export const EDIT_PAGES = 70;
export const CLOSE_PAGES = 9700; // 200 jobs closed (each row, its indexes and its triggers), 25 memberships, 20 notices and 20 emails
export const LIMIT_PAGES = 60;
export const EDIT_MS = 10;
export const CLOSE_MS = 150;
export const LIMIT_MS = 10;
let db: TestDb;
let owner: string, staff: string, org: number, name: string;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  const src = (await su.query("select id from job_source where kind = 'portal' and board = 'employer'")).rows[0].id;
  await su.query("insert into portal_user(id,name,email,email_verified,updated_at) select 'u'||g,'Fake','u'||g||'@example.test',true,now() from generate_series(1,5000) g");
  await su.query("insert into organisation(slug,display_name,kind,status) select 'o'||g,'Fake Org '||g,'employer','verified' from generate_series(1,500) g");
  // 10 members a company; the first company (the one closed) gets 20 of them and 5 invites
  await su.query(`insert into membership(organisation_id,portal_user_id,role,status,joined_at)
    select (select min(id) from organisation) + case when g <= 20 then 0 else 1 + (g - 21) % 499 end, 'u'||g, case when g = 1 or g between 21 and 519 then 'account_owner' else 'recruiter' end, 'active', now()
      from generate_series(1,5000) g`);
  ({ id: org, display_name: name } = (await su.query("select id, display_name from organisation order by id limit 1")).rows[0]);
  await su.query(`insert into membership(organisation_id,invited_email,role,status,invite_token_hash,invite_expires_at)
    select $1, 'inv'||g||'@example.test', 'poster', 'invited', encode(sha256(convert_to('t'||g,'utf8')),'hex'), now() + interval '7 days' from generate_series(1,5) g`, [org]);
  owner = (await su.query("select portal_user_id from membership where organisation_id = $1 and role = 'account_owner' and status = 'active'", [org])).rows[0].portal_user_id;
  await su.query(
    `insert into job(organisation_id,source,job_source_id,title,employer_name,sector,permit_type,status,closes_at,own_page_url,salary_low,search_vector)
     select case when g <= 200 then $2 else (select min(id) from organisation) + 1 + g % 499 end, 'employer', $1, 'Fake role '||g, 'Fake', 'IT', 'critical_skills', 'live', now() + interval '20 days', 'https://example.test', 30000 + g, 'x'
       from generate_series(1,10000) g`, [src, org]);
  await su.query("insert into staff_user(id,name,email,email_verified,status) values ('s1','Fake Staff','s1@example.test',true,'active')");
  await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ('s1','account_reviewer',true)");
  staff = "s1";
  await su.query("analyze");
});
afterAll(() => db.drop());

async function pagesOf(c: ClientBase, text: string, values: unknown[]) {
  const plans: unknown[] = [];
  for (let pass = 0; pass < 2; pass++) {
    await c.query("begin");
    plans.push((await c.query(`explain (analyze, buffers, serialize, format json) ${text}`, values)).rows[0]["QUERY PLAN"]);
    await c.query("rollback");
  }
  return costOf(text, plans[1]);
}

it("the profile edit, the close of 200 jobs and 20 members, and the limit change stay inside their page and time budgets", async () => {
  const p = await db.pool("app_portal").connect(), a = await db.pool("app_admin").connect();
  try {
    expect((await p.query("select count(*)::int n from job where organisation_id = $1 and status = 'live'", [org])).rows[0].n).toBe(200);
    const edit = await pagesOf(p, "select private.company_edit($1, $2, $3, $4)", [owner, "Fake description", "https://fake.example.test", "Cork"]);
    const close = await pagesOf(p, "select private.company_close($1, $2)", [owner, name]);
    const limit = await pagesOf(a, "select private.member_limit_set($1, $2, 30, 'growing_team')", [staff, org]);
    console.log(`company perf: edit ${edit.pages} pages ${edit.ms} ms; close ${close.pages} pages ${close.ms} ms; limit ${limit.pages} pages ${limit.ms} ms`);
    expect(edit.pages).toBeLessThanOrEqual(EDIT_PAGES);
    expect(close.pages).toBeLessThanOrEqual(CLOSE_PAGES);
    expect(limit.pages).toBeLessThanOrEqual(LIMIT_PAGES);
    expect(edit.ms).toBeLessThan(EDIT_MS);
    expect(close.ms).toBeLessThan(CLOSE_MS);
    expect(limit.ms).toBeLessThan(LIMIT_MS);
    // the close really did its work in the measured pass (then rolled back)
    await p.query("begin");
    expect((await p.query("select private.company_close($1, $2) r", [owner, name])).rows[0].r).toMatchObject({ jobsClosed: 200, membershipsEnded: 20, invitesCancelled: 5 });
    await p.query("rollback");
  } finally {
    p.release();
    a.release();
  }
});
