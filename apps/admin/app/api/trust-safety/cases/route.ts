// Trust and safety cases (#44, #104, #134 to #137, #213, #214 d): GET lists the cases that need a step or shows one (?id=); POST opens a case,
// notifies the employer, enters a reply or appeal received by email or post, decides, confirms or refuses as the second person, decides an appeal,
// proposes a ban lift, ticks off the WRC report, or adds a staff note (B69). Every call needs a signed-in staff member; the trust_and_safety role check is in each database call.
import { StaffRefused, staffSettings } from "@portal/auth";
import {
  addStrikeNote, confirmDecision, decideAppeal, decideCase, getCase, getPool, listCases, markWrcReported, notifyEmployer, openCase, proposeBanLift, recordAppeal,
  recordReply, refuseDecision,
} from "@portal/db";
import { checkOrigin } from "../../../../lib/account-review";
import { refusal } from "../../../../lib/refusal";
import { readQuery } from "../../../../lib/admin-api";
import { requireStaff, staffSession } from "../../../../lib/staff";
import { CASE_ACTIONS, checkLength, parseBody } from "../../../../lib/trust-safety";

export const dynamic = "force-dynamic";

// C4: the actions that set, confirm, overturn or lift a strike or ban need a sign-in in the last 10 minutes.
const SENSITIVE = new Set(["decide", "confirm", "decide_appeal", "propose_ban_lift"]);

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["id", "after"]);
    const id = q.id ?? null;
    if (id !== null) {
      const found = await getCase(getPool(), staff, id);
      return found ? Response.json({ item: found }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(await listCases(getPool(), staff, { after: q.after }));
  } catch (e) {
    return refusal(e, "cases");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"));
    const { id: staff, fresh } = await staffSession(request.headers);
    const b = parseBody(await request.text(), CASE_ACTIONS);
    if (!fresh && SENSITIVE.has(b.action as string)) throw new StaffRefused("reauth_required");
    const db = getPool();
    const id = b.caseId as string;
    const s = (k: string) => b[k] as string;
    switch (b.action) {
      case "open":
        return Response.json({ ok: true, ...(await openCase(db, staff, {
          organisationId: s("organisationId"), jobId: b.jobId as string | undefined, caseKind: s("caseKind"), reasonCode: s("reasonCode"), noticeSummary: b.noticeSummary as string | undefined,
        })) });
      case "notify": return Response.json({ ok: true, ...(await notifyEmployer(db, staff, id)) });
      case "record_reply": await recordReply(db, staff, id, s("text"), s("receivedAt")); break;
      case "decide": return Response.json({ ok: true, ...(await decideCase(db, staff, id, { outcome: s("outcome"), conclusive: b.conclusive as boolean | undefined })) });
      case "confirm": return Response.json({ ok: true, ...(await confirmDecision(db, staff, id)) });
      case "refuse": await refuseDecision(db, staff, id); break;
      case "record_appeal": await recordAppeal(db, staff, id, s("text"), s("receivedAt")); break;
      case "decide_appeal": return Response.json({ ok: true, ...(await decideAppeal(db, staff, id, s("result"))) });
      case "propose_ban_lift": return Response.json({ ok: true, ...(await proposeBanLift(db, staff, id)) });
      case "mark_wrc": await markWrcReported(db, staff, id); break;
      case "add_note": return Response.json({ ok: true, ...(await addStrikeNote(db, staff, id, s("text"))) });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return refusal(e, "cases");
  }
}
