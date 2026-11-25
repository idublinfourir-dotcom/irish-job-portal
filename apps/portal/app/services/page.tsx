// /services (frame E17): the company's permit services cases, newest first, 20 a page (Previous and Next). Signed out goes to sign-in and back. Only an account owner or a recruiter
// reads it; a poster and a viewer see the plain refusal and no read is made. Reads only through lib/data.ts.
import type { Metadata } from "next";
import { readCases, readPermitNotice } from "../../lib/data";
import { member } from "../_jobs/guard";
import { meta } from "../_site/meta";
import { say } from "./messages";
import { SERVICE_ROLES, type CaseRow } from "./model";
import { CasesView, noticeOf, RoleRefused } from "./views";

export const metadata: Metadata = meta("Permit services", "The permit services cases our team is handling for your company: documents we need from you, what has been submitted to DETE, and the decision when it is made.");

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/; // the route's own token alphabet; anything else is not passed on

export default async function Page({ searchParams }: { searchParams: Promise<{ after?: string | string[] }> }) {
  const { after } = await searchParams;
  const m = await member("/services");
  if (!SERVICE_ROLES.includes(m.role)) return <RoleRefused />;
  const token = typeof after === "string" && CURSOR.test(after) ? after : undefined;
  const [cases, notice] = await Promise.all([readCases(token ? { after: token } : undefined).catch(() => null), readPermitNotice().catch(() => null)]);
  const ok = cases?.status === 200;
  return (
    <CasesView
      cases={ok ? (cases.body.cases as CaseRow[]) : []}
      prevHref={token ? "/services" : undefined}
      nextHref={ok && typeof cases.body.next === "string" ? `/services?after=${encodeURIComponent(cases.body.next)}` : null}
      notice={notice?.status === 200 ? noticeOf(notice.body) : null}
      error={ok ? undefined : say({ status: cases?.status ?? 500, code: cases?.body.code as string | undefined })}
    />
  );
}
