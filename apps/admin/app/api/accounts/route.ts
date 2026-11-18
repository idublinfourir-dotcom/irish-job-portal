// Candidate and portal logins (step 15 C3), administrators only: POST suspends a candidate login or blocks a portal login (its open sessions end in the same
// transaction), or lifts either, with a reason code kept in the audit row. The administrator check is inside the database call. Appeal: the contact form.
import { staffSettings } from "@portal/auth";
import { getPool, setLoginHold, type HoldPool } from "@portal/db";
import { checkLength, checkOrigin, parseBody, reasonCode, refuse, staffIdOk, type Field, type Spec } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 300;
const spec: Spec = { need: ["userId", "reason"] };
const ACTIONS: Record<string, Spec> = { suspend_candidate: spec, lift_candidate: spec, block_portal: spec, lift_portal: spec };
const FIELDS: Record<string, Field> = { userId: [staffIdOk, "bad_user_id"], reason: [reasonCode, "bad_reason"] };

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    const pool: HoldPool = b.action.endsWith("_candidate") ? "candidate" : "portal";
    return Response.json({ ok: true, ...(await setLoginHold(getPool(), staff, pool, b.userId as string, !b.action.startsWith("lift_"), b.reason as string)) });
  } catch (e) {
    return refuse(e, "accounts");
  }
}
