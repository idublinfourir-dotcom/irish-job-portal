// The fetched-queue decisions as labelled rows for the matcher test set (step 15 Q8, #120), 50 a page, oldest first; `after` is the page's `next`.
// Fetched-job reviewers, rules data editors and administrators; the role check is inside the database call.
import { getPool } from "@portal/db";
import { fetchedDecisions } from "@portal/db/staff-tools";
import { readQuery, refuse } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["after"]);
    return Response.json(await fetchedDecisions(getPool(), staff, q.after));
  } catch (e) {
    return refuse(e, "fetched decisions");
  }
}
