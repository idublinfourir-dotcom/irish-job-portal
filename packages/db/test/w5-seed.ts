// Fake queue rows for the admin overview, account review and fetched-job pages (step 16, P14 to P16): used by the page integration test and by the one-off
// script that fills a scratch database for screenshots. Everything is fake: no real name, company, number or address. The sign-up functions make the account
// review items (as the real sign-up does), a trigger makes the fetched-job items.
import type pg from "pg";
import { fixtures } from "./fixtures";

type DbLike = { name: string; pool: (role: never) => pg.Pool };
const HOURS = (h: number) => `now() - interval '${h} hours'`;

export async function seedW5(db: DbLike) {
  const { F, id } = fixtures(db) as unknown as { id: (p: string) => string; F: { org: (o?: Record<string, unknown>) => Promise<number>; portal: (o?: Record<string, unknown>) => Promise<string>; cro: (o?: Record<string, unknown>) => Promise<unknown>; wrc: (o?: Record<string, unknown>) => Promise<unknown> } };
  const su = (db.pool as (r: string) => pg.Pool)("postgres");
  const portal = (db.pool as (r: string) => pg.Pool)("app_portal");
  const age = async (org: string | number, hours: number) => su.query("update review_item set created_at = " + HOURS(hours) + " where queue = 'account_review' and organisation_id = $1", [org]);
  const out: Record<string, { org: string; item: string; user?: string }> = {};
  const item = async (org: string | number) => (await su.query("select id::text from review_item where queue = 'account_review' and organisation_id = $1 order by id desc limit 1", [org])).rows[0].id as string;

  /** A first-time employer or an agency registering (always goes to review). */
  async function registered(key: string, o: { name: string; email: string; person: string; kind?: "employer" | "agency"; cro?: string; hours: number }) {
    const user = await F.portal({ email: o.email });
    await su.query("update portal_user set name = $2 where id = $1", [user, o.person]);
    const kind = o.kind ?? "employer";
    if (kind === "employer" && o.cro) await F.cro({ number: o.cro, name: o.name });
    if (kind === "agency") await F.wrc({ number: "EA9" + o.cro, name: o.name });
    const r = (await portal.query("select private.register_organisation($1, $2, $3, $4, $5) r", [user, kind, o.name, kind === "employer" ? (o.cro ?? id("cro")) : null, kind === "agency" ? "EA9" + o.cro : null])).rows[0].r;
    out[key] = { org: String(r.organisation_id), item: await item(r.organisation_id), user };
    await age(r.organisation_id, o.hours);
  }
  /** A claim of an existing sponsor's page by a new login. */
  async function claimed(key: string, o: { name: string; email: string; person: string; hours: number }) {
    const org = await F.org({ status: "unclaimed", name: o.name });
    const user = await F.portal({ email: o.email });
    await su.query("update portal_user set name = $2 where id = $1", [user, o.person]);
    await portal.query("select private.claim_organisation($1, $2)", [user, org]);
    out[key] = { org: String(org), item: await item(org), user };
    await age(org, o.hours);
  }
  await registered("harbourline", { name: "Fake Harbourline Hotels Ltd", email: "fake.owner1@gmail.com", person: "Fake Owner One", cro: "810001", hours: 5 });
  await registered("agency", { name: "Fake Example Recruitment Ltd", email: "fake.owner2@fakeagency.example.test", person: "Fake Owner Two", kind: "agency", cro: "20001", hours: 4 });
  await claimed("tallis", { name: "Fake Tallis Analytics Ltd", email: "fake.owner3@fake-tallis.example.test", person: "Fake Owner Three", hours: 3 });
  await registered("shared", { name: "Fake Boyne Civil Engineering", email: "hr@fake-boyne.example.test", person: "Fake Owner Four", cro: "810004", hours: 1 });
  await registered("asked", { name: "Fake Lakeside Care Homes", email: "fake.owner5@fake-lakeside.example.test", person: "Fake Owner Five", cro: "810005", hours: 30 });
  await registered("approved", { name: "Fake Approved Foods Ltd", email: "fake.owner6@fake-foods.example.test", person: "Fake Owner Six", cro: "810006", hours: 50 });
  await registered("rejected", { name: "Fake Rejected Trading Ltd", email: "fake.owner7@fake-trading.example.test", person: "Fake Owner Seven", cro: "810007", hours: 60 });
  // a company the owner was asked a question about, and one the owner answered
  await su.query("update organisation set status = 'needs_info' where id = $1", [out.asked!.org]);
  await su.query("update review_item set detail = detail || jsonb_build_object('answer', 'Fake answer: we are a care home group, our website is fake-lakeside.example.test.', 'answered_at', now()::text) where id = $1", [out.asked!.item]);
  // decided items (the staff column is left null: a decision by a staff member is made by the test through the real functions)
  await su.query("update review_item set status = 'done', outcome = 'approved', decided_at = now() - interval '2 hours' where id = $1", [out.approved!.item]);
  await su.query("update organisation set status = 'verified', verified_at = now() where id = $1", [out.approved!.org]);
  await su.query("update review_item set status = 'done', outcome = 'rejected', decided_at = now() - interval '3 hours' where id = $1", [out.rejected!.item]);
  await su.query("update organisation set status = 'rejected' where id = $1", [out.rejected!.org]);

  // ===== fetched jobs =====
  const src = (await su.query("insert into job_source(kind, board) values ('careers_page', $1) returning id", [id("board")])).rows[0].id;
  const jobs: Record<string, { job: string; item: string }> = {};
  async function queued(key: string, o: { title: string; employer: string; stage: string; reason: string; code: string | null; county: string; text: string; evidence: string | null; hours: number }) {
    const advert = (await su.query(
      "insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result, stage, reason, quoted_evidence, matcher_model) values ($1, $2, 'https://jobs.example.test/a', $3, $4, 'queued', $5, $6, $7, 'fake-model') returning id::text",
      [src, id("ext"), o.title, o.employer, o.stage, o.reason, o.evidence])).rows[0].id as string;
    const org = await F.org({ name: o.employer });
    const job = (await su.query(
      `insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, occupation_code, permit_type, status, closes_at, search_vector, own_page_url)
       values ($1, 'fetched', $2, $3, $4, $5, $6, 'IT', $7, 'critical_skills', 'in_review', 'infinity', to_tsvector('english', $4), 'https://jobs.example.test/a') returning id::text`,
      [org, src, advert, o.title, o.employer, o.county, o.code])).rows[0].id as string;
    await su.query("insert into job_text(job_id, advert_text) values ($1, $2)", [job, o.text]);
    const it = (await su.query("select id::text from review_item where queue = 'fetched_job' and job_id = $1", [job])).rows[0].id as string;
    await su.query("update review_item set created_at = " + HOURS(o.hours) + " where id = $1", [it]);
    jobs[key] = { job, item: it };
  }
  const PAY = "Join our fake team building fake things. The salary is €60,000 a year. The role is a permanent position.";
  await queued("contract", { title: "Fake Platform Engineer, Medical Systems", employer: "Fake Northquay Hospital Group", stage: "7 contract unclear (admin queue)", reason: "specified purpose", code: "2134", county: "Cork", text: PAY + " This is a specified purpose contract with a view to permanency.", evidence: "...recruiting for our team. This is a specified purpose contract with a view to permanency...", hours: 9 });
  await queued("occupation", { title: "Fake Data Analyst", employer: "Fake Stripe Test Ltd", stage: "5 unsure occupation (admin queue)", reason: "unclear tech role", code: null, county: "Dublin", text: PAY, evidence: null, hours: 7 });
  await queued("occupation2", { title: "Fake Process Technician", employer: "Fake Intel Test Ltd", stage: "5 unsure occupation (admin queue)", reason: "two codes", code: "2134", county: "Kildare", text: "Join our fake team building fake things. Pay is discussed later.", evidence: "...process technician for the line...", hours: 5 });
  await queued("irish", { title: "Fake Field Service Engineer", employer: "Fake Siemens Test GmbH", stage: "3 unsure Irish employer (admin queue)", reason: "no Irish address", code: "2134", county: "Dublin", text: PAY, evidence: "...our Dublin office...", hours: 3 });
  await queued("script", { title: "<script>alert(1)</script> Fake Risk Analyst", employer: "Fake AIB Test & Co", stage: "7 contract unclear (admin queue)", reason: "<b>bold</b> reason", code: "2134", county: "Dublin", text: PAY + " <img src=x onerror=alert(1)>", evidence: "...\"quoted\" <script>x</script> evidence...", hours: 2 });

  return { acc: out, jobs };
}
