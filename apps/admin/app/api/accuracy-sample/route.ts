// The monthly accuracy sample (step 15 Q8, #74): this month's 100 random live jobs, made on the first read and the same on every reload, with what a
// hand checker needs. Fetched-job reviewers, rules data editors, trust and safety and administrators; the role check is inside the database call.
import { getPool } from "@portal/db";
import { accuracySample } from "@portal/db/staff-tools";
import { readQuery, refuse } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await accuracySample(getPool(), staff));
  } catch (e) {
    return refuse(e, "accuracy sample");
  }
}
