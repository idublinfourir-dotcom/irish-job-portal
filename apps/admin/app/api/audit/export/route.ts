// The audit log as a CSV file (B59): the same filters as /api/audit (no cursor), newest first, at most 2,000 rows (the header x-audit-export-truncated says when there were more).
// An administrator exports every row, any other staff member their own. A sign-in in the last 10 minutes is needed (C4) and the export is itself logged (audit.export).
import { exportAudit, getPool } from "@portal/db";
import { readQuery, refuse } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

const PARAMS = ["staff", "action", "objectType", "objectId", "kind", "case", "from", "to"] as const;

export async function GET(request: Request) {
  let res: Response;
  try {
    const staff = await requireStaff(request.headers, true);
    const q = readQuery(request.url, PARAMS);
    const out = await exportAudit(getPool(), staff, { staff: q.staff, action: q.action, objectType: q.objectType, objectId: q.objectId, kind: q.kind, case: q.case, from: q.from, to: q.to });
    res = new Response(out.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"` } });
    if (out.truncated) res.headers.set("x-audit-export-truncated", "1");
  } catch (e) {
    res = refuse(e, "audit export");
  }
  res.headers.set("cache-control", "no-store");
  return res;
}
