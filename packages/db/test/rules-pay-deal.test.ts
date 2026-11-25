// Integration: the rules data fields (B64, B66) through the real admin route handlers, real staff sessions and the real test database as app_admin, with
// memoryStore() as the file store (no network). The history of past versions, the hourly figure, the pay-deal entries (body type, evidence, added, on or off, counts)
// and the evidence files. Every role is tried, and hostile input. Fake people only.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HSE_ENTRY, chainRules, assess } from "@portal/rules";
import { memoryStore, setFileStore, type MemoryStore } from "../src/file-store";
import { EXE, PDF, PNG } from "../src/file-fixture";
import { MAX_UPLOAD_BODY } from "../src/files";
import { getCompanyPage, PUBLIC_PAY_LABEL } from "../src/public-pages";
import { HISTORY, PAY_DEAL_COUNTS } from "../src/rules-admin";
import { loadRules, type PayDealList } from "../src/rules-data";
import { encodeIdCursor } from "../src/wire";
import { createTestDb, type TestDb } from "./db";
import { fixtures, in30 } from "./fixtures";
import { loadSpec, replyProblems } from "./openapi";
import { assertPageBudget, measurePages } from "./perf/pages";
import { BASE, counted, median, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

// Statements per call, requireStaff's 2 included (25 Nov 2026): history 4, pay-deal list 6 (check, version, counts, names), upload 9 (the role check in its own
// transaction 3, then begin, roles, audit, commit), open 6. Times are medians of 9 warm calls, with a floor for a busy laptop. Pages: the history 89 (11 versions, four index lookups each), the counts over
// 3,000 company names, 300 jobs. Raise these only on purpose.
const BUDGET = { history: 4, list: 6, upload: 9, open: 6, listMs: 40, historyMs: 30, uploadMs: 40, openMs: 25, historyPages: 130, countPages: 400 };

const spec = loadSpec("admin");
const R = "/api/rules", H = "/api/rules/history", P = "/api/rules/pay-deal-employers", E = "/api/rules/evidence";
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, su: pg.Pool, store: MemoryStore, today: string;
let rules: Route, history: Route, payDeal: Route, evidence: Route;
let F: { org(o?: object): Promise<number>; portal(): Promise<string>; member(org: number, user: string, o?: object): Promise<number> };
const one = async (sql: string, a: unknown[] = []) => (await su.query(sql, a)).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  ({ F } = fixtures(db) as unknown as { F: typeof F });
  h = await staffHarness(db);
  su = h.su;
  rules = await import("../../../apps/admin/app/api/rules/route");
  history = await import("../../../apps/admin/app/api/rules/history/route");
  payDeal = await import("../../../apps/admin/app/api/rules/pay-deal-employers/route");
  evidence = await import("../../../apps/admin/app/api/rules/evidence/route");
  for (const r of ROLE_NAMES) await h.makeStaff(r, [r]);
  await h.makeStaff("both", ["rules_data_editor", "administrator"]);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["rules_data_editor", "administrator"]);
  await su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
  today = (await one("select current_date::text d")).d;
  store = memoryStore();
  setFileStore(store);
});
afterAll(async () => {
  setFileStore(undefined);
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

const ED = "rules_data_editor", AD = "administrator";
const inForce = async () => (await one("select data from rules_version where kind = 'public_pay_employers' and effective_from <= current_date order by effective_from desc, id desc limit 1")).data as PayDealList;
const propose = (data: unknown, who = ED) => h.call(rules, R, who, { action: "propose", kind: "public_pay_employers", effectiveFrom: today, data });
const confirm = (requestId: string, who = AD) => h.call(rules, R, who, { action: "confirm", requestId });
const save = async (data: unknown) => { const p = await h.ok(propose(data)); await h.ok(confirm(p.requestId)); return p; };
const bad = async (data: unknown, why: RegExp) => { const r = await propose(data); expect([r.status, r.json.error], JSON.stringify(r.json)).toEqual([400, "bad_data"]); expect(r.json.detail).toMatch(why); };
const form = (bytes: Uint8Array, name = "service.pdf", field = "file") => { const f = new FormData(); f.append(field, new Blob([bytes as Uint8Array<ArrayBuffer>]), name); return f; };
async function upload(who: string | null, body: BodyInit = form(PDF), o: { origin?: string | null; query?: string; length?: string } = {}) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = h.signedIn(who);
  if (o.origin !== null) headers.origin = o.origin ?? BASE;
  if (o.length) headers["content-length"] = o.length;
  const res = await evidence.POST!(new Request(`${BASE}${E}${o.query ?? ""}`, { method: "POST", headers, body }));
  return { status: res.status, json: await res.json() };
}
async function open(who: string | null, q: string) {
  const res = await evidence.GET(new Request(`${BASE}${E}${q}`, { headers: who ? { cookie: h.signedIn(who) } : {} }));
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type"), headers: res.headers, bytes, json: res.status === 200 ? {} : JSON.parse(new TextDecoder().decode(bytes)) };
}
const link = { kind: "published_pay_policy", link: "https://example.test/pay", file: null };
const entry = (o: object = {}) => ({ tier: 2, bodyType: "section_38", evidence: link, ...o });
const row = async (name: string) => (await h.ok(h.call(payDeal, P, ED))).items.find((x: { name: string }) => x.name === name);

// ===== B64 =====
describe("the hourly figure and the history (B64)", () => {
  it("the minimums in force carry the hourly figure; the other kinds do not", async () => {
    const r = await h.ok(h.call(rules, R, "content_editor"));
    expect(replyProblems(spec, "GET", R, 200, r)).toEqual([]);
    expect(r.inForce.find((v: { kind: string }) => v.kind === "minimums").hourly).toMatchObject({ criticalSkills: 20.17, nonList: 33.98 });
    expect(r.inForce.filter((v: { kind: string; hourly?: object }) => v.kind !== "minimums" && v.hourly)).toEqual([]);
  });

  it("pages every started version of one kind, newest first, each with its change, dates and people; a version still to come is not in it", async () => {
    const m = (await one("select data from rules_version where kind = 'minimums' and seeded_by_owner")).data;
    const go = async (graduate: number, from = today) => {
      const p = await h.ok(h.call(rules, R, ED, { action: "propose", kind: "minimums", effectiveFrom: from, data: { ...m, graduate } }));
      return (await h.ok(confirm(p.requestId))).versionId as string;
    };
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push(await go(37000 + i));
    await go(39000, new Date(Date.parse(today) + 40 * 864e5).toISOString().slice(0, 10));
    const first = await h.ok(h.call(history, H, "norole", undefined, { query: "?kind=minimums" }));
    expect(replyProblems(spec, "GET", H, 200, first)).toEqual([]);
    expect(first.items.map((x: { versionId: string }) => x.versionId)).toEqual(ids.slice(1).reverse());
    expect(first.items[0]).toMatchObject({ inForce: true, until: null, seeded: false, effectiveFrom: today, proposedBy: h.staff[ED], proposedByName: `Fake ${ED}`, confirmedByName: `Fake ${AD}`,
      change: { added: {}, removed: {}, changed: { graduate: { before: 37009, after: 37010 } } } });
    expect(first.items[1]).toMatchObject({ inForce: false, until: today });
    expect(first.items[0].confirmedAt).toEqual(expect.any(String));
    const second = await h.ok(h.call(history, H, "norole", undefined, { query: `?kind=minimums&after=${first.next}` }));
    expect(second.items).toHaveLength(2);
    expect(second.items[0]).toMatchObject({ versionId: ids[0], change: { changed: { graduate: { before: 36848, after: 37000 } } } });
    expect(second.items[1]).toMatchObject({ seeded: true, proposedBy: null, proposedByName: null, confirmedByName: null, confirmedAt: null, until: today, change: { removed: {}, changed: {} } });
    expect(second.items[1].change.added).toEqual(m);
    expect(second.next).toBeNull();
    // a token of another list, a plain id, and another kind's version id inside a good token
    for (const t of [ids[0], encodeIdCursor("manual_jobs", ids[0]!)]) await h.no(h.call(history, H, ED, undefined, { query: `?kind=minimums&after=${t}` }), 400, "bad_cursor");
    expect((await h.ok(h.call(history, H, ED, undefined, { query: `?kind=ineligible_list&after=${first.next}` }))).items).toEqual([]);
    expect(JSON.stringify([first, second])).not.toContain("@example.test");
  });

  it("every active staff member reads it; nobody else; hostile queries are refused", async () => {
    for (const who of [...ROLE_NAMES, "norole"]) await h.ok(h.call(history, H, who, undefined, { query: "?kind=public_pay_employers" }));
    for (const q of ["?kind=minimums", ""]) { await h.no(h.call(history, H, null, undefined, { query: q }), 401, "no_session"); await h.no(h.call(history, H, "disabled", undefined, { query: q }), 401, "not_active"); }
    for (const q of ["", "?kind=quotas", "?kind=minimums'--", "?kind=__proto__"]) await h.no(h.call(history, H, ED, undefined, { query: q }), 400, "bad_kind");
    for (const q of ["?kind=minimums&kind=minimums", "?kind=minimums&x=1"]) await h.no(h.call(history, H, ED, undefined, { query: q }), 400, "bad_query");
  });
});

// ===== B66 =====
describe("pay-deal entries (B66)", () => {
  it("a new entry needs its body type and evidence, and the server sets who added it and when, whatever is sent", async () => {
    const list = await inForce();
    await bad({ ...list, "northquay hospital": { tier: 2 } }, /needs its body type and evidence/);
    await bad({ ...list, "northquay hospital": entry({ evidence: undefined }) }, /needs its body type and evidence/);
    await bad({ ...list, "northquay hospital": entry({ bodyType: undefined }) }, /needs its body type and evidence/);
    await bad({ ...list, "beaumont hospital": { ...list["beaumont hospital"], note: "a changed note" } }, /beaumont hospital: a new or changed entry/);
    const p = await h.ok(propose({ ...list, "northquay hospital": entry({ addedOn: "2020-01-01", addedBy: "somebody_else" }) }));
    expect(p.change).toEqual({ added: { "northquay hospital": { ...entry(), addedOn: today, addedBy: h.staff[ED] } }, removed: {}, changed: {} });
    expect(await row("northquay hospital")).toBeUndefined(); // nothing until a second person confirms
    const listed = (await h.ok(h.call(rules, R, AD))).pending.find((x: { requestId: string }) => x.requestId === p.requestId);
    expect(listed).toMatchObject({ proposedBy: h.staff[ED], proposedByName: `Fake ${ED}` });
    await h.ok(confirm(p.requestId));
    expect(await row("northquay hospital")).toEqual({ name: "northquay hospital", tier: 2, note: null, bodyType: "section_38", evidence: link, addedOn: today, addedBy: h.staff[ED],
      addedByName: `Fake ${ED}`, on: true, companies: 0, legalNames: 0, liveJobs: 0 });
    // a later editor's version keeps the first one's date and name
    await h.makeStaff("ed2", [ED]);
    const q = await h.ok(propose({ ...(await inForce()), "northquay hospital": entry({ note: "checked", addedBy: h.staff.ed2 }) }, "ed2"));
    await h.ok(confirm(q.requestId));
    expect(await row("northquay hospital")).toMatchObject({ note: "checked", addedOn: today, addedBy: h.staff[ED] });
    await h.no(propose(await inForce()), 409, "no_change"); // sending the list back as it was read changes nothing
  });

  it("an entry that is off counts for nothing at once: the snapshot every badge, posting check and the fetch reads has no such entry; the HSE switch too; it stays listed", async () => {
    const tierOf = async (employer: string) => (await assess({ source: "workday", employer, title: "Staff Nurse", location: "Dublin, Ireland", description: "Permanent role in Dublin. Visa sponsorship available.", employmentType: "", salaryBox: "" },
      { deteNames: new Set(), ...chainRules(await loadRules(db.pool("app_fetcher"), today)), matcher: async () => ({ occupationCode: "2231", onCriticalSkillsList: "yes", confidence: "high" }) })).publicPayTier;
    const { getRules, freshRules } = await import("../src/rules-data");
    await getRules(su); // the cached copy, from before the switch
    expect([await tierOf("Northquay Hospital"), await tierOf("HSE South")]).toEqual([2, 1]);
    // the company page's label, read by the candidate site's own login
    const { slug } = await one("select slug from organisation where id = $1", [await F.org({ name: "Northquay Hospital" })]);
    const labels = async () => ((await getCompanyPage(db.pool("app_candidate"), slug)) as { labels: string[] }).labels;
    expect(await labels()).toContain(PUBLIC_PAY_LABEL);
    const list = await inForce();
    // off needs no evidence: the HSE entry of the owner's version has none
    const p = await h.ok(propose({ ...list, "northquay hospital": { ...list["northquay hospital"], on: false }, [HSE_ENTRY]: { ...list[HSE_ENTRY], on: false } }));
    expect(Object.keys(p.change.changed).sort()).toEqual([HSE_ENTRY, "northquay hospital"]);
    expect(await tierOf("Northquay Hospital")).toBe(2); // pending: still on
    await h.ok(confirm(p.requestId));
    expect([await tierOf("Northquay Hospital"), await tierOf("HSE South")]).toEqual([0, 0]);
    expect(await labels()).not.toContain(PUBLIC_PAY_LABEL);
    const fresh = await freshRules(su); // what a post or an approval is checked with, whatever is cached
    expect([Object.hasOwn(fresh.publicPayEmployers, "northquay hospital"), Object.hasOwn(fresh.publicPayEmployers, HSE_ENTRY)]).toEqual([false, false]);
    for (const e of Object.values(fresh.publicPayEmployers)) for (const k of Object.keys(e)) expect(["tier", "note"]).toContain(k); // the shape the matcher, fetch and checks read is unchanged
    expect(await row("northquay hospital")).toMatchObject({ on: false, bodyType: "section_38" });
    // back on: the HSE entry now needs its body type and evidence
    await bad({ ...(await inForce()), [HSE_ENTRY]: list[HSE_ENTRY] }, /health service executive: a new or changed entry/);
    await save({ ...(await inForce()), [HSE_ENTRY]: { ...list[HSE_ENTRY], bodyType: "public_body", evidence: { kind: "dete_rule_text", link: "https://example.test/dete", file: null } } });
    expect(await tierOf("HSE South")).toBe(1);
    const off = Object.fromEntries(Object.entries(await inForce()).map(([k, e]) => [k, { ...e, on: false }]));
    await bad(off, /every entry is off/); // an empty list would stop the fetch
    await su.query("update organisation set display_name = 'Fake Renamed' where slug = $1", [slug]); // the next test counts this name's companies
  });

  it("counts each entry's companies, legal names and live jobs, off entries too; a draft, a closed job, a merged company and another company do not count", async () => {
    const a = await F.org({ name: "Northquay Hospital" }), b = await F.org({ name: "Fake Other Trading" }), gone = await F.org({ name: "Northquay Hospital" }), hse = await F.org({ name: "HSE Dublin North" }), not = await F.org({ name: "Fake Hsener Ltd" });
    await su.query("update organisation set merged_into_id = $2 where id = $1", [gone, a]);
    const name = (org: number, n: string, kind: string) => su.query("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2::text, lower($2::text), $3, 'admin')", [org, n, kind]);
    await name(a, "Northquay Hospital Group CLG", "legal"); await name(a, "Northquay Services DAC", "legal"); await name(a, "nqh", "alias");
    await name(b, "Northquay Hospital", "legal");
    const src = (await one("select id from job_source where kind = 'portal' and board = 'employer'")).id;
    const job = async (org: number, status: string) => {
      const m = await F.member(org, await F.portal());
      const { id } = await one("insert into job(organisation_id, source, job_source_id, title, employer_name, sector, permit_type, status, closes_at, own_page_url, salary_low, weekly_hours, occupation_code, pass_route, search_vector, posted_by_membership_id) " +
        "values ($1, 'employer', $2, 't', 'e', 'it', 'critical_skills', $3, $4, 'https://example.test/j', 50000, 39, '2136', 'stated_pay', 'x', $5) returning id", [org, src, status === "draft" ? "draft" : "live", in30(), m]);
      if (status === "closed") await su.query("update job set status = 'closed', closed_at = now(), close_reason = 'closed' where id = $1", [id]);
    };
    for (const [o, s] of [[a, "live"], [a, "live"], [a, "draft"], [a, "closed"], [b, "live"], [hse, "live"], [not, "live"]] as const) await job(o, s);
    expect(await row("northquay hospital")).toMatchObject({ on: false, companies: 2, legalNames: 3, liveJobs: 3 });
    expect(await row(HSE_ENTRY)).toMatchObject({ on: true, companies: 1, legalNames: 0, liveJobs: 1 });
    const r = await h.ok(h.call(payDeal, P, "norole"));
    expect(replyProblems(spec, "GET", P, 200, r)).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("@example.test");
  });

  it("every active staff member reads the list and nobody else; it takes no query key", async () => {
    for (const who of [...ROLE_NAMES, "norole"]) await h.ok(h.call(payDeal, P, who));
    await h.no(h.call(payDeal, P, null), 401, "no_session");
    await h.no(h.call(payDeal, P, "disabled"), 401, "not_active");
    await h.no(h.call(payDeal, P, ED, undefined, { query: "?name=x" }), 400, "bad_query");
  });

  it("two people, in the database too: the proposer is refused by the route, and by the table's own check when app_admin writes it directly", async () => {
    const list = await inForce();
    for (const who of [...ROLE_NAMES.filter((r) => r !== ED), "norole"]) await h.no(propose({ ...list, "fake body": entry() }, who), 403, "not_rules_editor");
    const p = await h.ok(propose({ ...list, "fake body": entry() }, "both"));
    await h.no(confirm(p.requestId, "both"), 409, "same_person");
    for (const who of [...ROLE_NAMES.filter((r) => r !== AD), "norole"]) await h.no(confirm(p.requestId, who), 403, "not_administrator");
    const c = await db.pool("app_admin").connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.staff_user_id', $1, true)", [h.staff.both]);
      await expect(c.query("update approval_request set status = 'confirmed' where id = $1", [p.requestId])).rejects.toMatchObject({ code: "23514" });
    } finally { await c.query("rollback"); c.release(); }
    expect((await one("select status from approval_request where id = $1", [p.requestId])).status).toBe("pending");
    await h.ok(h.call(rules, R, "both", { action: "withdraw", requestId: p.requestId }));
  });
});

