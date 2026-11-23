// The signed-in staff member's own identity (B57): id, name and roles, for the name chip and the links its roles may open. Any active staff login, whatever its roles.
import { getPool, staffMe } from "@portal/db";
import { readQuery, refuse } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await staffMe(getPool(), staff));
  } catch (e) {
    return refuse(e, "staff me");
  }
}
