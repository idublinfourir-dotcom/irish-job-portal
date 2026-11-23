// The reads of the home page (P6), all through lib/data.ts. Each section keeps its own result, so one refusal (429) or failure hides only that section.
import { VISITOR_JOBS, type ContentPage, type JobCard, type ReadResult } from "@portal/db";
import { readGuides, readJobs, readMinimums, readOccupations, readSectors, readSignedIn, readUpdates } from "../../lib/data";

import { safe, type Failed } from "./safe";
export type { Failed };
export type Sec<T> = { ok: true; data: T } | Failed;
export type Minimums = {
  criticalSkills: number; graduate: number; graduateMonths: number; nonList: number | null; general: number | null; minContractMonths: number;
  rulesCheckedOn: string; nextVersionOn: string | null;
};
export type Jobs = { jobs: JobCard[]; signInForMore: boolean; count: { n: number; more: boolean } | null };
export type SectorCount = { sector: string; jobs: number };
export type GuideLink = { slug: string; title: string; checkedOn: string | null };
export type Occupation = { code: string; title: string; slug: string; listStatus: string };
/** The occupations the "Built for people moving to Ireland" cards show (frame N01), in the frame's order, with their photo and sector chip. */
export const FEATURED: { code: string; photo: string; sector: string }[] = [
  { code: "2231", photo: "occ-nurses", sector: "Health" },
  { code: "5434", photo: "occ-chefs", sector: "Hospitality" },
  { code: "2136", photo: "occ-software", sector: "IT" },
  { code: "2211", photo: "occ-doctors", sector: "Health" },
  { code: "2213", photo: "occ-pharmacists", sector: "Pharma" },
  { code: "6145", photo: "occ-carers", sector: "Care" },
  { code: "2121", photo: "occ-engineers", sector: "Construction" },
];
export type HomeData = {
  minimums: Sec<Minimums>; jobs: Sec<Jobs>; sectors: Sec<SectorCount[]>; guides: Sec<GuideLink[]>; updates: Sec<ContentPage[]>;
  /** The FEATURED codes found in the code list, in FEATURED order. */
  occupations: Sec<Occupation[]>;
  /** The sector tab in use, or null for "All". */
  tab: string | null;
  /** A signed-in candidate does not see the "create a free account" block. */
  signedIn: boolean;
};

const typed = <T>(r: ReadResult, pick: (d: never) => T = (d) => d as T): Sec<T> => (r.ok ? { ok: true, data: pick(r.data as never) } : r);

/** `sector` is the raw ?sector= value: anything but a short string is ignored, and a value the list refuses (400) falls back to all jobs. */
export async function loadHome(sector?: unknown): Promise<HomeData> {
  const wanted = typeof sector === "string" && sector.length > 0 && sector.length <= 40 ? sector : null;
  const jobsRead = (s: string | null) => readJobs(s ? { sort: "newest", sector: s } : { sort: "newest" });
  const [sectors, minimums, guides, updates, first, occupations, signedIn] = await Promise.all([
    safe(readSectors(), "sectors"), safe(readMinimums(), "minimums"), safe(readGuides(), "guides"), safe(readUpdates(), "updates"), safe(jobsRead(wanted), "jobs"),
    safe(readOccupations(), "occupations"), readSignedIn(),
  ]);
  const jobs = wanted && !first.ok && first.status === 400 ? await jobsRead(null) : first;
  const sec = typed<SectorCount[]>(sectors, (d: { sectors: SectorCount[] }) => d.sectors);
  const tab = wanted && jobs === first && sec.ok && sec.data.some((s) => s.sector === wanted) ? wanted : null;
  return {
    minimums: typed<Minimums>(minimums),
    jobs: typed<Jobs>(jobs, (d: Jobs) => ({ ...d, jobs: d.jobs.slice(0, VISITOR_JOBS) })), // a signed-in candidate's page is longer; the home shows the first few
    sectors: sec,
    guides: typed<GuideLink[]>(guides, (d: { guides: GuideLink[] }) => d.guides.slice(0, 3)),
    updates: typed<ContentPage[]>(updates, (d: { updates: ContentPage[] }) => d.updates.slice(0, 3)),
    occupations: typed<Occupation[]>(occupations, (d: { occupations: Occupation[] }) => featured(d.occupations)),
    tab,
    signedIn,
  };
}

/** The FEATURED codes from the whole code list, in FEATURED order; a code the list no longer has is left out. */
export const featured = (all: Occupation[]) => FEATURED.flatMap((f) => all.filter((o) => o.code === f.code));
