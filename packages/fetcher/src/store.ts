// The database writes of the fetcher. Design: step5/L8-DESIGN.md section 3. Every statement is a constant string with
// parameters; no value is ever put into SQL text (test/store.security.test.ts reads this file to check it).
// Connected as app_fetcher: no network call while a transaction is open, no `set` without `local`, no advisory locks.
import type pg from "pg";
import { changeOf } from "./plan";
import type { AdvertRow, Change, Db, JobRow, Known, Plan } from "./types";

const UPSERT_SOURCE = "insert into job_source(kind, board) values ($1, $2) on conflict (kind, board) do update set board = excluded.board returning id";
const START_RUN = "insert into fetch_run(job_source_id) values ($1) returning id";
// Every advert row of the board with its job, gone ones too (design 3.8). The fetcher reads the job's status, never `result`.
const KNOWN =
  "select external_id, f.id as advert_id, f.content_hash, f.gone_at, j.id as job_id, j.status, j.close_reason " +
  "from fetched_advert f left join job j on j.fetched_advert_id = f.id where f.job_source_id = $1";
// One statement is one transaction (3.1 steps 6 and 7, 3.8 "advert gone"): seen again, adverts gone, their live jobs closed with their
// text deleted, run row and source row move together. Only after a fetch that returned ids (cardinality check), and only live jobs
// (so in_review and hidden jobs are never touched). An advert that was not seen but is saved as gone stays out of `seen` here.
const FINISH =
  "with seen as (update fetched_advert set last_seen_at = $3 where job_source_id = $1 and external_id = any($4::text[]) returning 1), " +
  "gone as (update fetched_advert set gone_at = $3 where job_source_id = $1 and gone_at is null and cardinality($4::text[]) > 0 and external_id <> all($4::text[]) returning 1), " +
  "closed as (update job set status = 'closed', close_reason = 'closed', search_vector = null where status = 'live' and cardinality($4::text[]) > 0 and fetched_advert_id in " +
  "(select id from fetched_advert where job_source_id = $1 and external_id <> all($4::text[])) returning id), " +
  "texts as (delete from job_text where job_id in (select id from closed) returning 1), " +
  "run as (update fetch_run set finished_at = $3, seen = $5, new = $6, closed = (select count(*) from closed) + $7 where id = $2 returning 1) " +
  "update job_source set last_ok_at = $3, last_error = null where id = $1 returning (select count(*) from closed)::int as gone_closed";
// A board with no good fetch for STALE_BOARD_DAYS (W1b: Workday, skipped since 18 Nov 2026; a board dropped from boards.json): its live jobs
// close as 'source_stale' with their text deleted, and their adverts are marked gone, so a later good fetch that lists one hands it back with
// its text and the usual reopen brings it back. A board that never had a good fetch counts from the advert's first sighting. Only live fetched
// jobs: in_review, hidden and staff-closed jobs are never touched. One statement.
export const STALE_BOARD_DAYS = 7;
export const CLOSE_STALE =
  "with c as (update job j set status = 'closed', close_reason = 'source_stale', closed_at = $1, search_vector = null from fetched_advert f join job_source s on s.id = f.job_source_id " +
  "where j.fetched_advert_id = f.id and j.source = 'fetched' and j.status = 'live' and coalesce(s.last_ok_at, f.first_seen_at) < $1::timestamptz - make_interval(days => $2::int) " +
  // the same test on the board alone, as a list read once, so the plan starts from the few stale boards and reads their adverts by index
  "and f.job_source_id = any(array(select id from job_source where last_ok_at is null or last_ok_at < $1::timestamptz - make_interval(days => $2::int))) " +
  "returning j.id, j.fetched_advert_id), " +
  "t as (delete from job_text where job_id in (select id from c) returning 1), " +
  "g as (update fetched_advert set gone_at = $1 where id in (select fetched_advert_id from c) and gone_at is null returning 1) " +
  "select count(*)::int as n from c";
