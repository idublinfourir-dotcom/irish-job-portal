// The account layout (DD39, CF127): one nav, the guard, the counts from reads. Reads are faked here; nothing reaches the network or the database.
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type R = { ok: true; data: unknown } | { ok: false; status: number; code: string };
const reads = vi.hoisted(() => ({ profile: undefined as unknown, saved: undefined as unknown, alerts: undefined as unknown, tracker: undefined as unknown, cases: undefined as unknown, path: null as string | null }));
vi.mock("../../lib/data", () => ({
  readProfile: async () => reads.profile, readSaved: async () => reads.saved, readAlerts: async () => reads.alerts, readTracker: async () => reads.tracker, readCases: async () => reads.cases,
  siteOrigin: () => "https://example.test",
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(reads.path ? { "x-own-path": reads.path } : {}) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect ${to}`); }, usePathname: () => "/account/saved" }));

const ok = (data: unknown): R => ({ ok: true, data });
beforeEach(() => {
  reads.profile = ok({ profile: { fullName: "Alex Example", locationKind: "abroad" } });
  reads.saved = ok({ saved: [{}, {}, {}] });
  reads.alerts = ok({ alerts: [{}] });
  reads.tracker = ok({ tracker: [], count: 5 });
  reads.cases = ok({ cases: [] });
  reads.path = null;
});
const render = async () => (await import("./layout")).default({ children: <p>page body</p> }).then((el) => html(el));

describe("the account layout", () => {
  it("sends a visitor to sign-in, back to the page they opened", async () => {
    reads.profile = { ok: false, status: 401, code: "NO_SESSION" };
    reads.path = "/account/alerts?edit=31";
    await expect(render()).rejects.toThrow("redirect /login?next=%2Faccount%2Falerts%3Fedit%3D31");
  });
  it("never trusts a hostile return address", async () => {
    reads.profile = { ok: false, status: 401, code: "NO_SESSION" };
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example"]) {
      reads.path = bad;
      await expect(render(), bad).rejects.toThrow("redirect /login");
      await expect(render(), bad).rejects.not.toThrow("next=");
    }
  });
  it("tells a suspended login so, with no nav", async () => {
    reads.profile = { ok: false, status: 403, code: "REFUSED" };
    const h = await render();
    expect(h).toContain("cannot be used");
    expect(h).not.toContain('href="/account/saved"');
  });
  it("shows one nav with the seven links, the counts from the reads and the current page marked", async () => {
    const h = await render();
    for (const href of ["/account", "/account/applications", "/account/saved", "/account/alerts", "/account/cases", "/account/profile", "/account/settings"]) expect(h).toContain(`href="${href}"`);
    expect(h).toContain("Alex Example");
    expect([...h.matchAll(/data-count[^>]*>(\d+)</g)].map((m) => m[1]).slice(0, 4)).toEqual(["5", "3", "1", "0"]);
    expect(h).toContain('aria-current="page"');
    expect(h).toContain("page body");
    for (const gone of ["Visibility", "Contact requests", "Profile hidden", "Launch B"]) expect(h).not.toContain(gone);
  });
  it("leaves a count out when its read failed, and keeps the page", async () => {
    reads.saved = { ok: false, status: 429, code: "TOO_MANY_REQUESTS" };
    const h = await render();
    expect(h.match(/data-count/g)).toHaveLength(6); // three counts, drawn in the card and in the phone row
    expect(h).toContain("page body");
  });
  it("is not indexed", async () => {
    expect((await import("./layout")).metadata.robots).toEqual({ index: false, follow: false });
  });
});
