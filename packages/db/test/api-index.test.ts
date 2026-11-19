// GET /api (decision #265) through the real handlers: the candidate and employer indexes answer anyone, read no database and ignore any
// input; the admin index answers every active staff member and refuses signed out, forged, other-site and disabled logins and any query
// key. Each lists exactly its own app's routes (the sync test keeps lib/api-index.json equal to docs/openapi), never a setting's value.
// No network. Budgets: public 0 statements and median under 5 ms; admin requireStaff's 2 statements and median under 20 ms.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { apiIndex, loadSpec, replyProblems } from "./openapi";
import { counted, median, oneOfEachRole, ROLE_NAMES, staffHarness, type Route } from "./staff-routes-harness";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const BUDGET = { publicStatements: 0, publicMs: 5, adminStatements: 2, adminMs: 20 };
const PLANTED = { BACKUP_S3_SECRET: "planted-backup-secret-value", FILES_S3_SECRET: "planted-s3-secret-value", CANDIDATE_AUTH_SECRET: "planted-auth-secret-value" };
const settings = (o: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(o)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };

let db: TestDb, h: Awaited<ReturnType<typeof staffHarness>>, admin: Route;
const adminGet = (who: string | null, query = "", o: Parameters<typeof h.call>[4] = {}) => h.call(admin, "/api", who, undefined, { ...o, query });

beforeAll(async () => {
  settings(PLANTED);
  db = await createTestDb();
  h = await staffHarness(db);
  admin = await import("../../../apps/admin/app/api/route");
  await oneOfEachRole(h);
  await h.makeStaff("norole", []);
  await h.makeStaff("disabled", ["administrator"]);
  await h.su.query("update staff_user set status = 'disabled' where id = $1", [h.staff.disabled]);
});
afterAll(async () => {
  settings({ APP_VERSION: undefined, VERCEL_ENV: undefined, ...Object.fromEntries(Object.keys(PLANTED).map((k) => [k, undefined])) });
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

describe.each(["candidate", "portal"] as const)("GET /api on the %s site", (app) => {
  const get = async (query = "") => {
    const { GET } = await import(`../../../apps/${app}/app/api/route.ts`);
    const res: Response = await GET(new Request(`http://localhost/api${query}`, { headers: { cookie: "candidate.session_token=forged; portal.session_token=forged" } }));
    return { status: res.status, text: await res.clone().text(), json: await res.json() };
  };

  it("answers anyone with the name, the deployed commit, the environment, the time and exactly this app's routes", async () => {
    settings({ APP_VERSION: "abc1234", VERCEL_ENV: "production" });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, version: "abc1234", environment: "production", ...apiIndex(loadSpec(app)) });
    expect(Date.now() - Date.parse(r.json.timestamp)).toBeLessThan(60_000);
    expect(replyProblems(loadSpec(app), "GET", "/api", 200, r.json)).toEqual([]);
    settings({ APP_VERSION: undefined, VERCEL_ENV: undefined });
    expect((await get()).json).toMatchObject({ version: "local", environment: "development" });
  });

  it("lists no staff route and no setting's value, and ignores hostile input", async () => {
    // the same path may exist on both sites (/api/contact: the public form and the staff inbox), so compare method, path and who
    const staffOnly = new Set(Object.values(apiIndex(loadSpec("admin")).routes).filter((r) => r.includes("(")));
    const r = await get("?x=<script>alert(1)</script>&limit=99999&" + "a".repeat(5000));
    expect(r.status).toBe(200);
    expect(Object.values(r.json.routes as Record<string, string>).filter((x) => staffOnly.has(x))).toEqual([]);
    expect(Object.values(r.json.routes as Record<string, string>).some((x) => /staff|administrator/.test(x))).toBe(false);
    for (const v of [...Object.values(PLANTED), process.env.DATABASE_URL!, process.env.STAFF_AUTH_SECRET!]) expect(r.text).not.toContain(v);
    expect(r.text).not.toContain("<script>");
    const mod = await import(`../../../apps/${app}/app/api/route.ts`);
    expect(Object.keys(mod).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
  });

  it("reads no database and stays inside its time budget", async () => {
    const [, s] = await counted(() => get());
    expect(s).toBeLessThanOrEqual(BUDGET.publicStatements);
    const ms = await median(() => get());
    expect(ms).toBeLessThan(BUDGET.publicMs);
    console.log(`${app} GET /api: ${s} statements, median ${ms.toFixed(2)} ms`);
  });
});

describe("GET /api on the admin site", () => {
  it("every active staff member, any role or none, reads the admin index", async () => {
    for (const who of [...ROLE_NAMES.map((r) => `only_${r}`), "norole"]) {
      const r = await h.ok(adminGet(who));
      expect(r, who).toMatchObject({ success: true, ...apiIndex(loadSpec("admin")) });
    }
  });
  it("refuses signed out, forged, candidate, employer and disabled logins, and any query key; there is no way to write", async () => {
    await h.no(adminGet(null), 401, "no_session");
    for (const cookie of ["staff.session_token=forged.value", "candidate.session_token=abc.def", "portal.session_token=abc.def"])
      await h.no(adminGet(null, "", { cookie }), 401, "no_session");
    await h.no(adminGet("disabled"), 401, "not_active");
    for (const q of ["?x=1", "?x=" + "<script>".repeat(500)]) await h.no(adminGet("only_administrator", q), 400, "bad_query");
    expect(Object.keys(admin).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
  });
  it("never shows a setting's value, and matches docs/openapi/admin.yaml", async () => {
    const r = await adminGet("only_content_editor");
    const text = JSON.stringify(r.json);
    for (const v of [...Object.values(PLANTED), process.env.DATABASE_URL!, process.env.STAFF_AUTH_SECRET!]) expect(text).not.toContain(v);
    const spec = loadSpec("admin");
    for (const x of [r, await adminGet(null), await adminGet("only_content_editor", "?x=1")])
      expect(replyProblems(spec, "GET", "/api", x.status, x.json), String(x.status)).toEqual([]);
  });
  it("stays inside the statement and time budgets", async () => {
    const [, s] = await counted(() => adminGet("only_administrator"));
    expect(s, `${s} statements`).toBeLessThanOrEqual(BUDGET.adminStatements);
    const ms = await median(() => adminGet("only_administrator"));
    expect(ms).toBeLessThan(BUDGET.adminMs);
    console.log(`admin GET /api: ${s} statements, median ${ms.toFixed(1)} ms`);
  });
});
