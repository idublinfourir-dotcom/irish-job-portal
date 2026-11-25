// B64: the versions of one rules kind that have started, newest first, each with its change, its dates and who proposed and confirmed it. GET ?kind=&after=.
// Any active staff member (the check is inside listRulesHistory).
import { getPool, listRulesHistory } from "@portal/db";
import { refuse } from "../../../../lib/rules";
import { readQuery } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    return Response.json(await listRulesHistory(getPool(), staff, readQuery(request.url, ["kind", "after"])));
  } catch (e) {
    return refuse(e);
  }
}
