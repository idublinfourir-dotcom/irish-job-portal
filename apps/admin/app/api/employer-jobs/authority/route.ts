// The client's written authority kept on an agency job (P8), for the staff who check agency jobs: account_reviewer (the agency_client_check queue)
// or an administrator. GET ?jobId= lists the copies (metadata only); GET ?jobId=&docId= answers the file itself (inline, fixed type, nosniff, no-store) once
// the malware scan passed (409 scan_pending or file_blocked before) and writes one data_access audit row. The role check is inside each database call.
import { FilesUnavailable, getPool, listJobAuthority, openJobAuthority } from "@portal/db";
import { readQuery, refuse } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["jobId", "docId"]);
    if (q.jobId === undefined) return Response.json({ error: "bad_query" }, { status: 400 });
    if (q.docId === undefined) {
      const documents = await listJobAuthority(getPool(), staff, q.jobId);
      return documents ? Response.json({ documents }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return (await openJobAuthority(getPool(), staff, q.jobId, q.docId)) ?? Response.json({ error: "not_found" }, { status: 404 });
  } catch (e) {
    if (e instanceof FilesUnavailable) return Response.json({ error: "files_unavailable" }, { status: 503 });
    return refuse(e, "employer-jobs/authority");
  }
}
