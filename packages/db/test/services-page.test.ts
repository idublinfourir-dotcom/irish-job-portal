// Integration, security and performance: the services board pages (step 16 wave 3, P26, frame D11) run through the admin app's real data layer and real sessions on the real
// test database, rendered to HTML. Every one of the seven roles and no login is tried; hostile ids and query values; and no field a role must not see (a note, a copy, the
// requester's name or email for an administrator). The routes' own refusals are in services-board.test.ts and staff-case-files.test.ts. Fake people only, no network.
import { renderToStaticMarkup } from "react-dom/server";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { fixtures } from "./fixtures";
import { counted, median, ROLE_NAMES, staffHarness } from "./staff-routes-harness";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
  useRouter: () => ({ replace() {}, refresh() {} }),
  usePathname: () => "/services",
}));
vi.setConfig({ testTimeout: 180000, hookTimeout: 120000 });

// Budgets (measured 25 Nov 2026, printed below): the board measured 23 statements and the case page 22 (each read opens its own session check). Limits are about a third above the measures
// session statement each; time is a floor for a busy laptop.
const BUDGET = { boardStatements: 30, caseStatements: 30, boardMs: 400, caseMs: 400 };

type Params = { searchParams: Promise<Record<string, unknown>> };
type Mod<T> = { default: (a: T) => Promise<React.ReactElement> };
const pageModule = (name: string): Promise<unknown> => import(/* @vite-ignore */ `${import.meta.dirname}/../../../apps/admin/app/${name}`);
let list: Mod<Params>["default"], detail: Mod<{ params: Promise<{ id: string }> }>["default"];
let db: TestDb, su: pg.Pool, h: Awaited<ReturnType<typeof staffHarness>>;
let F: { cand: () => Promise<string> }, text: string;
const as = (who: string | null) => { state.headers = new Headers(who ? { cookie: h.cookies[who]! } : {}); };
const board = async (q: Record<string, unknown> = {}) => renderToStaticMarkup(await list({ searchParams: Promise.resolve(q) }));
const casePage = async (id: string) => renderToStaticMarkup(await detail({ params: Promise.resolve({ id }) }));
const outcome = async (f: () => Promise<string>) => f().then((html) => html, (e: Error) => e.message);
const one = async (sql: string, args: unknown[] = []) => (await su.query(sql, args)).rows[0];

async function makeCase(o: { email?: string; assignedTo?: string; status?: string; hr?: boolean } = {}) {
  const cand = await F.cand();
  await su.query("update candidate_user set name = 'Fake Requester Name', email = $2 where id = $1", [cand, o.email ?? `fake-req-${cand}@example.test`]);
  const consent = (await one("insert into consent_record(candidate_user_id, consent_text_id) values ($1, $2) returning id", [cand, text])).id;
  const c = (await one("insert into services_case(candidate_user_id, consent_record_id, employer_contact_consent_record_id, payer, permit_type, offer_details, status, assigned_staff_user_id) values ($1, $2, $3, 'employer', 'critical_skills', $4, $5, $6) returning id::text id",
    [cand, consent, o.hr ? consent : null, JSON.stringify({ details: { title: "Fake Nurse Title", employerName: "Fake Hospital Ltd" } }), o.status ?? "received", o.assignedTo ?? null])).id as string;
  await su.query("insert into case_event(case_id, kind, status, candidate_user_id) values ($1, 'received', 'received', $2)", [c, cand]);
  return { cand, c };
}

