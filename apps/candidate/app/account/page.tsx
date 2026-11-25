// /account (frame NA1): see home.tsx.
import type { Metadata } from "next";
import { connection } from "next/server";
import { SITE_NAME } from "@portal/ui";
import { readAccountEmail, readAlerts, readCases, readDidYouApply, readNotices, readProfile, readSaved, readTracker } from "../../lib/data";
import { safe } from "../_home/safe";
import { HomeView, type Case, type HomeData, type Prompt, type Tracked, type Update } from "./home";
import { accountPath } from "../../lib/paths";
import { orSignIn } from "./guard";

export const metadata: Metadata = { title: `Your account | ${SITE_NAME}`, robots: { index: false, follow: false } };

const ok = <T,>(r: { ok: boolean; data?: unknown }): T | null => (r.ok ? (r.data as T) : null);

export default async function Page() {
  await connection(); // per visit: a failed read below must not turn the page into a static one
  const [profile, saved, alerts, tracker, cases, prompts, notices, login] = await Promise.all([
    safe(readProfile(), "profile"), safe(readSaved(), "saved"), safe(readAlerts(), "alerts"), safe(readTracker(), "tracker"), safe(readCases(), "cases"), safe(readDidYouApply(), "prompts"), safe(readNotices(), "notices"), readAccountEmail(),
  ]);
  orSignIn(profile, accountPath());
  const t = ok<{ tracker: Tracked[]; count: number }>(tracker);
  const data: HomeData = {
    name: ok<{ profile: { fullName: string | null } | null }>(profile)?.profile?.fullName?.trim() || login?.name.trim() || null,
    saved: ok<{ saved: unknown[] }>(saved)?.saved.length ?? null,
    alerts: ok<{ alerts: unknown[] }>(alerts)?.alerts.length ?? null,
    applications: t?.count ?? null,
    tracked: t?.tracker.slice(0, 3) ?? [],
    prompt: ok<{ prompts: Prompt[] }>(prompts)?.prompts[0] ?? null,
    permitCase: ok<{ cases: (Case & { status: string })[] }>(cases)?.cases.find((c) => c.status !== "closed") ?? null,
    updates: ok<{ items: Update[] }>(notices)?.items.slice(0, 3) ?? [],
  };
  return <HomeView d={data} now={new Date()} />;
}
