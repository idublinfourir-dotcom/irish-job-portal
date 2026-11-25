"use client";
// Frames NE3 and E10: post a job (draft, edit, repost) with the checks running while the employer types. One form, five steps: the job, pay, contract and place, description and applying,
// the sponsorship statement. Every request is a documented route (docs/openapi/portal.yaml): POST /api/portal/jobs, /jobs/edit, /jobs/check and GET /jobs/suggest. A refused save shows its
// sentence and keeps everything typed. Parts that come later (apply on site, screening question) and Town or Eircode (L52) are not here.
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Checkbox, CriticalSkillsBadge, Input, JobCard, Notice, Radio, Select, SponsorBadge, Textarea } from "@portal/ui";
import { api } from "../(auth)/api";
import { Authority } from "./authority";
import { blockedCount, bodyOf, COUNTIES, emptyForm, eur, formFromJob, missing, money, payLine, payModes, socOf, type Check, type Form, type JobDetail, type PayMode } from "./model";
import { ChecksPanel, FirstTimeCard } from "./panels";
import { saveMessage, savedWord } from "./words";

export type Occupation = { code: string; title: string; slug: string; listStatus: string };
export type Grade = { code: string; title: string; firstEur: number; lastEur: number; note: string | null };
export type FormProps = {
  company: { name: string; kind: string; tier: number; permitHistory: string };
  statement: { version: string; body: string } | null; occupations: Occupation[]; rangeNote: string; grades: Grade[];
  job?: JobDetail; mode: "new" | "edit" | "repost"; saved?: string;
};
type Checked = { checks: Check[]; ok: boolean; exception?: string } | { error: string };

const PERMIT = { critical_skills: "Critical Skills Employment Permit", general: "General Employment Permit" } as const;
const MODE_WORD: Record<PayMode, string> = { one: "One amount", range: "A range", grade: "Public pay-scale grade" };
const card = "flex flex-col gap-4 rounded-bento bg-sand p-6";
const stepBadge = "grid size-8 place-items-center rounded-pill bg-ink text-small font-semibold text-white";
const Step = ({ n, title, children }: { n: number; title: string; children: ReactNode }) => (
  <section aria-labelledby={`step-${n}`} className={card}><h2 id={`step-${n}`} className="flex items-center gap-3 text-xl"><span aria-hidden="true" className={stepBadge}>{n}</span>{title}</h2>{children}</section>
);