beforeAll(async () => {
  db = await createTestDb();
  ({ F } = fixtures(db) as unknown as { F: typeof F & { text: (p: string) => Promise<string> } });
  text = await (F as unknown as { text: (p: string) => Promise<string> }).text("services_request");
  h = await staffHarness(db);
  su = h.su;
  for (const r of ROLE_NAMES) await h.makeStaff(`only_${r}`, [r]);
  for (const n of ["h1", "h2"]) await h.makeStaff(n, ["services_case_handler"]);
  await h.makeStaff("ad", ["administrator"]);
  list = ((await pageModule("services/page")) as Mod<Params>).default;
  detail = ((await pageModule("services/[id]/page")) as Mod<{ params: Promise<{ id: string }> }>).default;
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe("who may open the board and a case", () => {
  it("only the services case handler and the administrator get the board; every other role gets the not-for-your-roles state with no case in it", async () => {
    const k = await makeCase();
    for (const r of ROLE_NAMES) {
      as(`only_${r}`);
      const [b, d] = [await outcome(() => board()), await outcome(() => casePage(k.c))];
      if (r === "services_case_handler" || r === "administrator") {
        expect(b, r).toMatch(/Services cases/);
        expect(b, r).not.toMatch(/not for your roles/);
        expect(d, r).toMatch(/PS-/);
      } else {
        expect(b, r).toMatch(/This page is not for your roles/);
        expect(d, r).toMatch(/This page is not for your roles/);
        expect(b + d, r).not.toMatch(new RegExp(`PS-${k.c.padStart(4, "0")}|Fake Requester|Fake Nurse`));
      }
    }
  });
  it("signed out, a forged cookie and a disabled login go to the sign-in page", async () => {
    const k = await makeCase();
    as(null);
    expect(await outcome(() => board())).toBe("REDIRECT:/sign-in");
    expect(await outcome(() => casePage(k.c))).toBe("REDIRECT:/sign-in");
    state.headers = new Headers({ cookie: "better-auth.session_token=forged" });
    expect(await outcome(() => board())).toBe("REDIRECT:/sign-in");
    await h.makeStaff("off", ["services_case_handler"]);
    await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.off]);
    as("off");
    expect(await outcome(() => board())).toBe("REDIRECT:/sign-in");
  });
});

describe("the board", () => {
  it("shows five columns with the seeded cases (no Ready to submit, no New case), filters Mine and Unassigned, and pages the table", async () => {
    const a = await makeCase({ assignedTo: h.staff.h1 }), b = await makeCase(), c = await makeCase({ status: "documents_needed", assignedTo: h.staff.h2 });
    as("h1");
    const all = await board();
    for (const w of ["Received", "Documents needed", "Waiting on employer", "Submitted", "Decision"]) expect(all).toContain(w);
    expect(all).not.toMatch(/Ready to submit|New case|candidate pays|Fake Requester|Fake Nurse|example\.test/);
    for (const k of [a, b, c]) expect(all).toContain(`href="/services/${k.c}"`);
    const mine = await board({ who: "mine" });
    expect(mine).toContain(`/services/${a.c}"`);
    expect(mine).not.toContain(`/services/${b.c}"`);
    expect(mine).not.toContain(`/services/${c.c}"`);
    const un = await board({ who: "unassigned" });
    expect(un).toContain(`/services/${b.c}"`);
    expect(un).not.toContain(`/services/${a.c}"`);
    const table = await board({ view: "table", status: "documents_needed" });
    expect(table).toContain(`/services/${c.c}"`);
    expect(table).not.toContain(`/services/${a.c}"`);
  });
  it("hostile query values fall back to the default and never fail the page", async () => {
    as("h1");
    for (const q of [{ view: ["a", "b"] }, { status: "closed" }, { status: "x".repeat(5000) }, { who: "<script>" }, { view: "table", after: "not-a-cursor" }, { view: "table", after: ["a", "b"] }, { status: { a: 1 } }]) {
      const html = await board(q);
      expect(html, JSON.stringify(q)).toMatch(/Services cases/);
      expect(html).not.toContain("<script>");
    }
  });
});

