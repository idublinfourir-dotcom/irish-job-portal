import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readAccountReviews, readAudit, readCounts, readFetchedJobs, readMe, readOverdue, readReports, readRules } from "../lib/data";
import { guarded } from "./_queue/guard";
import { NoAccess } from "./_queue/no-access";
import { Overview, tilesOf } from "./overview";
import { nextRules, workRows, WORK_ROWS } from "./overview-data";

export const metadata: Metadata = { title: `Queues overview, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * P14: one overview per role (#287, Q75). Each tile and list is asked for only when the member holds the role that reads it (the database functions check the role again),
 * so nothing a role may not see is read, let alone sent. A visitor goes to the sign-in page.
 */
export default async function Page() {
  const r = await guarded(async () => {
    const me = await readMe();
    const has = (role: string) => me.roles.includes(role);
    const [counts, accounts, fetched, reports, overdue, audit, rules] = await Promise.all([
      readCounts({ merges: true }),
      has("account_reviewer") ? readAccountReviews({ tab: "waiting" }) : null,
      has("fetched_job_reviewer") ? readFetchedJobs({}) : null,
      has("trust_and_safety") ? readReports() : null,
      has("administrator") ? readOverdue() : null,
      readAudit(),
      readRules(),
    ]);
    return { me, counts, accounts, fetched, reports, overdue, audit, rules };
  });
  if (r.refused) return <NoAccess title="Queues overview" role="right"/* a role removed while the page loaded */ />;
  const { me, counts, accounts, fetched, reports, overdue, audit, rules } = r.value;
  const tiles = tilesOf(counts, me.roles, overdue ? { count: overdue.items.length, more: overdue.truncated } : null);
  const work = workRows({ accounts: accounts?.items.slice(0, WORK_ROWS) ?? null, fetched: fetched?.items.slice(0, WORK_ROWS) ?? null, reports: reports?.items.slice(0, WORK_ROWS) ?? null });
  return <Overview now={new Date()} tiles={tiles} work={work} audit={audit.events.slice(0, 4)} auditFull={me.roles.includes("administrator")} upcoming={nextRules(rules.upcoming)} roleCount={me.roles.length} />;
}
