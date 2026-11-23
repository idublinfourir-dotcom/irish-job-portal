// The admin sidebar's counts (P4): the numbers the staff counts read (C1, GET /api/staff/me/counts) gives, keyed by the link label packages/ui's AdminShell shows
// them on. Pure, no server-only, so a test can run it. A count the member's roles do not cover is left out (the link is hidden then anyway); a queue the member
// works but that is empty counts 0. The name-merge suggestion count is not here: it runs the name matcher (about 170 ms), so only the name merges page asks for it.
import type { myCounts } from "@portal/db/staff-tools";

type StaffCounts = Awaited<ReturnType<typeof myCounts>>;

export function sidebarCounts(c: StaffCounts): Record<string, number | undefined> {
  const n = (v: number | null) => v ?? undefined;
  return {
    "Account reviews": c.queues.account_review ?? 0,
    "Fetched jobs": c.queues.fetched_job ?? 0,
    "Reports and strikes": n(c.reportsOpen),
    "Services cases": n(c.casesOpen),
  };
}
