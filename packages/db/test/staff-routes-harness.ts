// Shared set-up for the step 13d route tests (staff, audit, content, fetched jobs): the admin app's real route handlers on the real test database as app_admin,
// with real staff sessions (sign-in through the real auth route). Fake people only, no network. The pattern of pay-floors-admin.test.ts, written once.
import pg from "pg";
import { expect } from "vitest";
import { seedStaff } from "../src/staff-seed-cli";
import { urlFor, type TestDb } from "./db";

export const BASE = "http://localhost:3002";
export const PW = "Fake-staff-password-1";
type Handler = (r: Request) => Promise<Response>;
export type Route = { GET: Handler; POST?: Handler };
export type Reply = { status: number; json: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function staffHarness(db: TestDb) {
  const su = db.pool("postgres");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_admin"), DATABASE_SSL: "disable", STAFF_AUTH_URL: BASE, STAFF_AUTH_SECRET: "trial-only-secret-trial-only-secret-32" });
  const { POST: AUTH } = await import("../../../apps/admin/app/api/auth/staff/[...all]/route");
  const staff: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  let ip = 10;

  /** A login with these roles (none: all roles removed) and a signed-in session. */
  async function makeStaff(name: string, roles: string[]) {
    const c = await su.connect();
    try {
      staff[name] = await seedStaff(c, { email: `${name}@example.test`, name: `Fake ${name}`, roles: roles.length ? roles : ["content_editor"] }, PW);
    } finally {
      c.release();
    }
    if (roles.length === 0) await su.query("delete from staff_role where staff_user_id = $1", [staff[name]]);
    const res = await AUTH(new Request(`${BASE}/api/auth/staff/sign-in/email`, {
      method: "POST", body: JSON.stringify({ email: `${name}@example.test`, password: PW }),
      headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": `198.51.100.${ip++}` },
    }));
    expect(res.status, name).toBe(200);
    cookies[name] = res.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
  }

  /** One call to a route handler. `who` is a name from makeStaff (or null for no session). A body makes it a POST with the right Origin unless told otherwise. */
  async function call(route: Route, path: string, who: string | null, body?: unknown, o: { origin?: string | null; raw?: string; query?: string; cookie?: string; length?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const cookie = o.cookie ?? (who ? cookies[who] : undefined);
    if (cookie) headers.cookie = cookie;
    if (o.length) headers["content-length"] = o.length;
    const post = body !== undefined || o.raw !== undefined;
    if (post && o.origin !== null) headers.origin = o.origin ?? BASE;
    const res = await (post ? route.POST! : route.GET)(new Request(`${BASE}${path}${o.query ?? ""}`, { method: post ? "POST" : "GET", body: post ? (o.raw ?? JSON.stringify(body)) : undefined, headers }));
    return { status: res.status, json: await res.json() };
  }
  const ok = async (r: Promise<Reply>) => { const x = await r; expect(x.status, JSON.stringify(x.json)).toBe(200); return x.json; };
  const no = async (r: Promise<Reply>, status: number, error: string) => { const x = await r; expect([x.status, x.json.error], JSON.stringify(x.json)).toEqual([status, error]); };
  return { su, staff, cookies, makeStaff, call, ok, no, AUTH, signedIn: (name: string) => cookies[name]! };
}

/** Counts every pg.Client.query call made while `fn` runs (the pool's connections included). */
export async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const q = pg.Client.prototype.query;
  let n = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { n++; return (q as (...x: unknown[]) => unknown).apply(this, a); } as typeof q;
  try { return [await fn(), n]; } finally { pg.Client.prototype.query = q; }
}
export const median = async (fn: (i: number) => Promise<unknown>) => {
  const ms = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await fn(i); ms.push(performance.now() - t); }
  return ms.sort((a, b) => a - b)[4]!;
};

export const ROLE_NAMES = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "content_editor", "administrator"] as const;
/** One login per role, named after it (a_<role>), all signed in. */
export async function oneOfEachRole(h: Awaited<ReturnType<typeof staffHarness>>, only: readonly string[] = ROLE_NAMES): Promise<void> {
  for (const r of only) await h.makeStaff(`only_${r}`, [r]);
}
