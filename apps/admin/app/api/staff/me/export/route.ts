// The signed-in staff member's own data as one downloadable file (R1): any active staff login, whatever its roles. One audit row. Staff do not delete
// their own login: an administrator disables it (POST /api/staff, action disable).
import { exportFilename, getPool, staffExport } from "@portal/db";
import { readQuery, refuse } from "../../../../../lib/admin-api";
import { requireStaff } from "../../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let res: Response;
  try {
    const staff = await requireStaff(request.headers, true); // C4: an export needs a sign-in in the last 10 minutes
    readQuery(request.url, []);
    res = Response.json(await staffExport(getPool(), staff));
    res.headers.set("content-disposition", `attachment; filename="${exportFilename(new Date())}"`);
  } catch (e) {
    res = refuse(e, "staff export");
  }
  res.headers.set("cache-control", "no-store");
  return res;
}
