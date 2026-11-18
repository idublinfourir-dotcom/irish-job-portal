// D6 (#49): the DETE names whose permit count went up in the newest monthly import, biggest rise first, at most 200, with the linked company.
// Any active staff member may read it: DETE publishes these counts. GET only, no query keys.
import { getPool, latestPermitRises } from "@portal/db";
import { readQuery, refuse } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json({ rises: await latestPermitRises(getPool()) });
  } catch (e) {
    return refuse(e, "permit-rises");
  }
}
