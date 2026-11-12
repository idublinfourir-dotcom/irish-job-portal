// The page gate (design 23-database-design.md, section 8, "CI page check"). On fake data at full size, with every live job row rewritten
// once, every page form is measured as app_candidate in two states: straight after the rewrite with no vacuum (autovacuum off for job),
// and after `vacuum (analyze)`. A page is the page's own query plus the signed-in shared queries, counting planning, execution and
// serialisation together. Any page over PAGE_LIMIT fails the run. A change that pushes a page over is fixed in the design, not in the limit.
// Run it with: npm run test:perf (see the hand-over for the wiring), or: npx vitest run --config packages/db/test/perf/vitest.config.ts
//
// Roles: postgres loads the fill and rewrites the rows (it can switch triggers off), portal_owner vacuums and sets table options,
// and app_candidate, the role the candidate site runs as, takes every measurement. Fake data only.
import pg from "pg";
import { CHAIN_RULES_V1 } from "@portal/rules";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, tx, urlFor, type TestDb } from "../db";
import { GOOD_RUN_TODAY, utcDayStart } from "../../src/fetch-guard-cli";
import { LAST_5_YEARS } from "../../src/dete";
import { JOB_QUERY, listQuery, SORTS as LIST_SORTS, type Cursor, type Sort as ListSort } from "../../src/search";
import { approveAccount, claimReview, REVIEW_AFTER, REVIEW_DECIDE, REVIEW_FIRST, REVIEW_ITEM, REVIEW_LOCK, listAccountReviews } from "../../src/account-review";
import { REPORTS_AFTER, REPORTS_FIRST } from "../../src/trust-safety";
import { approve, claim, DECIDE, listQueue, LOCK, QUEUE_ACT, QUEUE_AFTER, QUEUE_FIRST, QUEUE_ITEM, RELEASE, STALE_AFTER, TAKE_OVER } from "../../src/admin-queue";
import { fill } from "./fill";
import { costOf, measurePages, pageOver, type PageCost, type Statement } from "./pages";

export const PAGE_LIMIT = 1000;
// The Search module's pages also have a time budget: execution plus serialisation of all the page's own statements, warm, on this machine.
// The measured worst is a few milliseconds; the limit is far above that so a slow runner does not fail it, and a plan that walks the table does.
export const MS_LIMIT = 150;

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

// ===== QUERY FORMS: ported as they are from schema-trial-3/50-pages.py (design section 3). The job list and the job page now run the Search
// module's own statements (src/search.ts); what stays here is the sector browse and the filter and search forms, which the module does not have yet. =====
const LIVE = "status='live' and closes_at > now()";
const LIST = "job.id, job.title, job.employer_name, job.county, job.salary_low, job.salary_high, job.pass_route, job.pay_grade, job.badge, job.quota_full, job.posted_at, job.job_source_id";
const KEY = { newest: "posted_at", salary: "salary_sort" } as const;
type Sort = keyof typeof KEY;
const SORTS = Object.keys(KEY) as Sort[];

// Browse, first page: the rows and the capped count from one index walk. Next and previous are a plain keyset.
function browse(sort: Sort, extra = "", cursor?: string, prev = false): string {
  const k = KEY[sort];
  if (!cursor)
    return (
      `with hits as materialized (select id, (not quota_full) as r, ${k} as k from job where ${LIVE} ${extra} order by (not quota_full) desc, ${k} desc, id desc limit 201) ` +
      `select ${LIST}, (select count(*) from hits) as capped from (select id, r, k from hits order by r desc, k desc, id desc limit 21) page join job on job.id = page.id order by page.r desc, page.k desc, page.id desc`
    );
  if (!prev) return `select ${LIST} from job where ${LIVE} ${extra} and ((not quota_full), ${k}, id) < ${cursor} order by (not quota_full) desc, ${k} desc, id desc limit 21`;
  return `select ${LIST} from job where ${LIVE} ${extra} and ((not quota_full), ${k}, id) > ${cursor} order by (not quota_full) asc, ${k} asc, id asc limit 21`;
}
// Search, or any filter other than sector alone: the rows and the capped count from one scan.
function filt(sort: Sort, extra: string, cursor?: string, prev = false): string {
  const k = KEY[sort];
  const d = prev ? "asc" : "desc";
  const where = cursor ? `where (r, k, id) ${prev ? ">" : "<"} ${cursor}` : "";
  const cnt = cursor ? "" : ", (select count(*) from (select 1 from hits limit 201) c) as capped";
  return (
    `with hits as materialized (select id, (not quota_full) as r, ${k} as k from job where ${LIVE} ${extra}), ` +
    `page as (select id, r, k from hits ${where} order by r ${d}, k ${d}, id ${d} limit 21) ` +
    `select ${LIST}${cnt} from page join job on job.id = page.id order by page.r desc, page.k desc, page.id desc`
  );
}
// ===== end of the query forms =====

