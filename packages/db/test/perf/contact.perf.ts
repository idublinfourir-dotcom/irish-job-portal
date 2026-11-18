// Performance: the contact form's insert (src/contact.ts) and the staff inbox (src/contact-inbox.ts) on 60,000 messages (50,000 decided, 5,000 new, 5,000
// claimed), 20,000 candidates and 5,000 portal users. Each call's database statements together, counted in 8 kB pages (planning, execution and
// serialisation) and in time, warm. The form's rate-limit count is the shared single-row upsert (candidate-route.ts withinRate) and is counted as a
// statement in contact-candidate.test.ts. A change that pushes a call over its budget is fixed in the query, not in the budget. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import pg from "pg";
import { createTestDb, urlFor, type TestDb } from "../db";
import { CONTACT_SQL } from "../../src/contact";
import { CONTACT_ACT, CONTACT_AFTER, CONTACT_AUDIT, CONTACT_CLAIM, CONTACT_DECIDE, CONTACT_FIRST, CONTACT_ITEM } from "../../src/contact-inbox";
import { assertPageBudget, measurePages, type Statement } from "./pages";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });
// Measured on 16 Nov 2026 (printed by the test): insert 14 (visitor), 20 (candidate), 17 (portal) pages; inbox page 10 pages, also 3,000 messages in; read one 16;
// claim 15; decide 13; each under 1 ms. C3 (18 Nov 2026): read one 22 pages, read one appeal 23 (portal) and 24 (candidate site), the email looked up on the unique email index. Each budget is about 3 times the measure; the time limit is far above it, for a busy machine.
export const INSERT_PAGES = 60; // the visitor's insert, the signed-in candidate's, the portal user's
export const LIST_PAGES = 30; // role check + one page of the inbox
export const ONE_PAGES = 50; // role check + read + the audit row
export const STEP_PAGES = 50; // role check + claim or decide + the audit row
export const MS_LIMIT = 10;

const CANDIDATES = 20_000, PORTAL = 5_000, DECIDED = 50_000, OPEN = 5_000;
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const k = new pg.Client({ connectionString: urlFor(db.name) });
  await k.connect();
  try {
    await k.query("set session_replication_role = replica"); // as fill.ts: the load switches triggers off; the rows are still checked by their CHECKs
    await k.query(`insert into candidate_user(id, name, email, email_verified, created_at, updated_at) select 'perf-c-' || g, 'Fake', 'perf-c-' || g || '@example.test', true, now(), now() from generate_series(1, ${CANDIDATES}) g`);
    await k.query(`insert into portal_user(id, name, email, email_verified, created_at, updated_at) select 'perf-p-' || g, 'Fake', 'perf-p-' || g || '@example.test', true, now(), now() from generate_series(1, ${PORTAL}) g`);
    await k.query(`insert into staff_user(id, name, email, email_verified) values ('perf-sc', 'Fake SC', 'perf-sc@example.test', true), ('perf-sc2', 'Fake SC 2', 'perf-sc2@example.test', true)`);
    await k.query(`insert into staff_role(staff_user_id, role, seeded_by_owner) values ('perf-sc', 'services_case_handler', true), ('perf-sc', 'administrator', true), ('perf-sc2', 'services_case_handler', true)`);
    const row = (status: string, g: string) =>
      `select 'candidate_site', case when ${g} % 2 = 0 then 'perf-c-' || (1 + ${g} % ${CANDIDATES}) end, 'Fake Person ' || ${g}, 'fake.' || ${g} || '@example.test', (array['general','account','data_request','other'])[1 + ${g} % 4],
              repeat('A fake contact form message. ', 8), '${status}', now() - (${g} || ' minutes')::interval`;
    await k.query(`insert into contact_message(surface, candidate_user_id, from_name, from_email, topic, body, status, created_at) ${row("new", "g")} from generate_series(1, ${OPEN}) g`);
    await k.query(`insert into contact_message(surface, candidate_user_id, from_name, from_email, topic, body, status, created_at, claimed_by_staff_user_id, claimed_at)
      ${row("claimed", "g").replace("now() - (g", "now() - ((g + 3)")}, 'perf-sc2', now() from generate_series(${OPEN}, ${2 * OPEN}) g`);
    await k.query(`insert into contact_message(surface, candidate_user_id, from_name, from_email, topic, body, status, created_at, closed_at)
      ${row("closed", "g").replace("now() - (g", "now() - ((g + 100000)")}, now() from generate_series(1, ${DECIDED}) g`);
    // C3: two appeals from held logins, one per side, so the read of an appeal is measured on its email lookups.
    await k.query("update candidate_user set suspended_at = now() where id = 'perf-c-500'; update portal_user set status = 'blocked' where id = 'perf-p-50'");
    await k.query(`insert into contact_message(surface, from_name, from_email, topic, body) values ('candidate_site', 'Fake', 'PERF-C-500@example.test', 'appeal', 'x'), ('portal', 'Fake', 'perf-p-50@example.test', 'appeal', 'x')`);
  } finally {
    await k.end();
  }
  await db.pool("portal_owner").query("vacuum (analyze)");
});
afterAll(() => db.drop());