// #261: the HSE switch is off, so no live job may rest on the public pay route. They close, their text goes, and their adverts lose the hash, so the next read assesses them
// as any employer's. ponytail: switched on again, an advert comes back when its text changes, as after any rules change.
export const CLOSE_PUBLIC_PAY =
  "with c as (update job set status = 'closed', close_reason = 'recheck_failed', search_vector = null where source = 'fetched' and status = 'live' and pass_route = 'public_pay' " +
  "returning id, fetched_advert_id), t as (delete from job_text where job_id in (select id from c)), " +
  "a as (update fetched_advert set content_hash = null where id in (select fetched_advert_id from c)) select count(*)::int as n from c";
const FAIL =
  "with run as (update fetch_run set finished_at = $2, error = $3 where id = $1 returning 1) update job_source set last_error = $3 where id = $4";
const INSERT_ADVERT =
  "insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result, stage, reason, quoted_evidence, matcher_model, content_hash) " +
  "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id";
// A known advert assessed again: the row is rewritten, it came back (gone_at null), and it has its hash.
const UPDATE_ADVERT =
  "update fetched_advert set url = $3, title = $4, employer_name = $5, result = $6, stage = $7, reason = $8, quoted_evidence = $9, matcher_model = $10, " +
  "content_hash = $11, gone_at = null where id = $1 and job_source_id = $2 returning id";
// Staff hold the job, or staff closed it: only `gone_at` and the hash move, never the job or its text.
const SETTLE = "update fetched_advert set content_hash = $2, gone_at = null where id = $1";
// The key is computed in SQL with the exact expression of job_defaults (0002:135), never in TypeScript.
const FIND_EMPLOYER =
  "with k as (select btrim(regexp_replace(lower($1::text), '[^a-z0-9]+', ' ', 'g')) as norm) " +
  "select k.norm, t.id, t.status from k left join organisation_name n on n.normalised_name = k.norm and n.organisation_id is not null " +
  "left join organisation o on o.id = n.organisation_id left join organisation t on t.id = coalesce(o.merged_into_id, o.id) " +
  "order by (n.kind = 'legal') desc, n.id limit 1";
const SLUGS = "select slug from organisation where slug = $1 or slug like $2";
const INSERT_ORG = "insert into organisation(slug, display_name, kind) values ($1, $2, 'employer') returning id";
const INSERT_NAME =
  "insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $3, 'alias', 'job_site')";
export const INSERT_JOB =
  "insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, occupation_code, permit_type, badge, " +
  "salary_low, salary_high, pass_route, status, closes_at, search_vector, own_page_url) " +
  "values ($1, 'fetched', $2, $3, $4::text, $5::text, $6, $7, $8, 'critical_skills', $9, $10, $11, $12, $13, 'infinity', " +
  "to_tsvector('english', $4::text || ' ' || $5::text || ' ' || $14::text), $15) returning id";
const INSERT_TEXT = "insert into job_text(job_id, advert_text) values ($1, $2)";
const UPSERT_TEXT = "insert into job_text(job_id, advert_text) values ($1, $2) on conflict (job_id) do update set advert_text = excluded.advert_text";
// 3.8: new content for a job the fetcher owns. $2 is the status the job must be in now, so a job staff moved meanwhile is left alone (no row, so the
// caller throws and rolls back). Never the organisation (finding 7). The status changes: live to live, closed to live (reopen), live to in_review.
const UPDATE_JOB =
  "update job set title = $3::text, employer_name = $4::text, county = $5, sector = $6, occupation_code = $7, badge = $8, salary_low = $9, salary_high = $10, " +
  "pass_route = $11, status = $12, close_reason = null, closed_at = null, own_page_url = $13, " +
  "search_vector = to_tsvector('english', $3::text || ' ' || $4::text || ' ' || $14::text) where id = $1 and status = $2";
// A live job that now fails its check: its own close reason, no search vector, no text.
export const CLOSE_RECHECK =
  "with c as (update job set status = 'closed', close_reason = 'recheck_failed', search_vector = null where id = $1 and status = 'live' returning id), " +
  "t as (delete from job_text where job_id in (select id from c)) select count(*)::int as n from c";

// Postgres refuses U+0000 in text.
const clean = <T extends string | null>(v: T): T => (v === null ? v : (v.replace(/\u0000/g, "") as T));
const cut = (v: string, n: number) => [...clean(v)].slice(0, n).join("");

export type BoardRun = { sourceId: number; runId: number; rows: Map<string, Known> };

