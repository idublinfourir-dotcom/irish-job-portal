import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readAccuracySample, readFetchedDecisions, readMe, readOverdue, readPermitRises, readScheduledChecks, readSignupNoCounts, readTargets } from "../../lib/data";
import { one } from "../_queue/guard";
import { tryRead } from "../_tools/read";
import { Figures, type Blocks } from "./view";

export const metadata: Metadata = { title: `Figures, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const val = <T,>(r: { ok: true; value: T } | { ok: false }): T | null => (r.ok ? r.value : null);

/** Each block is its own read, so a block shows only to the roles that read's own check lets in; a refused block is left out, not shown empty. */
export default async function Page({ searchParams }: { searchParams: Promise<{ after?: string | string[] }> }) {
  const after = one((await searchParams).after);
  await tryRead(readMe); // a visitor or a disabled login goes to the sign-in page before any block is read
  const decide = async () => {
    try {
      return await readFetchedDecisions(after);
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("bad_cursor"))) throw e;
      return readFetchedDecisions(undefined); // a page link that does not read: the first page
    }
  };
  const [signup, rises, targets, overdue, checks, sample, decisions] = await Promise.all([
    tryRead(readSignupNoCounts), tryRead(readPermitRises), tryRead(readTargets), tryRead(readOverdue), tryRead(readScheduledChecks), tryRead(readAccuracySample), tryRead(decide),
  ]);
  const b: Blocks = { signup: val(signup), rises: val(rises), targets: val(targets), overdue: val(overdue), checks: val(checks), sample: val(sample), decisions: val(decisions) };
  return <Figures b={b} now={new Date()} prev={after ? "/figures#decisions" : undefined} />;
}
