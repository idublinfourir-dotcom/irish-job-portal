// SEC-3: the emailed verify, change-email and new-email links open our own /confirm-email page (candidate and portal), which changes nothing; only its
// button (a GET form to Better Auth's /verify-email with the same token) acts. On the test database, through each pool's real auth handler (createAuth),
// the real sender switch (createMail, here its fake sender, so no network) and the real page functions. Only Next's request context is stood in.
// Fake people only.
import type pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, urlFor, type TestDb } from "./db";
import { createAuth, createMail } from "../../auth/src";
import { answers, portalAnswers, seedSignupTerms } from "./better-auth-helper";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); }, useRouter: () => ({ replace() {}, refresh() {} }) }));
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const secret = "trial-only-secret-trial-only-secret-32";
const BASE = "http://localhost:3000";
const PASSWORD = "Fake-password-for-tests-1";
type Pool = "candidate" | "portal";
type Page = ((p: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<import("react").ReactElement>) & object;
type Mod = { default: Page; metadata?: Record<string, unknown>; generateMetadata?: () => Record<string, unknown> };
let db: TestDb, su: pg.Pool;
const S = {} as Record<Pool, { auth: ReturnType<typeof createAuth>; mail: ReturnType<typeof createMail>; page: Mod }>;
// The page modules are .tsx and this package has no JSX setting: the paths are variables (the type checker does not follow them).
const PAGES: Record<Pool, string> = { candidate: "../../../apps/candidate/app/confirm-email/page", portal: "../../../apps/portal/app/(auth)/confirm-email/page" };

beforeAll(async () => {
  db = await createTestDb();
  su = db.pool("postgres");
  await seedSignupTerms(su);
  await seedSignupTerms(su, "portal_signup_terms");
  Object.assign(process.env, { DATABASE_URL: urlFor(db.name, "app_portal"), DATABASE_SSL: "disable", PORTAL_AUTH_URL: BASE, PORTAL_AUTH_SECRET: secret, CANDIDATE_AUTH_URL: "https://candidates.example.test" });
  for (const pool of ["candidate", "portal"] as const) {
    const mail = createMail(BASE, {}, () => {});
    S[pool] = { mail, auth: createAuth(pool, { database: db.pool(`app_${pool}`), baseURL: BASE, secret, sendEmail: mail.send }), page: (await import(/* @vite-ignore */ PAGES[pool])) as Mod };
  }
});
afterAll(async () => {
  await (await import("../src")).getPool().end();
  await db.drop();
});

let n = 0;
const ip = () => `192.0.2.${(++n % 200) + 20}`;
const post = (pool: Pool, path: string, body: unknown, cookie?: string) =>
  S[pool].auth.handler(new Request(`${BASE}/api/auth/${pool}/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: BASE, "x-vercel-forwarded-for": ip(), ...(cookie ? { cookie } : {}) } }));
const get = (pool: Pool, url: string) => S[pool].auth.handler(new Request(url, { headers: { "x-vercel-forwarded-for": ip() }, redirect: "manual" }));
const sent = (pool: Pool, to: string, kind: string) => S[pool].mail.outbox.filter((m) => m.to === to && m.kind === kind);
const row = async (pool: Pool, email: string) => (await su.query(`select id, email, email_verified from ${pool}_user where email = $1`, [email])).rows[0] as { id: string; email: string; email_verified: boolean } | undefined;
const rowById = async (pool: Pool, id: string) => (await su.query(`select email, email_verified from ${pool}_user where id = $1`, [id])).rows[0];

/** What a mail filter does with the emailed link: open it. Here that is the page function; it returns the rendered HTML. */
const open = async (pool: Pool, link: string) => {
  const u = new URL(link);
  expect(`${u.origin}${u.pathname}`).toBe(`${BASE}/confirm-email`);
  return renderToStaticMarkup(await S[pool].page.default({ searchParams: Promise.resolve(Object.fromEntries(u.searchParams)) }));
};
/** What the person does: press the button, which submits the page's GET form. Returns the auth handler's answer. */
const press = (pool: Pool, html: string) => {
  const form = /<form [^>]*action="([^"]+)"[^>]*>(.*?)<\/form>/s.exec(html);
  expect(form, "the page has the confirm form").not.toBeNull();
  const fields = [...form![2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]);
  return get(pool, `${BASE}${form![1]}?${new URLSearchParams(fields)}`);
};
const signUp = async (pool: Pool, callbackURL: string) => {
  const email = `fake.sec3.${pool}.${++n}.${Date.now().toString(36)}@example.test`;
  expect((await post(pool, "sign-up/email", { email, password: PASSWORD, name: "Fake Person", callbackURL, ...(pool === "candidate" ? answers : portalAnswers) })).status).toBe(200);
  return email;
};
const CB: Record<Pool, string> = { candidate: "/verify?verified=1", portal: "/verify-email" };

describe("SEC-3: the emailed confirm link opens our page; only its button acts", () => {
  for (const pool of ["candidate", "portal"] as const) {
    it(`${pool}: the verify email links to /confirm-email with the token and our callback; opening it changes nothing; the button confirms`, async () => {
      const email = await signUp(pool, CB[pool]);
      const link = sent(pool, email, "verify").at(-1)!.link;
      expect(new URL(link).searchParams.get("callbackURL")).toBe(CB[pool]);
      const before = await row(pool, email);
      for (let i = 0; i < 3; i++) await open(pool, link); // a filter may open it more than once
      expect(await row(pool, email)).toEqual(before);
      expect(before!.email_verified).toBe(false);
      const r = await press(pool, await open(pool, link));
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe(CB[pool]);
      expect((await row(pool, email))!.email_verified).toBe(true);
      // the same link pressed again: Better Auth treats a confirmed address as done and lands on the same page; nothing else changes
      const again = await press(pool, await open(pool, link));
      expect([again.status, again.headers.get("location")]).toEqual([302, CB[pool]]);
    });

    it(`${pool}: a forged and an ended token are refused by the button (our page with ?error), and nothing is confirmed`, async () => {
      const email = await signUp(pool, CB[pool]);
      const real = new URL(sent(pool, email, "verify").at(-1)!.link);
      const token = real.searchParams.get("token")!;
      const [h, p] = token.split(".");
      const forged = `${h}.${p}.${"A".repeat(43)}`;
      for (const t of [forged, "abc.def.ghi"]) {
        const r = await press(pool, await open(pool, `${BASE}/confirm-email?${new URLSearchParams({ token: t, callbackURL: CB[pool] })}`));
        expect(r.status).toBe(302);
        const to = new URL(r.headers.get("location")!, BASE);
        expect(to.pathname).toBe(new URL(CB[pool], BASE).pathname);
        expect(to.searchParams.get("error")).toBe("INVALID_TOKEN");
      }
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 3600_000 });
      let ended: Response;
      try { ended = await press(pool, await open(pool, real.toString())); } finally { vi.useRealTimers(); }
      expect(new URL(ended.headers.get("location")!, BASE).searchParams.get("error")).toBe("TOKEN_EXPIRED");
      expect((await row(pool, email))!.email_verified).toBe(false);
    });

    it(`${pool}: hostile links show the bad-link state or fall back to our own page; the page holds nothing but the token, is noindex and sends no referrer`, async () => {
      const page = S[pool].page;
      const meta = page.metadata ?? page.generateMetadata!();
      expect(meta.referrer).toBe("no-referrer");
      expect(meta.robots).toMatchObject({ index: false, follow: false });
      const render = async (q: Record<string, string | string[] | undefined>) => renderToStaticMarkup(await page.default({ searchParams: Promise.resolve(q) }));
      for (const q of [{}, { token: "" }, { token: ["a.b.c", "d.e.f"] }, { token: "not-a-token" }, { token: '"><script>alert(1)</script>.a.b' }, { token: `${"a".repeat(3000)}.b.c` }]) {
        const html = await render(q);
        expect(html, JSON.stringify(q).slice(0, 80)).toMatch(/does not work/);
        expect(html).not.toMatch(/<form|<script/);
      }
      for (const cb of ["//evil.example/x", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)", ["/a", "/b"]]) {
        const html = await render({ token: "aaa.bbb.ccc", callbackURL: cb });
        expect(html).toContain(`name="callbackURL" value="${pool === "candidate" ? "/verify" : "/verify-email"}"`);
      }
      const html = await render({ token: "aaa.bbb.ccc", callbackURL: "/settings?email=link" });
      expect(html).toContain('name="token" value="aaa.bbb.ccc"');
      expect(html).toContain(`action="/api/auth/${pool}/verify-email"`);
      expect(html.match(/[\w-]+\.[\w-]+\.[\w-]+/g)?.filter((x) => x.split(".").every((part) => part.length >= 3) && !x.includes("example")) ?? []).toEqual(["aaa.bbb.ccc"]); // no secret but the token
    });
  }

  it("candidate email change: neither emailed link acts when opened; the old address confirms by button, then the new address by button, and only then the address moves", async () => {
    const email = await signUp("candidate", CB.candidate);
    expect((await press("candidate", await open("candidate", sent("candidate", email, "verify").at(-1)!.link))).status).toBe(302);
    const s = await post("candidate", "sign-in/email", { email, password: PASSWORD });
    const cookie = s.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const id = (await row("candidate", email))!.id, to = `fake.sec3.new.${++n}@example.test`;
    expect((await post("candidate", "change-email", { newEmail: to, callbackURL: "/account/settings?email=link" }, cookie)).status).toBe(200);
    const first = sent("candidate", email, "change-email").at(-1)!.link;
    for (let i = 0; i < 3; i++) await open("candidate", first);
    expect(sent("candidate", to, "new-email")).toEqual([]); // opening the old address's link sends nothing to the new one
    expect((await rowById("candidate", id)).email).toBe(email);
    expect((await press("candidate", await open("candidate", first))).status).toBe(302);
    const second = sent("candidate", to, "new-email").at(-1)!.link;
    expect(new URL(second).pathname).toBe("/confirm-email");
    await open("candidate", second);
    expect((await rowById("candidate", id)).email).toBe(email); // opening the new address's link moves nothing
    const done = await press("candidate", await open("candidate", second));
    expect([done.status, done.headers.get("location")]).toEqual([302, "/account/settings?email=link"]);
    expect(await rowById("candidate", id)).toEqual({ email: to, email_verified: true });
  });

  it("performance: opening the page reads nothing from the database (0 statements), and renders fast", async () => {
    const pgMod = await import("pg");
    const orig = pgMod.default.Client.prototype.query;
    let c = 0;
    pgMod.default.Client.prototype.query = function (this: pg.Client, ...a: unknown[]) { c++; return (orig as (...x: unknown[]) => unknown).apply(this, a); } as typeof orig;
    const t = performance.now();
    try {
      for (const pool of ["candidate", "portal"] as const) for (let i = 0; i < 10; i++) await open(pool, `${BASE}/confirm-email?token=aaa.bbb.ccc&callbackURL=%2F`);
    } finally { pgMod.default.Client.prototype.query = orig; }
    expect(c).toBe(0);
    expect((performance.now() - t) / 20).toBeLessThan(50); // ms per render
  });
});
