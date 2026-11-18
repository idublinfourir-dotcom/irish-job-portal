// The OpenAPI files stay in sync with the route files (decision #248): every apps/<app>/app/api/**/route.ts and each method it exports is in
// docs/openapi/<app>.yaml, the file has no path or method without a route, and each operation has a summary, a 4xx (or x-no-4xx with a reason)
// and a success example. Files only, no network. Budget: the whole check, the three real files included, runs in under 2 seconds; the
// lint run (npm run lint:api) is budgeted at 15 seconds and measured here too.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appRoutes, APPS, exportedMethods, loadSpec, replyProblems, ROOT, routePath, schemaProblems, syncProblems, type Spec } from "../test/openapi";

const BUDGET = { syncMs: 2000, lintMs: 15_000 };

describe("the route walk", () => {
  it("reads the methods a route file exports, in each form the repo uses", () => {
    expect(exportedMethods("export const GET = a;\nexport const POST = (r: Request) => b(r);")).toEqual(["GET", "POST"]);
    expect(exportedMethods("export async function GET() {}\nexport function DELETE() {}")).toEqual(["GET", "DELETE"]);
    expect(exportedMethods("const PUT = 1; // export const PUTS = 2")).toEqual([]);
  });

  it("turns Next.js folders into OpenAPI paths", () => {
    expect(routePath(join("api", "candidate", "cases", "[id]", "documents", "[docId]", "route.ts"))).toBe("/api/candidate/cases/{id}/documents/{docId}");
    expect(routePath(join("api", "auth", "staff", "[...all]", "route.ts"))).toBe("/api/auth/staff/{path}");
  });
});

// A small fixture, not the real files.
const op = (extra: Record<string, unknown> = {}) => ({
  summary: "A thing",
  responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object" }, example: {} } } }, "400": { description: "bad" } },
  ...extra,
});
const fixture = (): Spec => ({ paths: { "/api/a": { get: op(), post: op() }, "/api/b/{id}": { get: op() } } });
const routes = { "/api/a": ["GET", "POST"], "/api/b/{id}": ["GET"] };

describe("syncProblems on a fixture", () => {
  it("is empty when routes and spec agree", () => {
    expect(syncProblems(routes, fixture())).toEqual([]);
  });

  it("fails on a route or method missing from the spec", () => {
    expect(syncProblems({ ...routes, "/api/c": ["GET"] }, fixture())).toEqual(["missing in spec: GET /api/c"]);
    expect(syncProblems({ ...routes, "/api/a": ["GET", "POST", "DELETE"] }, fixture())).toEqual(["missing in spec: DELETE /api/a"]);
  });

  it("fails on a spec path or method with no route", () => {
    const s = fixture();
    s.paths!["/api/extra"] = { get: op() };
    s.paths!["/api/a"]!.put = op();
    expect(syncProblems(routes, s)).toEqual(["no route for: PUT /api/a", "no route for: GET /api/extra"]);
  });

  it("fails on an operation with no summary, no 4xx or no success example", () => {
    const s = fixture();
    s.paths!["/api/a"] = {
      get: op({ summary: " " }),
      post: op({ responses: { "200": { description: "ok", content: { "application/json": { schema: {} } } }, "500": { description: "x" } } }),
    };
    expect(syncProblems(routes, s)).toEqual(["no summary: GET /api/a", "no 4xx response: POST /api/a", "no success example: POST /api/a"]);
  });

  it("takes x-no-4xx with a reason, a 4XX range, a 302 with an example Location, and shared $ref responses", () => {
    const s: Spec = {
      components: { responses: { Ok: { description: "ok", content: { "application/json": { example: { ok: true } } } } } },
      paths: {
        "/api/a": {
          get: { summary: "health", "x-no-4xx": "reads nothing", responses: { "200": { $ref: "#/components/responses/Ok" } } },
          post: { summary: "go", responses: { "302": { description: "to", headers: { Location: { example: "/x" } } }, "4XX": { description: "no" } } },
        },
        "/api/b/{id}": { get: op() },
      },
    };
    expect(syncProblems(routes, s)).toEqual([]);
  });
});

