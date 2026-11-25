// The eligibility checker page body (frame C18), a pure view of the answers and the read. Not built, by decision #287 (Q52, L25): the public-pay and health insurance inputs, the per-rule
// results, the graduate comparison and the "jobs that pass" count. The words of the answer are the checker's own (`why`); the headline and the registration block are worded here (BA20).
import type { ReactNode } from "react";
import { A, Breadcrumb, Button, Icon, Input, Notice, Radio } from "@portal/ui";
import { wrap } from "../_content/head";
import { shortDate } from "../_home/format";
import { euro } from "../jobs/format";
import { Join } from "../jobs/parts";
import { occupationJobsPath, occupationPagePath, staticPath } from "../../lib/paths";
import { optionText, type Occupation, type Parsed } from "./input";

export type Registration = { status: "required" | "may_need" | "not_open"; body: { id: string; name: string; url: string }; line: string; steps: readonly string[]; degreeNote?: string } | null;
export type Answer = { qualifies: boolean; reason: string; minimum: number | null; why: string; standingLine: string; rulesCheckedOn: string; registration: Registration };
export type CheckerProps = { parsed: Parsed; occupations: Occupation[] | null; answer: Answer | null; failed: { status: number } | null; signedIn: boolean };

const HEAD: Record<string, string> = {
  unknown_code: "We do not know that occupation code",
  ineligible: "This occupation is not open for a Critical Skills permit",
  contract_too_short: "The contract is too short for a Critical Skills permit",
  below_minimum: "The salary is below the minimum",
  degree_needed: "A relevant degree is needed for this job",
  non_list_route_blocked: "This permit route is not open without a relevant degree",
};
export const headlineOf = (a: Pick<Answer, "qualifies" | "reason">): ReactNode =>
  a.qualifies ? <>This job could qualify for a <span className="text-deep-green">Critical Skills</span> permit</> : <>{HEAD[a.reason] ?? "This job does not meet the Critical Skills rules"}</>;

