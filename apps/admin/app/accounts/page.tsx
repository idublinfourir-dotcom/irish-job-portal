import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readCandidateMerges, readMe } from "../../lib/data";
import { guarded } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { Accounts } from "./view";

export const metadata: Metadata = { title: `Accounts, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function Page() {
  const r = await guarded(async () => ({ me: await readMe(), merges: await readCandidateMerges() }));
  if (r.refused) return <NoAccess title="Accounts" role="administrator" />;
  return <Accounts pending={r.value.merges.pending} meId={r.value.me.id} now={new Date()} />;
}
