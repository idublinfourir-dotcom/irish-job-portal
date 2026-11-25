import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readDataRequests, readMe } from "../../lib/data";
import { NoAccess } from "../_queue/no-access";
import { tryRead } from "../_tools/read";
import { DataRequests } from "./view";

export const metadata: Metadata = { title: `Data requests, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function Page() {
  const r = await tryRead(async () => ({ me: await readMe(), list: await readDataRequests() }));
  if (!r.ok) return <NoAccess title="Data requests" role="administrator" />;
  const { me, list } = r.value;
  return <DataRequests items={list.items} truncated={list.truncated} pending={list.pending} meId={me.id} />;
}
