// Trust and safety cases (#44, #104, #134 to #137, #213, #214 d): GET lists the cases that need a step or shows one (?id=); POST opens a case,
// notifies the employer, enters a reply or appeal received by email or post, decides, confirms or refuses as the second person, decides an appeal,
// proposes a ban lift, or ticks off the WRC report. Every call needs a signed-in staff member; the trust_and_safety role check is in each database call.
import { staffSettings } from "@portal/auth";
import {
  confirmDecision, decideAppeal, decideCase, getCase, getPool, listCases, markWrcReported, notifyEmployer, openCase, proposeBanLift, recordAppeal,
  recordReply, refuseDecision,
} from "@portal/db";
import { checkOrigin } from "../../../../lib/account-review";
import { refusal } from "../../../../lib/refusal";
import { requireStaff } from "../../../../lib/staff";
import { CASE_ACTIONS, checkLength, parseBody } from "../../../../lib/trust-safety";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    if (id !== null) {
      const found = await getCase(getPool(), staff, id);
      return found ? Response.json({ item: found }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(await listCases(getPool(), staff, { after: params.get("after") ?? undefined }));
  } catch (e) {
    return refusal(e, "cases");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"));
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), CASE_ACTIONS);
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
    }
    return Response.json({ ok: true });
  } catch (e) {
    return refusal(e, "cases");
  }
}
