// Render tests of the home page (P6): every section and state as HTML, fixture props only (no database, no network).
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HomeView } from "./home";
import { photoSrc } from "./photos";
import { FEATURED, featured, type HomeData, type Occupation } from "./load";
import { DETE_FIGURES, pct, topFiveShare } from "./dete";
import { eur, jobsIn, sectorLabel, shortDate } from "./format";
import { employersHref, HOME_DESCRIPTION, HOME_TITLE } from "./meta";
import { generateMetadata } from "../page";

vi.mock("server-only", () => ({})); // page.tsx reaches lib/data.ts; nothing here calls it
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const card = (n: number, o: object = {}) => ({
  id: String(n), title: `Fake Cook ${n}`, employerName: "Fake Employer", county: "Cork", salaryLow: 30000, salaryHigh: null, salaryLine: "From €30,000", payGrade: null, passRoute: "x",
  badge: "critical_skills_eligible", quotaFull: false, postedAt: new Date(0), sponsorPermits: null, lastCheckedAt: null, contractMonths: null, permitHistory: "not_linked",
  source: "admin_manual", employerSlug: "fake-employer", employerLogoUrl: null, payScaleLine: null, ...o,
});
const occ = (code: string, title: string, listStatus: string): Occupation => ({ code, title, slug: title.toLowerCase(), listStatus });
const mins = { criticalSkills: 41000, graduate: 37000, graduateMonths: 12, nonList: null, general: 36000, minContractMonths: 24, rulesCheckedOn: "2026-11-16", nextVersionOn: "2027-03-01" };
const full = (o: Partial<HomeData> = {}): HomeData => ({
  minimums: { ok: true, data: mins },
  jobs: { ok: true, data: { jobs: [1, 2, 3, 4, 5, 6].map((n) => card(n, n === 2 ? { badge: "sponsor_confirmed" } : n === 3 ? { salaryLine: null, quotaFull: true, county: null } : {})) as never, signInForMore: true, count: { n: 40, more: false } } },
  sectors: { ok: true, data: [{ sector: "health", jobs: 5 }, { sector: "IT", jobs: 9 }, { sector: "care", jobs: 0 }] },
  guides: { ok: true, data: [{ slug: "g-one", title: "Fake guide", checkedOn: "2026-11-01" }] },
  updates: { ok: true, data: [{ slug: "u-one", title: "Fake update", checkedOn: "2026-11-02" }] as never },
  occupations: { ok: true, data: [occ("2231", "Nurses", "critical-skills"), occ("5434", "Chefs", "ineligible")] },
  tab: null, signedIn: false, ...o,
});
const fail = { ok: false as const, status: 500, code: "ERROR" }, limited = { ok: false as const, status: 429, code: "TOO_MANY_REQUESTS", retryAfter: 42 };

