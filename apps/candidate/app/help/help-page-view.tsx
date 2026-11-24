// One help page (frames C21's questions and C25, "Not sure?" who needs a permit), a pure view: the title, the "Checked on" day, the plain body (Q2: the body format is open, so the two columns
// of the frame wait for it), and for the sign-up question the "Still not sure?" box.
import type { ReactNode } from "react";
import { Button } from "@portal/ui";
import { Body } from "../_content/body";
import { dayText } from "../_content/dates";
import { PageHead, wrap } from "../_content/head";
import { sourceOf } from "../guides/guide-view";
import { Join } from "../jobs/parts";
import { staticPath } from "../../lib/paths";

export type HelpPageData = { slug: string; title: string; body: string; sourceUrl: string | null; checkedOn: string | null };
/** The help page of the sign-up question (frame C25): the sign-up page links here, and it ends with the way back. */
export const WHO_NEEDS_PERMIT = "who-needs-a-permit";

export function HelpPageView({ page: p, signedIn }: { page: HelpPageData; signedIn: boolean }): ReactNode {
  const checked = dayText(p.checkedOn);
  const src = sourceOf(p.sourceUrl);
  return (
    <>
      <div className={`${wrap} pb-10`}>
        <PageHead
          crumbs={[{ label: "Help", href: staticPath("help")! }, { label: p.title }]}
          title={p.title}
          lead={(checked || src) && <>{checked && `Checked on ${checked}`}{checked && src && " against "}{src && <a href={src.href} target="_blank" rel="noopener noreferrer" className="font-semibold text-deep-green underline underline-offset-2">{src.host}</a>}.</>}
        />
        <Body text={p.body} className="mt-6 max-w-[46rem] text-lead text-muted" />
        {p.slug === WHO_NEEDS_PERMIT && (
          <section aria-labelledby="unsure-h" className="mt-10 flex flex-col gap-5 rounded-bento bg-ink p-6 text-white sm:p-8 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 id="unsure-h" className="text-[1.75rem] text-white">Still not sure?</h2>
              <p className="mt-2 max-w-[34rem] text-white/85">Answer &ldquo;Yes&rdquo; if you think you might need a permit. You can delete your account at any time.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button href="/signup" variant="sun" size="lg">Back to sign-up</Button>
              <Button href="/guides" size="lg" className="bg-transparent text-white hover:bg-ink-hover">Read the guides</Button>
            </div>
          </section>
        )}
      </div>
      {!signedIn && <Join />}
    </>
  );
}
