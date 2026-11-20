// M4: the stored copies of one services case (metadata only), for the services_case_handler assigned to it; every other role, an unassigned
// handler and a handler whose email is the requester's are refused. The role and the assignment are checked inside the database call.
import { getPool } from "@portal/db";
import { listCaseDocuments } from "@portal/db/staff-case-files";
import { readQuery, refuse } from "../../../../../../lib/admin-api";
import { requireStaff } from "../../../../../../lib/staff";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await listCaseDocuments(getPool(), staff, (await params).id));
  } catch (e) {
    return refuse(e, "services/cases/documents");
  }
}
