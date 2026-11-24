// /permit-services (DD26, built in the Mint Pill style from the old Bento text of frame C19, with the wording of decisions #84, #287 and #291). A plain
// function of its props, so a test renders every variant: a visitor, a signed-in candidate with no open request, and one with an open request.
// The "verify your email" variant cannot be reached here (an unverified account cannot sign in); the request form shows it when the route says NOT_VERIFIED.
import type { ReactNode } from "react";
import { A, Breadcrumb, Button, Icon, Notice, Pill } from "@portal/ui";
import { Dot, Hl, Join, wrap } from "../jobs/parts";

export type Variant = "visitor" | "no-case" | "open-case";
export type LandingProps = {
  variant: Variant;
  /** How many open requests the candidate has, and where to follow them (the case itself when there is one, the account when there are several). */
  open?: { count: number; href: string };
  /** The DETE-closed notice (#291), or null (hidden). */
  notice: { title: string; body: string } | null;
  /** Where "Start a permit request" goes: the form, or the log in page that comes back to it. */
  startHref: string;
  loginHref: string;
  signupHref: string;
  trackHref: string;
};

/** The notice from the read (`GET /api/permit-notice`), or null when it is off or has no text. */
export const noticeOf = (data: unknown): LandingProps["notice"] => {
  const n = data as { title?: unknown; body?: unknown } | null;
  return n && typeof n.title === "string" && typeof n.body === "string" ? { title: n.title, body: n.body } : null;
};

/** The notice staff switch on while DETE's Employment Permits portal is closed (#291). The text is staff's own plain text; it is never HTML. */
export function ClosedNotice({ notice }: { notice: { title: string; body: string } | null }) {
  return notice && <Notice kind="closed" title={notice.title}><span className="whitespace-pre-line">{notice.body}</span></Notice>;
}

const FREE = <Pill tone="green">Free</Pill>;
const PAID = <Pill tone="lilac">Paid service</Pill>;
const ROWS = {
  employers: [["First consultation", FREE], ["EPOS set-up", PAID], ["Application handling", PAID], ["Labour Market Needs Test guidance", PAID], ["Renewals", PAID]],
  candidates: [["Eligibility check", FREE], ["Document checklist", FREE], ["First consultation", FREE], ["Employment permit application or renewal", <Pill key="e" tone="lilac">Paid by your employer</Pill>]],
} as const satisfies Record<string, readonly (readonly [string, ReactNode])[]>;
const STEPS = [
  ["Received", "We record your request at once. We aim to come back to you within 1 working day."],
  ["Documents needed", "A list of what we need from you and from your employer."],
  ["Submitted", "We send the application to DETE through EPOS."],
  ["Decision", "We email you when the decision is in. Emails go out once a day."],
] as const;
const PROMISES = [
  ["mail", "Updates by email", "Documents needed, the decision and the close of your case come by email. Every change also shows in your case tracker."],
  ["users", "Our own team", "The same team handles your case from request to decision."],
  ["file", "Uploaded copies only", "We work from the copies you upload. We keep them for 30 days after your case closes, then delete them."],
] as const;

function List({ title, rows, dark }: { title: string; rows: readonly (readonly [string, ReactNode])[]; dark?: boolean }) {
  return (
    <section aria-label={title} className={`flex flex-col gap-4 rounded-bento p-7 sm:p-10 ${dark ? "bg-ink text-white" : "bg-sand"}`}>
      <h2 className="text-[1.5rem] lg:text-[1.75rem]">{title}</h2>
      <ul className="flex flex-col">
        {rows.map(([name, tag]) => (
          <li key={name} className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t py-3 ${dark ? "border-white/15" : "border-line"}`}>
            <span className="font-medium">{name}</span>
            <span className="text-ink">{tag}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LandingView({ variant, open, notice, startHref, loginHref, signupHref, trackHref }: LandingProps) {
  return (
    <>
      <div className={`${wrap} flex flex-col gap-6 pb-4 pt-6`}>
        <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Permit services" }]} />
        <ClosedNotice notice={notice} />
        <section aria-labelledby="ps-h" className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="flex flex-col items-start gap-6 rounded-bento bg-sand p-7 sm:p-10 lg:p-12">
            <h1 id="ps-h" className="text-[2.25rem] leading-[1.2] lg:text-[3rem]">Got an offer? We can handle your <Hl c="green">permit</Hl></h1>
            <p className="max-w-xl text-lead text-muted">Our own team prepares the employment permit application and tracks the case with you and your employer.</p>
            {variant === "open-case" && open && (
              <p className="flex items-center gap-2 rounded-pill bg-lilac px-4 py-2 text-small font-semibold"><Icon name="file" size={16} />{open.count === 1 ? "You have an open request." : `You have ${open.count} open requests.`}</p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button href={startHref} size="lg">Start a permit request <Icon name="arrow" size={16} /></Button>
              {variant === "open-case" && open && <Button href={open.href} variant="outline" size="lg">{open.count === 1 ? "Track your request" : "Track your requests"}</Button>}
              {variant === "visitor" && <Button href={trackHref} variant="outline" size="lg">Track an existing case</Button>}
            </div>
            {variant === "visitor" && (
              <p className="text-small text-muted">New here? <A href={signupHref} className="font-semibold text-deep-green underline-offset-2 hover:underline">Create a free account</A> or <A href={loginHref} className="font-semibold text-deep-green underline-offset-2 hover:underline">log in</A> to ask for help.</p>
            )}
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-1 flex-col gap-2 rounded-bento bg-peach p-7">
              <h2 className="text-ui font-semibold">Candidates never pay for our permit services</h2>
              <p className="text-small">The employer or agency pays. You do not pay us for an application, a renewal or the first consultation.</p>
            </div>
            <div className="flex flex-1 flex-col gap-2 rounded-bento bg-ink p-7 text-white">
              <h2 className="text-ui font-semibold">Application support, not legal advice</h2>
              <p className="text-small text-white/75">Complex or refused cases are referred to a solicitor.</p>
            </div>
          </div>
        </section>
      </div>

      <div className={`${wrap} grid gap-4 py-4 lg:grid-cols-2`}>
        <List title="For employers and agencies" rows={ROWS.employers} dark />
        <List title="For candidates" rows={ROWS.candidates} />
      </div>

      <section aria-labelledby="ps-steps" className={`${wrap} py-8 lg:py-12`}>
        <h2 id="ps-steps" className="mb-6 text-[1.875rem] lg:text-[2.5rem]">How a case <Hl c="peach">moves</Hl> <Dot /></h2>
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(([name, text], i) => (
            <li key={name} className="flex flex-col gap-3 rounded-bento bg-sand p-6">
              <span aria-hidden="true" className={`grid size-9 place-items-center rounded-pill font-heading font-semibold ${i === 0 ? "bg-deep-green text-white" : "bg-lilac"}`}>{i + 1}</span>
              <h3 className="text-[1.25rem]">{name}</h3>
              <p className="text-small text-muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="What we promise" className={`${wrap} grid gap-4 pb-8 md:grid-cols-3`}>
        {PROMISES.map(([icon, title, text]) => (
          <div key={title} className="flex flex-col gap-2 rounded-bento border border-line bg-white p-6">
            <span aria-hidden="true" className="grid size-11 place-items-center rounded-pill bg-green-tint text-deep-green"><Icon name={icon} size={22} /></span>
            <h3 className="text-[1.125rem]">{title}</h3>
            <p className="text-small text-muted">{text}</p>
          </div>
        ))}
      </section>
      {variant === "visitor" && <Join />}
    </>
  );
}