// A page is one or more statements. `timed` rows are the Search module's, which also have the time budget.
type Row = { kind: string; name: string; sqls: Statement[]; timed?: boolean };
const BANDS: [number, number][] = [[1, 3], [4, 10], [11, 30], [31, 100], [101, 300], [301, 1000], [1001, 5000]];

let db: TestDb;
let su: pg.Pool; // postgres
let owner: pg.Pool; // portal_owner
let rows: Row[];
let sharedIn: string[];
let sharedNames: string[];
const wall: Record<string, number> = {};
const lap = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    wall[label] = (Date.now() - t) / 1000;
  }
};

// Builds every query string once. The cursors come from the data, so the same strings serve both states.
async function buildRows(): Promise<void> {
  const one = async (sql: string) => (await su.query(sql)).rows[0];
  const count = async (extra: string) => Number((await one(`select count(*) n from job where ${LIVE} ${extra}`)).n);
  const keyset = async (sort: Sort, extra: string, off: number) => {
    const k = KEY[sort];
    const r = await one(`select (not quota_full)::text a, ${k}::text b, id::text c from job where ${LIVE} ${extra} order by (not quota_full) desc, ${k} desc, id desc offset ${off} limit 1`);
    return sort === "newest" ? `(${r.a}, '${r.b}'::timestamptz, ${r.c})` : `(${r.a}, ${r.b}, ${r.c})`;
  };
  rows = [];
  const add = (kind: string, name: string, sql: Statement | Statement[], timed = false) => rows.push({ kind, name, sqls: Array.isArray(sql) ? sql : [sql], timed });
  const depths = (n: number) => (n > 25 ? [...new Set([20, 200, 1000, 4000, n - 30, n - 5])].filter((o) => o >= 1 && o < n).sort((a, b) => a - b) : []);

  // the job list, all three sorts, from the Search module, including the quota area (the last 50 live rows have quota_full)
  const ORDER: Record<ListSort, [keys: string, order: string]> = {
    sponsor: ["array[sponsor_sort::text, posted_at::text]", "sponsor_sort desc, posted_at desc"],
    newest: ["array[posted_at::text]", "posted_at desc"],
    salary: ["array[salary_sort::text]", "salary_sort desc"],
  };
  const cursorAt = async (sort: ListSort, off: number): Promise<Cursor> => {
    const [keys, order] = ORDER[sort];
    const r = await one(`select quota_full q, ${keys} k, id::text i from job where ${LIVE} order by (not quota_full) desc, ${order}, id desc offset ${off} limit 1`);
    return { sort, quotaFull: r.q, keys: r.k, id: r.i };
  };
  const live = await count("");
  for (const s of LIST_SORTS) {
    add("list", `${s} first page + count`, listQuery(s), true);
    for (const off of depths(live)) {
      const c = await cursorAt(s, off);
      add("list", `${s} next, ${off} in`, listQuery(s, c, "after"), true);
      add("list", `${s} previous, ${off} in`, listQuery(s, c, "before"), true);
    }
  }

  // sector browse pages (the module has no sector filter yet)
  for (const s of SORTS)
    for (const [sec, label] of [["IT", "sector IT"], ["finance", "sector finance (rare)"]] as const) {
      const ex = `and sector = '${sec}'`;
      const n = await count(ex);
      add("sector", `${s} ${label} first page + count`, browse(s, ex));
      for (const off of depths(n)) {
        const c = await keyset(s, ex, off);
        add("sector", `${s} ${label} next, ${off} in`, browse(s, ex, c));
        add("sector", `${s} ${label} previous, ${off} in`, browse(s, ex, c, true));
      }
    }

  // filters (filter shape, no words), then the sector-combined shapes (`sector || ''` stops a walk of the sector index)
  const F: Record<string, string> = {
    "permit history has_history": "and permit_history = 'has_history'", "permit history first_time": "and permit_history = 'first_time'", "permit history not_linked": "and permit_history = 'not_linked'",
    "county Leitrim (rare)": "and county = 'Leitrim'", "county Dublin": "and county = 'Dublin'", "badge critical_skills_eligible": "and badge = 'critical_skills_eligible'",
    "salary 60k+": "and salary_sort >= 60000", "first_time + Dublin + 50k+": "and permit_history = 'first_time' and county = 'Dublin' and salary_sort >= 50000",
    "sector IT + county Dublin": "and sector || '' = 'IT' and county = 'Dublin'", "sector health + salary 50k+": "and sector || '' = 'health' and salary_sort >= 50000",
    "sector IT + first_time + Dublin + 50k+": "and sector || '' = 'IT' and permit_history = 'first_time' and county = 'Dublin' and salary_sort >= 50000",
    "sector finance + badge": "and sector || '' = 'finance' and badge = 'critical_skills_eligible'", "county Leitrim + first_time + 50k+": "and county = 'Leitrim' and permit_history = 'first_time' and salary_sort >= 50000",
    "salary 100k+": "and salary_sort >= 100000", "county Dublin + not_linked": "and county = 'Dublin' and permit_history = 'not_linked'",
  };
  for (const s of SORTS)
    for (const [name, ex] of Object.entries(F)) {
      const n = await count(ex);
      add("filter", `${s} ${name} first page + count (${n} hits)`, filt(s, ex));
      if (n >= 42) {
        const c = await keyset(s, ex, Math.floor(n / 2));
        add("filter", `${s} ${name} next, middle`, filt(s, ex, c));
        add("filter", `${s} ${name} previous, middle`, filt(s, ex, c, true));
      }
    }

  // search sweep: 14 words from each band of match counts (the same words in both states), every sort, first, middle and previous pages
  for (const [lo, hi] of BANDS) {
    const words = (await su.query(
      `select word from ts_stat($$select search_vector from job where status='live'$$) where word ~ '^[a-z]{4,}$' and ndoc between ${lo} and ${hi} order by md5(word) limit 14`,
    )).rows.map((r) => r.word as string);
    for (const w of words) {
      const tq = `and search_vector @@ websearch_to_tsquery('english', '${w}')`;
      const n = await count(tq);
      for (const s of SORTS) {
        for (const [name, ex] of [["first", tq], ["sector health", `${tq} and sector || '' = 'health'`], ["county Dublin", `${tq} and county = 'Dublin'`], ["first_time", `${tq} and permit_history = 'first_time'`]] as const)
          add("search", `${s} ${w} (${n}) ${name}`, filt(s, ex));
        if (n >= 42) {
          const c = await keyset(s, tq, Math.floor(n / 2));
          add("search", `${s} ${w} (${n}) next, middle`, filt(s, tq, c));
          add("search", `${s} ${w} (${n}) previous, middle`, filt(s, tq, c, true));
        }
      }
    }
  }

  // the signed-in shared queries (session, user, flags, last-checked dates, saved and tracker marks, prompts) and the job page
  const { token, user_id } = await one("select s.token, s.user_id from candidate_session s join saved_job j on j.candidate_user_id = s.user_id group by 1,2 order by count(*) desc limit 1");
  const ids = (await one(`select string_agg(id::text, ',') v from (select id from job where ${LIVE} order by (not quota_full) desc, posted_at desc, id desc limit 21) s`)).v;
  const src = (await one(`select string_agg(distinct job_source_id::text, ',') v from job where id in (${ids})`)).v;
  const shared: [string, string][] = [
    ["session by token", `select * from candidate_session where token = '${token}'`],
    ["user by id", `select * from candidate_user where id = '${user_id}'`],
    ["flags", "select key, enabled from feature_flag"],
    ["last-checked dates", `select id, last_ok_at from job_source where id in (${src})`],
    ["saved marks", `select job_id from saved_job where candidate_user_id = '${user_id}' and job_id in (${ids})`],
    ["tracker marks", `select job_id, stage from tracker_entry where candidate_user_id = '${user_id}' and job_id in (${ids})`],
    ["pending prompts", `select id, job_id from apply_click where candidate_user_id = '${user_id}' and status in ('pending','not_yet') limit 3`],
  ];
  sharedNames = shared.map((s) => s[0]);
  sharedIn = shared.map((s) => s[1]);
  // the job page: the module's job statement (named columns, advert text, employer, last checked), then the DETE count for its employer
  const jp = (await one("select max(job_id) v from job_text where job_id in (select id from job where status='live')")).v;
  const org = (await one(`select organisation_id v from job where id = ${jp}`)).v;
  const y = new Date().getUTCFullYear();
  add("job page", "job page: job + advert text + employer, then permits", [{ text: JOB_QUERY, values: [jp] }, { text: LAST_5_YEARS, values: [org, y - 4, y] }], true);
}

