// Integration (Stage 3 step 2): a staff write reaches the candidate site's cache. The real admin routes (/api/content, /api/legal-texts) with real staff
// sessions on the test database as app_admin; once a publish, withdraw or legal confirm has committed, their after() work calls the real candidate route
// POST /api/revalidate, through a fake fetch that hands the Request to it (no network). next/cache's revalidatePath is recorded; next/server's after is
// kept and awaited, as Next runs it once the answer is sent. Budget: the call adds no statement to the staff write (publish 8, as content-admin.test.ts),
// and the candidate route reads no database (0 statements).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { counted, staffHarness, type Route } from "./staff-routes-harness";

const { state } = vi.hoisted(() => ({ state: { after: [] as (Promise<unknown> | (() => unknown))[], cleared: [] as [string, string | undefined][] } }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: Promise<unknown> | (() => unknown)) => { state.after.push(fn); } })); // run in the flush, never before: Next runs it once the answer is sent
vi.mock("next/cache", () => ({ revalidatePath: (p: string, t?: string) => { state.cleared.push([p, t]); } }));

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
const SECRET = "fake-revalidate-secret-fake-revalidate-secret";
const CANDIDATE = "http://localhost:3000";
const BUDGET = { publish: 8, route: 0 };
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, content: Route, legal: Route, REVALIDATE: Handler;
let R: typeof import("../src/revalidate");
const sent: string[] = [];
const flush = async () => { await Promise.all(state.after.splice(0).map((f) => (typeof f === "function" ? f() : f))); const c = state.cleared.splice(0); return c; };

beforeAll(async () => {
  db = await createTestDb();
  h = await staffHarness(db);
  content = await import("../../../apps/admin/app/api/content/route");
  legal = await import("../../../apps/admin/app/api/legal-texts/route");
  ({ POST: REVALIDATE } = await import("../../../apps/candidate/app/api/revalidate/route"));
  R = await import("../src/revalidate");
  for (const [name, roles] of [["ce1", ["content_editor"]], ["ad1", ["administrator"]], ["acc", ["account_reviewer"]]] as const) await h.makeStaff(name, [...roles]);
  Object.assign(process.env, { REVALIDATE_SECRET: SECRET, CANDIDATE_AUTH_URL: CANDIDATE });
  // the candidate site, reached without a network: the Request goes straight to its route handler
  vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => { sent.push(String(url)); return REVALIDATE(new Request(url, init)); });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  for (const k of ["REVALIDATE_SECRET", "CANDIDATE_AUTH_URL"]) delete process.env[k];
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

let n = 0;
const helpDraft = async () => (await h.ok(h.call(content, "/api/content", "ce1", { action: "create", kind: "help", slug: `reval-help-${n++}`, title: "A fake help page", body: "Fake body." }))).id as string;
const post = (body: string, sig: string | null, len?: string) =>
  REVALIDATE(new Request(`${CANDIDATE}/api/revalidate`, { method: "POST", body, headers: { "content-type": "application/json", ...(sig === null ? {} : { [R.REVALIDATE_HEADER]: sig }), ...(len ? { "content-length": len } : {}) } }));

describe("a staff write clears the candidate site's pages", () => {
  it("a help publish and a withdraw each clear every content page, after the write; a draft clears nothing", async () => {
    const id = await helpDraft();
    expect(await flush()).toEqual([]);
    await h.ok(h.call(content, "/api/content", "ce1", { action: "publish", id }));
    expect(await flush()).toEqual(R.CONTENT_PATHS.map((t) => [t.path, t.type]));
    await h.ok(h.call(content, "/api/content", "ce1", { action: "withdraw", id }));
    expect(await flush()).toEqual(R.CONTENT_PATHS.map((t) => [t.path, t.type]));
    expect(sent.every((u) => u === `${CANDIDATE}/api/revalidate`)).toBe(true);
  });
  it("a legal confirm clears the five legal pages; a proposal clears nothing", async () => {
    const p = await h.ok(h.call(legal, "/api/legal-texts", "ce1", { action: "propose", purpose: "privacy_notice", version: "v-reval", body: "PLACEHOLDER privacy text." }));
    expect(await flush()).toEqual([]);
    await h.ok(h.call(legal, "/api/legal-texts", "ad1", { action: "confirm", requestId: p.requestId ?? p.id }));
    expect(await flush()).toEqual(R.LEGAL_PATHS.map((t) => [t.path, undefined]));
  });
  it("security: a refused write (wrong role, no session, other origin) clears nothing", async () => {
    const id = await helpDraft();
    expect((await h.call(content, "/api/content", "acc", { action: "publish", id })).status).toBe(403);
    expect((await h.call(content, "/api/content", null, { action: "publish", id })).status).toBe(401);
    expect((await h.call(content, "/api/content", "ce1", { action: "publish", id }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await flush()).toEqual([]);
    expect(sent.length).toBeGreaterThan(0);
  });
  it("performance: the call adds no statement to the publish, and the candidate route reads no database", async () => {
    const id = await helpDraft();
    const [, stmts] = await counted(async () => { await h.ok(h.call(content, "/api/content", "ce1", { action: "publish", id })); await flush(); });
    expect(stmts).toBeLessThanOrEqual(BUDGET.publish);
    const body = JSON.stringify({ paths: R.LEGAL_PATHS, at: Date.now() });
    const [r, route] = await counted(() => post(body, R.signBody(body, SECRET)));
    expect(r.status).toBe(200);
    expect(route).toBe(BUDGET.route);
    await flush();
  });
});

describe("POST /api/revalidate refuses what is not a signed, fresh call for known paths", () => {
  it("refuses unsigned, wrongly signed, old and unknown-path calls, and an oversized body, and clears nothing", async () => {
    const body = JSON.stringify({ paths: R.LEGAL_PATHS, at: Date.now() });
    const old = JSON.stringify({ paths: R.LEGAL_PATHS, at: Date.now() - 61_000 });
    const odd = JSON.stringify({ paths: [{ path: "/account" }], at: Date.now() });
    const cases: [Promise<Response>, number, string][] = [
      [post(body, null), 401, "BAD_SIGNATURE"], [post(body, R.signBody(body, "another-secret-another-secret-another")), 401, "BAD_SIGNATURE"],
      [post(old, R.signBody(old, SECRET)), 401, "STALE"], [post(odd, R.signBody(odd, SECRET)), 400, "UNKNOWN_PATH"], [post(body, R.signBody(body, SECRET), "9000"), 413, "BAD_BODY"],
    ];
    for (const [r, status, code] of cases) { const x = await r; expect([x.status, ((await x.json()) as { code: string }).code]).toEqual([status, code]); }
    expect(state.cleared).toEqual([]);
    const { loadSpec, replyProblems } = await import("./openapi");
    const ok = await post(body, R.signBody(body, SECRET));
    expect(replyProblems(loadSpec("candidate"), "post", "/api/revalidate", ok.status, await ok.json())).toEqual([]);
    expect(state.cleared).toHaveLength(R.LEGAL_PATHS.length);
    state.cleared.splice(0);
  });
  it("is off when the site has no secret", async () => {
    const body = JSON.stringify({ paths: R.LEGAL_PATHS, at: Date.now() });
    delete process.env.REVALIDATE_SECRET;
    try { expect((await post(body, R.signBody(body, SECRET))).status).toBe(503); } finally { process.env.REVALIDATE_SECRET = SECRET; }
  });
});
