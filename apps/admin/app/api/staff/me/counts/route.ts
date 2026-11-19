// The signed-in staff member's notices (step 15 Q11): open items per queue their roles may work, reports, appeals, contact messages and requests
// waiting for a second person. Any active staff login; a count its roles do not cover is null.
import { getPool } from "@portal/db";
import { myCounts } from "@portal/db/staff-tools";
import { readQuery, refuse } from "../../../../../lib/admin-api";
import { requireStaff } from "../../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await myCounts(getPool(), staff));
  } catch (e) {
    return refuse(e, "staff counts");
  }
}