const sum = (list: PageCost[], key: "pages" | "planning" | "execution" | "serialisation" | "ms") => list.reduce((n, c) => n + c[key], 0);

// Measures every page as app_candidate, prints the worst page per kind, and returns the pages over the limit.
async function sweep(state: string): Promise<{ failures: string[]; worst: Record<string, number> }> {
  const client = new pg.Client({ connectionString: urlFor(db.name, "app_candidate") });
  await client.connect();
  let flat: PageCost[], shared: PageCost[];
  try {
    flat = await measurePages(client, rows.flatMap((r) => r.sqls));
    shared = await measurePages(client, sharedIn);
  } finally {
    await client.end();
  }
  const overhead = shared.reduce((n, c) => n + c.pages, 0);
  const failures: string[] = [];
  const worst: Record<string, number> = {};
  const lines: string[] = [];
  let top: { name: string; total: number; cost: PageCost }[] = [];
  const per = new Map<string, { name: string; total: number; cost: PageCost }[]>();
  let at = 0;
  rows.forEach((r) => {
    const own = flat.slice(at, (at += r.sqls.length));
    // a page of several statements is shown as one: the pages and the time add up, the plan names are joined
    const cost: PageCost = own.length === 1 ? own[0]! : {
      sql: own.map((c) => c.sql).join(" ; "), pages: sum(own, "pages"), planning: sum(own, "planning"), execution: sum(own, "execution"),
      serialisation: sum(own, "serialisation"), ms: Math.round(sum(own, "ms") * 100) / 100, scans: own.map((c) => c.scans).join(" ; "),
    };
    const over = pageOver(`${r.kind}: ${r.name} (${state})`, [...own, ...shared], PAGE_LIMIT);
    if (over) failures.push(over);
    if (r.timed && cost.ms > MS_LIMIT) failures.push(`page "${r.kind}: ${r.name} (${state})" took ${cost.ms} ms, budget ${MS_LIMIT} ms (plan ${cost.scans})`);
    const e = { name: r.name, total: cost.pages + overhead, cost };
    per.set(r.kind, [...(per.get(r.kind) ?? []), e]);
    top.push(e);
  });
  for (const [kind, list] of per) {
    list.sort((a, b) => a.total - b.total);
    const w = list[list.length - 1]!;
    worst[kind] = w.total;
    lines.push(`${kind.padEnd(9)} ${String(list.length).padStart(5)} runs, median ${list[Math.floor(list.length / 2)]!.total}, worst ${w.total} (own ${w.cost.pages} = planning ${w.cost.planning} + execution ${w.cost.execution} + serialisation ${w.cost.serialisation}, ${w.cost.ms} ms) ${w.name} [${w.cost.scans}]`);
  }
  // the Search module's pages, worst of each sort and move: own pages / ms (the shared signed-in queries come on top)
  const moves = new Map<string, PageCost>();
  for (const e of per.get("list") ?? []) {
    const [sort, move] = e.name.replace(",", "").split(" ");
    const k = `${sort} ${move}`;
    const w = moves.get(k);
    if (!w || e.cost.pages > w.pages) moves.set(k, e.cost);
  }
  lines.push(`list worst by move (own pages / ms): ${[...moves].map(([k, c]) => `${k} ${c.pages}/${c.ms}`).join(", ")}`);
  top = top.sort((a, b) => b.total - a.total).slice(0, 5);
  console.log(
    `\n=== page gate, ${state}: ${rows.length} pages, shared signed-in queries ${overhead} pages (${sharedNames.map((n, i) => `${n} ${shared[i]!.pages}`).join(", ")})\n` +
      `${lines.join("\n")}\nover ${PAGE_LIMIT}: ${failures.length}\ntop 5: ${top.map((t) => `${t.total} ${t.name}`).join(" | ")}`,
  );
  return { failures, worst };
}