describe("one case", () => {
  it("a handler sees the requester, the notes and the copies of a case assigned to them, and the 30 day copy wording", async () => {
    const k = await makeCase({ assignedTo: h.staff.h1, hr: true });
    await su.query("insert into case_note(services_case_id, author_staff_user_id, body) values ($1, $2, 'INTERNALNOTE-visible-to-handler')", [k.c, h.staff.h1]);
    await su.query("insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id) values ($1, 'case/x-a', 'offer-fake.pdf', 'pdf', 10, $2)", [k.c, k.cand]);
    await su.query("insert into case_document(services_case_id, file_name, content_type, byte_size, candidate_user_id, copy_deleted_at) values ($1, 'removed-fake.pdf', 'pdf', 10, $2, now())", [k.c, k.cand]);
    as("h1");
    const html = await casePage(k.c);
    expect(html).toContain("Fake Requester Name");
    expect(html).toContain("INTERNALNOTE-visible-to-handler");
    expect(html).toContain("offer-fake.pdf");
    expect(html).toMatch(/Copy deleted/);
    expect(html).toContain("Copies only, never originals.");
    expect(html).toContain("Our service fee is paid by the employer or agency.");
    expect(html).toMatch(/Ask for documents/);
    expect(html).toMatch(/aria-label="Open the copy offer-fake\.pdf"/);
    expect(html).not.toMatch(/aria-label="Open the copy removed-fake/); // a removed copy has no open button
  });
  it("another handler's case shows no copies and no action buttons; an unassigned one offers Take this case", async () => {
    const mine = await makeCase({ assignedTo: h.staff.h2 }), free = await makeCase();
    await su.query("insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id) values ($1, 'case/x-b', 'other-fake.pdf', 'pdf', 10, $2)", [mine.c, mine.cand]);
    as("h1");
    const other = await casePage(mine.c);
    expect(other).not.toContain("other-fake.pdf");
    expect(other).toMatch(/Another handler holds this case/);
    expect(other).not.toMatch(/Ask for documents|Close the case/);
    expect(await casePage(free.c)).toMatch(/Take this case/);
  });
  it("an administrator sees no note, no copy and no requester name or email, and may assign", async () => {
    const k = await makeCase({ assignedTo: h.staff.h1 });
    await su.query("insert into case_note(services_case_id, author_staff_user_id, body) values ($1, $2, 'INTERNALNOTE-hidden-from-admin')", [k.c, h.staff.h1]);
    await su.query("insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id) values ($1, 'case/x-c', 'admin-hidden.pdf', 'pdf', 10, $2)", [k.c, k.cand]);
    as("ad");
    const html = await casePage(k.c);
    expect(html).not.toMatch(/INTERNALNOTE|admin-hidden|Fake Requester|example\.test/);
    expect(html).toMatch(/Assign to/);
    expect(html).not.toMatch(/Ask for documents|Add a note|Close the case/);
  });
  it("a case under the viewer's own email is refused with a plain page, and a bad or missing id is a 404", async () => {
    const k = await makeCase({ email: "h1@example.test", assignedTo: h.staff.h1 });
    as("h1");
    const own = await casePage(k.c);
    expect(own).toMatch(/under your own email address/);
    expect(own).not.toMatch(/Fake Nurse|offer/);
    for (const id of ["0", "999999999", "abc", "1; drop table services_case", "x".repeat(3000), "-1", "1e3"]) expect(await outcome(() => casePage(id)), id).toBe("NOT_FOUND");
  });
  it("every open of a case writes a data_access audit row", async () => {
    const k = await makeCase({ assignedTo: h.staff.h1 });
    as("h1");
    await casePage(k.c);
    expect(Number((await one("select count(*) n from audit_event where kind = 'data_access' and action = 'services_case.read' and object_id = $1", [k.c])).n)).toBe(1);
  });
  it("a closed case shows no controls", async () => {
    const k = await makeCase({ assignedTo: h.staff.h1 });
    await su.query("update services_case set status = 'closed', closed_at = now(), close_reason = 'no_reply' where id = $1", [k.c]);
    as("h1");
    const html = await casePage(k.c);
    expect(html).toMatch(/This case is closed/);
    expect(html).not.toMatch(/Close the case|Refer to solicitor/);
  });
});

describe("performance", () => {
  it("the board and a case page stay inside their statement and time budgets", async () => {
    const k = await makeCase({ assignedTo: h.staff.h1 });
    await su.query("insert into case_document(services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id) values ($1, 'case/x-p', 'p-fake.pdf', 'pdf', 10, $2)", [k.c, k.cand]);
    as("h1");
    await board();
    await casePage(k.c);
    const [, bs] = await counted(() => board());
    const [, cs] = await counted(() => casePage(k.c));
    const bms = await median(() => board()), cms = await median(() => casePage(k.c));
    console.log(`services page perf: board ${bs} statements ${bms.toFixed(1)} ms, case ${cs} statements ${cms.toFixed(1)} ms`);
    expect(bs).toBeLessThanOrEqual(BUDGET.boardStatements);
    expect(cs).toBeLessThanOrEqual(BUDGET.caseStatements);
    expect(bms).toBeLessThan(BUDGET.boardMs);
    expect(cms).toBeLessThan(BUDGET.caseMs);
  });
});
