import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readMe, readSettings } from "../../lib/data";
import { NoAccess } from "../_queue/no-access";
import { tryRead } from "../_tools/read";
import { Settings } from "./view";

export const metadata: Metadata = { title: `Settings, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function Page() {
  const r = await tryRead(async () => ({ me: await readMe(), list: await readSettings() }));
  if (!r.ok) return <NoAccess title="Settings" role="administrator" />;
  return <Settings settings={r.value.list.settings} pending={r.value.list.pending} meId={r.value.me.id} />;
}
