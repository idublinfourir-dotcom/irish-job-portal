// /account/alerts (frame A05): see view.tsx.
import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readAlert, readAlerts, readOccupations } from "../../../lib/data";
import { safe } from "../../_home/safe";
import { Failed, Head } from "../parts";
import { AlertsView, type AlertRow } from "./view";

export const metadata: Metadata = { title: `Job alerts | ${SITE_NAME}`, robots: { index: false, follow: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ edit?: string | string[] }> }) {
  const { edit } = await searchParams;
  const id = typeof edit === "string" && /^[0-9]{1,18}$/.test(edit) ? edit : null; // anything else is ignored: the form is then the new-alert one
  const [list, occ, one] = await Promise.all([safe(readAlerts(), "alerts"), safe(readOccupations(), "occupations"), id ? safe(readAlert(id), "alert") : null]);
  if (!list.ok) return <><Head title="Job alerts" /><Failed what="your alerts" code={list.code} /></>;
  const occupations = occ.ok ? (occ.data as { occupations: { code: string; title: string }[] }).occupations.map(({ code, title }) => ({ code, title })) : [];
  const edited = one === null ? null : one.ok ? (one.data as { alert: AlertRow }).alert : "missing";
  return <AlertsView alerts={(list.data as { alerts: AlertRow[] }).alerts} occupations={occupations} edit={edited} now={new Date()} />;
}