function Form({ parsed, occupations }: { parsed: Parsed; occupations: Occupation[] | null }) {
  const v = parsed.values, e = parsed.errors;
  return (
    <form method="get" action={staticPath("eligibility-checker")!} className="flex flex-col gap-5 rounded-bento bg-sand p-6 sm:p-8">
      <h2 className="flex items-center gap-3 text-[1.25rem]"><span aria-hidden="true" className="grid size-8 place-items-center rounded-pill bg-deep-green text-small text-white">1</span>The job</h2>
      <Input name="occupation" label="Occupation" list="occupations" defaultValue={v.occupation} error={e.occupation} autoComplete="off" required help="Start typing a name, or enter the four-digit SOC code." />
      {occupations && <datalist id="occupations">{occupations.map((o) => <option key={o.code} value={optionText(o)} />)}</datalist>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Input name="pay" label="Salary offered (euro a year)" inputMode="decimal" defaultValue={v.pay} error={e.pay} required />
        <Input name="months" label="Contract length in months" inputMode="numeric" defaultValue={v.months} error={e.months} help="Leave empty for a permanent job." />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input name="hours" label="Hours a week" inputMode="decimal" defaultValue={v.hours} error={e.hours} help="Leave empty for a full week (39 hours)." />
        <Input name="title" label="Job title (optional)" defaultValue={v.title} error={e.title} maxLength={200} help="Tells a nursing or medical role from other jobs in the same group." />
      </div>
      <h2 className="mt-2 flex items-center gap-3 text-[1.25rem]"><span aria-hidden="true" className="grid size-8 place-items-center rounded-pill bg-deep-green text-small text-white">2</span>You</h2>
      <fieldset className="flex flex-col gap-1" aria-describedby={e.degree ? "degree-error" : undefined}>
        <legend className="mb-1 text-small font-semibold">Do you have a relevant degree?</legend>
        <Radio name="degree" value="yes" label="Yes, I have a relevant degree" defaultChecked={v.degree === "yes"} />
        <Radio name="degree" value="no" label="No, I do not have a relevant degree" defaultChecked={v.degree === "no"} />
        {e.degree && <p id="degree-error" role="alert" className="text-small font-semibold text-error">{e.degree}</p>}
      </fieldset>
      <Input name="degreeMonth" type="month" label="Month you got your degree (optional)" defaultValue={v.degreeMonth} error={e.degreeMonth} help="Only if you have a relevant degree. A degree from the last 12 months has a lower minimum." />
      <Button type="submit" variant="dark" size="lg" className="self-start">Check eligibility</Button>
    </form>
  );
}

function Registration({ r }: { r: NonNullable<Registration> }) {
  return (
    <section aria-labelledby="reg-h" className="flex flex-col gap-3 rounded-bento bg-sand p-6">
      <h2 id="reg-h" className="text-[1.25rem]">Registration: {r.body.name}</h2>
      <p className="text-muted">{r.line}</p>
      {r.steps.length > 0 && <ol className="list-decimal pl-6 text-muted">{r.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
      <p><A href={r.body.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 font-semibold text-deep-green underline-offset-2 hover:underline">Read the {r.body.name} guide <Icon name="external" size={14} /></A></p>
    </section>
  );
}

function Result({ p, occupations, a, failed }: { p: Parsed; occupations: Occupation[] | null; a: Answer | null; failed: { status: number } | null }) {
  if (failed)
    return failed.status === 429
      ? <Notice kind="warning" title="Too many checks">Please wait a little and try again.</Notice>
      : failed.status === 400
        ? <Notice kind="error" title="We could not check that">Some of the answers were not accepted. Check them and try again.</Notice>
        : <Notice kind="error" title="The check could not be run">Please try again in a moment.</Notice>;
  if (!a)
    return (
      <section aria-labelledby="result-h" className="flex flex-col gap-3 rounded-bento bg-ink p-6 text-white sm:p-8">
        <p className="text-small text-white/75">Result</p>
        <h2 id="result-h" className="text-[1.75rem] leading-snug text-white">{p.submitted ? "Fix the answers marked on the left" : "Your result appears here"}</h2>
        <p className="text-white/85">{p.submitted ? "We need every answer before we can check." : "Answer the questions and press Check eligibility. Nothing you enter is saved."}</p>
      </section>
    );
  const occ = occupations?.find((o) => o.code === p.code);
  const page = occ && occupationPagePath(occ);
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="result-h" data-result={a.qualifies ? "qualifies" : "no"} className="flex flex-col gap-4 rounded-bento bg-ink p-6 text-white sm:p-8">
        <p className="text-small text-white/75">Result</p>
        <h2 id="result-h" className="text-[1.75rem] leading-snug text-white sm:text-[2.1rem]">{headlineOf(a)}</h2>
        <p className="flex items-start gap-3 text-white/90"><Icon name={a.qualifies ? "check" : "info"} size={20} className="mt-0.5 shrink-0" />{a.why}</p>
      </section>
      {a.minimum !== null && (
        <section aria-label="Minimum that applies to you" className="flex flex-col gap-2 rounded-bento bg-peach p-6">
          <p className="text-small">Minimum that applies to you</p>
          <p className="font-heading text-[2.25rem] font-semibold leading-none">{euro(a.minimum)}</p>
          <p className="text-small">From the rules table, checked {shortDate(a.rulesCheckedOn)}.</p>
        </section>
      )}
      {a.registration && <Registration r={a.registration} />}
      <div className="flex flex-wrap gap-3">
        {p.code && <Button href={occupationJobsPath(p.code)} variant="outline" size="md">See jobs for this occupation</Button>}
        {page && <Button href={page} variant="outline" size="md">Read about this occupation</Button>}
      </div>
      <p className="text-small text-muted">{a.standingLine}</p>
    </div>
  );
}

/** The breadcrumb of the page, also its markup. */
export const CHECKER_CRUMBS = [{ label: "Home", href: "/" }, { label: "Eligibility checker" }];

export function CheckerView({ parsed, occupations, answer, failed, signedIn }: CheckerProps): ReactNode {
  return (
    <>
      <div className={`${wrap} pb-10 pt-6 sm:pt-8`}>
        <Breadcrumb items={CHECKER_CRUMBS} />
        <h1 className="mt-4">Eligibility <span className="text-deep-green">checker</span></h1>
        <p className="mt-3 max-w-[40rem] text-lead text-muted">Answer a few questions. The same rules engine as the job badges. This is guidance, not legal advice.</p>
        <div className="mt-8 grid items-start gap-5 lg:grid-cols-2">
          <Form parsed={parsed} occupations={occupations} />
          <div className="flex flex-col gap-4">
            <Result p={parsed} occupations={occupations} a={answer} failed={failed} />
            <p className="text-small text-muted">The employer must also be registered and trading in Ireland, and meet the 50:50 staff rule. That is the employer&rsquo;s responsibility.</p>
          </div>
        </div>
      </div>
      {!signedIn && <Join />}
    </>
  );
}
