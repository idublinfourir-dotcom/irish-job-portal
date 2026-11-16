// Decision #55: a portal login on the candidate contact route and a candidate login on the portal one. The three login pools are separate (#97), so a
// cookie from one is no session in the other. Both real auth routes and both real contact routes run on one connection as the database owner here (the
// only way one process can hold both logins); what is tested is which session each route sees, not the grants (those are in the two route test files).
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { answers, portalAnswers, seedSignupTerms } from "./better-auth-helper";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const CAND = "http://localhost:3000", PORT = "http://localhost:3001";
type Handler = (r: Request) => Promise<Response>;
let db: TestDb, su: pg.Pool;
let candAuth: Handler, portAuth: Handler, candContact: Handler, portContact: Handler;

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name), DATABASE_SSL: "disable", CANDIDATE_AUTH_URL: CAND, CANDIDATE_AUTH_SECRET: secret, PORTAL_AUTH_URL: PORT, PORTAL_AUTH_SECRET: secret });
  ({ POST: candAuth } = await import("../../../apps/candidate/app/api/auth/candidate/[...all]/route"));
  ({ POST: portAuth } = await import("../../../apps/portal/app/api/auth/portal/[...all]/route"));
  ({ POST: candContact } = await import("../../../apps/candidate/app/api/contact/route"));
  ({ POST: portContact } = await import("../../../apps/portal/app/api/portal/contact/route"));
});
afterAll(async () => {
  const { getPool } = await import("../src");
  await getPool().end();
  await db.drop();
});

async function signIn(auth: Handler, base: string, pool: "candidate" | "portal", email: string, extra: object) {
  const h = { "content-type": "application/json", origin: base, "x-vercel-forwarded-for": "198.51.100.77" };
  const password = "Fake-password-12345";
  expect((await auth(new Request(`${base}/api/auth/${pool}/sign-up/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password, name: "Fake", ...extra }) }))).status).toBe(200);
  await su.query(`update ${pool}_user set email_verified=true where email=$1`, [email]);
  const r = await auth(new Request(`${base}/api/auth/${pool}/sign-in/email`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) }));
  expect(r.status).toBe(200);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
const send = (route: Handler, base: string, path: string, cookie: string, body: object) =>
  route(new Request(`${base}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: base, cookie, "x-vercel-forwarded-for": "198.51.100.78" } }));

it("a portal login on the candidate route is a visitor; a candidate login on the portal route has no session", async () => {
  const candCookie = await signIn(candAuth, CAND, "candidate", "cross.cand@example.test", answers);
  const portCookie = await signIn(portAuth, PORT, "portal", "cross.portal@example.test", portalAnswers);

  // the portal cookie on the candidate route: a visitor, so name and email are needed and no id is stored
  expect((await send(candContact, CAND, "/api/contact", portCookie, { topic: "general", body: "x" })).status).toBe(400);
  expect((await send(candContact, CAND, "/api/contact", portCookie, { topic: "general", body: "from portal cookie", name: "Visitor", email: "cross.visitor@example.test" })).status).toBe(200);
  expect((await su.query("select candidate_user_id, portal_user_id from contact_message where body='from portal cookie'")).rows).toEqual([{ candidate_user_id: null, portal_user_id: null }]);

  // the candidate cookie on the portal route: refused, nothing written
  const r = await send(portContact, PORT, "/api/portal/contact", candCookie, { topic: "general", body: "from candidate cookie" });
  expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([401, "NO_SESSION"]);
  expect((await su.query("select 1 from contact_message where body='from candidate cookie'")).rowCount).toBe(0);

  // and each login still works on its own route
  expect((await send(candContact, CAND, "/api/contact", candCookie, { topic: "general", body: "own candidate" })).status).toBe(200);
  expect((await send(portContact, PORT, "/api/portal/contact", portCookie, { topic: "general", body: "own portal" })).status).toBe(200);
  expect((await su.query("select surface, (candidate_user_id is not null) c, (portal_user_id is not null) p from contact_message where body in ('own candidate','own portal') order by body")).rows)
    .toEqual([{ surface: "candidate_site", c: true, p: false }, { surface: "portal", c: false, p: true }]);
});
