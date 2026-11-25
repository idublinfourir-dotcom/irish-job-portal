// /account/settings (frame A09, content column only): sign-in, notifications, your data, delete. The frame's currency row is gone (CF5) and so are the toggles
// nothing sends (CF41: job_alerts and account only); "Request export" and "Request log" are a download after a fresh sign-in (CF62) and a list on the page (B41).
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button, Notice } from "@portal/ui";
import { readAccountEmail, readDataAccess, readNotificationSettings, readSecurity, readSignInProviders } from "../../../lib/data";
import { loginPath, settingsDeletePath, settingsPath } from "../../../lib/paths";
import { pageDescription, pageTitle } from "../../../lib/seo";
import { shortDate } from "../../_home/format";
import { emailLinkError } from "../messages";
import { need } from "../guard";
import { Section } from "../section";
import { DataLog, type LogRow } from "./data-log";
import { EmailRow, ExportRow, GoogleRow, JobAlertsSwitch, PasswordRow, SignOutAll } from "./settings-forms";

export const generateMetadata = (): Metadata => ({
  title: pageTitle("Settings"),
  description: pageDescription("Your sign-in details, which emails you get, a copy of your data, and how to delete your account. Changing your email or deleting your account asks you to sign in again first."),
  robots: { index: false, follow: false },
});

export default async function Page({ searchParams }: { searchParams: Promise<{ email?: string | string[]; error?: string | string[] }> }) {
  const q = await searchParams;
  const account = await readAccountEmail();
  if (!account) redirect(loginPath(settingsPath()));
  const [sec, notif, access] = [need(await readSecurity(), settingsPath()), need(await readNotificationSettings(), settingsPath()), need(await readDataAccess(), settingsPath())];
  if ("refused" in sec) return <Notice kind="error" title="This account cannot use settings">Use the Help page to contact us if you think this is a mistake.</Notice>;
  const security = sec.data as { passwordChangedAt: string | null; signInMethods: string[] };
  const alertsOn = "data" in notif ? (notif.data as { settings: { job_alerts: boolean } }).settings.job_alerts : true;
  const log = "data" in access ? (access.data as { log: LogRow[] }).log : [];
  const flash = typeof q.error === "string" ? { kind: "error" as const, text: emailLinkError(q.error) }
    : q.email === "link" ? { kind: "ok" as const, text: "That link worked. When both links of an email change are opened, your address changes. Check the inbox of the new address for the second one." } : undefined;
  const hasPassword = security.signInMethods.includes("credential");
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-[2rem] leading-tight sm:text-[2.5rem]">Settings</h1>
      <Section title="Sign-in">
        <EmailRow email={account.email} verified={account.verified} flash={flash} />
        <PasswordRow hasPassword={hasPassword} changedOn={security.passwordChangedAt ? shortDate(security.passwordChangedAt.slice(0, 10)) : null} />
        {readSignInProviders().google && <GoogleRow connected={security.signInMethods.includes("google")} />}
        <SignOutAll />
      </Section>
      <Section title="Notifications">
        <JobAlertsSwitch on={alertsOn} />
        <p className="text-small text-muted">Emails about your account, such as sign-in and security messages and updates on a permit case you asked us about, are always sent.</p>
      </Section>
      <span id="data" />
      <Section title="Your data">
        <ExportRow />
        <DataLog rows={log} />
      </Section>
      <Section title="Delete account" tone="danger">
        <p>Your sign-in stops working at once. We delete your profile, CV, saved jobs, alerts and tracker 30 days later. Records we keep for business reasons stay for their own period. This cannot be undone.</p>
        <Button href={settingsDeletePath()} variant="danger" className="self-start">Delete my account and data</Button>
      </Section>
    </div>
  );
}
