import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SITE_NAME } from "@portal/ui";
import { readCompanyDomains, readCompanyPreview, readMe, readOwnerReassigns } from "../../../lib/data";
import { guarded } from "../../_queue/guard";
import { NoAccess } from "../../_queue/no-access";
import { Company, isCompanyId } from "./view";

export const metadata: Metadata = { title: `Company, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const MAX_PAGES = 5; // ponytail: open owner requests are few; past 100 the rest are not listed here

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isCompanyId(id)) notFound();
  const r = await guarded(async () => {
    const me = await readMe();
    const [company] = await readCompanyPreview([id]);
    if (!company) return null;
    const domains = await readCompanyDomains(id); // the roles of this page: account reviewer or administrator
    const canOwner = me.roles.includes("account_reviewer");
    const open = [];
    for (let after: string | undefined, n = 0; canOwner && n < MAX_PAGES; n++) {
      const page = await readOwnerReassigns({ after });
      open.push(...page.items.filter((x) => x.organisation_id === id));
      if (!page.next) break;
      after = page.next;
    }
    return { company, domains, open, canOwner };
  });
  if (r.refused) return <NoAccess title="Company" role="account reviewer or administrator" />;
  if (r.value === null) notFound();
  const { company, domains, open, canOwner } = r.value;
  return <Company c={company} domains={domains} open={open} canOwner={canOwner} now={new Date()} />;
}
