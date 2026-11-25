import type { Metadata } from "next";
import { readAgencyJobs, readJobStats, readJobs, readStatus, readTeam } from "../../lib/data";
import { member, bodyOf, nowMs } from "../_jobs/guard";
import type { Job, StatRow } from "../_jobs/words";
import { meta } from "../_site/meta";
import { DashboardView, type AgencyJob, type StatusPage, type Team } from "./view";

export const metadata: Metadata = meta("Dashboard", "Your live jobs, views and apply clicks for the last 30 days, jobs that end soon, your company's account status, your team and jobs agencies posted for you.");

const soft = <T,>(p: Promise<T>) => p.catch(() => null);

/**
 * Frame NE2. One read each: the jobs, 30 days of stats, the account status, the team and the agency jobs, run together. A read that fails shows its own card as unavailable,
 * never a failed page. A suspended, closed or restricted company still opens this page (the shell's banner says why).
 */
export default async function Page() {
  const m = await member("/dashboard");
  const [jobs, stats, status, team, agency] = await Promise.all([soft(readJobs()), soft(readJobStats({ days: "30" })), soft(readStatus()), soft(readTeam()), soft(readAgencyJobs())]);
  return (
    <DashboardView
      now={nowMs()} role={m.role} jobs={bodyOf<Job[]>(jobs, "jobs")} stats={bodyOf<StatRow[]>(stats, "stats")} status={bodyOf<StatusPage>(status, "page")}
      team={bodyOf<Team>(team, "team") ?? null} teamOk={team?.status === 200} agency={bodyOf<AgencyJob[]>(agency, "jobs")}
    />
  );
}
