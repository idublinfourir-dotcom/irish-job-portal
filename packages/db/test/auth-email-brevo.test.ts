// E1: the auth send path end to end on the test database. Each pool's real auth handler (createAuth) sends through createMail with Brevo
// switched on, and Brevo is a fetch fake: the request body must carry the sender name, HTML and text, and the link Better Auth made.
// Nothing calls the network (the network guard stays on). Fake people only.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { createAuth, createMail } from "../../auth/src";
import { BREVO_URL } from "../../auth/src/brevo.ts";
import { answers, portalAnswers, seedSignupTerms } from "./better-auth-helper";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
let db: TestDb, su: pg.Pool;
const calls: { url: string; body: Record<string, unknown> }[] = [];
const fetchFake = (async (url: string, init: RequestInit) => (calls.push({ url, body: JSON.parse(init.body as string) }), new Response("{}", { status: 201 }))) as unknown as typeof fetch;
const env = { BREVO_API_KEY: "xkeysib-test-only", EMAIL_FROM: "no-reply@account.example.ie" };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  await seedSignupTerms(su, "portal_signup_terms");
});
afterAll(() => db.drop());

const post = (auth: { handler: (r: Request) => Promise<Response> }, pool: string, path: string, body: unknown) =>
  auth.handler(new Request(`${BASE}/api/auth/${pool}/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": "192.0.2.77" } }));

describe("auth emails through the Brevo sender (fetch fake)", () => {
  for (const pool of ["candidate", "portal"] as const)
    it(`${pool}: sign-up sends the verify email and a reset request the reset email, each as HTML plus text with the sender name`, async () => {
      calls.length = 0;
      const auth = createAuth(pool, { database: db.pool(pool === "candidate" ? "app_candidate" : "app_portal"), baseURL: BASE, secret, sendEmail: createMail(BASE, env, () => {}, fetchFake).send });
      const email = `e1-${pool}-${Date.now()}@example.test`;
      expect((await post(auth, pool, "sign-up/email", { email, password: "Fake-password-for-tests-1", name: "<script>alert(1)</script>", ...(pool === "candidate" ? answers : portalAnswers) })).status).toBe(200);
      expect((await post(auth, pool, "request-password-reset", { email })).status).toBe(200);
      expect(calls.map((c) => c.body.subject)).toEqual(["Confirm your email address", "Reset your password"]);
      for (const { url, body } of calls) {
        expect(url).toBe(BREVO_URL);
        expect(body.sender).toEqual({ name: "irishworkpermit.ie", email: env.EMAIL_FROM });
        expect(body.to).toEqual([{ email }]);
        expect(body).not.toHaveProperty("headers"); // no header of ours on an account email
        const html = String(body.htmlContent), text = String(body.textContent);
        const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
        expect(links).toHaveLength(2); // the button and the link written out
        expect(links.every((l) => l.startsWith(`${BASE}/api/auth/${pool}/`))).toBe(true);
        expect(text).toContain(links[0]!);
        expect(html + text).toContain("1 hour");
        expect(html + text).not.toMatch(/<script|PLACEHOLDER/); // the person's typed name is never in the email
      }
    });
});
