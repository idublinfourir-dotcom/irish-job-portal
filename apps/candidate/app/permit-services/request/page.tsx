// /permit-services/request (frame C20, DD31): the candidate's permit request. Signed out goes to log in and comes back here (the job it is about is kept).
// `?job=<id>` is the job the request is about, from a job page: the page reads it like any visitor would, and only a live job is used.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { JobPage } from "@portal/db";
import { Notice } from "@portal/ui";
import { readJob, readOccupations, readPermitNotice, readSignedIn } from "../../../lib/data";
import { loginPath, permitRequestPath } from "../../../lib/paths";
import { pageDescription, pageTitle } from "../../../lib/seo";
import { employersHref } from "../../_home/meta";
import { safe } from "../../_home/safe";
import { noticeOf } from "../landing";
import { RequestFlow } from "./form";
import type { Occupation } from "./views";

const DESCRIPTION = "Ask our team for help with your employment permit. Tell us about the job offer and get a free check of the pay rule. Candidates never pay: the employer or agency does.";
export const generateMetadata = (): Metadata => ({ title: pageTitle("Start a permit request"), description: pageDescription(DESCRIPTION), robots: { index: false, follow: false } });

export default async function Page({ searchParams }: { searchParams: Promise<{ job?: string | string[] }> }) {
  await connection();
  const { job } = await searchParams;
  const jobId = typeof job === "string" && /^[0-9]{1,18}$/.test(job) ? job : null; // anything else is ignored: the request is then about no job
  if (!(await readSignedIn())) redirect(loginPath(permitRequestPath(jobId)));
  const [notice, occupations, read] = await Promise.all([safe(readPermitNotice(), "permit notice"), safe(readOccupations(), "occupations"), jobId ? safe(readJob({ id: jobId }), "job") : null]);
  if (!occupations.ok) return <div className="mx-auto max-w-page px-5 py-8 sm:px-8"><Notice kind="error" title="This form could not be loaded">Reload the page to try again.</Notice></div>; // the occupation list is the form's only required read
  const j = read?.ok ? (read.data as JobPage) : null;
  return (
    <RequestFlow
      occupations={(occupations.data as { occupations: Occupation[] }).occupations.map(({ code, title }) => ({ code, title }))}
      job={j ? { id: j.id, title: j.title, employerName: j.employerName, occupationCode: j.occupationCode, contractMonths: j.contractMonths } : null}
      employersHref={employersHref()}
      notice={notice.ok ? noticeOf(notice.data) : null}
    />
  );
}
