// What the two posting pages share: the reads (through lib/data.ts only), the guard and the states a person can land in. A viewer sees why there is no form; a job of another company or an
// address that is not an id is the same 404; a closed or hidden job cannot be edited.
import { notFound } from "next/navigation";
import { A, Notice } from "@portal/ui";
import { readCompany, readJob, readJobForm, readJobGrades } from "../../lib/data";
import { bodyOf, member } from "../_jobs/guard";
import { JobForm, type Grade, type Occupation } from "./form";
import type { JobDetail } from "./model";
import { loadMessage, SAVED } from "./words";

const ID = /^[1-9][0-9]{0,17}$/;
export const validId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

type Company = { name: string; kind: string; publicPayTier: number; permitHistory: string };
type FormRead = { statement: { version: string; body: string } | null; occupations: Occupation[]; rangeNote: string };

/** `mode` new: a blank form, or the job `jobId` filled in again for a repost; edit: the job `jobId`. */
export async function FormPage({ here, mode, jobId, saved }: { here: string; mode: "new" | "edit"; jobId?: string; saved?: string }) {
  const m = await member(here);
  if (m.role === "viewer") {
    return <div className="mx-auto max-w-page"><Notice kind="info" title="Your role cannot post jobs">A viewer can see the jobs and their numbers. Ask the account owner to give you the poster role in Team. <A href="/jobs" className="font-semibold underline">Back to the jobs</A></Notice></div>;
  }
  const [company, form, one] = await Promise.all([readCompany().catch(() => null), readJobForm().catch(() => null), jobId ? readJob(jobId).catch(() => null) : null]);
  if (jobId && one?.status === 404) notFound();
  const c = bodyOf<Company>(company, "company"), fr = form?.status === 200 ? (form.body as unknown as FormRead) : null, job = bodyOf<JobDetail>(one, "job");
  if (!c || !fr || (jobId && !job)) return <div className="mx-auto max-w-page"><Notice kind="error" title="We cannot open the form now">{loadMessage({ status: (!c ? company?.status : !fr ? form?.status : one?.status) ?? 0 })}</Notice></div>;
  if (job && (job.status === "closed" || job.status === "hidden") && mode === "edit") {
    return <div className="mx-auto max-w-page"><Notice kind="info" title={job.status === "closed" ? "This job is closed" : "This job is hidden"}>It cannot be edited. {job.status === "closed" ? <A href={`/jobs/new?from=${job.id}`} className="font-semibold underline">Post it again</A> : <A href="/account-status" className="font-semibold underline">See why</A>}</Notice></div>;
  }
  const grades = c.publicPayTier > 0 && c.kind !== "agency" ? bodyOf<Grade[]>(await readJobGrades().catch(() => null), "grades") ?? [] : [];
  return (
    <JobForm
      company={{ name: c.name, kind: c.kind, tier: c.publicPayTier, permitHistory: c.permitHistory }} statement={fr.statement} occupations={fr.occupations} rangeNote={fr.rangeNote} grades={grades}
      job={job} mode={mode === "edit" ? "edit" : job ? "repost" : "new"} saved={saved && SAVED.includes(saved) ? saved : undefined}
    />
  );
}
