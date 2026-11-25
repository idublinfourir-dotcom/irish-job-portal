// B72: the employer picker of the manual post. GET ?q=: at most 10 companies a post can be made for, by any of their names or CRO number. Account reviewers only
// (the role check is inside searchManualCompanies). Company facts only: no login, member or email.
import { getPool, searchManualCompanies } from "@portal/db";
import { refuse } from "../../../../lib/companies";
import { readQuery } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    return Response.json(await searchManualCompanies(getPool(), staff, readQuery(request.url, ["q"]).q));
  } catch (e) {
    return refuse(e, "manual-jobs/companies");
  }
}
