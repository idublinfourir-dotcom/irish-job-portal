import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readMe, readSolicitors } from "../../lib/data";
import { NoAccess } from "../_queue/no-access";
import { tryRead } from "../_tools/read";
import { Solicitors, type Firm } from "./view";

export const metadata: Metadata = { title: `Solicitors, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function Page() {
  const r = await tryRead(async () => ({ me: await readMe(), list: await readSolicitors() }));
  if (!r.ok) return <NoAccess title="Solicitors" role="services case handler or administrator" />;
  return <Solicitors items={r.value.list.items as Firm[]} isAdmin={r.value.me.roles.includes("administrator")} />;
}
