// The employer's permit request form (frame C20) and the screen after it. Plain functions of their props, so a test renders every state; the requests are in form.tsx. Decisions replacing
// the frame's wording: no "who is asking" step (this is the employer portal), no employer email (the employer is the one asking), no service kind, no save for later (#287, L24), the upload
// note says 4 MB (the route's limit) and "Copies only, never originals." (#297), the 30 day rule for copies (#99), our fee as the employer or agency's (CF1).
import type { FormEvent, ReactNode } from "react";
import { A, Breadcrumb, Button, Checkbox, Icon, Input, Notice, Pill, Select } from "@portal/ui";
import { Picker } from "../actions";
import { fmtSize, permitFeeLabel, PRICE_LINE, SERVICE_FEE } from "../model";
import { ClosedNotice, type Notice as NoticeProps } from "../views";

export type Occupation = { code: string; title: string };
export type LiveJob = { id: string; title: string; occupationCode: string | null };
export type FreeCheck = { qualifies: boolean; reason: string; minimum: number | null; why: string; standingLine: string; rulesCheckedOn: string; registration: { status: string; line: string; body: { name: string; url: string } } | null } | null;
export type Doc = { fileName: string; sizeBytes: number };
type Submit = (e: FormEvent<HTMLFormElement>) => void;
const money = (n: number) => `€${n.toLocaleString("en-IE")}`;

/** Picking one of the company's jobs fills an empty job title and picks the job's occupation when the list has it. */
function prefill(el: HTMLSelectElement, jobs: LiveJob[]) {
  const job = jobs.find((j) => j.id === el.value), title = el.form?.elements.namedItem("title"), occ = el.form?.elements.namedItem("occupationCode");
  if (job && title instanceof HTMLInputElement && title.value.trim() === "") title.value = job.title.slice(0, 120);
  if (job && occ instanceof HTMLSelectElement && [...occ.options].some((o) => o.value === job.occupationCode)) occ.value = job.occupationCode!;
}

