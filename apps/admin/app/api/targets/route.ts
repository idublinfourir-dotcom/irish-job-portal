// The #74 target counts (step 15 Q8): weekly active candidates, "Yes, I applied" and "Mark applied" taps, hires, live jobs and reports per 1,000 live
// jobs. Aggregates only; any staff login holding a role (matrix 20c: stats are viewed by every role).
import { getPool } from "@portal/db";
import { targetCounts } from "@portal/db/staff-tools";
import { readQuery, refuse } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await targetCounts(getPool(), staff));
  } catch (e) {
    return refuse(e, "targets");
  }
}
