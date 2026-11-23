// The signed-in staff member's notices (step 15 Q11): open items per queue their roles may work, reports, appeals, contact messages and requests
// waiting for a second person. Any active staff login; a count its roles do not cover is null. ?merges=1 adds the name-merge suggestion count (B57, slower).
import { getPool } from "@portal/db";
import { myCounts } from "@portal/db/staff-tools";
import { BadRequest, readQuery, refuse } from "../../../../../lib/admin-api";
import { requireStaff } from "../../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["merges"]);
    if (q.merges !== undefined && q.merges !== "1") throw new BadRequest("bad_query");
    return Response.json(await myCounts(getPool(), staff, { merges: q.merges === "1" }));
  } catch (e) {
    return refuse(e, "staff counts");
  }
}
