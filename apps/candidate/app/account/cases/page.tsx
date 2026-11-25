// /account/cases (BA29): the candidate's permit cases, newest first. Signed out goes to log in and comes back here. Until the account layout is combined
// (P17a) the page guards itself. Reads only through lib/data.ts.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { readCases, readPermitNotice } from "../../../lib/data";
import { casesPath, loginPath } from "../../../lib/paths";
import { pageDescription, pageTitle } from "../../../lib/seo";
import { safe } from "../../_home/safe";
import { noticeOf } from "../../permit-services/landing";
import { caseSay } from "./messages";
import type { CaseRow } from "./model";
import { CasesView } from "./views";

export const generateMetadata = (): Metadata => ({
  title: pageTitle("Permit cases"),
  description: pageDescription("Your permit requests with our team in Ireland, and where each one stands: documents we need, what has been submitted and the decision when it is made."),
  robots: { index: false, follow: false },
});

export default async function Page({ searchParams }: { searchParams: Promise<{ after?: string | string[] }> }) {
  await connection();
  const { after } = await searchParams;
  const [cases, notice] = await Promise.all([safe(readCases(typeof after === "string" ? { after: after.slice(0, 200) } : undefined), "cases"), safe(readPermitNotice(), "permit notice")]);
  if (!cases.ok && cases.status === 401) redirect(loginPath(casesPath()));
  const data = cases.ok ? (cases.data as { cases: CaseRow[]; next: string | null }) : null;
  return (
    <CasesView
      cases={data?.cases ?? []}
      olderHref={data?.next ? `${casesPath()}?after=${encodeURIComponent(data.next)}` : null}
      notice={notice.ok ? noticeOf(notice.data) : null}
      error={cases.ok ? undefined : caseSay("read", { ok: false, status: cases.status, code: cases.code })}
    />
  );
}
