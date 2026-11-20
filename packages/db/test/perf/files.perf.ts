// Performance: the database part of the CV and case document routes (src/files.ts) on 20,000 candidates with a CV, 5,000 services cases on each
// side and 60,000 case documents, as app_candidate and app_portal. Each route's statements together, counted in 8 kB pages (planning, execution
// and serialisation), warm. A change that pushes a route over its budget is fixed in the query, not in the budget. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import pg from "pg";
import { createTestDb, urlFor, type TestDb } from "../db";
import { CV_SQL, docSql, type Side } from "../../src/files";
import { CASE_FILES_SQL } from "../../src/staff-case-files";
import { assertPageBudget, measurePages, type Statement } from "./pages";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });
// Measured on 16 Nov 2026 (printed by the test): CV 11 pages, each side's documents 44 pages, under 1 ms. Each budget is about 3 times the measure.
export const CV_PAGES = 40; // key + upsert (the upload), get, key (the download)
export const DOC_PAGES = 130; // case + insert (the upload), case + list, one (the link)
export const MS_LIMIT = 50;
// M4 (staff-case-files.ts), measured on 20 Nov 2026 (printed by the test); the budget is about 3 times the measure.
export const STAFF_DOC_PAGES = 90; // 29 pages measured: case (assignment and own-case check), list, one, the audit row

const CANDIDATES = 20_000, CASES = 5_000, DOCS = 60_000;
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const k = new pg.Client({ connectionString: urlFor(db.name) });
  await k.connect();
  try {
    await k.query("set session_replication_role = replica"); // as fill.ts: the load switches triggers off; the rows are still checked by their CHECKs
    await k.query(`insert into consent_text(purpose, version, body) values ('services_request', 'perf', 'Fake wording')`);
    await k.query(`insert into candidate_user(id, name, email, email_verified, created_at, updated_at, last_active_at)
      select 'perf-c-' || g, 'Fake', 'perf-c-' || g || '@example.test', true, now(), now(), now() from generate_series(1, ${CANDIDATES}) g`);
    await k.query(`insert into portal_user(id, name, email, email_verified, created_at, updated_at)
      select 'perf-p-' || g, 'Fake', 'perf-p-' || g || '@example.test', true, now(), now() from generate_series(1, ${CASES}) g`);
    await k.query(`insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes)
      select 'perf-c-' || g, 'cv/' || gen_random_uuid(), 'cv.pdf', 'pdf', 1000 + g from generate_series(1, ${CANDIDATES}) g`);
    await k.query(`insert into consent_record(candidate_user_id, consent_text_id) select 'perf-c-' || g, (select id from consent_text) from generate_series(1, ${CASES}) g;
      insert into consent_record(portal_user_id, consent_text_id) select 'perf-p-' || g, (select id from consent_text) from generate_series(1, ${CASES}) g`);
    await k.query(`insert into services_case(candidate_user_id, consent_record_id) select r.candidate_user_id, r.id from consent_record r where r.candidate_user_id is not null;
      insert into services_case(portal_user_id, consent_record_id, dedupe_key) select r.portal_user_id, r.id, 'perf-' || r.id from consent_record r where r.portal_user_id is not null`);
    await k.query(`insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id, portal_user_id)
      select c.id, 'case/' || gen_random_uuid(), 'd.pdf', 'pdf', 1000, c.candidate_user_id, c.portal_user_id
      from generate_series(1, ${DOCS}) g join services_case c on c.id = 1 + g % ${2 * CASES}`);
  } finally {
    await k.end();
  }
  await db.pool("portal_owner").query("vacuum (analyze)");
});
afterAll(() => db.drop());

async function measure(role: string, statements: Statement[], staff?: string) {
  const c = new pg.Client({ connectionString: urlFor(db.name, role) });
  await c.connect();
  try {
    await c.query("begin"); // the inserts and updates run twice under EXPLAIN ANALYZE: rolled back after
    if (staff) await c.query("select set_config('app.staff_user_id', $1, true)", [staff]); // as requireRole does
    const costs = await measurePages(c, statements);
    await c.query("rollback");
    return costs;
  } finally { await c.end(); }
}

