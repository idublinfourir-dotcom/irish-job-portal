// Trust and safety reports queue (#91, #214 c). GET lists the open reports or shows one (?id=); POST hides the job, clears or upholds (which opens
// a case). Every call needs a signed-in staff member; the trust_and_safety role check is inside each database call.
import { staffSettings } from "@portal/auth";
import { clearReport, getPool, getReport, hideReportedJob, listReports, upholdReport } from "@portal/db";
import { checkOrigin } from "../../../../lib/account-review";
import { refusal } from "../../../../lib/refusal";
import { requireStaff } from "../../../../lib/staff";
import { checkLength, parseBody, REPORT_ACTIONS } from "../../../../lib/trust-safety";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    if (id !== null) {
      const found = await getReport(getPool(), staff, id);
      return found ? Response.json({ item: found }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(await listReports(getPool(), staff, { after: params.get("after") ?? undefined }));
  } catch (e) {
    return refusal(e, "reports");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"));
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), REPORT_ACTIONS);
    const db = getPool();
    const id = b.reportId as string;
    if (b.action === "hide") await hideReportedJob(db, staff, id);
    else if (b.action === "clear") await clearReport(db, staff, id);
    else {
      const input = { caseKind: b.caseKind as string, reasonCode: b.reasonCode as string, noticeSummary: b.noticeSummary as string | undefined };
      return Response.json({ ok: true, ...(await upholdReport(db, staff, id, input)) });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return refusal(e, "reports");
  }
}