export function JobForm({ company, statement, occupations, rangeNote, grades, job, mode, saved }: FormProps) {
  const router = useRouter();
  const ctx = { agency: company.kind === "agency", tier: company.tier };
  const jobId = mode === "edit" ? job?.id : undefined;
  const [f, setF] = useState<Form>(() => (job ? formFromJob(job, mode === "repost") : emptyForm()));
  const [checked, setChecked] = useState<Checked | null>(null), [checking, setChecking] = useState(false);
  const [suggest, setSuggest] = useState<Occupation[]>([]);
  const [pending, setPending] = useState<"draft" | "live" | null>(null), [error, setError] = useState<string>(), [tried, setTried] = useState(false), [exceptionText, setExceptionText] = useState<string>();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  const miss = missing(f, ctx), isReady = Object.keys(miss).length === 0;
  const shown = (k: keyof typeof miss) => (tried ? miss[k] : undefined); // a field's error shows after the first try to publish
  const sig = JSON.stringify(bodyOf(f, ctx, "live"));

  // The live checks: once the form is complete, ask the check route (no more than one call per pause in typing). Stale answers are dropped.
  useEffect(() => {
    if (!isReady) return;
    const stop = new AbortController();
    const t = setTimeout(async () => {
      setChecking(true);
      const r = await api("/api/portal/jobs/check", { method: "POST", body: JSON.parse(sig) as object, signal: stop.signal }).catch(() => null);
      if (!r) return;
      setChecking(false);
      const checks = Array.isArray(r.body.checks) ? (r.body.checks as Check[]) : null;
      if ((r.status === 200 || r.status === 422) && checks) setChecked({ checks, ok: r.status === 200, ...(typeof r.body.exception === "string" ? { exception: r.body.exception } : {}) });
      else setChecked({ error: saveMessage(r) });
    }, 600);
    return () => { clearTimeout(t); stop.abort(); };
  }, [sig, isReady]);

  // Occupation suggestions from the typed title (up to 3), only while no occupation is picked.
  const hasOcc = socOf(f.occupation) !== "", title = f.title.trim();
  useEffect(() => {
    if (hasOcc || title.length < 3) return;
    const stop = new AbortController();
    const t = setTimeout(async () => {
      const r = await api(`/api/portal/jobs/suggest?title=${encodeURIComponent(title)}`, { signal: stop.signal }).catch(() => null);
      if (r?.status === 200) setSuggest(((r.body.suggestions as { code: string; title: string }[]) ?? []).map((s) => ({ ...s, slug: "", listStatus: occupations.find((o) => o.code === s.code)?.listStatus ?? "other" })));
    }, 500);
    return () => { clearTimeout(t); stop.abort(); };
  }, [title, hasOcc, occupations]);

  const result = isReady ? checked : null;
  const checks = result && "checks" in result ? result.checks : null;
  const blocked = checks ? blockedCount(checks) : 0;
  const exception = result && "checks" in result ? result.exception ?? (checks?.find((c) => c.id === "condition")?.detail?.exception as string | undefined) : undefined;
  const occ = occupations.find((o) => o.code === socOf(f.occupation));
  const minEur = typeof checks?.find((c) => c.id === "pay")?.detail?.minimumEur === "number" ? (checks.find((c) => c.id === "pay")!.detail!.minimumEur as number) : null;
  const low = money(f.salaryLow);
  const client = ctx.agency && f.employerIs === "client";
  const grade = grades.find((g) => g.code === f.grade);
  const publishOff = pending !== null || (isReady && blocked > 0); // a form that is not complete stays clickable: the click shows what is missing

  async function save(status: "draft" | "live") {
    setError(undefined);
    if (status === "live" && !isReady) { setTried(true); setError("Fill in the fields marked below, then publish."); return; }
    if (status === "draft" && f.title.trim().length < 2) { setTried(true); setError("Give the job a title (at least 2 characters) to save a draft."); return; }
    setPending(status);
    const r = await api(jobId ? "/api/portal/jobs/edit" : "/api/portal/jobs", { method: "POST", body: bodyOf(f, ctx, status, jobId) });
    setPending(null);
    if (r.status !== 200) {
      if (r.status === 422 && typeof r.body.exception === "string") setExceptionText(r.body.exception);
      setError(saveMessage(r));
      return;
    }
    const id = String(r.body.jobId ?? jobId ?? ""), state = String(r.body.status ?? status);
    router.push(status === "draft" || (client && id) ? `/jobs/${id}/edit?saved=${state}` : `/jobs?saved=${state}`);
    router.refresh();
  }

  const tick = exception ?? exceptionText;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save("live"); }} noValidate className="mx-auto flex max-w-page flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1>{mode === "edit" ? "Edit job" : mode === "repost" ? "Post this job again" : "Post a job"}</h1>
          <p className="mt-2 max-w-2xl text-muted">{company.tier > 0 && !ctx.agency ? `${company.name} is on the public pay-deal employer list, so you can choose a grade instead of typing a salary. ` : ""}Checks run while you type, so you see what blocks a post before you publish.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="outline" size="lg" disabled={pending !== null} onClick={() => void save("draft")}>{pending === "draft" ? "Saving" : "Save draft"}</Button>
          <Button href="#preview" variant="outline" size="lg">Preview</Button>
        </div>
      </header>
      {saved && <Notice kind="success">{savedWord(saved, saved === "draft")}</Notice>}
      {error && <Notice kind="error" title="This was not saved">{error}</Notice>}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Step n={1} title="The job">
            <Input label="Job title" value={f.title} maxLength={200} onChange={(e) => set("title", e.target.value)} error={shown("title")} autoComplete="off" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Occupation" list="occupation-list" value={f.occupation} onChange={(e) => set("occupation", e.target.value)} error={shown("occupation")} autoComplete="off" placeholder="Type the code or the name"
                status={occ?.listStatus === "critical-skills" ? "passed" : undefined}
                note={occ ? `SOC ${occ.code} ${occ.title} · ${occ.listStatus === "critical-skills" ? "on the Critical Skills list" : occ.listStatus === "ineligible" ? "on the Ineligible list: some roles have an exception you can confirm" : "on neither list"}` : undefined}
              />
              <Select label="Permit type" value={f.permitType} onChange={(e) => set("permitType", e.target.value as Form["permitType"])}>
                {Object.entries(PERMIT).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </div>
            <datalist id="occupation-list">{occupations.map((o) => <option key={o.code} value={`${o.code} ${o.title}`} />)}</datalist>
            {!hasOcc && suggest.length > 0 && (
              <p className="flex flex-wrap items-center gap-2 text-small" data-suggestions><span className="text-muted">Suggested:</span>
                {suggest.map((s) => <Button key={s.code} type="button" variant="chip" onClick={() => set("occupation", `${s.code} ${s.title}`)}>{s.code} {s.title}</Button>)}
              </p>
            )}
            {tick && (
              <div data-exception className="flex flex-col gap-2 rounded-card bg-green-tint p-4">
                <p className="font-semibold">A condition applies to this role</p>
                <p>{tick}</p>
                <Checkbox label="I confirm my company meets this condition" checked={f.exception} onChange={(e) => set("exception", e.target.checked)} />
              </div>
            )}
          </Step>

          <Step n={2} title="Pay">
            <fieldset className="flex flex-wrap gap-x-6">
              <legend className="mb-1 text-small font-semibold">How is the pay set?</legend>
              {payModes(ctx).map((m) => <Radio key={m} name="pay-mode" label={MODE_WORD[m]} checked={f.payMode === m} onChange={() => set("payMode", m)} />)}
            </fieldset>
            {f.payMode === "grade" ? (
              <>
                <Select label="Pay-scale grade" value={f.grade} onChange={(e) => set("grade", e.target.value)} error={shown("pay")}>
                  <option value="">Choose a grade</option>
                  {grades.map((g) => <option key={g.code} value={g.code}>{g.title}</option>)}
                </Select>
                {grade && <Notice kind="success" title="Public sector pay scale applies">{`Pay scale for this grade: ${eur(grade.firstEur)} to ${eur(grade.lastEur)} a year. The salary minimum check is skipped for your company.`}{grade.note ? ` ${grade.note}` : ""}</Notice>}
                <p className="text-small text-muted">The pay-scale table is for display. The employer on the permit must be the public body itself, never an agency placing staff there.</p>
              </>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label={f.payMode === "range" ? "From, euro a year" : "Salary, euro a year"} inputMode="numeric" value={f.salaryLow} onChange={(e) => set("salaryLow", e.target.value)} error={shown("pay")} />
                {f.payMode === "range" && <Input label="To, euro a year" inputMode="numeric" value={f.salaryHigh} onChange={(e) => set("salaryHigh", e.target.value)} />}
                <Input label="Employer-paid health insurance, euro a year (optional)" inputMode="numeric" value={f.health} onChange={(e) => set("health", e.target.value)} error={shown("health")} help="DETE counts basic salary plus health insurance paid to a registered insurer." />
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2"><Input label="Hours a week" inputMode="numeric" value={f.hours} onChange={(e) => set("hours", e.target.value)} error={shown("hours")} /></div>
            {f.payMode === "range" && typeof low === "number" && minEur !== null && low < minEur && <Notice kind="info" title="A range that starts below the minimum">{`Candidates will see: "${rangeNote}"`}</Notice>}
          </Step>

          <Step n={3} title="Contract and place">
            <div className="grid gap-4 sm:grid-cols-2">
              <Select label="Contract type" value={f.contractType} onChange={(e) => set("contractType", e.target.value as Form["contractType"])} error={shown("contractType")}>
                <option value="">Choose</option><option value="permanent">Permanent</option><option value="fixed_term">Fixed term</option>
              </Select>
              {f.contractType === "fixed_term" && <Input label="Contract length, months" inputMode="numeric" value={f.months} onChange={(e) => set("months", e.target.value)} error={shown("months")} />}
              <Select label="County" value={f.county} onChange={(e) => set("county", e.target.value)} error={shown("county")}>
                <option value="">Choose the county</option>{COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
            {ctx.agency && (
              <div data-agency className="flex flex-col gap-3 rounded-card bg-peach p-4">
                <fieldset className="flex flex-col">
                  <legend className="font-semibold">Who is the permit employer?</legend>
                  <p className="mb-1 text-small">Agencies tell us who the permit employer is, the agency or the client, and we check that employer against the permit records.</p>
                  <Radio name="employer-is" label={`The agency (${company.name})`} checked={f.employerIs === "self"} onChange={() => set("employerIs", "self")} />
                  <Radio name="employer-is" label="The client" checked={f.employerIs === "client"} onChange={() => set("employerIs", "client")} />
                </fieldset>
                {client && <Input label="Client company" value={f.clientName} maxLength={160} onChange={(e) => set("clientName", e.target.value)} error={shown("client")} />}
                {client && jobId && <Authority jobId={jobId} />}
                {client && !jobId && <p className="text-small">After you save the job you can add a copy of the client&apos;s written authority.</p>}
              </div>
            )}
          </Step>

          <Step n={4} title="Description and applying">
            <Textarea label="What the job involves" rows={8} value={f.description} maxLength={10000} onChange={(e) => set("description", e.target.value)} error={shown("description")} />
            <Input label="Where candidates apply" type="url" value={f.ownPageUrl} maxLength={500} onChange={(e) => set("ownPageUrl", e.target.value)} error={shown("ownPageUrl")} help="Your own application page. Candidates apply on your site." placeholder="https://" />
          </Step>

          <section aria-labelledby="step-5" className={`${card} border-2 border-ink bg-white`}>
            <h2 id="step-5" className="flex items-center gap-3 text-xl"><span aria-hidden="true" className={stepBadge}>5</span>Sponsorship statement</h2>
            <p className="text-small text-muted">{f.permitType === "general" ? "A General permit job needs the statement signed." : "Optional for a Critical Skills job. Signing gives the job the Sponsor confirmed badge."}</p>
            {statement ? <blockquote data-statement-wording className="rounded-card bg-lilac-soft p-4 font-heading text-lead">{statement.body}</blockquote> : <Notice kind="info" title="No statement wording is published yet">A job cannot be signed until it is. You can save a draft.</Notice>}
            <Checkbox label="I confirm this statement on behalf of the employer." checked={f.statement} disabled={!statement} onChange={(e) => set("statement", e.target.checked)} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Named person" value={f.signerName} maxLength={120} onChange={(e) => set("signerName", e.target.value)} error={f.statement ? shown("signer") : undefined} />
              <Input label="Role" value={f.signerTitle} maxLength={120} onChange={(e) => set("signerTitle", e.target.value)} />
            </div>
            {client && f.statement && <Checkbox label="I have the client's written authority" checked={f.authority} onChange={(e) => set("authority", e.target.checked)} error={shown("authority")} />}
            <div className="flex flex-wrap items-center gap-4">
              <Button type="submit" variant="dark" size="lg" disabled={publishOff}>{pending === "live" ? "Publishing" : mode === "edit" && job?.status !== "draft" ? "Save changes" : "Publish job"}</Button>
              {isReady && blocked > 0 && <span className="text-small text-muted" data-blocked-hint>{`Fix ${blocked} blocked ${blocked === 1 ? "check" : "checks"} to publish.`}</span>}
            </div>
          </section>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-4">
          <ChecksPanel checks={checks} missing={Object.keys(miss).map((k) => LABEL[k] ?? k)} checking={checking} error={result && "error" in result ? result.error : undefined} />
          <p className="text-small text-muted" id="preview">How it will look</p>
          <JobCard
            title={f.title.trim() || "Job title"} employer={company.name} place={f.county || "County"} salary={payLine(f, grade) || undefined}
            badges={<>{f.statement && <SponsorBadge />}{occ?.listStatus === "critical-skills" && f.permitType === "critical_skills" && <CriticalSkillsBadge />}</>}
          />
          {company.permitHistory === "first_time" && <FirstTimeCard />}
        </aside>
      </div>
    </form>
  );
}
const LABEL: Record<string, string> = { title: "the title", description: "the description", county: "the county", occupation: "the occupation", contractType: "the contract type", months: "the contract length", ownPageUrl: "the address where candidates apply", pay: "the pay", hours: "the hours", health: "the health insurance", client: "the client", signer: "the signer", authority: "the written authority tick" };
