// The help page body (frame C21), a pure view. Not built, by decision #287: help search (L62), the "A job listing" topic and its job reference (CF37), a reply-time promise (Q47).
// The four cards and the questions come from the help list read (B19: slug, title, category); each question opens its own page (/help/<slug>), so no answer is read here.
import type { ReactNode } from "react";
import { A, Breadcrumb, Button, Icon, type IconName } from "@portal/ui";
import { helpPath } from "../../lib/paths";
import { Accent, wrap } from "../_content/head";
import { Join } from "../jobs/parts";
import { ContactForm } from "./contact-form";

export type HelpItem = { slug: string; title: string; category: string | null };
export type HelpProps = { pages: HelpItem[] | null; /** undefined: not known on the server (the cached page); the contact form asks the hint cookie */ signedIn: boolean | undefined };

export const GROUPS: { key: string; title: string; note: string; icon: IconName }[] = [
  { key: "account", title: "Your account", note: "Sign-up, email, password, delete", icon: "user" },
  { key: "jobs_badges", title: "Jobs and badges", note: "What each badge means, blurred jobs", icon: "briefcase" },
  { key: "permit_services", title: "Permit services", note: "Requests, documents, who pays", icon: "file" },
  { key: "report_problem", title: "Report a problem", note: "Scams, wrong details, closed jobs", icon: "flag" },
];
/** The help pages of each group in the order of GROUPS, then the pages with no group (or a group we have no card for) last. */
export function grouped(pages: HelpItem[]): { key: string; title: string; pages: HelpItem[] }[] {
  const out = GROUPS.map((g) => ({ key: g.key, title: g.title, pages: pages.filter((p) => p.category === g.key) }));
  const rest = pages.filter((p) => !GROUPS.some((g) => g.key === p.category));
  return [...out, ...(rest.length ? [{ key: "other", title: "More questions", pages: rest }] : [])].filter((g) => g.pages.length > 0);
}

export function HelpView({ pages, signedIn }: HelpProps): ReactNode {
  const groups = pages ? grouped(pages) : [];
  return (
    <>
      <div className={`${wrap} pb-10 pt-6 sm:pt-8`}>
        <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Help" }]} />
        <section aria-labelledby="help-h" className="mt-4 rounded-bento bg-ink px-6 py-12 text-center text-white sm:py-16">
          <h1 id="help-h" className="text-white"><Accent text="How can we help?" n={1} /></h1>
          <p className="mx-auto mt-3 max-w-[32rem] text-lead text-white/85">Find an answer below, or send us a message.</p>
        </section>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {GROUPS.map((g) => (
            <A key={g.key} href={`#${g.key}`} className="flex min-h-[184px] flex-col justify-between gap-6 rounded-bento bg-sand p-6 no-underline hover:bg-hover-light">
              <span aria-hidden="true" className="grid size-12 place-items-center rounded-pill bg-white text-deep-green"><Icon name={g.icon} size={22} /></span>
              <span><span className="block font-heading text-[1.2rem] font-semibold">{g.title}</span><span className="block text-small text-muted">{g.note}</span></span>
            </A>
          ))}
        </div>

        <section aria-labelledby="q-h" className="mx-auto mt-14 max-w-[54rem]">
          <h2 id="q-h" className="mb-6 text-center text-[2rem] sm:text-[2.75rem]"><Accent text="Questions, answered" n={1} /></h2>
          {pages === null && <p role="alert" className="rounded-bento border border-dashed border-line bg-sand p-6 text-muted">The questions could not be loaded. Please try again in a moment, or send us a message below.</p>}
          {pages?.length === 0 && <p className="rounded-bento border border-dashed border-line bg-sand p-6 text-muted">There are no help pages yet. Send us a message below.</p>}
          {groups.map((g) => (
            <div key={g.key} id={g.key} className="mb-8 scroll-mt-6">
              <h3 className="mb-3 text-[1.1rem]">{g.title}</h3>
              <ul className="flex flex-col gap-2.5">
                {g.pages.map((p) => (
                  <li key={p.slug}>
                    <A href={helpPath(p.slug)} prefetch className="flex min-h-[64px] items-center justify-between gap-4 rounded-bento bg-sand px-6 py-3 font-heading text-[1.05rem] font-semibold no-underline hover:bg-hover-light">
                      <span className="break-words">{p.title}</span>
                      <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-pill bg-white text-deep-green"><Icon name="right" size={16} /></span>
                    </A>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>

        <div id="contact" className="mt-10 grid items-start gap-5 scroll-mt-6 lg:grid-cols-2">
          <ContactForm signedIn={signedIn} />
          <div className="flex flex-col gap-4">
            <section aria-labelledby="scam-h" className="flex flex-col gap-4 rounded-bento bg-peach p-6 sm:flex-row sm:items-center sm:p-7">
              <span aria-hidden="true" className="grid size-14 shrink-0 place-items-center rounded-pill bg-ink text-white"><Icon name="warning" size={24} /></span>
              <div className="min-w-0 flex-1">
                <h2 id="scam-h" className="text-[1.25rem] leading-snug">No genuine employer asks you to pay for a job offer. Report it.</h2>
                <p className="mt-1 text-small">Every listing has a Report button. Reports can lead to strikes and removal of sponsorship claims.</p>
              </div>
              <Button href="/report" variant="dark" size="md" className="shrink-0"><Icon name="flag" size={16} />Report</Button>
            </section>
            <section aria-labelledby="emp-h" className="flex flex-col gap-2 rounded-bento bg-sand p-6 sm:p-7">
              <h2 id="emp-h" className="text-[1.1rem]">Employers and agencies</h2>
              <p className="text-muted">Help with verification, posting and account status is in the employer portal.</p>
              <A href="/employers" className="inline-flex min-h-11 items-center gap-2 font-semibold text-deep-green underline-offset-2 hover:underline">Open employer help <Icon name="arrow" size={16} /></A>
            </section>
          </div>
        </div>
      </div>
      {!signedIn && <Join />}
    </>
  );
}
