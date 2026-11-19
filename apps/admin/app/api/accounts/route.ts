// Candidate and portal logins (step 15 C3), administrators only: POST suspends a candidate login or blocks a portal login (its open sessions end in the same
// transaction), or lifts either, with a reason code kept in the audit row. The administrator check is inside the database call. Appeal: the contact form.
// Step 15 C6: GET lists the candidate merges waiting; POST merge_propose {keep, drop}, merge_confirm and merge_refuse {requestId} (two administrators).
import { staffSettings } from "@portal/auth";
import { getPool, setLoginHold, type HoldPool } from "@portal/db";
import { confirmCandidateMerge, listCandidateMerges, proposeCandidateMerge, refuseCandidateMerge } from "@portal/db/staff-tools";
import { checkLength, checkOrigin, id19, parseBody, readQuery, reasonCode, refuse, staffIdOk, type Field, type Spec } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 300;
const spec: Spec = { need: ["userId", "reason"] };
const byId: Spec = { need: ["requestId"] };
const ACTIONS: Record<string, Spec> = {
  suspend_candidate: spec, lift_candidate: spec, block_portal: spec, lift_portal: spec, merge_propose: { need: ["keep", "drop"] }, merge_confirm: byId, merge_refuse: byId,
};
const FIELDS: Record<string, Field> = {
  userId: [staffIdOk, "bad_user_id"], reason: [reasonCode, "bad_reason"], keep: [staffIdOk, "bad_user_id"], drop: [staffIdOk, "bad_user_id"], requestId: [id19, "bad_request_id"],
};

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await listCandidateMerges(getPool(), staff));
  } catch (e) {
    return refuse(e, "accounts");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers, true); // C4: every action here blocks, lifts or merges a login
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    const db = getPool();
    if (b.action === "merge_propose") return Response.json({ ok: true, ...(await proposeCandidateMerge(db, staff, b.keep, b.drop)) });
    if (b.action === "merge_confirm") return Response.json({ ok: true, ...(await confirmCandidateMerge(db, staff, b.requestId)) });
    if (b.action === "merge_refuse") {
      await refuseCandidateMerge(db, staff, b.requestId);
      return Response.json({ ok: true });
    }
    const pool: HoldPool = b.action.endsWith("_candidate") ? "candidate" : "portal";
    return Response.json({ ok: true, ...(await setLoginHold(db, staff, pool, b.userId as string, !b.action.startsWith("lift_"), b.reason as string)) });
  } catch (e) {
    return refuse(e, "accounts");
  }
}
