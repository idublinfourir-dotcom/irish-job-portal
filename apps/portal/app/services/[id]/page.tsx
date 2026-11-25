// /services/[id] (frame A08): one permit services case. A bad id, a case of another company, a missing case and a case this login may not read are all the same 404. Signed out goes to
// sign-in and back. Only the requester can read the copies (they are personal), so a 404 on that read means "not the requester": no copies, no upload, no withdraw. Reads only through lib/data.ts.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readCase, readCaseDocuments, readCaseTimeline, readPermitNotice } from "../../../lib/data";
import { member } from "../../_jobs/guard";
import { meta } from "../../_site/meta";
import { UploadBox, WithdrawButton } from "../actions";
import { say } from "../messages";
import { SERVICE_ROLES, type CaseDoc, type CaseEvent, type CaseRow } from "../model";
import { CaseProblem, CaseView, noticeOf, RoleRefused } from "../views";

export const metadata: Metadata = meta("Permit case", "Follow one permit services case: the documents we need from you, the steps from received to decision, what each update means and who pays for what.");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9]{1,18}$/.test(id)) notFound();
  const m = await member(`/services/${id}`);
  if (!SERVICE_ROLES.includes(m.role)) return <RoleRefused />;
  const [one, timeline, docs, notice] = await Promise.all([readCase(id).catch(() => null), readCaseTimeline(id).catch(() => null), readCaseDocuments(id).catch(() => null), readPermitNotice().catch(() => null)]);
  if (one?.status === 404) notFound();
  if (one?.status !== 200) return <CaseProblem message={say({ status: one?.status ?? 500, code: one?.body.code as string | undefined })} />;
  if (timeline?.status !== 200) return <CaseProblem message={say({ status: timeline?.status ?? 500, code: timeline?.body.code as string | undefined })} />;
  const c = one.body.case as CaseRow, requester = docs?.status !== 404, listed = docs?.status === 200;
  return (
    <CaseView
      c={c}
      events={timeline.body.events as CaseEvent[]}
      docs={listed ? (docs.body.documents as CaseDoc[]) : []}
      docsError={requester && !listed ? say({ status: docs?.status ?? 500, code: docs?.body.code as string | undefined }) : undefined}
      requester={requester}
      notice={notice?.status === 200 ? noticeOf(notice.body) : null}
      upload={<UploadBox caseId={c.id} />}
      withdraw={<WithdrawButton caseId={c.id} />}
    />
  );
}
