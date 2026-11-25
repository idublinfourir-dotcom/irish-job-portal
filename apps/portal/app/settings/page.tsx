import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PORTAL_SIGN_IN, readLogin, readNoticeSettings } from "../../lib/data";
import { tokenMeta } from "../_site/meta";
import { SettingsView, type Banner } from "./view";

export const metadata: Metadata = tokenMeta("Settings", "Change your sign-in email, sign out everywhere, choose which emails you get, download your data or delete your login on Irish Work Permit for employers.");

/** BA30. Signed out goes to sign-in and comes back (the emailed change-email links end here). Any signed-in login, with or without a company; only two return markers are read from the address. */
export default async function Page({ searchParams }: { searchParams: Promise<{ email?: string | string[]; error?: string | string[] }> }) {
  const q = await searchParams;
  const banner: Banner = q.error === "EMAIL_TAKEN" ? "EMAIL_TAKEN" : q.email === "confirm" ? "confirm" : null;
  const [login, notices] = await Promise.all([readLogin().catch(() => null), readNoticeSettings().catch(() => null)]);
  if (!login) redirect(`${PORTAL_SIGN_IN}?next=${encodeURIComponent(banner === "confirm" ? "/settings?email=confirm" : "/settings")}`);
  const s = notices?.status === 200 ? (notices.body.settings as { job_expiry_reminder?: unknown } | undefined) : undefined;
  return <SettingsView email={login.email} reminder={typeof s?.job_expiry_reminder === "boolean" ? s.job_expiry_reminder : null} banner={banner} />;
}
