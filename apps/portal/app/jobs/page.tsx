import type { Metadata } from "next";
import { readJobStats, readJobs } from "../../lib/data";
import { bodyOf, member, nowMs } from "../_jobs/guard";
import type { Job, StatRow } from "../_jobs/words";
import { meta } from "../_site/meta";
import { JobsView } from "./view";

export const metadata: Metadata = meta("Jobs", "All the jobs your company has posted, live, under review, expired or closed, with the views and apply clicks of each over the last 30 days.");

type Query = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** Frame E08. Two reads: the company's jobs (at most 200, newest first) and 30 days of stats for all of them; the tab, the page and the picked job come from the address and are checked in the view. */
export default async function Page({ searchParams }: { searchParams: Query }) {
  const q = await searchParams;
  const m = await member("/jobs");
  const [jobs, stats] = await Promise.all([readJobs().catch(() => null), readJobStats({ days: "30" }).catch(() => null)]);
  return <JobsView now={nowMs()} role={m.role} jobs={bodyOf<Job[]>(jobs, "jobs")} stats={bodyOf<StatRow[]>(stats, "stats")} tab={one(q.tab)} from={one(q.from)} pick={one(q.job)} saved={one(q.saved)} />;
}
