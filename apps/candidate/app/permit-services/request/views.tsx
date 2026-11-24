// The permit request form (frame C20) and the screen after it (DD31). Plain functions of their props, so a test renders every state; the requests are in
// form.tsx. Decisions replacing the frame's wording: no service kind, no employer email, no save for later (#287, L24), the upload note says 4 MB (the route's
// limit) and the 30 day rule (#99), and an agency or employer is sent to the employer portal (this form is the candidate's request).
import type { FormEvent, ReactNode } from "react";
import { A, Breadcrumb, Button, Checkbox, Icon, Input, Notice, Pill, Select, type IconName } from "@portal/ui";
import { wrap } from "../../jobs/parts";
import { ClosedNotice } from "../landing";

export type Who = "candidate" | "employer" | "agency";
export type Occupation = { code: string; title: string };
export type JobPrefill = { id: string; title: string; employerName: string; occupationCode: string | null; contractMonths: number | null };
export type FreeCheck = { qualifies: boolean; reason: string; minimum: number | null; why: string; standingLine: string; rulesCheckedOn: string; registration: { status: string; line: string; body: { name: string; url: string } } | null } | null;
export type Doc = { fileName: string; sizeBytes: number };
type Submit = (e: FormEvent<HTMLFormElement>) => void;
export const MAX_FILE_BYTES = 4_194_304; // the upload route's own limit (4 MiB)

