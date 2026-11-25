import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readCompanyPreview, readDeteLinks, readMe } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { LINK_VIEWERS, MERGE_ROLES, NameMerges } from "./view";

export const metadata: Metadata = { title: `Company name merges, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Params = { page?: string | string[]; a?: string | string[]; b?: string | string[] };
const id = (v: string | undefined) => (v !== undefined && /^[1-9]\d{0,17}$/.test(v) ? v : undefined); // a company number; anything else is not looked up

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const rawPage = one(q.page);
  const page = rawPage !== undefined && /^[1-9]\d{0,3}$/.test(rawPage) && Number(rawPage) <= 1000 ? Number(rawPage) : 1; // the route's own range
  const a = id(one(q.a)), b = id(one(q.b));
  const r = await guarded(async () => {
    const me = await readMe();
    if (!me.roles.some((x) => MERGE_ROLES.includes(x))) throw new Error("no_role"); // no data is read for a role this page is not for
    const links = me.roles.some((x) => LINK_VIEWERS.includes(x)) ? await readDeteLinks(page) : null;
    const ids = [...new Set([a, b].filter((x): x is string => x !== undefined))];
    const found = ids.length ? await readCompanyPreview(ids) : null;
    return { me, links, found };
  });
  if (r.refused) return <NoAccess title="Company name merges" role="account reviewer, fetched-job reviewer, rules data editor, trust and safety or administrator" />;
  const { me, links, found } = r.value;
  return <NameMerges links={links} roles={me.roles} page={page} a={a} b={b} found={found} />;
}