/** 3.1 steps 1 to 3: the source row, a new run row, and every advert row saved for the board (3.8). Three statements. */
export async function startBoard(db: Db, kind: string, board: string): Promise<BoardRun> {
  const s = await db.query<{ id: string }>(UPSERT_SOURCE, [clean(kind), clean(board)]);
  const sourceId = Number(s.rows[0]!.id);
  const r = await db.query<{ id: string }>(START_RUN, [sourceId]);
  const res = await db.query<{ external_id: string; advert_id?: string; content_hash?: string | null; gone_at?: Date | null; job_id?: string | null; status?: string | null; close_reason?: string | null }>(KNOWN, [sourceId]);
  const rows = new Map<string, Known>();
  for (const x of res.rows)
    rows.set(x.external_id, {
      advertId: Number(x.advert_id), hash: x.content_hash ?? null, gone: x.gone_at != null, jobId: x.job_id == null ? null : Number(x.job_id), status: x.status ?? null, closeReason: x.close_reason ?? null,
    });
  return { sourceId, runId: Number(r.rows[0]!.id), rows };
}

/**
 * 3.1 steps 6 and 7 in one statement: seen adverts move, adverts not seen go missing and their live jobs close, the run row closes, the source row says
 * it worked. `rechecked` is the number of live jobs closed earlier in this run because their changed advert fails. Returns the jobs closed in all.
 */
export async function finishBoard(db: Db, run: BoardRun, now: Date, seen: readonly string[], added: number, rechecked = 0): Promise<number> {
  const r = await db.query<{ gone_closed: number }>(FINISH, [run.sourceId, run.runId, now, seen.map(clean), seen.length, added, rechecked]);
  return Number(r.rows[0]?.gone_closed ?? 0) + rechecked;
}

/** Closes the live jobs of every board with no good fetch for `days` (default STALE_BOARD_DAYS) before `now`. Returns how many closed. */
export async function closeStale(db: Db, now: Date, days = STALE_BOARD_DAYS): Promise<number> {
  return Number((await db.query<{ n: number }>(CLOSE_STALE, [now, days])).rows[0]?.n ?? 0);
}

/** Closes every live fetched job on the public pay route (the HSE switch is off). Returns how many closed. */
export async function closePublicPay(db: Db): Promise<number> {
  return Number((await db.query<{ n: number }>(CLOSE_PUBLIC_PAY)).rows[0]?.n ?? 0);
}

/** A fetch that failed: the run row and the source row say why. `last_ok_at` stays. Message cut to 300 code points. */
export async function failBoard(db: Db, run: BoardRun, now: Date, message: string): Promise<void> {
  await db.query(FAIL, [run.runId, now, cut(message, 300), run.sourceId]);
}

const advertParams = (a: AdvertRow, hash: string) => [
  clean(a.url), clean(a.title), clean(a.employerName), a.result, clean(a.stage), clean(a.reason), clean(a.quotedEvidence), clean(a.matcherModel), hash,
];
/** Writes the advert row: a new row, or (`known`) the rewrite of the row the board already has. Returns its id. */
const writeAdvert = async (c: Pick<pg.PoolClient, "query">, sourceId: number, a: AdvertRow, hash: string, known?: Known) => {
  const r = known
    ? await c.query<{ id: string }>(UPDATE_ADVERT, [known.advertId, sourceId, ...advertParams(a, hash)])
    : await c.query<{ id: string }>(INSERT_ADVERT, [sourceId, clean(a.externalId), ...advertParams(a, hash)]);
  if (!r.rows[0]) throw new Error("advert row not found");
  return Number(r.rows[0].id);
};

/** 3.2: a rejected advert is one statement. No job, no text, no organisation. With `known` it rewrites the existing row. */
export async function saveReject(db: Db, sourceId: number, advert: AdvertRow, hash: string, known?: Known): Promise<void> {
  await writeAdvert(db, sourceId, { ...advert, result: "rejected" }, hash, known);
}

/** An advert that came back or changed but needs no job write: only `gone_at` and the hash move (design 3.8 first row, and staff-closed jobs). */
export async function settleAdvert(db: Db, known: Known, hash: string | null): Promise<void> {
  await db.query(SETTLE, [known.advertId, hash]);
}

