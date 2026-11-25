// B66: the public pay-deal employers in force, on and off, each with its body type, evidence, who added it and when, and the count of its companies' legal names
// and live jobs. Any active staff member (the check is inside listPayDealEmployers). A change is a `propose` of the kind public_pay_employers on /api/rules.
import { getPool, listPayDealEmployers } from "@portal/db";
import { refuse } from "../../../../lib/rules";
import { readQuery } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await listPayDealEmployers(getPool(), staff));
  } catch (e) {
    return refuse(e);
  }
}
