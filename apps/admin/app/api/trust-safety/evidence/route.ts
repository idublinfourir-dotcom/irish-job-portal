// Evidence files on a report or a strike case (Q7, #91, #99), trust_and_safety only: GET ?reportId= or ?caseId= answers the one evidence file itself once
// the malware scan passed (409 scan_pending or file_blocked before; one data_access audit row); POST multipart with the same query (field `file`, PDF, JPEG or PNG up to 4 MB) attaches it, once,
// while the report is open or the case's appeal is not decided. The file follows the report's or case's retention. The role check is in each database call.
import { staffSettings } from "@portal/auth";
import { FilesUnavailable, getPool, MAX_UPLOAD_BODY } from "@portal/db";
import { attachEvidence, openEvidence, type EvidenceOn } from "@portal/db/staff-uploads";
import { BadRequest, checkOrigin } from "../../../../lib/account-review";
import { readQuery } from "../../../../lib/admin-api";
import { refusal } from "../../../../lib/refusal";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

/** Exactly one of reportId and caseId. */
function target(url: string): [EvidenceOn, string] {
  const q = readQuery(url, ["reportId", "caseId"]);
  if ((q.reportId === undefined) === (q.caseId === undefined)) throw new BadRequest("bad_query");
  return q.reportId !== undefined ? ["report", q.reportId] : ["strike", q.caseId!];
}
const failed = (e: unknown) => (e instanceof FilesUnavailable ? Response.json({ error: "files_unavailable" }, { status: 503 }) : refusal(e, "evidence"));

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const [on, id] = target(request.url);
    return (await openEvidence(getPool(), staff, on, id)) ?? Response.json({ error: "not_found" }, { status: 404 });
  } catch (e) {
    return failed(e);
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BODY) return Response.json({ error: "file_too_large" }, { status: 413 });
    const staff = await requireStaff(request.headers);
    const [on, id] = target(request.url);
    return Response.json({ ok: true, ...(await attachEvidence(getPool(), staff, on, id, request)) });
  } catch (e) {
    return failed(e);
  }
}
