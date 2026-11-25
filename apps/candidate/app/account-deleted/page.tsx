// The goodbye after the account is deleted (DD5): the session is gone, so this page is outside /account and needs no sign-in.
import type { Metadata } from "next";
import { Button } from "@portal/ui";
import { pageDescription, pageTitle } from "../../lib/seo";

export const generateMetadata = (): Metadata => ({
  title: pageTitle("Your account is deleted"),
  description: pageDescription("Your account is closed and you are signed out. We delete your profile, CV, saved jobs, alerts and tracker in 30 days. You can still search every job without an account."),
  robots: { index: false, follow: false },
});

export default function Page() {
  return (
    <section className="mx-auto flex max-w-page flex-col items-start gap-5 px-5 py-16 sm:px-8">
      <h1 className="text-[2rem] sm:text-[2.5rem]">Your account is deleted</h1>
      <p className="max-w-prose text-muted">You are signed out and cannot sign in again. We delete your profile, CV, saved jobs, alerts and tracker in 30 days, and we sent you an email to confirm. Records we have to keep stay for their own period.</p>
      <p className="max-w-prose text-muted">You can still search every job without an account, and you are welcome to make a new one later.</p>
      <div className="flex flex-wrap gap-3">
        <Button href="/jobs" variant="dark">Find jobs</Button>
        <Button href="/" variant="outline">Home</Button>
      </div>
    </section>
  );
}