// The employer cannot take a live job: the advert is saved as rejected instead (3.5 steps 2 and 3).
class Refused extends Error {
  constructor(readonly stage: string) {
    super(stage);
  }
}

/** 3.5: find the employer, or add an unclaimed organisation and its alias name. Inside the caller's transaction. */
async function employerId(c: pg.PoolClient, name: string): Promise<number> {
  const found = await c.query<{ norm: string; id: string | null; status: string | null }>(FIND_EMPLOYER, [name]);
  const { norm, id, status } = found.rows[0]!;
  if (norm === "") throw new Refused("0 no employer name");
  if (id !== null) {
    if (status === "suspended" || status === "banned" || status === "closed") throw new Refused("0 employer suspended, banned or closed");
    return Number(id);
  }
  const base = norm.replace(/ /g, "-");
  const taken = new Set((await c.query<{ slug: string }>(SLUGS, [base, `${base}-%`])).rows.map((r) => r.slug));
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  const org = Number((await c.query<{ id: string }>(INSERT_ORG, [slug, name])).rows[0]!.id);
  await c.query(INSERT_NAME, [org, name, norm]);
  return org;
}

async function inTransaction<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === "23505";

/**
 * 3.3 and 3.4: advert, job and text in one transaction. Returns the result that was saved: the plan's, or "rejected"
 * when the employer cannot take a job. A unique violation (two boards adding one employer at once) runs it once more.
 */
export async function saveJob(db: Db, sourceId: number, advert: AdvertRow, job: JobRow, text: string, hash: string, known?: Known): Promise<AdvertRow["result"]> {
  const run = () =>
    inTransaction(db, async (c) => {
      const org = await employerId(c, clean(job.employerName));
      const advertId = await writeAdvert(c, sourceId, advert, hash, known);
      const queued = job.status === "in_review";
      const j = await c.query<{ id: string }>(INSERT_JOB, [
        org, sourceId, advertId, clean(job.title), clean(job.employerName), clean(job.county), clean(job.sector), clean(job.occupationCode),
        queued ? null : "critical_skills_eligible", job.salaryLow, job.salaryHigh, queued ? null : job.passRoute, job.status, clean(text), clean(job.ownPageUrl),
      ]);
      await c.query(INSERT_TEXT, [Number(j.rows[0]!.id), clean(text)]);
      return advert.result;
    });
  try {
    try {
      return await run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return await run();
    }
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    await saveReject(db, sourceId, { ...advert, stage: e.stage }, hash, known);
    return "rejected";
  }
}

/**
 * 3.8: a known advert assessed again, one transaction. `changeOf` picks the write. Returns it, so the caller can count. A job that is no longer in the
 * status the fetcher read (staff moved it meanwhile) matches no row: the transaction rolls back and the id comes back next run.
 */
export async function saveKnown(db: Db, sourceId: number, k: Known, p: Exclude<Plan, { action: "defer" }>, hash: string): Promise<Change> {
  const change = changeOf(k, p);
  if (change === "advert") await writeAdvert(db, sourceId, p.advert, hash, k);
  else if (change === "insert") await saveJob(db, sourceId, p.advert, (p as Extract<Plan, { action: "job" }>).job, (p as Extract<Plan, { action: "job" }>).text, hash, k);
  else
    await inTransaction(db, async (c) => {
      await writeAdvert(c, sourceId, p.advert, hash, k);
      if (change === "close") {
        if (Number((await c.query<{ n: number }>(CLOSE_RECHECK, [k.jobId])).rows[0]?.n) !== 1) throw new Error("job is no longer live");
        return;
      }
      const { job, text } = p as Extract<Plan, { action: "job" }>;
      const queued = job.status === "in_review";
      const u = await c.query(UPDATE_JOB, [
        k.jobId, change === "reopen" ? "closed" : "live", clean(job.title), clean(job.employerName), clean(job.county), clean(job.sector), clean(job.occupationCode),
        queued ? null : "critical_skills_eligible", job.salaryLow, job.salaryHigh, queued ? null : job.passRoute, job.status, clean(job.ownPageUrl), clean(text),
      ]);
      if (u.rowCount !== 1) throw new Error("job is no longer in the status it was read in");
      await c.query(UPSERT_TEXT, [k.jobId, clean(text)]);
    });
  return change;
}
