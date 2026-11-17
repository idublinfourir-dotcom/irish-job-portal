// The held employer and agency job queues (step 15 Q1, #244): scam_flag for trust_and_safety, post_strike_job_review and agency_client_check for
// account_reviewer, all three for an administrator. GET lists one queue's open and claimed items (?queue=, ?after=) or shows one item with its advert
// text (?id=); POST claims, releases, approves (the job goes live when no other item holds it) or rejects (a reason code; the job closes as removed).
// The role check is inside each database call, reads included.
import { staffSettings } from "@portal/auth";
import { approveJobItem, claimJobItem, getJobQueueItem, getPool, listJobQueue, rejectJobItem, releaseJobItem } from "@portal/db";
import { checkLength, checkOrigin, id19, parseBody, readQuery, reasonCode, refuse, type Field, type Spec } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 300;
const ACTIONS: Record<string, Spec> = { claim: { need: ["itemId"] }, release: { need: ["itemId"] }, approve: { need: ["itemId"] }, reject: { need: ["itemId", "reason"] } };
const FIELDS: Record<string, Field> = { itemId: [id19, "bad_item_id"], reason: [reasonCode, "bad_reason"] };

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["id", "queue", "after"]);
    if (q.id !== undefined) {
      const found = await getJobQueueItem(getPool(), staff, q.id);
      return found ? Response.json({ item: found }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(await listJobQueue(getPool(), staff, q.queue, { after: q.after }));
  } catch (e) {
    return refuse(e, "employer-jobs");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    const db = getPool();
    const id = b.itemId as string;
    switch (b.action) {
      case "claim": await claimJobItem(db, staff, id); break;
      case "release": await releaseJobItem(db, staff, id); break;
      case "approve": return Response.json({ ok: true, ...(await approveJobItem(db, staff, id)) });
      case "reject": await rejectJobItem(db, staff, id, b.reason as string); break;
    }
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "employer-jobs");
  }
}
