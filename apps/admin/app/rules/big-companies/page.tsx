import type { Metadata } from "next";
import type { BigName, Minimums } from "@portal/db";
import { SITE_NAME } from "@portal/ui";
import { readMe, readRules } from "../../../lib/data";
import { guarded } from "../../_queue/guard";
import { BigCompanies } from "../view";
import { isoDay } from "../text";

export const metadata: Metadata = { title: `Big-company list, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function Page() {
  const r = await guarded(async () => ({ me: await readMe(), rules: await readRules() })); // any active staff member reads it; the forms show to a rules data editor only
  if (r.refused) return null; // not reached: no role is refused here
  const { me, rules } = r.value, now = new Date();
  const rows = (rules.inForce.find((v) => v.kind === "big_company_names")?.data ?? []) as BigName[];
  const mins = rules.inForce.find((v) => v.kind === "minimums")?.data as Minimums | undefined;
  return <BigCompanies rows={rows} pending={rules.pending} upcoming={rules.upcoming} who={{ id: me.id, roles: me.roles }} today={isoDay(now)} now={now} criticalSkills={mins?.criticalSkills ?? null} />;
}