describe("evidence files (B66)", () => {
  it("an editor uploads, puts the file on an entry with a second person, and the six viewing roles open it; the name is the uploaded one", async () => {
    const up = await upload(ED);
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect(replyProblems(spec, "POST", E, 200, up.json)).toEqual([]);
    const { id } = up.json.file;
    expect(store.objects.get(`rules/${id}`)!.contentType).toBe("application/pdf");
    expect(await one("select actor_staff_user_id a, after from audit_event where action = 'rules.evidence_upload' and object_id = $1", [id])).toEqual({ a: h.staff[ED], after: { file_name: "service.pdf", content_type: "pdf", size_bytes: PDF.length } });
    const p = await save({ ...(await inForce()), "fake evidence body": entry({ bodyType: "section_39", evidence: { kind: "service_arrangement", link: null, file: { id, name: "a forged name.pdf" } } }) });
    expect(p.change.added["fake evidence body"].evidence.file).toEqual({ id, name: "service.pdf" });
    expect((await row("fake evidence body")).evidence).toEqual({ kind: "service_arrangement", link: null, file: { id, name: "service.pdf" } });
    for (const who of ROLE_NAMES.filter((r) => r !== "content_editor")) {
      const f = await open(who, `?file=${id}`);
      expect([f.status, f.type, f.headers.get("x-content-type-options"), f.headers.get("cache-control")], who).toEqual([200, "application/pdf", "nosniff", "no-store"]);
      expect(f.bytes).toEqual(PDF);
    }
    expect((await one("select count(*)::int n from audit_event where action = 'rules.evidence_open' and kind = 'data_access' and object_id = $1", [id])).n).toBe(6);
    for (const who of ["content_editor", "norole"]) expect(await open(who, `?file=${id}`)).toMatchObject({ status: 403, json: { error: "not_rules_viewer" } });
    expect(await open(null, `?file=${id}`)).toMatchObject({ status: 401 });
    expect(await open("disabled", `?file=${id}`)).toMatchObject({ status: 401 });
    // the malware scan: not scanned yet, then blocked
    store.tags.set(`rules/${id}`, null);
    expect(await open(AD, `?file=${id}`)).toMatchObject({ status: 409, json: { error: "scan_pending" } });
    store.tags.set(`rules/${id}`, "THREATS_FOUND");
    expect(await open(AD, `?file=${id}`)).toMatchObject({ status: 409, json: { error: "file_blocked" } });
  });

  it("a file that was never uploaded here, or another store's file, cannot be put on an entry or opened", async () => {
    const other = "0f8fad5b-d9cb-469f-a165-70867728950e.pdf";
    await store.put(`evidence/${other}`, PDF, "application/pdf");
    const list = await inForce();
    const at = (id: unknown) => ({ ...list, "fake body": entry({ evidence: { kind: "other", link: null, file: { id, name: "x.pdf" } } }) });
    await bad(at(other), /not an uploaded file/);
    for (const id of [`../evidence/${other}`, `evidence/${other}`, "cv/1", 5, ""]) await bad(at(id), /not an uploaded file/);
    for (const q of [`?file=${other}`, `?file=../evidence/${other}`, "?file=", "", "?file=%00", `?file=${"x".repeat(3000)}`]) expect((await open(AD, q)).json, q).toMatchObject({ error: expect.stringMatching(/not_found|scan_pending/) });
    expect(await open(AD, `?file=${other}&x=1`)).toMatchObject({ status: 400, json: { error: "bad_query" } });
  });

  it("only a rules data editor uploads; hostile uploads are refused and store nothing", async () => {
    const before = store.objects.size;
    for (const who of [...ROLE_NAMES.filter((r) => r !== ED), "norole"]) expect(await upload(who), who).toEqual({ status: 403, json: { error: "not_rules_editor" } });
    expect((await upload(null)).status).toBe(401);
    expect((await upload("disabled")).status).toBe(401);
    for (const origin of ["https://evil.example", null]) expect(await upload(ED, form(PDF), { origin })).toEqual({ status: 403, json: { error: "bad_origin" } });
    expect(await upload(ED, form(EXE, "a.pdf"))).toEqual({ status: 415, json: { error: "wrong_file_type" } });
    expect(await upload(ED, form(new Uint8Array()))).toEqual({ status: 400, json: { error: "empty_file" } });
    expect(await upload(ED, form(PDF, "a.pdf", "other"))).toEqual({ status: 400, json: { error: "bad_file" } });
    expect(await upload(ED, "not a form")).toEqual({ status: 400, json: { error: "bad_file" } });
    expect(await upload(ED, form(PDF), { query: "?x=1" })).toEqual({ status: 400, json: { error: "bad_query" } });
    expect(await upload(ED, form(PDF), { length: String(MAX_UPLOAD_BODY + 1) })).toEqual({ status: 413, json: { error: "file_too_large" } });
    expect(store.objects.size).toBe(before);
    expect((await upload(ED, form(PNG, "scan.png"))).json.file.id).toMatch(/\.png$/);
  });
});