async function measure(role: string, statements: Statement[]) {
  const c = new pg.Client({ connectionString: urlFor(db.name, role) });
  await c.connect();
  try {
    await c.query("begin"); // the inserts and updates run twice under EXPLAIN ANALYZE: rolled back after
    const costs = await measurePages(c, statements);
    await c.query("rollback");
    return costs;
  } finally { await c.end(); }
}
const show = (name: string, costs: { pages: number; ms: number; scans: string }[]) =>
  console.log(`${name}: ${costs.reduce((n, c) => n + c.pages, 0)} pages, ${costs.reduce((n, c) => n + c.ms, 0).toFixed(2)} ms (${costs.map((c) => c.scans).join(" | ")})`);
async function page(role: string, name: string, statements: Statement[], budget: number, scans?: RegExp) {
  const costs = await measure(role, statements);
  show(name, costs);
  assertPageBudget(name, costs, budget);
  expect(costs.reduce((n, x) => n + x.ms, 0), `${name} time`).toBeLessThan(MS_LIMIT);
  if (scans) expect(costs.map((x) => x.scans).join("|"), `${name} plan`).toMatch(scans);
}

it("the form's insert stays under its page and time budget, for a visitor, a candidate and a portal user", async () => {
  const text = "A fake message.";
  await page("app_candidate", "visitor insert", [{ text: CONTACT_SQL.visitor, values: ["candidate_site", "Fake", "fake@example.test", "general", text] }], INSERT_PAGES);
  await page("app_candidate", "candidate insert", [{ text: CONTACT_SQL.user("candidate"), values: ["candidate_site", "perf-c-777", null, null, "data_request", text] }], INSERT_PAGES, /candidate_user_pkey/);
  await page("app_portal", "portal insert", [{ text: CONTACT_SQL.user("portal"), values: ["portal", "perf-p-77", null, null, "other", text] }], INSERT_PAGES, /portal_user_pkey/);
});

it("every inbox call stays under its page and time budget, and the list reads the inbox index", async () => {
  const check = { text: CONTACT_ACT, values: ["perf-sc"] };
  const first = { text: CONTACT_FIRST, values: [] };
  await page("app_admin", "inbox, first page", [check, first], LIST_PAGES, /contact_message_inbox_idx/);
  const c = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await c.connect();
  const deep = (await c.query("select created_text, id from (select created_at, created_at::text as created_text, id::text from contact_message where status in ('new','claimed') order by created_at, id offset 3000 limit 1) x")).rows[0];
  const one = (await c.query("select id::text from contact_message where status = 'new' order by created_at, id offset 10 limit 1")).rows[0].id as string;
  await c.end();
  await page("app_admin", "inbox, 3,000 in", [check, { text: CONTACT_AFTER, values: [deep.created_text, deep.id] }], LIST_PAGES, /contact_message_inbox_idx/);
  const audit = (action: string) => ({ text: CONTACT_AUDIT, values: ["admin_action", "perf-sc", "services_case_handler", action, one, "perf-c-2", "{}"] });
  await page("app_admin", "read one", [check, { text: CONTACT_ITEM, values: [one] }, audit("contact.read")], ONE_PAGES);
  const c2 = new pg.Client({ connectionString: urlFor(db.name, "app_admin") });
  await c2.connect();
  const appeals = (await c2.query("select surface, id::text from contact_message where topic = 'appeal'")).rows as { surface: string; id: string }[];
  await c2.end();
  for (const a of appeals)
    await page("app_admin", `read one appeal (${a.surface})`, [check, { text: CONTACT_ITEM, values: [a.id] }, audit("contact.read")], ONE_PAGES, a.surface === "portal" ? /portal_user_email_key/ : /candidate_user_email_key/);
  await page("app_admin", "claim", [check, { text: CONTACT_CLAIM, values: [one, "perf-sc", "24 hours"] }, audit("contact.claim")], STEP_PAGES);
  await page("app_admin", "decide", [check, { text: CONTACT_DECIDE, values: [one, "answered", "perf-sc"] }, audit("contact.answered")], STEP_PAGES);
});
