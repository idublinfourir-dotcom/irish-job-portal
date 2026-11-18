// The overdue view (step 15 Q12): GET lists the open and claimed items of every queue older than one working day (Monday to Friday, Irish time).
// Administrators only; the role check is inside the database call.
import { getPool } from "@portal/db";
import { listOverdue } from "@portal/db/staff-tools";
import { readQuery, refuse } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await listOverdue(getPool(), staff));
  } catch (e) {
    return refuse(e, "overdue");
  }
}
