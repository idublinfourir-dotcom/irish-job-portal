// The reads of the home page (P6), all through lib/data.ts. Each section keeps its own result, so one refusal (429) or failure hides only that section.
import { VISITOR_JOBS, type ContentPage, type JobCard, type ReadResult } from "@portal/db";
import { readGuides, readJobs, readMinimums, readSectors, readSignedIn, readUpdates } from "../../lib/data";

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
export type HomeData = {
  minimums: Sec<Minimums>; jobs: Sec<Jobs>; sectors: Sec<SectorCount[]>; guides: Sec<GuideLink[]>; updates: Sec<ContentPage[]>;
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
  const [sectors, minimums, guides, updates, first, signedIn] = await Promise.all([
    safe(readSectors(), "sectors"), safe(readMinimums(), "minimums"), safe(readGuides(), "guides"), safe(readUpdates(), "updates"), safe(jobsRead(wanted), "jobs"), readSignedIn(),
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
    tab,
    signedIn,
  };
}