it("the CV routes stay inside their page and time budget", async () => {
  const u = "perf-c-777";
  const costs = await measure("app_candidate", [
    { text: CV_SQL.key, values: [u] },
    { text: CV_SQL.upsert, values: [u, "cv/none", "cv.pdf", "pdf", 1234] },
    { text: CV_SQL.get, values: [u] },
  ]);
  const pages = costs.reduce((s, c) => s + c.pages, 0), ms = costs.reduce((s, c) => s + c.ms, 0);
  process.stdout.write(`files perf, CV: ${pages} pages, ${ms.toFixed(2)} ms (${costs.map((c) => `${c.pages} ${c.scans}`).join("; ")})\n`);
  assertPageBudget("CV routes", costs, CV_PAGES);
  expect(ms).toBeLessThan(MS_LIMIT);
});

for (const side of ["candidate", "portal"] as Side[]) {
  it(`the ${side} case document routes stay inside their page and time budget`, async () => {
    const sql = docSql(side);
    const k = new pg.Client({ connectionString: urlFor(db.name) });
    await k.connect();
    const { id, who } = (await k.query(`select id::text, coalesce(candidate_user_id, portal_user_id) as who from services_case where ${side}_user_id is not null order by id limit 1 offset 100`)).rows[0];
    const doc = (await k.query("select id::text from case_document where services_case_id = $1 limit 1", [id])).rows[0].id;
    await k.end();
    const costs = await measure(`app_${side}`, [
      { text: sql.case, values: [id, who] },
      { text: sql.insert, values: [id, "case/none", "d.pdf", "pdf", 10, who] },
      { text: sql.list, values: [id, who] },
      { text: sql.one, values: [doc, id, who] },
    ]);
    const pages = costs.reduce((s, c) => s + c.pages, 0), ms = costs.reduce((s, c) => s + c.ms, 0);
    process.stdout.write(`files perf, ${side} documents: ${pages} pages, ${ms.toFixed(2)} ms (${costs.map((c) => `${c.pages} ${c.scans}`).join("; ")})\n`);
    assertPageBudget(`${side} document routes`, costs, DOC_PAGES);
    expect(ms).toBeLessThan(MS_LIMIT);
  });
}

it("the staff view of a case's copies (M4) stays inside its page and time budget", async () => {
  const k = new pg.Client({ connectionString: urlFor(db.name) });
  await k.connect();
  await k.query("insert into staff_user(id, name, email, email_verified, created_at, updated_at) values ('perf-s', 'Fake', 'perf-s@example.test', true, now(), now()) on conflict do nothing");
  const { id } = (await k.query("select id::text from services_case where portal_user_id is not null order by id limit 1 offset 100")).rows[0];
  await k.query("update services_case set assigned_staff_user_id = 'perf-s' where id = $1", [id]);
  const doc = (await k.query("select id::text from case_document where services_case_id = $1 limit 1", [id])).rows[0].id;
  await k.query("analyze services_case");
  await k.end();
  const costs = await measure("app_admin", [
    { text: CASE_FILES_SQL.case, values: [id, "perf-s"] },
    { text: CASE_FILES_SQL.list, values: [id] },
    { text: CASE_FILES_SQL.one, values: [id, doc] },
    { text: CASE_FILES_SQL.audit, values: ["perf-s", doc, `services_case:${id}`] },
  ], "perf-s");
  const pages = costs.reduce((s, c) => s + c.pages, 0), ms = costs.reduce((s, c) => s + c.ms, 0);
  process.stdout.write(`files perf, staff case documents: ${pages} pages, ${ms.toFixed(2)} ms (${costs.map((c) => `${c.pages} ${c.scans}`).join("; ")})\n`);
  assertPageBudget("staff case document routes", costs, STAFF_DOC_PAGES);
  expect(ms).toBeLessThan(MS_LIMIT);
});
