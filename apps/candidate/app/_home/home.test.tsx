// Render tests of the home page (P6): every section and state as HTML, fixture props only (no database, no network).
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HomeView } from "./home";
import type { HomeData } from "./load";
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
const mins = { criticalSkills: 41000, graduate: 37000, graduateMonths: 12, nonList: null, general: 36000, minContractMonths: 24, rulesCheckedOn: "2026-11-16", nextVersionOn: "2027-03-01" };
const full = (o: Partial<HomeData> = {}): HomeData => ({
  minimums: { ok: true, data: mins },
  jobs: { ok: true, data: { jobs: [1, 2, 3, 4, 5, 6].map((n) => card(n, n === 2 ? { badge: "sponsor_confirmed" } : n === 3 ? { salaryLine: null, quotaFull: true, county: null } : {})) as never, signInForMore: true, count: { n: 40, more: false } } },
  sectors: { ok: true, data: [{ sector: "health", jobs: 5 }, { sector: "IT", jobs: 9 }, { sector: "care", jobs: 0 }] },
  guides: { ok: true, data: [{ slug: "g-one", title: "Fake guide", checkedOn: "2026-11-01" }] },
  updates: { ok: true, data: [{ slug: "u-one", title: "Fake update", checkedOn: "2026-11-02" }] as never },
  tab: null, signedIn: false, ...o,
});
const fail = { ok: false as const, status: 500, code: "ERROR" }, limited = { ok: false as const, status: 429, code: "TOO_MANY_REQUESTS", retryAfter: 42 };

describe("home page, normal state", () => {
  const h = html(<HomeView data={full()} />);
  it("has one H1 and every section of the brief", () => {
    expect(h.match(/<h1/g)).toHaveLength(1);
    for (const id of ["sectors", "latest-jobs", "badges", "steps", "minimums", "permit-services", "employers", "guides", "faq", "join-h"]) expect(h).toContain(`id="${id}`);
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
    expect(h.match(/<article/g)!.length).toBeGreaterThanOrEqual(6);
    expect(h).toContain('href="/jobs/fake-cook-1-cork-1"');
    expect(h).toContain("Critical Skills eligible");
    expect(h).toContain("Sponsor confirmed");
    expect(h).toContain("Quota full");
    expect(h).toContain("Salary not stated");
    expect(h).not.toMatch(/Hybrid|Full time|Trusted Partner|Sample|Medical devices|Retail|Logos|\bDETE, 2026\b/);
  });
  it("shows the sign-in box and blurred placeholder rows from the count and the flag", () => {
    expect(h).toContain("data-sign-in-for-more");
    expect(h).toContain("There are 40 live jobs.");
    expect(h.match(/data-placeholder/g)).toHaveLength(3);
  });
  it("lists the sectors that have jobs, biggest first, as links to the job list, and tabs for them", () => {
    expect(h.indexOf("9 live jobs")).toBeLessThan(h.indexOf("5 live jobs"));
    expect(h).toContain('href="/jobs?sector=IT"');
    expect(h).not.toMatch(/\b0 live jobs/);
    expect(h).toContain('role="tablist"');
    expect(h).toContain('href="/?sector=health#latest-jobs"');
  });
  it("words the fees by decision: no Critical Skills fee clause, services paid by the employer or agency", () => {
    expect(h).not.toMatch(/may pay the fee|can be paid by you|you can pay/);
    expect(h).toContain("paid by the employer or agency");
  });
  it("has guides and updates cards, the FAQ as visible text, and the account block", () => {
    expect(h).toContain('href="/guides/g-one"');
    expect(h).toContain('href="/updates/u-one"');
    expect(h).toContain("Checked on 1 Nov 2026");
    expect(h).toContain("Do I pay to use the site");
    expect(h).toContain("Visitors see the latest 6 jobs");
    expect(h).toContain('href="/signup"');
    expect(h).not.toMatch(/dangerouslySetInnerHTML|<script|<img/);
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
    const h = html(<HomeView data={{ minimums: limited, jobs: limited, sectors: limited, guides: limited, updates: limited, tab: null, signedIn: false }} />);
    expect(h).toContain("Please try again in 42 seconds.");
    expect(h.match(/<h1/g)).toHaveLength(1);
  });
  it("other read errors: a reload notice, and the hero card is left out", () => {
    const h = html(<HomeView data={{ minimums: fail, jobs: fail, sectors: fail, guides: fail, updates: fail, tab: null, signedIn: false }} />);
    expect(h).toContain("This part could not be loaded");
    expect(h).not.toContain("From the rules table</p>");
  });
  it("escapes hostile text", () => {
    const h = html(<HomeView data={full({ guides: { ok: true, data: [{ slug: "a", title: "<script>alert(1)</script>", checkedOn: null }] } })} />);
    expect(h).not.toContain("<script>alert");
  });
});

describe("helpers and metadata", () => {
  it("formats", () => {
    expect([shortDate("2026-01-05"), shortDate("junk"), eur(40904), sectorLabel("health"), sectorLabel("IT"), jobsIn(1), jobsIn(2)]).toEqual(["5 Jan 2026", "junk", "€40,904", "Health", "IT", "1 live job", "2 live jobs"]);
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
    expect(html(<HomeView data={full({ signedIn: true })} />)).not.toContain("Create a free account and see every job");
    expect(html(<HomeView data={full({ signedIn: false })} />)).toContain("Create a free account and see every job");
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
