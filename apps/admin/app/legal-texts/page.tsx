import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readLegal, readMe } from "../../lib/data";
import { NoAccess } from "../_queue/no-access";
import { tryRead } from "../_tools/read";
import { LegalTexts } from "./view";

export const metadata: Metadata = { title: `Legal texts, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function Page() {
  const r = await tryRead(async () => ({ me: await readMe(), list: await readLegal() }));
  if (!r.ok) return <NoAccess title="Legal texts" role="content editor or administrator" />;
  return <LegalTexts versions={r.value.list.versions} pending={r.value.list.pending} meId={r.value.me.id} roles={r.value.me.roles} />;
}
