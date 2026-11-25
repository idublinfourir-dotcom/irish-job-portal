// Manual posting (#232): GET lists the manual posts (?mine=true only one's own; account reviewers edit; the trust and safety officer and the administrator view); POST creates a post for an
// existing employer or agency (listed only if it passes the employer post checks, otherwise a draft with the reason) or closes the staff member's own post.
// "Sponsor confirmed" comes later, through /api/manual-jobs/sponsor-confirmation (Q6). The role check is inside each database call.
import { staffSettings } from "@portal/auth";
import { closeManualPost, createManualPost, getPool, listManualPosts } from "@portal/db";
import { checkOrigin } from "../../../lib/account-review";
import { checkLength, parseManual, refuse } from "../../../lib/companies";
import { BadRequest, readQuery } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["after", "mine"]);
    if (q.mine !== undefined && q.mine !== "true") throw new BadRequest("bad_query");
    return Response.json(await listManualPosts(getPool(), staff, { after: q.after, mine: q.mine === "true" }));
  } catch (e) {
    return refuse(e, "manual-jobs");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"));
    const staff = await requireStaff(request.headers);
    const b = parseManual(await request.text());
    const db = getPool();
    if (b.action === "create") return Response.json({ ok: true, ...(await createManualPost(db, staff, b.post)) });
    return Response.json({ ok: true, ...(await closeManualPost(db, staff, b.jobId)) });
  } catch (e) {
    return refuse(e, "manual-jobs");
  }
}
