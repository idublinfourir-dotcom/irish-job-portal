// /account/applications (frames NA2, M07): see view.tsx.
import type { Metadata } from "next";
import { connection } from "next/server";
import { SITE_NAME } from "@portal/ui";
import { readAlerts, readOccupations, readSaved, readTracker } from "../../../lib/data";
import { safe } from "../../_home/safe";
import type { AlertRow } from "../alerts/view";
import { Failed, Head } from "../parts";
import { ApplicationsView, type SavedBit, type TrackedRow } from "./view";
import { applicationsPath } from "../../../lib/paths";
import { orSignIn } from "../guard";

export const metadata: Metadata = { title: `Your applications | ${SITE_NAME}`, robots: { index: false, follow: false } };

export default async function Page() {
  await connection(); // per visit: a failed read below must not turn the page into a static one
  const [t, s, a, o] = await Promise.all([safe(readTracker(), "tracker"), safe(readSaved(), "saved"), safe(readAlerts(), "alerts"), safe(readOccupations(), "occupations")]);
  orSignIn(t, applicationsPath());
  if (!t.ok) return <><Head title="Your applications and saved jobs" /><Failed what="your applications" code={t.code} /></>;
  const { tracker, count } = t.data as { tracker: TrackedRow[]; count: number };
  const saved = s.ok ? (s.data as { saved: SavedBit[] }).saved : null;
  const titles = new Map(o.ok ? (o.data as { occupations: { code: string; title: string }[] }).occupations.map((x) => [x.code, x.title]) : []);
  return <ApplicationsView tracked={tracker} count={count} saved={saved} savedCount={saved?.length ?? 0} alerts={a.ok ? (a.data as { alerts: AlertRow[] }).alerts : null} titleOf={(c) => titles.get(c)} now={new Date()} />;
}
