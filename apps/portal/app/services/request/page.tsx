// /services/request (frame C20): the employer's permit request. Signed out goes to sign-in and back. Only an account owner or a recruiter may ask (a poster and a viewer see the plain
// refusal); the route refuses again (ROLE_REFUSED). The job list is the company's live jobs.
import type { Metadata } from "next";
import { Notice } from "@portal/ui";
import { readJobs, readOccupations, readPermitNotice } from "../../../lib/data";
import { bodyOf, member } from "../../_jobs/guard";
import type { Job } from "../../_jobs/words";
import { meta } from "../../_site/meta";
import { SERVICE_ROLES } from "../model";
import { noticeOf, RoleRefused } from "../views";
import { RequestFlow } from "./form";
import type { Occupation } from "./views";

export const metadata: Metadata = meta("New permit request", "Ask our team to prepare an employment permit for a hire. Tell us about the offer and get a free pay check. Our fee is paid by the employer or agency.");

export default async function Page() {
  const m = await member("/services/request");
  if (!SERVICE_ROLES.includes(m.role)) return <RoleRefused />;
  const [occupations, jobs, notice] = await Promise.all([readOccupations().catch(() => null), readJobs().catch(() => null), readPermitNotice().catch(() => null)]);
  if (occupations?.status !== 200) return <Notice kind="error" title="This form could not be loaded">Reload the page to try again.</Notice>; // the occupation list is the form's only required read
  return (
    <RequestFlow
      occupations={(occupations.body.occupations as Occupation[]).map(({ code, title }) => ({ code, title }))}
      jobs={(bodyOf<(Job & { occupationCode: string | null })[]>(jobs, "jobs") ?? []).filter((j) => j.status === "live").map(({ id, title, occupationCode }) => ({ id, title, occupationCode }))}
      notice={notice?.status === 200 ? noticeOf(notice.body) : null}
    />
  );
}
