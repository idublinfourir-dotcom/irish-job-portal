// The audit log viewer (#234 D2): GET only. An administrator reads every row and may filter by staff member, action, object type, object id and a date range;
// any other staff member reads only the rows where they are the actor. Newest first, 50 a page (?after= is the `next` of the page before).
// Nothing here writes: the log has no edit or delete (app_admin holds select and insert on it, 0003).
import { getPool, listAudit } from "@portal/db";
import { readQuery, refuse } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const PARAMS = ["staff", "action", "objectType", "objectId", "from", "to", "after"] as const;

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, PARAMS);
    return Response.json(await listAudit(getPool(), staff, { staff: q.staff, action: q.action, objectType: q.objectType, objectId: q.objectId, from: q.from, to: q.to, after: q.after }));
  } catch (e) {
    return refuse(e, "audit");
  }
}