describe("performance", () => {
  it("each read and the upload stay inside their statement, time and page budgets", async () => {
    await su.query("insert into organisation(slug, display_name, kind, status) select 'perf-' || g, 'Fake Perf Company ' || g, 'employer', 'verified' from generate_series(1, 3000) g");
    const c = await su.connect();
    try { await c.query("analyze organisation"); } finally { c.release(); }
    const [, historyN] = await counted(() => h.call(history, H, ED, undefined, { query: "?kind=public_pay_employers" }));
    const [, listN] = await counted(() => h.call(payDeal, P, ED));
    const [up, uploadN] = await counted(() => upload(ED));
    const [, openN] = await counted(() => open(ED, `?file=${up.json.file.id}`));
    expect({ historyN, listN, uploadN, openN }).toEqual({ historyN: BUDGET.history, listN: BUDGET.list, uploadN: BUDGET.upload, openN: BUDGET.open });
    expect(await median(() => h.call(history, H, ED, undefined, { query: "?kind=ineligible_list" }))).toBeLessThan(BUDGET.historyMs);
    expect(await median(() => h.call(payDeal, P, ED))).toBeLessThan(BUDGET.listMs);
    expect(await median(() => upload(ED))).toBeLessThan(BUDGET.uploadMs);
    expect(await median(() => open(ED, `?file=${up.json.file.id}`))).toBeLessThan(BUDGET.openMs);
    const client = await su.connect();
    try {
      await client.query("begin");
      const names = Object.keys(await inForce());
      assertPageBudget("rules history, one page", await measurePages(client, [{ text: HISTORY, values: ["minimums", null] }]), BUDGET.historyPages);
      const counts = await measurePages(client, [{ text: PAY_DEAL_COUNTS, values: [names] }]);
      console.log(`pay-deal counts: ${counts[0]!.pages} pages`);
      assertPageBudget("pay-deal counts", counts, BUDGET.countPages);
    } finally { await client.query("rollback"); client.release(); }
  });
});