function expectNoneOver(state: string, failures: string[]) {
  if (failures.length) throw new Error(`${failures.length} pages over their budget (${PAGE_LIMIT} pages, ${MS_LIMIT} ms for the module's pages) ${state}. First ones:\n${failures.slice(0, 5).join("\n")}`);
}

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  owner = db.pool("portal_owner");
  const loader = new pg.Client({ connectionString: urlFor(db.name) });
  await loader.connect();
  try {
    const steps = await lap("fill", () => fill(loader));
    console.log(`fill steps (seconds): ${steps.map((s) => s.toFixed(1)).join(", ")}`);
  } finally {
    await loader.end();
  }
  await lap("vacuum after fill", () => owner.query("vacuum (analyze)"));
  const sizes = (await su.query(
    "select count(*) n, round(avg(length(search_vector))) lexemes, round(avg(pg_column_size(search_vector))) tsv_bytes from job where status = 'live'")).rows[0];
  const text = (await su.query("select round(avg(length(advert_text))) chars from job_text")).rows[0];
  console.log(`live jobs ${sizes.n}: search_vector ${sizes.lexemes} lexemes, ${sizes.tsv_bytes} bytes on average; advert text ${text.chars} characters on average (trial: 5,000, 293, 4,752, 5,444)`);
  await lap("build query list", buildRows);
});
afterAll(async () => {
  console.log(`wall time (seconds): ${Object.entries(wall).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")}`);
  await db?.drop();
});

