// The page gate (design 23-database-design.md, section 8, "CI page check"). On fake data at full size, with every live job row rewritten
// once, every page form is measured as app_candidate in two states: straight after the rewrite with no vacuum (autovacuum off for job),
// and after `vacuum (analyze)`. A page is the page's own query plus the signed-in shared queries, counting planning, execution and
// serialisation together. Any page over PAGE_LIMIT fails the run. A change that pushes a page over is fixed in the design, not in the limit.
// Run it with: npm run test:perf (see the hand-over for the wiring), or: npx vitest run --config packages/db/test/perf/vitest.config.ts
//
// Roles: postgres loads the fill and rewrites the rows (it can switch triggers off), portal_owner vacuums and sets table options,
// and app_candidate, the role the candidate site runs as, takes every measurement. Fake data only.
import pg from "pg";
import { afterAll, beforeAll, it, vi } from "vitest";
import { createTestDb, tx, urlFor, type TestDb } from "../db";
import { fill } from "./fill";
import { measurePages, pageOver, type PageCost } from "./pages";

export const PAGE_LIMIT = 1000;

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

// ===== QUERY FORMS: ported as they are from schema-trial-3/50-pages.py (design section 3). They move into the Search module when it is written. =====
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

type Row = { kind: string; name: string; sql: string };
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
  const add = (kind: string, name: string, sql: string) => rows.push({ kind, name, sql });

  // browse, including the quota area (the last 50 live rows have quota_full) and sector pages
  for (const s of SORTS)
    for (const [sec, label] of [[null, "all"], ["IT", "sector IT"], ["finance", "sector finance (rare)"]] as const) {
      const ex = sec ? `and sector = '${sec}'` : "";
      const n = await count(ex);
      const kind = sec ? "sector" : "browse";
      add(kind, `${s} ${label} first page + count`, browse(s, ex));
      const offs = n > 25 ? [...new Set([20, 200, 1000, 4000, n - 30, n - 5])].filter((o) => o >= 1 && o < n).sort((a, b) => a - b) : [];
      for (const off of offs) {
        const c = await keyset(s, ex, off);
        add(kind, `${s} ${label} next, ${off} in`, browse(s, ex, c));
        add(kind, `${s} ${label} previous, ${off} in`, browse(s, ex, c, true));
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
  const jp = (await one("select max(job_id) v from job_text where job_id in (select id from job where status='live')")).v;
  add("job page", "job page: named columns + advert text",
    `select ${LIST}, job.sector, job.permit_type, job.salary_sort, job.application_route, job.own_page_url, t.advert_text from job join job_text t on t.job_id = job.id where job.id = ${jp} and job.status = 'live'`);
}

// Measures every page as app_candidate, prints the worst page per kind, and returns the pages over the limit.
async function sweep(state: string): Promise<{ failures: string[]; worst: Record<string, number> }> {
  const client = new pg.Client({ connectionString: urlFor(db.name, "app_candidate") });
  await client.connect();
  let costs: PageCost[], shared: PageCost[];
  try {
    costs = await measurePages(client, rows.map((r) => r.sql));
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
  rows.forEach((r, i) => {
    const cost = costs[i]!;
    const over = pageOver(`${r.kind}: ${r.name} (${state})`, [cost, ...shared], PAGE_LIMIT);
    if (over) failures.push(over);
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
  top = top.sort((a, b) => b.total - a.total).slice(0, 5);
  console.log(
    `\n=== page gate, ${state}: ${rows.length} pages, shared signed-in queries ${overhead} pages (${sharedNames.map((n, i) => `${n} ${shared[i]!.pages}`).join(", ")})\n` +
      `${lines.join("\n")}\nover ${PAGE_LIMIT}: ${failures.length}\ntop 5: ${top.map((t) => `${t.total} ${t.name}`).join(" | ")}`,
  );
  return { failures, worst };
}

function expectNoneOver(state: string, failures: string[]) {
  if (failures.length) throw new Error(`${failures.length} pages over ${PAGE_LIMIT} ${state}. First ones:\n${failures.slice(0, 5).join("\n")}`);
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
