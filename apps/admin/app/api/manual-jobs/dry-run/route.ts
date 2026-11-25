// B72: what posting this job would do, nothing written: POST with the create body (without `action`) answers live or draft, the badge and every check. Account
// reviewers only (the role check is inside the database call), with the same refusals as the post.
import { staffSettings } from "@portal/auth";
import { dryRunManualPost, getPool } from "@portal/db";
import { checkOrigin } from "../../../../lib/account-review";
import { checkLength, MAX_BODY, parseObject, refuse } from "../../../../lib/companies";
import { readQuery } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"));
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await dryRunManualPost(getPool(), staff, parseObject(await request.text(), MAX_BODY)), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return refuse(e, "manual-jobs/dry-run");
  }
}