it("no page is over the limit straight after every live job row was rewritten, no vacuum", async () => {
  await lap("rewrite", async () => {
    await owner.query("alter table job set (autovacuum_enabled = false)");
    await tx(su, async (c) => {
      await c.query("set local session_replication_role = replica");
      await c.query("update job set title = title where status = 'live'");
    });
  });
  const { failures } = await lap("sweep after rewrite", () => sweep("after rewrite, no vacuum"));
  expectNoneOver("after rewrite, no vacuum", failures);
});

it("no page is over the limit after vacuum (analyze)", async () => {
  await owner.query("alter table job reset (autovacuum_enabled)");
  await lap("vacuum job", () => owner.query("vacuum (analyze) job"));
  const { failures } = await lap("sweep after vacuum", () => sweep("after vacuum (analyze)"));
  expectNoneOver("after vacuum (analyze)", failures);
});

// The admin queue (src/admin-queue.ts), measured as app_admin on the same full-size fill: 300 open items among the fill's done ones, the list's first
// page and a page from the middle, one item, and an approve (its lock and its write, measured on the real call inside a savepoint before each runs).
it("the admin queue pages and an approve stay under the limit", async () => {
  const staff = "staf0000001x0123456789abcdef";
  // the queue accepts only staff with the fetched_job_reviewer role (#193); the fill may already have given it to this one
  await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'fetched_job_reviewer', true) on conflict do nothing", [staff]);
  await su.query(
    "insert into review_item(queue, job_id, reason, created_at) select 'fetched_job', id, 'Fake reason', now() - g * interval '1 minute' " +
      "from (select id, row_number() over (order by id) g from job where status = 'closed' and source = 'fetched' order by id limit 300) s",
  );
  // two queued jobs with their text: the first approve warms the connection, the second is measured
  const made: string[] = [];
  for (let i = 0; i < 2; i++) {
    const adv = (await su.query("insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result, stage) values (1, $1, 'https://jobs.example.test/q', 'Platform Engineer', 'Fake Employer 1', 'queued', '7 contract unclear (admin queue)') returning id", [`gate-${i}`])).rows[0].id;
    const job = (await su.query(
      "insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, permit_type, status, closes_at, search_vector, own_page_url) " +
        "values (1, 'fetched', 1, $1, 'Platform Engineer', 'Fake Employer 1', 'Dublin', 'IT', 'critical_skills', 'in_review', 'infinity', to_tsvector('english', 'platform'), 'https://jobs.example.test/q') returning id",
      [adv],
    )).rows[0].id;
    await su.query("insert into job_text(job_id, advert_text) values ($1, $2)", [job, `${"We build fake things for fake people. ".repeat(120)} The salary is €60,000 a year.`]);
    made.push((await su.query("select id::text from review_item where queue = 'fetched_job' and job_id = $1", [job])).rows[0].id);
  }
  await owner.query("vacuum (analyze) review_item, audit_event");
  const pool = db.pool("app_admin");
  for (const item of made) await claim(pool, staff, item);

  const client = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await client.connect();
  let reads: PageCost[];
  try {
    const mid = (await listQueue(client)).next!;
    const [t, i] = Object.values(JSON.parse(Buffer.from(mid, "base64url").toString("utf8"))) as string[];
    reads = await measurePages(client, [QUEUE_FIRST, { text: QUEUE_AFTER, values: [t, i] }, { text: QUEUE_ITEM, values: [made[1]] }]);
  } finally {
    await client.end();
  }

  let write: PageCost[] = [];
  const measuring = {
    query: pool.query.bind(pool),
    connect: async () => {
      const c = await pool.connect();
      return Object.assign(Object.create(c), {
        release: () => c.release(),
        query: async (text: string, values?: unknown[]) => {
          if (text === LOCK || text === DECIDE) {
            await c.query("savepoint m");
            const e = await c.query(`explain (analyze, buffers, serialize, format json) ${text}`, values);
            await c.query("rollback to savepoint m");
            write.push(costOf(text, e.rows[0]["QUERY PLAN"]));
          }
          return c.query(text, values);
        },
      });
    },
  } as unknown as pg.Pool;
  const rules = { chain: { deteNames: new Set<string>(), publicPayCandidates: new Map<string, 1 | 2>(), ...CHAIN_RULES_V1 }, lists: [{ code: "2134", list: "critical-skills" }] };
  for (const item of made) {
    write = [];
    await approve(measuring, staff, item, { occupationCode: "2134", contractConfirmed: true }, rules);
  }
  // Taking over a stale claim and giving one back: each one statement, measured as the acting staff member inside a rolled-back transaction.
  const other = "gate-take-over-staff";
  await su.query("insert into staff_user(id, name, email, email_verified, created_at, updated_at) values ($1, 'Fake Staff 2', 'gate2@example.test', true, now(), now())", [other]);
  const stale = (await su.query("select id::text from review_item where queue = 'fetched_job' and status = 'open' order by id limit 1")).rows[0].id as string;
  await claim(pool, staff, stale);
  await su.query("update review_item set claimed_at = now() - interval '48 hours' where id = $1", [stale]);
  const one = async (who: string, text: string, values: unknown[]) => {
    const c = await pool.connect();
    try {
      for (const measure of [false, true]) {
        await c.query("begin");
        await c.query("select set_config('app.staff_user_id', $1, true)", [who]);
        if (!measure) await c.query(text, values); // warm
        else {
          const plan = (await c.query(`explain (analyze, buffers, serialize, format json) ${text}`, values)).rows[0]["QUERY PLAN"];
          return { cost: costOf(text, plan), rows: plan[0]["Plan"]["Actual Rows"] as number };
        }
        await c.query("rollback");
      }
      throw new Error("unreachable");
    } finally {
      await c.query("rollback");
      c.release();
    }
  };
  const take = await one(other, TAKE_OVER, [stale, other, "fetched_job.take_over", STALE_AFTER]);
  const give = await one(staff, RELEASE, [stale, staff, "fetched_job.release"]);
  const who = await one(staff, QUEUE_ACT, [staff]); // the active-staff and role check every action starts with
  expect([take.rows, give.rows, who.rows]).toEqual([1, 1, 1]); // each wrote its audit row, so the whole statement was measured
  const pages = [
    ["admin queue first page", [reads[0]!]], ["admin queue page from the middle", [reads[1]!]], ["admin queue item", [reads[2]!]], ["admin approve: lock + write", write],
    ["admin take over a stale claim", [take.cost]], ["admin release a claim", [give.cost]], ["admin staff and role check", [who.cost]],
  ] as const;
  console.log(`\n=== admin queue (app_admin): ${pages.map(([n, c]) => `${n} ${sum([...c], "pages")} pages / ${Math.round(sum([...c], "ms") * 100) / 100} ms [${c.map((x) => x.scans).join(" ; ")}]`).join(" | ")}`);
  const failures = pages.flatMap(([n, c]) => {
    const over = pageOver(n, [...c], PAGE_LIMIT);
    const ms = sum([...c], "ms");
    return [...(over ? [over] : []), ...(ms > MS_LIMIT ? [`page "${n}" took ${ms} ms, budget ${MS_LIMIT} ms`] : [])];
  });
  expect(write).toHaveLength(2);
  expectNoneOver("admin queue", failures);
});