describe("schemaProblems", () => {
  const spec: Spec = { components: { schemas: { Id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" } } } };
  const schema = {
    type: "object", required: ["id", "when"], additionalProperties: false,
    properties: { id: { $ref: "#/components/schemas/Id" }, when: { type: ["string", "null"], format: "date-time" }, n: { type: "integer", maximum: 5 } },
  };
  it("passes a matching value and names each problem of a wrong one", () => {
    expect(schemaProblems(spec, schema, { id: "12", when: "2026-11-18T09:30:00.000Z", n: 5 })).toEqual([]);
    expect(schemaProblems(spec, schema, { id: 12, when: "x", n: 6, extra: 1 })).toEqual(["$.id: integer is not string", "$.when: not a date-time", "$.n: over 5", "$: unexpected extra"]);
    expect(schemaProblems(spec, schema, { id: "0" })).toEqual(["$: missing when", "$.id: does not match ^[1-9][0-9]{0,18}$"]);
  });
});

describe("the real files", () => {
  it("every app's routes and its OpenAPI file are in sync, within the time budget", () => {
    const t = performance.now();
    const problems = APPS.flatMap((app) => syncProblems(appRoutes(join(ROOT, "apps", app)), loadSpec(app)).map((p) => `${app}: ${p}`));
    const ms = performance.now() - t;
    console.log(`openapi sync: ${ms.toFixed(0)} ms for ${APPS.length} apps (budget ${BUDGET.syncMs} ms)`);
    expect(problems).toEqual([]);
    expect(ms).toBeLessThan(BUDGET.syncMs);
  });

  it("the shared Conventions text is the same in all three files", () => {
    const conventions = APPS.map((app) => String((loadSpec(app) as { info?: { description?: string } }).info?.description).split("## Conventions")[1]);
    expect(conventions[0]).toBeTruthy();
    expect(new Set(conventions).size).toBe(1);
  });

  it("every operation names its security and roles; every write its Origin check, body cap and rate limit; every staff route a session", () => {
    const problems: string[] = [];
    for (const app of APPS)
      for (const [path, item] of Object.entries(loadSpec(app).paths ?? {}))
        for (const [method, op] of Object.entries(item)) {
          if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
          const o = op as Record<string, unknown>, name = `${app} ${method.toUpperCase()} ${path}`;
          if (!Array.isArray(o.security)) problems.push(`${name}: no security`);
          if (!Array.isArray(o["x-roles"]) || !o["x-roles"].length) problems.push(`${name}: no x-roles`);
          if (app === "admin" && !path.startsWith("/api/auth/") && path !== "/api/health" && JSON.stringify(o.security) !== JSON.stringify([{ staffSession: [] }]))
            problems.push(`${name}: a staff route without the staff session`);
          if (method === "get") continue;
          for (const k of ["x-body-cap", "x-rate-limit"]) if (typeof o[k] !== "string" && typeof o[k] !== "number") problems.push(`${name}: no ${k}`);
          if (!/origin/i.test(String(o.description))) problems.push(`${name}: the Origin check is not described`);
        }
    expect(problems).toEqual([]);
  });

  it("no example holds a secret, an internal host or a real address", () => {
    const text = APPS.map((app) => JSON.stringify(loadSpec(app))).join("\n");
    expect(text).not.toMatch(/supabase\.co|vercel\.app|amazonaws|postgres(ql)?:\/\/|sk_live|BEGIN [A-Z ]*PRIVATE KEY|AUTH_SECRET=|BREVO_API_KEY=/i);
    const emails = [...text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map((m) => m[1]!.toLowerCase());
    expect(emails.filter((d) => !/(^|\.)example\.(com|ie|org|net|test)$/.test(d))).toEqual([]);
  });

  it("every JSON example, of a body or a reply, matches the schema beside it", () => {
    const problems: string[] = [];
    for (const app of APPS) {
      const spec = loadSpec(app);
      for (const [path, item] of Object.entries(spec.paths ?? {}))
        for (const [method, op] of Object.entries(item)) {
          const o = op as { requestBody?: { content?: Record<string, { schema?: object; example?: unknown }> }; responses?: Record<string, { $ref?: string; content?: Record<string, { schema?: object; example?: unknown }> }> };
          const media = [["body", o.requestBody?.content?.["application/json"]] as const,
            ...Object.entries(o.responses ?? {}).map(([s, r]) => [s, r.$ref ? undefined : r.content?.["application/json"]] as const)];
          for (const [where, m] of media)
            if (m?.schema && m.example !== undefined)
              problems.push(...schemaProblems(spec, m.schema as Record<string, unknown>, m.example).map((x) => `${app} ${method.toUpperCase()} ${path} ${where}: ${x}`));
        }
    }
    expect(problems).toEqual([]);
  });

  it("replyProblems finds an operation's documented schema", () => {
    expect(replyProblems(loadSpec("candidate"), "GET", "/api/health", 200, { ok: true, database: true })).toEqual([]);
    expect(replyProblems(loadSpec("candidate"), "GET", "/api/health", 200, { ok: "yes" })).toEqual(["$: missing database", "$.ok: string is not boolean"]);
  });

  it("lint:api passes within its time budget", () => {
    const t = performance.now();
    execFileSync("npm", ["run", "--silent", "lint:api"], { cwd: ROOT, stdio: "pipe" }); // throws when the lint fails
    const ms = performance.now() - t;
    console.log(`lint:api: ${ms.toFixed(0)} ms (budget ${BUDGET.lintMs} ms)`);
    expect(ms).toBeLessThan(BUDGET.lintMs);
  }, 30_000);
});
