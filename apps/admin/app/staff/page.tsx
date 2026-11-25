import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readMe, readStaff } from "../../lib/data";
import { guarded } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { Staff } from "./view";

export const metadata: Metadata = { title: `Staff and roles, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function Page() {
  const r = await guarded(async () => ({ me: await readMe(), team: await readStaff() })); // readStaff is the administrator's: any other role is refused by the database function
  if (r.refused) return <NoAccess title="Staff and roles" role="administrator" />;
  const { me, team } = r.value;
  return <Staff staff={team.staff} truncated={team.truncated} pending={team.pending} meId={me.id} now={new Date()} />;
}
