// FM1 (page motion): the server HTML of the home page already holds the final numbers and hides nothing; the motion layer only adds marks after mount.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HomeView } from "./home";
import type { HomeData, Occupation } from "./load";
import { DETE_FIGURES, pct, topFiveShare } from "./dete";
import { eur } from "./format";


vi.mock("server-only", () => ({}));
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


describe("home page server HTML with the motion layer", () => {
  const h = html(<HomeView data={full()} />);
  it("holds the final numbers, marked to count up", () => {
        const counted = (text: string) => expect(h).toMatch(new RegExp(`<(p|strong) data-count="[^"]*" class="[^"]*">${text}</`));
    counted(eur(mins.criticalSkills));
    counted(pct(DETE_FIGURES.sectors[0]!.share));
    counted(pct(topFiveShare));
    expect(h.match(/data-count/g)!.length).toBeGreaterThanOrEqual(5);
  });
  it("marks the cards for the lift and reveal, and hides nothing", () => {
    expect(h.match(/data-lift/g)!.length).toBeGreaterThanOrEqual(6);
    expect(h).not.toMatch(/data-rv|opacity:\s*0|visibility:\s*hidden|mo-pre/);
  });
});
