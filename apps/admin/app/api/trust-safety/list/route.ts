// B69 (frame D08): one list of reports and cases for a tab (?tab=open|waiting|appeals|closed, default open), 20 a page, with the report counts per job and company and,
// on the first page, the count of each tab. Reads only. The trust_and_safety role check is inside the database call.
import { getPool, listTrust } from "@portal/db";
import { readQuery } from "../../../../lib/admin-api";
import { refusal } from "../../../../lib/refusal";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["tab", "after"]);
    return Response.json(await listTrust(getPool(), staff, { tab: q.tab, after: q.after }));
  } catch (e) {
    return refusal(e, "list");
  }
}
