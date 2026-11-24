// The report page body, a pure view (decision #259): a report needs a login, so a visitor is asked to sign in, and everyone can use the contact form.
import type { ReactNode } from "react";
import { Breadcrumb, Button, Icon } from "@portal/ui";
import { wrap } from "../_content/head";
import { ContactForm } from "../help/contact-form";
import { loginHref } from "../jobs/format";

export function ReportView({ signedIn }: { signedIn: boolean }): ReactNode {
  return (
    <div className={`${wrap} pb-12 pt-6 sm:pt-8`}>
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Report a job" }]} />
      <h1 className="mt-4">Report a <span className="text-deep-green">job</span></h1>
      <p className="mt-3 max-w-[40rem] text-lead text-muted">No genuine employer asks you to pay for a job offer. If a job or a company looks wrong, tell us. A person reviews every report.</p>
      <div className="mt-8 grid items-start gap-5 lg:grid-cols-2">
        <section aria-labelledby="how-h" className="flex flex-col gap-4 rounded-bento bg-peach p-6 sm:p-8">
          <span aria-hidden="true" className="grid size-12 place-items-center rounded-pill bg-ink text-white"><Icon name="flag" size={22} /></span>
          {signedIn ? (
            <>
              <h2 id="how-h" className="text-[1.5rem]">Open the job and use its Report button</h2>
              <p>Every job page has a Report button, and every company page has a Report this company link. Open the one that looks wrong and choose what is wrong with it.</p>
              <Button href="/jobs" variant="dark" size="lg" className="self-start">Find a job</Button>
            </>
          ) : (
            <>
              <h2 id="how-h" className="text-[1.5rem]">Sign in to report a job</h2>
              <p>Reports come from signed-in accounts, so each one can be checked and nobody can flood us with false ones. It is free for candidates. After you sign in, open the job and use its Report button.</p>
              <span className="flex flex-wrap gap-3"><Button href={loginHref("/report")} variant="dark" size="lg">Sign in</Button><Button href="/signup" variant="outline" size="lg">Create free account</Button></span>
            </>
          )}
        </section>
        <ContactForm signedIn={signedIn} />
      </div>
    </div>
  );
}
