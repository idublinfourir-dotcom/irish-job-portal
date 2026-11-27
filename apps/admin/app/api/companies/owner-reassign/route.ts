// An owner who cannot be reached (#234 D6, 20b "Account owner leaves"): GET lists the open requests; POST records one (after the reviewer ticked that the company
// domain and the CRO number were checked), completes it after its 7 days, or cancels it. Account reviewers only; the role check is inside each database call.
import { StaffRefused, staffSettings } from "@portal/auth";
import { cancelOwnerReassign, completeOwnerReassign, getPool, listOwnerReassigns, requestOwnerReassign } from "@portal/db";
import { checkOrigin } from "../../../../lib/account-review";
import { checkLength, MAX_SMALL_BODY, parseOwner, refuse } from "../../../../lib/companies";
import { readQuery } from "../../../../lib/admin-api";
import { requireStaff, staffSession } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    return Response.json(await listOwnerReassigns(getPool(), staff, { after: readQuery(request.url, ["after"]).after }));
  } catch (e) {
    return refuse(e, "companies/owner-reassign");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_SMALL_BODY);
    const { id: staff, fresh } = await staffSession(request.headers);
    const b = parseOwner(await request.text());
    if (!fresh && b.action !== "cancel") throw new StaffRefused("reauth_required"); // SEC-12, C4: the change hands a company to another login
    const db = getPool();
    if (b.action === "request") return Response.json({ ok: true, ...(await requestOwnerReassign(db, staff, b.membershipId, b)) });
    if (b.action === "complete") return Response.json({ ok: true, ...(await completeOwnerReassign(db, staff, b.requestId)) });
    return Response.json({ ok: true, ...(await cancelOwnerReassign(db, staff, b.requestId)) });
  } catch (e) {
    return refuse(e, "companies/owner-reassign");
  }
}
