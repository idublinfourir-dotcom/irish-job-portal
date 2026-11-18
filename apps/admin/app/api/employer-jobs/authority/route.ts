// The client's written authority kept on an agency job (P8), for the staff who check agency jobs: account_reviewer (the agency_client_check queue)
// or an administrator. GET ?jobId= lists the copies (metadata only); GET ?jobId=&docId= answers 302 to a 60-second download link and writes one
// data_access audit row. The role check is inside each database call.
import { fileLink, FilesUnavailable, getPool, listJobAuthority, openJobAuthority } from "@portal/db";
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
    const url = await openJobAuthority(getPool(), staff, q.jobId, q.docId, fileLink);
    if (!url) return Response.json({ error: "not_found" }, { status: 404 });
    return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch (e) {
    if (e instanceof FilesUnavailable) return Response.json({ error: "files_unavailable" }, { status: 503 });
    return refuse(e, "employer-jobs/authority");
  }
}