describe("home page, normal state", () => {
  const h = html(<HomeView data={full()} />);
  it("has one H1 and every section of the brief", () => {
    expect(h.match(/<h1/g)).toHaveLength(1);
    for (const id of ["sectors", "latest-jobs", "badges", "steps", "minimums", "permits", "occupations", "permit-services", "employers", "guides", "faq", "join-h"]) expect(h).toContain(`id="${id}`);
    expect(h).toContain('action="/jobs"'); // the search goes to /jobs
    expect(h).toContain('name="q"');
    expect(h).toContain('<option value="Cork">');
  });
  it("prints the minimums and their checked-on date from the read, never typed", () => {
    expect(h).toContain("€41,000");
    expect(h).toContain("16 Nov 2026");
    expect(h).toContain("New minimums start on 1 Mar 2027.");
    expect(h).toContain("at least 24 months");
  });
  it("shows six job cards with badges, the quota label, links by readable address and no work-pattern tag", () => {
    expect(h.match(/data-job-card/g)).toHaveLength(6);
    expect(h).toContain('href="/jobs/fake-cook-1-cork-1"');
    expect(h).toContain("Critical Skills eligible");
    expect(h).toContain("Sponsor confirmed");
    expect(h).toContain("Quota full");
    expect(h).toContain("Salary not stated");
    expect(h).not.toMatch(/Hybrid|Full time|Trusted Partner|Sample|Medical devices|Retail|Logos|\bDETE, 2026\b/);
  });
  it("shows the sign-in box and blurred placeholder rows from the count and the flag", () => {
    expect(h).toContain("data-sign-in-for-more");
    expect(h).toContain("There are 14 live jobs."); // the sector tiles' own total, not the list's capped count (40 here)
    expect(html(<HomeView data={full({ tab: "IT" })} />)).toContain("There are 9 live jobs.");
    expect(html(<HomeView data={full({ sectors: fail })} />)).toContain("There are 40 live jobs."); // the tiles' read failed: what the list counted
    const many = html(<HomeView data={full({ sectors: { ok: true, data: [{ sector: "health", jobs: 97 }, { sector: "IT", jobs: 253 }, { sector: "pharma and science", jobs: 110 }] } })} />);
    for (const t of ["There are 460 live jobs.", "97 live jobs", "250+ live jobs", "110 live jobs"]) expect(many, t).toContain(t); // #301
    expect(many).not.toContain("253");
    expect(h.match(/data-placeholder/g)).toHaveLength(3);
  });
  it("shows the sector tiles in DETE's order with our live counts, and sector tabs biggest first", () => {
    expect(h.indexOf("5 live jobs")).toBeLessThan(h.indexOf("9 live jobs")); // health tile before IT
    expect(h).toContain("No live jobs yet"); // hospitality has none in the fixture
    expect(h).not.toMatch(/\b0 live jobs/);
    expect(h).toContain('href="/jobs?sector=IT"');
    expect(h).toContain('role="tablist"');
    expect(h.indexOf('href="/?sector=IT#latest-jobs"')).toBeLessThan(h.indexOf('href="/?sector=health#latest-jobs"'));
  });
  it("lets the sector chip row shrink and scroll inside the toolbar, so a phone page never scrolls sideways (bug at 390 px, 23 Nov)", () => {
    expect(h).toMatch(/class="flex min-w-0 max-w-full flex-wrap[^"]*"><div role="tablist"[^>]*class="flex min-w-0 max-w-full[^"]*overflow-x-auto/);
  });
  it("prints the DETE figures with their period and a link to DETE, never a frame number", () => {
    expect(h).toContain("33,362");
    expect(h).toContain("DETE, Jan to Oct 2026");
    expect(h).toContain(`href="${DETE_FIGURES.source}"`);
    expect(h).not.toMatch(/26,629|Jan to Aug/);
  });
  it("lets the visitor pick a degree without script: one radio per minimum, each with its own amount", () => {
    expect(h.match(/name="home-degree"/g)).toHaveLength(3);
    for (const n of ["€41,000 a year", "€37,000 a year", "€36,000 a year"]) expect(h).toContain(n);
  });
  it("links each featured occupation to its page with the list status read from the rules", () => {
    expect(h).toContain('href="/occupations/nurses"');
    expect(h).toContain("On the Critical Skills list");
    expect(h).toContain("Only some roles qualify");
  });
  it("links an occupation on neither list to its jobs: it has no page (OCC1)", () => {
    const care = html(<HomeView data={full({ occupations: { ok: true, data: [occ("6145", "Carers", "other")] } })} />);
    expect(care).toContain('href="/jobs?occupationCode=6145"');
    expect(care).toContain("General Employment permit route");
    expect(care).not.toContain("/occupations/");
  });
  it("words the fees by decision: no Critical Skills fee clause, services paid by the employer or agency", () => {
    expect(h).not.toMatch(/may pay the fee|can be paid by you|you can pay/);
    expect(h).toContain("paid by the employer or agency");
  });
  it("has guides and updates cards, the FAQ as visible text, and the account block", () => {
    expect(h).toContain('href="/guides/g-one"');
    expect(h).toContain('href="/updates#u-one"');
    expect(h).toContain("Checked on 1 Nov 2026");
    expect(h).toContain("Do I pay to use the site");
    expect(h).toContain("Visitors see the latest 6 jobs");
    expect(h).toContain('href="/signup"');
    expect(h).not.toMatch(/dangerouslySetInnerHTML|<script/);
    // every photo is a self-hosted decorative file: empty alt, imported from ./photos
    for (const img of h.match(/<img[^>]*>/g)!) expect(img).toMatch(/src="[^"]*\/_home\/photos\/[a-z0-9-]+\.webp" alt=""/);
    expect(h).not.toMatch(/src="https?:\/\//); // no third-party image host
  });
});

describe("home page photos", () => {
  const dir = path.join(import.meta.dirname, "photos");
  const bytes = (names: string[]) => names.reduce((n, f) => n + statSync(path.join(dir, `${f}.webp`)).size, 0);
  const files = readdirSync(dir).map((f) => f.replace(/\.webp$/, ""));
  const h = html(<HomeView data={full()} />);
  const names = (re: RegExp) => [...new Set([...h.matchAll(re)].map((m) => m[1]!))].sort();
  const eager = names(/<img src="[^"]*photos\/([a-z0-9-]+)\.webp" alt="" loading="eager"/g);
  const wide = names(/<link rel="preload" as="image" href="[^"]*photos\/([a-z0-9-]+)\.webp" media="\(min-width: 40rem\)"/g);

  it("loads what is in view at once; what a phone hides is fetched early on wide screens only", () => {
    expect(eager).toEqual(["face-4", "face-5", "face-6", "hero"]);
    expect(wide).toEqual(["face-1", "face-2", "face-3", "rules-card"]);
    for (const n of wide) expect(h).not.toMatch(new RegExp(`${n}\\.webp" alt="" loading="eager"`));
  });
  it("PERF-10: only the hero is fetched at high priority", () => {
    expect([...h.matchAll(/<img[^>]*fetchPriority="high"[^>]*>/gi)].map((m) => m[0].match(/photos\/([a-z0-9-]+)\.webp/)![1])).toEqual(["hero"]);
  });
  it("has a file for every featured occupation, and no file nothing uses", () => {
    for (const f of FEATURED) expect(files).toContain(f.photo);
    const all = html(<HomeView data={full({ occupations: { ok: true, data: FEATURED.map((f) => occ(f.code, `Fake ${f.code}`, "ineligible")) }, sectors: { ok: true, data: ["health", "hospitality", "IT", "construction and engineering", "finance", "pharma and science"].map((sector) => ({ sector, jobs: 1 })) as never }, guides: { ok: true, data: [1, 2, 3].map((n) => ({ slug: `g-${n}`, title: `Fake ${n}`, checkedOn: "2026-11-01" })) } })} />);
    const used = new Set([...all.matchAll(/photos\/([a-z0-9-]+)\.webp/g)].map((m) => m[1]));
    expect(files.filter((f) => !used.has(f))).toEqual([]);
  });
  it("stays within the photo budget (23 Nov 2026: 135 KB at once on a phone, 42 KB more on a wide screen, 1.16 MB in all)", () => {
    expect(bytes(eager)).toBeLessThan(160_000);
    expect(bytes(wide)).toBeLessThan(60_000);
    expect(bytes(files)).toBeLessThan(1_300_000);
  });
  it.each(["nope", "../home", "../../../../package", "hero.webp", "__proto__", "constructor", ""])("refuses a name that is not a photo: %j", (name) => {
    expect(() => photoSrc(name)).toThrow("no photo");
  });
});

describe("home page, other states", () => {
  it("signed in or few jobs: no sign-in box, no placeholders", () => {
    const h = html(<HomeView data={full({ jobs: { ok: true, data: { jobs: [card(1)] as never, signInForMore: false, count: null } } })} />);
    expect(h).not.toContain("data-sign-in-for-more");
    expect(h).not.toContain("data-placeholder");
  });
  it("marks the active tab", () => expect(html(<HomeView data={full({ tab: "IT" })} />)).toMatch(/aria-selected="true"[^>]*href="\/\?sector=IT#latest-jobs"/));
  it("empty: no jobs and no sectors", () => {
    const h = html(<HomeView data={full({ jobs: { ok: true, data: { jobs: [], signInForMore: false, count: null } }, sectors: { ok: true, data: [] }, guides: { ok: true, data: [] }, updates: { ok: true, data: [] } })} />);
    expect(h).toContain("No jobs here yet");
    expect(h).toContain("No live jobs yet");
    expect(h).toContain("will appear here when they are published");
  });
  it("429 on every read: each section says how long to wait, nothing else breaks", () => {
    const h = html(<HomeView data={{ minimums: limited, jobs: limited, sectors: limited, guides: limited, updates: limited, occupations: limited, tab: null, signedIn: false }} />);
    expect(h).toContain("Please try again in 42 seconds.");
    expect(h.match(/<h1/g)).toHaveLength(1);
  });
  it("other read errors: a reload notice, and the hero card is left out", () => {
    const h = html(<HomeView data={{ minimums: fail, jobs: fail, sectors: fail, guides: fail, updates: fail, occupations: fail, tab: null, signedIn: false }} />);
    expect(h).toContain("This part could not be loaded");
    expect(h).not.toContain("From the rules table</p>");
  });
  it("escapes hostile text", () => {
    const h = html(<HomeView data={full({ guides: { ok: true, data: [{ slug: "a", title: "<script>alert(1)</script>", checkedOn: null }] } })} />);
    expect(h).not.toContain("<script>alert");
  });
});

describe("helpers and metadata", () => {
  it("rounds the DETE shares as the frame prints them, and keeps the featured order", () => {
    expect([pct(26.7), pct(4.0), pct(topFiveShare), pct(100 - topFiveShare)]).toEqual(["27%", "4%", "58%", "42%"]);
    const all = [occ("2136", "Programmers", "critical-skills"), occ("9999", "Other", "other"), occ("2231", "Nurses", "critical-skills")];
    expect(featured(all).map((o) => o.code)).toEqual(["2231", "2136"]);
  });
  it("formats", () => {
    expect([shortDate("2026-01-05"), shortDate("junk"), eur(40904), sectorLabel("health"), sectorLabel("IT"), jobsIn({ n: 1, more: false }), jobsIn({ n: 253, more: false })]).toEqual(["5 Jan 2026", "junk", "€40,904", "Health", "IT", "1 live job", "250+ live jobs"]);
  });
  it("sets a title of 60 characters or fewer plus the brand, and a description of 120 to 160", () => {
    const m = generateMetadata();
    expect(HOME_TITLE.length).toBeLessThanOrEqual(60);
    expect(String(m.title)).toMatch(/ \| .+$/);
    expect(HOME_DESCRIPTION.length).toBeGreaterThanOrEqual(120);
    expect(HOME_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(m.robots).toBeUndefined(); // the layout's site-wide noindex stays
  });
});

describe("home leftovers closed by the main session", () => {
  it("hides the create-account block for a signed-in candidate and shows it to a visitor", () => {
    expect(html(<HomeView data={full({ signedIn: true })} />)).not.toContain('id="join-h"');
    const out = html(<HomeView data={full({ signedIn: false })} />);
    expect(out).toContain('id="join-h"');
    expect(out).toContain("data-join"); // the footer runs on from it
  });
  it("no featured occupation in the list: the section is left out", () => {
    expect(html(<HomeView data={full({ occupations: { ok: true, data: [] } })} />)).not.toContain('id="occupations"');
  });
  it("links employers to the portal address, the dev server when unset, and nowhere in production when unset", () => {
    expect(employersHref({ PORTAL_AUTH_URL: "https://employers.example.ie/api/auth/portal", NODE_ENV: "production" })).toBe("https://employers.example.ie/");
    expect(employersHref({ NODE_ENV: "development" })).toBe("http://localhost:3001/");
    expect(employersHref({ NODE_ENV: "production" })).toBeNull();
  });
});

describe("a section read that throws becomes that section's failed state", () => {
  it("returns READ_FAILED and logs, and passes a good read through", async () => {
    const { safe } = await import("./safe");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(safe(Promise.reject(new Error('column "category" does not exist')), "updates")).resolves.toEqual({ ok: false, status: 500, code: "READ_FAILED" });
    expect(log).toHaveBeenCalledWith("home: the updates read failed", expect.any(Error));
    await expect(safe(Promise.resolve({ ok: true, data: 1 }), "jobs")).resolves.toEqual({ ok: true, data: 1 });
    log.mockRestore();
  });
});
