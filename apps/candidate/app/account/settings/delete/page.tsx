// /account/settings/delete (frame A10 as a page): what deleting does, said as docs/database.md and the decisions say it (not the frame's "deleted at once",
// CF64; an open permit case keeps the data until it closes, CF63, #99; no open applications at Launch A, CF27), then the typed confirmation. The route needs a
// sign-in in the last 10 minutes (D270), so an older session is asked to sign in again and comes back here (DD10, DD13).
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { A, Notice } from "@portal/ui";
import { readAccountEmail, readCases, readSecurity } from "../../../../lib/data";
import { loginPath, settingsDeletePath, settingsPath } from "../../../../lib/paths";
import { pageDescription, pageTitle } from "../../../../lib/seo";
import { need } from "../../guard";
import { DeleteForm } from "../settings-forms";

export const generateMetadata = (): Metadata => ({
  title: pageTitle("Delete your account"),
  description: pageDescription("Delete your account and data. Your sign-in stops at once and your profile, CV, saved jobs, alerts and tracker are deleted after 30 days. Records we must keep stay for their own period."),
  robots: { index: false, follow: false },
});

export default async function Page() {
  if (!(await readAccountEmail())) redirect(loginPath(settingsDeletePath()));
  const sec = need(await readSecurity(), settingsDeletePath());
  if ("refused" in sec) return <Notice kind="error" title="This account cannot be changed here">Use the Help page to contact us if you think this is a mistake.</Notice>;
  const cases = await readCases();
  const openCase = cases.ok && ((cases.data as { cases: { status: string }[] }).cases ?? []).some((c) => c.status !== "closed");
  const googleOnly = !(sec.data as { signInMethods: string[] }).signInMethods.includes("credential");
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-[2rem] leading-tight sm:text-[2.5rem]">Delete your account?</h1>
      <section className="flex flex-col gap-5 rounded-bento bg-sand p-6 sm:p-8">
        <Notice kind="error" title="This cannot be undone">
          <ul className="mt-1 list-disc pl-5">
            <li>Your sign-in stops working at once, and every device is signed out.</li>
            <li>We delete your profile, CV, saved jobs, alerts and tracker 30 days later. We email you a confirmation now.</li>
            <li>We keep what a business has to keep: permit case records and invoices (for 6 years after a case closes) and proof of what you agreed to.</li>
          </ul>
        </Notice>
        {openCase && <Notice kind="info" title="You have an open permit case">Your data stays with us until the case closes. After that the 30 days run, and then we delete it.</Notice>}
        {googleOnly && <p className="text-muted">You sign in with Google, so Google asks you to confirm it is you if you have not signed in in the last 10 minutes.</p>}
        <p>Want a copy first? <A href={`${settingsPath()}#data`} className="font-semibold text-deep-green underline underline-offset-2">Download my data</A>.</p>
        <DeleteForm back={settingsDeletePath()} googleOnly={googleOnly} />
      </section>
    </div>
  );
}
