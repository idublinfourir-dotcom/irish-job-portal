// C5 (#253): how many visitors answered "no" to "Do you need a work permit?" at candidate sign-up, one number per UTC day, newest first, the last 366 days.
// Any active staff member may read it: the table holds a date and a count, nothing about any visitor. GET only, no query keys.
import { getPool, signupNoCounts } from "@portal/db";
import { readQuery, refuse } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json({ days: await signupNoCounts(getPool()) });
  } catch (e) {
    return refuse(e, "signup-no-counts");
  }
}