/** The cards beside the form and the result (frame C20's right column). `step` is the current stage of the case, 1 to 4. */
export function Aside({ step = 1 }: { step?: number }) {
  return (
    <aside className="flex flex-col gap-4" aria-label="About this request">
      <div className="flex flex-col gap-2 rounded-bento bg-peach p-6">
        <h2 className="text-ui font-semibold">Payment</h2>
        <p className="text-small">{SERVICE_FEE}</p>
        <p className="text-small">{PRICE_LINE}</p>
        <p className="text-small">DETE&apos;s permit fee: {permitFeeLabel("critical_skills")} for Critical Skills, {permitFeeLabel("general").toLowerCase()} for General.</p>
      </div>
      <div className="flex flex-col gap-4 rounded-bento bg-sand p-6">
        <h2 className="text-ui font-semibold">What happens next</h2>
        <ol className="grid grid-cols-4 gap-1 text-center text-caption">
          {["Received", "Documents", "Submitted", "Decision"].map((s, i) => (
            <li key={s} className="flex flex-col items-center gap-1.5">
              <span aria-hidden="true" className={`grid size-8 place-items-center rounded-pill font-semibold ${i + 1 === step ? "bg-deep-green text-white" : "bg-lilac"}`}>{i + 1}</span>
              <span className={i + 1 === step ? "font-semibold" : ""}>{s}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="flex flex-col gap-2 rounded-bento bg-ink p-6 text-white">
        <h2 className="text-ui font-semibold">What we handle</h2>
        <p className="text-small text-white/75">EPOS set-up, application handling, Labour Market Needs Test guidance and renewals. The eligibility check and the first consultation are free.</p>
      </div>
    </aside>
  );
}

const Step = ({ n, title, children }: { n: number; title: string; children: ReactNode }) => (
  <section aria-labelledby={`step-${n}`} className="flex flex-col gap-5 rounded-bento bg-sand p-6 sm:p-8">
    <h2 id={`step-${n}`} className="flex items-center gap-3 text-[1.25rem]"><span aria-hidden="true" className="grid size-7 place-items-center rounded-pill bg-deep-green text-small text-white">{n}</span>{title}</h2>
    {children}
  </section>
);

export function RequestView({ occupations, jobs, degree, onDegree, notice, error, pending, onSubmit }: {
  occupations: Occupation[]; jobs: LiveJob[]; degree: "yes" | "no" | null; onDegree?: (d: "yes" | "no") => void; notice: NoticeProps; error?: string; pending?: boolean; onSubmit?: Submit;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Breadcrumb items={[{ label: "Permit services", href: "/services" }, { label: "New request" }]} />
        <h1>New permit request</h1>
        <p className="text-muted">About five minutes. Our team checks the offer and prepares the application.</p>
      </div>
      <ClosedNotice notice={notice} />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <form onSubmit={onSubmit} aria-busy={pending || undefined} className="flex flex-col gap-4">
          <Step n={1} title="The permit">
            <Select label="Permit type" name="permitType" required defaultValue="critical_skills">
              <option value="critical_skills">Critical Skills Employment Permit</option>
              <option value="general">General Employment Permit</option>
            </Select>
          </Step>
          <Step n={2} title="The job offer">
            <Select label="Job" name="jobId" defaultValue="" onChange={(e) => prefill(e.currentTarget, jobs)} help="One of your company's live jobs, or none if the hire is not listed here.">
              <option value="">No job listed</option>
              {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
            </Select>
            <Input label="Job title" name="title" maxLength={120} />
            <Select label="Occupation" name="occupationCode" required defaultValue="" help="The nearest match. Our free check uses it with the salary and the degree.">
              <option value="" disabled>Choose an occupation</option>
              {occupations.map((o) => <option key={o.code} value={o.code}>{o.title}</option>)}
            </Select>
            <div className="grid gap-5 sm:grid-cols-2">
              <Input label="Salary offered, euro a year before tax" name="annualPay" inputMode="decimal" pattern="[0-9]{1,7}(\.[0-9]{1,2})?" title="Numbers only, for example 45000" required placeholder="45000" />
              <Input label="Start date offered" name="startDate" type="date" icon="calendar" />
            </div>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-small font-semibold">Does the candidate have a degree that is relevant to this job?</legend>
              <div className="flex gap-6">
                <label className="flex min-h-11 cursor-pointer items-center gap-2"><input type="radio" name="relevantDegree" value="yes" required checked={degree === "yes"} onChange={() => onDegree?.("yes")} className="size-5 accent-deep-green" />Yes</label>
                <label className="flex min-h-11 cursor-pointer items-center gap-2"><input type="radio" name="relevantDegree" value="no" checked={degree === "no"} onChange={() => onDegree?.("no")} className="size-5 accent-deep-green" />No</label>
              </div>
            </fieldset>
            <div className="grid gap-5 sm:grid-cols-3">
              {degree === "yes" && <Input label="Month the degree was awarded" name="degreeAwardMonth" type="month" help="Optional." />}
              <Input label="Contract length in months" name="contractMonths" inputMode="numeric" pattern="[0-9]{1,3}" title="Whole months, or leave empty for a permanent job" help="Leave empty if permanent." />
              <Input label="Hours a week" name="weeklyHours" inputMode="decimal" pattern="[0-9]{1,2}(\.[0-9]{1,2})?" title="For example 39" help="Optional. We assume 39." />
            </div>
          </Step>
          <Step n={3} title="Documents">
            <p className="text-small text-muted">After you send the request you can add copies on the next screen: the offer letter, the candidate&apos;s passport photo page, their degree and any registration decision letter. PDF, JPG or PNG, up to 4 MB each. Copies only, never originals. We keep them for 30 days after the case closes.</p>
          </Step>
          <Checkbox label="I agree that you may use these details to help with this permit request." name="servicesConsent" required help="See the Privacy notice for how we keep them." />
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" variant="dark" size="lg" disabled={pending}>{pending ? "Sending" : "Send request"}</Button>
            <A href="/services" className="text-small font-semibold text-deep-green underline-offset-2 hover:underline">Back to permit services</A>
          </div>
        </form>
        <Aside />
      </div>
    </div>
  );
}

/** The screen after a request: the case is in, our free check on the offer, and the place to add copies. */
export function ResultView({ caseHref, freeCheck, docs, uploading, uploadError, notice, onFiles }: {
  caseHref: string; freeCheck: FreeCheck; docs: Doc[]; uploading?: boolean; uploadError?: string; notice: NoticeProps; onFiles?: (files: FileList | null) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Breadcrumb items={[{ label: "Permit services", href: "/services" }, { label: "New request" }]} />
        <h1>Request received</h1>
        <p className="max-w-2xl text-muted">Our team has your request. We aim to come back to you within 1 working day, and we email you when we need documents or a decision is made.</p>
      </div>
      <ClosedNotice notice={notice} />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4">
          <section aria-labelledby="fc-h" className="flex flex-col gap-3 rounded-bento bg-sand p-6 sm:p-8">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="fc-h" className="text-[1.25rem]">Our free check</h2>
              {freeCheck && <Pill tone={freeCheck.qualifies ? "green" : "peach"}>{freeCheck.qualifies ? "Looks eligible" : "May not qualify"}</Pill>}
            </div>
            {freeCheck ? (
              <>
                <p>{freeCheck.why}</p>
                {freeCheck.minimum !== null && <p className="text-small"><strong>Minimum salary for this route:</strong> {money(freeCheck.minimum)} a year.</p>}
                {freeCheck.registration && <p className="text-small"><strong>Registration:</strong> {freeCheck.registration.line} <A href={freeCheck.registration.body.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-deep-green underline underline-offset-2">{freeCheck.registration.body.name}</A></p>}
                <p className="text-small text-muted">{freeCheck.standingLine}</p>
              </>
            ) : (
              <p className="text-small text-muted">We could not run the free check on these details. Our team will look at your request.</p>
            )}
          </section>
          <section aria-labelledby="docs-h" className="flex flex-col gap-4 rounded-bento bg-sand p-6 sm:p-8">
            <h2 id="docs-h" className="text-[1.25rem]">Add copies of the documents</h2>
            <p className="text-small text-muted">The offer letter, the passport photo page, the degree and any registration decision letter.</p>
            <Picker busy={!!uploading} error={uploadError} onFiles={(f) => onFiles?.(f)} />
            {docs.length > 0 && (
              <ul aria-label="Uploaded copies" className="flex flex-col gap-2">
                {docs.map((d, i) => <li key={`${d.fileName}${i}`} className="flex items-center justify-between gap-3 rounded-pill bg-white px-4 py-2 text-small"><span className="flex items-center gap-2 break-all"><Icon name="file" size={16} />{d.fileName}</span><span className="shrink-0 text-muted">{fmtSize(d.sizeBytes)} · uploaded</span></li>)}
              </ul>
            )}
            <p className="text-small text-muted">We work from the copies uploaded, and we keep them for 30 days after the case closes.</p>
          </section>
          <div className="flex flex-wrap gap-3">
            <Button href={caseHref} size="lg">Track this request <Icon name="arrow" size={16} /></Button>
            <Button href="/services" variant="outline" size="lg">Back to permit services</Button>
          </div>
        </div>
        <Aside step={1} />
      </div>
    </div>
  );
}
