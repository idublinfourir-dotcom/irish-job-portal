// B70 (frame D09): every ban (type, value, company, reason, case, date, who), newest first, 20 ban rows a page. Reads only: no ban is added here (a ban comes
// from a decided case, #44) and a lift is two officers (#104).
import { getPool, listBans } from "@portal/db";
import { readQuery } from "../../../../lib/admin-api";
import { refusal } from "../../../../lib/refusal";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    return Response.json(await listBans(getPool(), staff, { after: readQuery(request.url, ["after"]).after }));
  } catch (e) {
    return refusal(e, "bans");
  }
}