// The account review queue (src/account-review.ts), measured as app_admin on the same full-size fill: 300 pending companies with their owners among the
// fill's data. The list's first page and a page from the middle, one item, and an approve with the domain (its lock and its write, measured on the real
// call inside a savepoint before each runs). Same page and time limits as the fetched-job queue.
it("the account review pages and an approve stay under the limit", async () => {
  const staff = "gate-ar-staff";
  await su.query("insert into staff_user(id, name, email, email_verified, created_at, updated_at) values ($1, 'Fake Reviewer', 'gate-ar@example.test', true, now(), now())", [staff]);
  await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'account_reviewer', true)", [staff]);
  await su.query("insert into organisation(slug, display_name, kind, status, signup_path, claimed_at) select 'gate-ar-' || g, 'Gate Review ' || g, 'employer', 'pending_review', 'dete_claim', now() from generate_series(1, 300) g");
  await su.query("insert into portal_user(id, name, email, email_verified, created_at, updated_at) select 'gate-ar-u' || g, 'Fake Owner', 'owner' || g || '@gate-ar-' || g || '.example.test', true, now(), now() from generate_series(1, 300) g");
  await su.query("insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) select o.id, 'gate-ar-u' || substr(o.slug, 9), 'account_owner', 'active', true, now() from organisation o where o.slug like 'gate-ar-%'");
  await su.query("insert into review_item(queue, organisation_id, reason, created_at) select 'account_review', o.id, 'claim', now() - o.id * interval '1 second' from organisation o where o.slug like 'gate-ar-%'");
  await owner.query("vacuum (analyze) review_item, organisation, membership, portal_user, audit_event");
  const pool = db.pool("app_admin");
  const made = (await su.query("select r.id::text from review_item r join organisation o on o.id = r.organisation_id where o.slug like 'gate-ar-%' order by r.id desc limit 2")).rows.map((r) => r.id as string);
  for (const item of made) await claimReview(pool, staff, item);

  const client = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await client.connect();
  let reads: PageCost[];
  try {
    const mid = (await listAccountReviews(client, staff)).next!;
    const [t, i] = Object.values(JSON.parse(Buffer.from(mid, "base64url").toString("utf8"))) as string[];
    reads = await measurePages(client, [REVIEW_FIRST, { text: REVIEW_AFTER, values: [t, i] }, { text: REVIEW_ITEM, values: [made[1]] }]);
  } finally {
    await client.end();
  }

  let write: PageCost[] = [];
  const measuring = {
    query: pool.query.bind(pool),
    connect: async () => {
      const c = await pool.connect();
      return Object.assign(Object.create(c), {
        release: () => c.release(),
        query: async (text: string, values?: unknown[]) => {
          if (text === REVIEW_LOCK || text === REVIEW_DECIDE) {
            await c.query("savepoint m");
            const e = await c.query(`explain (analyze, buffers, serialize, format json) ${text}`, values);
            await c.query("rollback to savepoint m");
            write.push(costOf(text, e.rows[0]["QUERY PLAN"]));
          }
          return c.query(text, values);
        },
      });
    },
  } as unknown as pg.Pool;
  for (const item of made) {
    write = [];
    await approveAccount(measuring, staff, item, { addDomain: true });
  }
  const pages = [
    ["account review first page", [reads[0]!]], ["account review page from the middle", [reads[1]!]], ["account review item", [reads[2]!]], ["account approve: lock + write", write],
  ] as const;
  console.log(`\n=== account review (app_admin): ${pages.map(([n, c]) => `${n} ${sum([...c], "pages")} pages / ${Math.round(sum([...c], "ms") * 100) / 100} ms [${c.map((x) => x.scans).join(" ; ")}]`).join(" | ")}`);
  const failures = pages.flatMap(([n, c]) => {
    const over = pageOver(n, [...c], PAGE_LIMIT);
    const ms = sum([...c], "ms");
    return [...(over ? [over] : []), ...(ms > MS_LIMIT ? [`page "${n}" took ${ms} ms, budget ${MS_LIMIT} ms`] : [])];
  });
  expect(write).toHaveLength(2);
  expectNoneOver("account review", failures);
});

