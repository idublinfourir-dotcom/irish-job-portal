import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readDeteLinks, readMe } from "../../../lib/data";
import { guarded, one } from "../../_queue/guard";
import { NoAccess } from "../../_queue/no-access";
import { DeteLinks, href } from "./view";

export const metadata: Metadata = { title: `DETE name links, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const asked = one((await searchParams).page);
  const n = asked !== undefined && /^[1-9]\d{0,3}$/.test(asked) ? Number(asked) : 1; // a page that is not a number is the first
  const r = await guarded(async () => ({ me: await readMe(), list: await readDeteLinks(n) }));
  if (r.refused) return <NoAccess title="DETE name links" role="account reviewer, trust and safety or administrator" />;
  const { me, list } = r.value;
  return (
    <DeteLinks items={list.suggestions} total={list.total} page={n} canAct={me.roles.includes("account_reviewer")}
      next={n * 50 < list.total ? href(n + 1) : undefined} prev={n > 1 ? href(n - 1) : undefined} />
  );
}
