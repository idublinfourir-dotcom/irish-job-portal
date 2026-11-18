// The member limit of a company (P13; 0013's TEAM_FULL): POST { organisationId, memberLimit, reason } sets it from 1 to 50, never below the active members.
// Account reviewers and administrators only; the role check is inside the database call. One audit row with the old and new limit and the reason code.
import { staffSettings } from "@portal/auth";
import { getPool, setMemberLimit } from "@portal/db";
import { checkOrigin } from "../../../../lib/account-review";
import { checkLength, MAX_SMALL_BODY, parseLimit, refuse } from "../../../../lib/companies";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_SMALL_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseLimit(await request.text());
    return Response.json({ ok: true, ...(await setMemberLimit(getPool(), staff, b.organisationId, b.memberLimit, b.reason)) });
  } catch (e) {
    return refuse(e, "companies/member-limit");
  }
}