// The trust and safety reports queue (src/trust-safety.ts), as app_admin on the full-size fill (its reports are all cleared) plus 300 open and 50 job_hidden
// reports on live jobs: the first page and a page from the middle, under the same page and time limits as the other admin queues.
it("the trust and safety report list stays under the limit", async () => {
  await su.query("insert into report(target_kind, target_job_id, reason, evidence_text, status, created_at) select 'job', j.id, 'no_sponsorship', 'Fake evidence of normal length.', case when n <= 50 then 'job_hidden' else 'open' end, now() - n * interval '1 minute' from (select id, row_number() over (order by id) n from job where status = 'live' limit 350) j");
  await owner.query("vacuum (analyze) report");
  const mid = (await su.query("select created_at::text t, id::text i from report where status in ('open','job_hidden') order by created_at, id offset 150 limit 1")).rows[0];
  const client = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await client.connect();
  try {
    const [first, after] = await measurePages(client, [REPORTS_FIRST, { text: REPORTS_AFTER, values: [mid.t, mid.i] }]);
    console.log(`\n=== report list (app_admin): first ${first!.pages} pages / ${first!.ms} ms [${first!.scans}]; middle ${after!.pages} pages / ${after!.ms} ms [${after!.scans}]`);
    const failures = ([["report list first page", first!], ["report list page from the middle", after!]] as const).flatMap(([n, c]) => {
      const over = pageOver(n, [c], PAGE_LIMIT);
      return [...(over ? [over] : []), ...(c.ms > MS_LIMIT ? [`page "${n}" took ${c.ms} ms, budget ${MS_LIMIT} ms`] : [])];
    });
    expectNoneOver("report list", failures);
  } finally {
    await client.end();
  }
});

