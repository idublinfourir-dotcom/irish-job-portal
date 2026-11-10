// The database writes of the fetcher. Design: step5/L8-DESIGN.md section 3. Every statement is a constant string with
// parameters; no value is ever put into SQL text (test/store.security.test.ts reads this file to check it).
// Connected as app_fetcher: no network call while a transaction is open, no `set` without `local`, no advisory locks.
import type pg from "pg";
import type { AdvertRow, Db, JobRow } from "./types";

const UPSERT_SOURCE = "insert into job_source(kind, board) values ($1, $2) on conflict (kind, board) do update set board = excluded.board returning id";
const START_RUN = "insert into fetch_run(job_source_id) values ($1) returning id";
const KNOWN = "select external_id from fetched_advert where job_source_id = $1";
// One statement is one transaction: seen again, run row and source row move together (3.1 steps 6 and 7).
const FINISH =
  "with seen as (update fetched_advert set last_seen_at = $3 where job_source_id = $1 and external_id = any($4::text[]) returning 1), " +
  "run as (update fetch_run set finished_at = $3, seen = $5, new = $6, closed = 0 where id = $2 returning 1) " +
  "update job_source set last_ok_at = $3, last_error = null where id = $1";
const FAIL =
  "with run as (update fetch_run set finished_at = $2, error = $3 where id = $1 returning 1) update job_source set last_error = $3 where id = $4";
const INSERT_ADVERT =
  "insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result, stage, reason, quoted_evidence, matcher_model) " +
  "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id";
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
const INSERT_JOB =
  "insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, occupation_code, permit_type, badge, " +
  "salary_low, salary_high, pass_route, status, closes_at, search_vector, own_page_url) " +
  "values ($1, 'fetched', $2, $3, $4::text, $5::text, $6, $7, $8, 'critical_skills', $9, $10, $11, $12, $13, 'infinity', " +
  "to_tsvector('english', $4::text || ' ' || $5::text || ' ' || $14::text), $15) returning id";
const INSERT_TEXT = "insert into job_text(job_id, advert_text) values ($1, $2)";

// Postgres refuses U+0000 in text.
const clean = <T extends string | null>(v: T): T => (v === null ? v : (v.replace(/\u0000/g, "") as T));
const cut = (v: string, n: number) => [...clean(v)].slice(0, n).join("");

export type BoardRun = { sourceId: number; runId: number; known: Set<string> };

/** 3.1 steps 1 to 3: the source row, a new run row, and the ids already saved. Three statements. */
export async function startBoard(db: Db, kind: string, board: string): Promise<BoardRun> {
  const s = await db.query<{ id: string }>(UPSERT_SOURCE, [clean(kind), clean(board)]);
  const sourceId = Number(s.rows[0]!.id);
  const r = await db.query<{ id: string }>(START_RUN, [sourceId]);
  const known = await db.query<{ external_id: string }>(KNOWN, [sourceId]);
  return { sourceId, runId: Number(r.rows[0]!.id), known: new Set(known.rows.map((x) => x.external_id)) };
}

/** 3.1 steps 6 and 7 in one statement: seen adverts move, the run row closes, the source row says it worked. */
export async function finishBoard(db: Db, run: BoardRun, now: Date, seen: readonly string[], added: number): Promise<void> {
  await db.query(FINISH, [run.sourceId, run.runId, now, seen.map(clean), seen.length, added]);
}

/** A fetch that failed: the run row and the source row say why. `last_ok_at` stays. Message cut to 300 code points. */
export async function failBoard(db: Db, run: BoardRun, now: Date, message: string): Promise<void> {
  await db.query(FAIL, [run.runId, now, cut(message, 300), run.sourceId]);
}

const insertAdvert = (c: Pick<pg.PoolClient, "query">, sourceId: number, a: AdvertRow) =>
  c
    .query<{ id: string }>(INSERT_ADVERT, [
      sourceId, clean(a.externalId), clean(a.url), clean(a.title), clean(a.employerName), a.result, clean(a.stage), clean(a.reason), clean(a.quotedEvidence), clean(a.matcherModel),
    ])
    .then((r) => Number(r.rows[0]!.id));

/** 3.2: a rejected advert is one statement. No job, no text, no organisation. */
export async function saveReject(db: Db, sourceId: number, advert: AdvertRow): Promise<void> {
  await insertAdvert(db, sourceId, { ...advert, result: "rejected" });
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
export async function saveJob(db: Db, sourceId: number, advert: AdvertRow, job: JobRow, text: string): Promise<AdvertRow["result"]> {
  const run = () =>
    inTransaction(db, async (c) => {
      const org = await employerId(c, clean(job.employerName));
      const advertId = await insertAdvert(c, sourceId, advert);
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
    await saveReject(db, sourceId, { ...advert, stage: e.stage });
    return "rejected";
  }
}