const WHO: [Who, string, IconName][] = [["candidate", "I am the candidate", "user"], ["employer", "I am the employer", "building"], ["agency", "I am an agency", "users"]];
const money = (n: number) => `€${n.toLocaleString("en-IE")}`;
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The three small cards beside the form and the result (frame C20's right column). `step` is the current stage of the case, 1 to 4. */
export function Aside({ step = 1 }: { step?: number }) {
  return (
    <aside className="flex flex-col gap-4" aria-label="About this request">
      <div className="flex flex-col gap-2 rounded-bento bg-peach p-6">
        <h2 className="text-ui font-semibold">You will not be charged</h2>
        <p className="text-small">Employment permit services are paid by the employer or agency, never the candidate.</p>
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
        <h2 className="text-ui font-semibold">Free for you</h2>
        <p className="text-small text-white/75">Eligibility check, document checklist and a first consultation.</p>
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

export function RequestView({ who, onWho, occupations, job, degree, onDegree, notice, employersHref, error, flashCheckEmail, pending, onSubmit }: {
  who: Who; onWho?: (w: Who) => void; occupations: Occupation[]; job: JobPrefill | null; degree: "yes" | "no" | null; onDegree?: (d: "yes" | "no") => void;
  notice: { title: string; body: string } | null; employersHref: string | null; error?: string; flashCheckEmail?: boolean; pending?: boolean; onSubmit?: Submit;
}) {
  const candidate = who === "candidate";
  return (
    <div className={`${wrap} flex flex-col gap-6 py-6`}>
      <div className="flex flex-col gap-3">
        <Breadcrumb items={[{ label: "Permit services", href: "/permit-services" }, { label: "Request" }]} />
        <h1 className="text-[2rem] lg:text-[3rem]">Start a <span className="text-deep-green">permit request</span></h1>
        <p className="text-muted">About five minutes.{job ? ` This request is about the ${job.title} job at ${job.employerName}.` : ""}</p>
      </div>
      <ClosedNotice notice={notice} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <form onSubmit={onSubmit} aria-busy={pending || undefined} className="flex flex-col gap-4">
          <Step n={1} title="Who is asking?">
            <div role="radiogroup" aria-label="Who is asking?" className="grid gap-3 sm:grid-cols-3">
              {WHO.map(([v, label, icon]) => (
                <label key={v} className="flex min-h-[88px] cursor-pointer flex-col justify-center gap-2 rounded-card border-2 border-transparent bg-white p-4 has-checked:border-deep-green has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink">
                  <input type="radio" name="who" value={v} checked={who === v} onChange={() => onWho?.(v)} className="sr-only" />
                  <span aria-hidden="true" className={`grid size-9 place-items-center rounded-pill ${who === v ? "bg-deep-green text-white" : "bg-sand"}`}><Icon name={icon} size={18} /></span>
                  <span className="font-medium">{label}</span>
                </label>
              ))}
            </div>
          </Step>
          {!candidate ? (
            <Notice kind="info" title="Employers and agencies ask in the employer portal">
              {employersHref ? <>The employer portal is where a company asks for permit services, follows its cases and uploads documents. <A href={employersHref} className="font-semibold underline underline-offset-2">Open the employer portal</A>.</> : "Employers and agencies ask for permit services in the employer portal."}
            </Notice>
          ) : (
            <>
              <Step n={2} title="The permit">
                <Select label="Permit type" name="permitType" required defaultValue="critical_skills">
                  <option value="critical_skills">Critical Skills Employment Permit</option>
                  <option value="general">General Employment Permit</option>
                </Select>
              </Step>
              <Step n={3} title="The job offer">
                <div className="grid gap-5 sm:grid-cols-2">
                  <Input label="Employer" name="employerName" icon="building" autoComplete="off" maxLength={120} defaultValue={job?.employerName} />
                  <Input label="Job title" name="title" maxLength={120} defaultValue={job?.title} />
                </div>
                <Select label="Occupation" name="occupationCode" required defaultValue={job?.occupationCode ?? ""} help="The nearest match. Our free check uses it with the salary and the degree.">
                  <option value="" disabled>Choose an occupation</option>
                  {occupations.map((o) => <option key={o.code} value={o.code}>{o.title}</option>)}
                </Select>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Input label="Salary offered, euro a year before tax" name="annualPay" inputMode="decimal" pattern="[0-9]{1,7}(\.[0-9]{1,2})?" title="Numbers only, for example 45000" required placeholder="45000" />
                  <Input label="Start date offered" name="startDate" type="date" icon="calendar" />
                </div>
                <fieldset className="flex flex-col gap-1">
                  <legend className="mb-1 text-small font-semibold">Do you have a degree that is relevant to this job?</legend>
                  <div className="flex gap-6">
                    <label className="flex min-h-11 cursor-pointer items-center gap-2"><input type="radio" name="relevantDegree" value="yes" required checked={degree === "yes"} onChange={() => onDegree?.("yes")} className="size-5 accent-deep-green" />Yes</label>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2"><input type="radio" name="relevantDegree" value="no" checked={degree === "no"} onChange={() => onDegree?.("no")} className="size-5 accent-deep-green" />No</label>
                  </div>
                </fieldset>
                <div className="grid gap-5 sm:grid-cols-3">
                  {degree === "yes" && <Input label="Month the degree was awarded" name="degreeAwardMonth" type="month" help="Optional." />}
                  <Input label="Contract length in months" name="contractMonths" inputMode="numeric" pattern="[0-9]{1,3}" title="Whole months, or leave empty for a permanent job" help="Leave empty if permanent." defaultValue={job?.contractMonths ?? undefined} />
                  <Input label="Hours a week" name="weeklyHours" inputMode="decimal" pattern="[0-9]{1,2}(\.[0-9]{1,2})?" title="For example 39" help="Optional. We assume 39." />
                </div>
                {job && <Checkbox label="Our team may contact the employer's HR about this request." name="employerContact" help="They pay for and sign the application. Without this tick we never contact them, and the request stays a free check." />}
              </Step>
              <Step n={4} title="Documents">
                <p className="text-small text-muted">After you send the request you can add copies on the next screen: the offer letter, the passport photo page, your degree and any registration decision letter. PDF, JPG or PNG, up to 4 MB each. We work from copies you upload, and we keep them for 30 days after your case closes.</p>
              </Step>
              <Checkbox label="I agree that you may use these details to help with my permit request." name="servicesConsent" required help="See the Privacy notice for how we keep them." />
              {flashCheckEmail && <Notice kind="warning" title="Verify your email first">We sent a link when you signed up. <A href="/verify" className="font-semibold underline underline-offset-2">Get a new link</A>.</Notice>}
              {error && !flashCheckEmail && <Notice kind="error">{error}</Notice>}
              <div className="flex flex-wrap items-center gap-4">
                <Button type="submit" variant="dark" size="lg" disabled={pending}>{pending ? "Sending" : "Send request"}</Button>
                <A href="/permit-services" className="text-small font-semibold text-deep-green underline-offset-2 hover:underline">Back to permit services</A>
              </div>
            </>
          )}
        </form>
        <Aside />
      </div>
    </div>
  );
}

/** DD31: the screen after a request: the case is in, our free check on the offer, and the place to add copies. */
export function ResultView({ caseHref, jobLine, freeCheck, docs, uploading, uploadError, notice, onFiles }: {
  caseHref: string; jobLine: string | null; freeCheck: FreeCheck; docs: Doc[]; uploading?: boolean; uploadError?: string; notice: { title: string; body: string } | null; onFiles?: (files: FileList | null) => void;
}) {
  return (
    <div className={`${wrap} flex flex-col gap-6 py-6`}>
      <div className="flex flex-col gap-3">
        <Breadcrumb items={[{ label: "Permit services", href: "/permit-services" }, { label: "Request" }]} />
        <h1 className="text-[2rem] lg:text-[3rem]">Request <span className="text-deep-green">received</span></h1>
        <p className="max-w-2xl text-muted">{jobLine ? `${jobLine} ` : ""}Our team has your request. We aim to come back to you within 1 working day, and we email you when we need documents or a decision is made.</p>
      </div>
      <ClosedNotice notice={notice} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
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
            <h2 id="docs-h" className="text-[1.25rem]">Add copies of your documents</h2>
            <label className="flex cursor-pointer flex-col gap-2 rounded-card border-[1.5px] border-dashed border-line-strong bg-white p-5 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink">
              <span className="flex items-center gap-3 font-semibold"><Icon name="upload" size={20} />Choose files</span>
              <span className="text-small text-muted">Offer letter, passport photo page, degree, registration decision letter. PDF, JPG or PNG, up to 4 MB each.</span>
              <input type="file" name="file" multiple accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={uploading} onChange={(e) => onFiles?.(e.currentTarget.files)} className="text-small" />
            </label>
            {uploading && <p role="status" className="text-small text-muted">Uploading</p>}
            {uploadError && <Notice kind="error">{uploadError}</Notice>}
            {docs.length > 0 && (
              <ul aria-label="Uploaded copies" className="flex flex-col gap-2">
                {docs.map((d, i) => <li key={`${d.fileName}${i}`} className="flex items-center justify-between gap-3 rounded-pill bg-white px-4 py-2 text-small"><span className="flex items-center gap-2 break-all"><Icon name="file" size={16} />{d.fileName}</span><span className="shrink-0 text-muted">{kb(d.sizeBytes)} · uploaded</span></li>)}
              </ul>
            )}
            <p className="text-small text-muted">We work from copies you upload, and we keep them for 30 days after your case closes.</p>
          </section>
          <div className="flex flex-wrap gap-3">
            <Button href={caseHref} size="lg">Track this request <Icon name="arrow" size={16} /></Button>
            <Button href="/permit-services" variant="outline" size="lg">Back to permit services</Button>
          </div>
        </div>
        <Aside step={1} />
      </div>
    </div>
  );
}
