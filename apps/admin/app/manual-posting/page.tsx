import type { Metadata } from "next";
import type { Occupation } from "@portal/db";
import { SITE_NAME } from "@portal/ui";
import { readManualPosts, readMe, readRules, readSponsorConfirmations } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { addDays, isoDay } from "../rules/text";
import { ManualPosting } from "./view";

export const metadata: Metadata = { title: `Manual posting, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const code = (e: unknown) => (e instanceof Error ? e.message.split(":")[0]! : "");

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const after = one((await searchParams).after);
  const r = await guarded(async () => {
    const me = await readMe(), reviewer = me.roles.includes("account_reviewer");
    let list;
    try {
      list = await readManualPosts({ after, mine: reviewer }); // an account reviewer sees their own posts; trust and safety and an administrator see all
    } catch (e) {
      if (code(e) !== "bad_cursor") throw e;
      list = await readManualPosts({ mine: reviewer }); // a page link that does not read: the first page
    }
    const [sponsor, rules] = [await readSponsorConfirmations(), reviewer ? await readRules() : null];
    return { me, list, sponsor: sponsor.pending, rules };
  });
  if (r.refused) return <NoAccess title="Manual posting" role="account reviewer, trust and safety or administrator" />;
  const { me, list, sponsor, rules } = r.value, today = isoDay(new Date());
  const occ = (rules?.inForce.find((v) => v.kind === "critical_skills_list")?.data ?? []) as Occupation[];
  const mins = rules?.inForce.find((v) => v.kind === "minimums")?.data as { standardWeekHours?: number } | undefined;
  const occupations = [...new Map(occ.map((o) => [o.code, { code: o.code, title: o.title }])).values()];
  return (
    <ManualPosting who={{ id: me.id, roles: me.roles }} items={list.items} sponsor={sponsor} prev={after ? "/manual-posting" : undefined} next={list.next ? `/manual-posting?after=${encodeURIComponent(list.next)}` : undefined}
      form={rules ? { occupations, hours: mins?.standardWeekHours ?? 39, today, last: addDays(today, 90) } : undefined} />
  );
}
