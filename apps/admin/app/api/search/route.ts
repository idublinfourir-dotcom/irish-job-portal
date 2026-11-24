// B58: the staff search. GET /api/search?q=: organisations (name, CRO number), jobs and services cases for the kinds the member's roles may search, at most 10 of each.
// Any active staff login may ask; the roles are checked inside searchStaff, and a kind the roles may not search is left out of the answer.
import { getPool, searchStaff } from "@portal/db";
import { BadRequest, readQuery, refuse } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const { q } = readQuery(request.url, ["q"]);
    if (q === undefined) throw new BadRequest("bad_query");
    return Response.json(await searchStaff(getPool(), staff, q));
  } catch (e) {
    return refuse(e, "staff search");
  }
}
