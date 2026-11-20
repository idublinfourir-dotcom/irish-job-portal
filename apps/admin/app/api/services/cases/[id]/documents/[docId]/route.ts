// M4: one stored copy of a services case, the file itself (inline, fixed type, nosniff, no-store) once the malware scan passed, with one
// data_access audit row (reason services_case, the case id). Only the services_case_handler assigned to the case (S-Q11 B: not an administrator).
import { FilesUnavailable, getPool } from "@portal/db";
import { openCaseDocument } from "@portal/db/staff-case-files";
import { readQuery, refuse } from "../../../../../../../lib/admin-api";
import { requireStaff } from "../../../../../../../lib/staff";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; docId: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    const p = await params;
    return await openCaseDocument(getPool(), staff, p.id, p.docId);
  } catch (e) {
    if (e instanceof FilesUnavailable) return Response.json({ error: "files_unavailable" }, { status: 503 });
    return refuse(e, "services/cases/documents/one");
  }
}