// The daily fetch guard (src/fetch-guard-cli.ts): one statement as app_fetcher on a year of runs (22,700 rows; about 30 a day in real life, so
// all but 30 of the fill's rows are moved to earlier days). Budget: 30 pages and
// MS_LIMIT ms, both when a good run is found at once and in the worst case (every run today failed, so the whole day's range is read), and the
// plan must use fetch_run_started_idx.
it("the fetch guard is one statement, under its page and time budget, and uses the started_at index", async () => {
  await su.query("update fetch_run set started_at = now() - interval '3 days' - id * interval '1 second' where id > (select min(id) + 29 from fetch_run)");
  await su.query("insert into fetch_run(job_source_id, started_at, finished_at, seen, new, closed) select 1 + (g % 30), now() - interval '10 days' - g * interval '1 minute', now(), 100, 3, 1 from generate_series(1, 20000) g");
  await owner.query("vacuum (analyze) fetch_run");
  const client = new pg.Client({ connectionString: urlFor(db.name, "app_fetcher") });
  await client.connect();
  try {
    const day = utcDayStart(new Date());
    const hit = (await measurePages(client, [{ text: GOOD_RUN_TODAY, values: [day] }]))[0]!;
    await su.query("update fetch_run set error = 'fake failure' where started_at >= $1", [day]);
    await owner.query("vacuum (analyze) fetch_run");
    const worst = (await measurePages(client, [{ text: GOOD_RUN_TODAY, values: [day] }]))[0]!;
    console.log(`\n=== fetch guard (app_fetcher): good run found ${hit.pages} pages / ${hit.ms} ms [${hit.scans}]; worst, none good ${worst.pages} pages / ${worst.ms} ms [${worst.scans}]`);
    for (const c of [hit, worst]) {
      expect(c.pages).toBeLessThanOrEqual(30);
      expect(c.ms).toBeLessThanOrEqual(MS_LIMIT);
      expect(c.scans).toMatch(/fetch_run_started_idx/);
    }
  } finally {
    await client.end();
  }
});
