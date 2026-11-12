// The rules versions (#229, #230, #234 D9): GET lists the versions in force, the confirmed ones still to come and the pending proposals (any active
// staff member). POST proposes a new version of a kind or the big-company flag on one company (a rules data editor), confirms or refuses one (an
// administrator who did not propose) or withdraws one's own proposal. Every call needs a signed-in staff member; the role check is inside each database call.
import { staffSettings } from "@portal/auth";
import { confirmRules, getPool, listRules, proposeBigFlag, proposeRules, refuseRules, withdrawRules } from "@portal/db";
import { checkOrigin } from "../../../lib/account-review";
import { checkLength, parseBody, refuse } from "../../../lib/rules";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    return Response.json(await listRules(getPool(), staff));
  } catch (e) {
    return refuse(e);
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"));
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text());
    const db = getPool();
    if (b.action === "propose") return Response.json({ ok: true, ...(await proposeRules(db, staff, b)) });
    if (b.action === "propose_flag") return Response.json({ ok: true, ...(await proposeBigFlag(db, staff, b.organisationId)) });
    if (b.action === "confirm") return Response.json({ ok: true, ...(await confirmRules(db, staff, b.requestId)) });
    await (b.action === "refuse" ? refuseRules : withdrawRules)(db, staff, b.requestId);
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e);
  }
}
