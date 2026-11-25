import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readCompanySeed, readMe } from "../../../lib/data";
import { guarded } from "../../_queue/guard";
import { NoAccess } from "../../_queue/no-access";
import { Seed } from "./view";

export const metadata: Metadata = { title: `Company seed, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function Page() {
  const r = await guarded(async () => ({ me: await readMe(), seed: await readCompanySeed() }));
  if (r.refused) return <NoAccess title="Company seed" role="rules data editor or administrator" />;
  const { me, seed } = r.value;
  return <Seed pending={seed.pending} meId={me.id} canPropose={me.roles.includes("rules_data_editor")} canDecide={me.roles.includes("administrator")} now={new Date()} />;
}
