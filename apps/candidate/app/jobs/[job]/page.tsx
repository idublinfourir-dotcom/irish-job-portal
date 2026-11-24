// /jobs/<title>-<county>-<id>: one job (P8). Reads only through lib/data.ts. The address ends in the id, which is all the page looks up; any other slug
// redirects to the current address (#288). A job that is not live is a 404, except a closed or expired job (anyone, the closed-job read B27) and a hidden
// or under-review one for the signed-in candidate who saved or tracked it (S20 wording, similar jobs).
import { cache } from "react";
import type { Metadata } from "next";
import type { JobPage } from "@portal/db";
import { notFound, permanentRedirect } from "next/navigation";
import { Notice } from "@portal/ui";
import { countView, readClosedJob, readDidYouApply, readJob, readMyJob, readProfile, readSignedIn, readSimilar } from "../../../lib/data";
import { jobIdOf, jobPath } from "../../../lib/paths";
import { fromSmall, type CardJob } from "../card";
import { ClosedJob } from "../closed";
import type { DegreeChoice } from "../degree";
import { jobDescription, jobTitleText } from "../format";
import { JobView } from "../job-view";

type Props = { params: Promise<{ job: string }> };

// One read per request, shared by generateMetadata and the page (each gated read counts against the read limit).
const load = cache((id: string) => readJob({ id }));
// The closed-job read (B27): asked only after the job read answered 404. It answers for a job its employer closed or the day-30 run expired, whoever opens it.
const loadClosed = cache((id: string) => readClosedJob({ id }));
type ClosedRead = { closed: true; reason: string; job: { title: string; employerName: string }; similar: Parameters<typeof fromSmall>[0][] };

const idOf = async (p: Props["params"]) => jobIdOf((await p).job);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const id = await idOf(params);
  const r = id ? await load(id) : null;
  if (r?.ok) {
    const j = r.data as JobPage;
    return { title: jobTitleText(j), description: jobDescription(j) };
  }
  const closed = id && r && r.status === 404 ? await loadClosed(id) : null;
  return { title: closed?.ok ? "This job has closed" : "Job not found" };
}

export default async function Page({ params }: Props) {
  const seg = (await params).job;
  const id = jobIdOf(seg);
  if (!id) notFound();
  const r = await load(id);
  const now = new Date();
  const same = (a: string, b: string) => a === b || (() => { try { return decodeURIComponent(a) === b; } catch { return false; } })();

  if (!r.ok) {
    if (r.status === 429) return <div className="mx-auto max-w-page px-5 py-8 sm:px-8"><Notice kind="warning" title="Too many requests">Please wait{"retryAfter" in r ? ` about ${r.retryAfter} seconds` : " a little"} and try again.</Notice></div>;
    if (r.status !== 404) notFound();
    // Not live. A job its employer closed (or that expired) gets the closed state for anyone; a signed-in candidate who saved or tracked a hidden or
    // under-review job gets the S20 state; everything else is the 404 page.
    const closed = await loadClosed(id);
    if (closed.ok) {
      const c = closed.data as ClosedRead;
      return <ClosedJob reason={c.reason} title={c.job.title} employerName={c.job.employerName} similar={(c.similar ?? []).map(fromSmall)} signedIn={await readSignedIn()} />;
    }
    const mine = await readMyJob(id);
    const own = mine.ok ? (mine.data as { job: { live: boolean; reason: string | null; title: string; employerName: string }; similar?: Parameters<typeof fromSmall>[0][] }) : null;
    if (!own || own.job.live) notFound();
    return <ClosedJob reason={own.job.reason} title={own.job.title} employerName={own.job.employerName} similar={(own.similar ?? []).map(fromSmall)} signedIn />;
  }

  const job = r.data as JobPage;
  const path = jobPath(job);
  if (!same(`/jobs/${seg}`, path)) permanentRedirect(path);
  await countView(job.id); // one view of one live job per page render (S12)

  const [similar, mine] = await Promise.all([readSimilar({ id }), readMyJob(id)]);
  // readMyJob: 401 is a visitor; 404 JOB_NOT_FOUND is a signed-in candidate who has not saved or tracked this job.
  const signedIn = mine.ok || (!mine.ok && mine.status === 404);
  const own = mine.ok ? (mine.data as { job: { saved: boolean; stage: string | null } }).job : null;
  const cs = job.permitType === "critical_skills";
  const [profile, prompts] = signedIn ? await Promise.all([cs ? readProfile() : null, readDidYouApply()]) : [null, null];
  const degree = (profile?.ok ? (profile.data as { profile: { degreeBox?: DegreeChoice } | null }).profile?.degreeBox : undefined) ?? "relevant";
  const asked = prompts?.ok ? (prompts.data as { prompts: { clickId: string; jobId: string; title: string; employerName: string; county: string | null }[] }).prompts.find((p) => p.jobId === job.id) : undefined;
  const similarCards: CardJob[] = similar.ok ? (similar.data as { jobs: Parameters<typeof fromSmall>[0][] }).jobs.map(fromSmall) : [];

  return (
    <JobView
      job={job}
      now={now}
      path={path}
      signedIn={signedIn}
      saved={own?.saved ?? false}
      stage={own?.stage ?? null}
      degree={degree}
      prompt={asked ? { clickId: asked.clickId, title: asked.title, employerName: asked.employerName, county: asked.county } : null}
      similar={similarCards}
    />
  );
}
