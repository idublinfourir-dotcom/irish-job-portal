import type { Metadata } from "next";
import type { PayDealList } from "@portal/db";
import { SITE_NAME } from "@portal/ui";
import { readMe, readPayDealEmployers, readRules } from "../../../lib/data";
import { guarded, one } from "../../_queue/guard";
import { PayDeal } from "../view";
import { isoDay } from "../text";

export const metadata: Metadata = { title: `Pay-deal employers, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const employer = one((await searchParams).employer);
  // Any active staff member reads the list; the forms show to a rules data editor only (the route checks the role again).
  const r = await guarded(async () => ({ me: await readMe(), list: await readPayDealEmployers(), rules: await readRules() }));
  if (r.refused) return null; // not reached: no role is refused here
  const { me, list, rules } = r.value, now = new Date();
  const data = (rules.inForce.find((v) => v.kind === "public_pay_employers")?.data ?? {}) as PayDealList; // the entries as the route reads them: a proposal sends them back as they are
  const selected = list.items.find((i) => i.name === employer)?.name ?? list.items[0]?.name ?? null;
  return <PayDeal items={list.items} versionId={list.versionId} data={data} selected={selected} pending={rules.pending} upcoming={rules.upcoming} who={{ id: me.id, roles: me.roles }} today={isoDay(now)} now={now} />;
}
