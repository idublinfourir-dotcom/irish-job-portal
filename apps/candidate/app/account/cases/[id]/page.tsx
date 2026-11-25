// /account/cases/[id] (frame A08): one permit case. A bad id, another candidate's case and a missing case are all the same 404. Signed out goes to log in
// and comes back here. Reads only through lib/data.ts. No staff name, id or note is ever read (the routes do not send one).
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { readCase, readCaseDocuments, readCaseTimeline, readPermitNotice } from "../../../../lib/data";
import { casePath, loginPath } from "../../../../lib/paths";
import { pageDescription, pageTitle } from "../../../../lib/seo";
import { safe } from "../../../_home/safe";
import { noticeOf } from "../../../permit-services/landing";
import { UploadBox, WithdrawButton } from "../actions";
import { caseSay } from "../messages";
import { isOpen, type CaseDoc, type CaseEvent, type CaseRow } from "../model";
import { CaseProblem, CaseView } from "../views";

export const generateMetadata = (): Metadata => ({
  title: pageTitle("Permit case"),
  description: pageDescription("Follow one permit request: the documents we need from you, the steps from received to decision, what each update means and who pays for the application."),
  robots: { index: false, follow: false },
});

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!/^[0-9]{1,18}$/.test(id)) notFound();
  const [one, timeline, docs, notice] = await Promise.all([safe(readCase(id), "case"), safe(readCaseTimeline(id), "case timeline"), safe(readCaseDocuments(id), "case documents"), safe(readPermitNotice(), "permit notice")]);
  if (!one.ok && one.status === 401) redirect(loginPath(casePath(id)));
  if (!one.ok && one.status === 404) notFound();
  if (!one.ok) return <CaseProblem message={caseSay("read", { ok: false, status: one.status, code: one.code })} />;
  const c = (one.data as { case: CaseRow }).case;
  if (!timeline.ok) return <CaseProblem message={caseSay("read", { ok: false, status: timeline.status, code: timeline.code })} />;
  return (
    <CaseView
      c={c}
      events={(timeline.data as { events: CaseEvent[] }).events}
      docs={docs.ok ? (docs.data as { documents: CaseDoc[] }).documents : []}
      docsError={docs.ok ? undefined : caseSay("read", { ok: false, status: docs.status, code: docs.code })}
      notice={notice.ok ? noticeOf(notice.data) : null}
      upload={<UploadBox caseId={c.id} />}
      withdraw={isOpen(c) ? <WithdrawButton caseId={c.id} /> : null}
    />
  );
}
