// Made-up data for the page tests (never a real company or figure).
import type { JobPage } from "@portal/db";
import type { CardJob } from "./card";

export const NOW = new Date("2026-11-23T12:00:00.000Z");

export const card = (o: Partial<CardJob> = {}): CardJob => ({
  id: "1042", title: "Staff Nurse", employerName: "Example Care Ltd", county: "Cork", salaryLow: 38000, salaryHigh: 45000, salaryLine: "€38,000 to €45,000", payGrade: null,
  passRoute: "stated_pay", badge: "critical_skills_eligible", quotaFull: false, postedAt: new Date("2026-11-20T08:00:00.000Z"), sponsorPermits: 12,
  lastCheckedAt: new Date("2026-11-23T06:00:00.000Z"), contractMonths: null, permitHistory: "has_history", employerSlug: "example-care", payScaleLine: null, ...o,
});

export const MINIMUMS: JobPage["minimums"] = {
  criticalSkills: 40904, graduate: 36848, graduateMonths: 12, nonList: 68911, minContractMonths: 24, standardWeekHours: 39, general: 36605, generalLower: 34000, generalLowerCodes: ["6145"],
};

export const job = (o: Partial<JobPage> = {}): JobPage => ({
  id: "1042", source: "employer", title: "Staff Nurse", employerName: "Example Care Ltd", county: "Cork", sector: "health", occupationCode: "2231", contractType: null, contractMonths: null,
  permitType: "critical_skills", applicationRoute: "own_page", ownPageUrl: "https://jobs.example.test/nurse", permitEmployerKind: null, permitEmployerName: null,
  salaryLow: 52000, salaryHigh: 52000, salaryLine: "€52,000", healthInsuranceEur: null, payGrade: null, passRoute: "stated_pay", postedAt: new Date("2026-11-20T08:00:00.000Z"), closesAt: null,
  advertText: "Made-up advert text.\nSecond line.", employer: { id: "7", slug: "example-care", name: "Example Care Ltd", website: null, logoUrl: null, shortDescription: null, kind: "employer" },
  badge: "critical_skills_eligible", sponsored: { permits: 12, since: 2022 }, permitHistory: "has_history", lastCheckedAt: new Date("2026-11-23T06:00:00.000Z"), rulesCheckedOn: "2026-11-16",
  registration: null, payScale: null, quotaFull: false, standingLine: "Our check is guidance, not a permit decision. Only DETE decides. Rules last checked on 16 November 2026.",
  minimums: MINIMUMS, permits: { byYear: [{ year: 2024, permits: 8 }, { year: 2025, permits: 12 }], peakYear: 2025, trend: "up", latestMonth: { year: 2026, month: 9, permits: 2 } },
  employerLabels: [], condition: null, salaryRangeCrosses: false, ...o,
});
