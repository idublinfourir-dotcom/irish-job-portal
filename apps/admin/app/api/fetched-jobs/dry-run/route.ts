// What Approve would do for one fetched-job item, nothing written (B63): the rules re-run with the occupation code, pay and contract the reviewer is about to give,
// broken down by check, with the badge the job would get. Fetched-job reviewers only (the role check is inside the database call). Query: id and occupationCode
// are required; salaryLow, salaryHigh (whole euros) and contractConfirmed (true or false) are optional.
import { dryRunApprove, getPool, QueueRefused, validId } from "@portal/db";
import { BadRequest, readQuery, refuse } from "../../../../lib/admin-api";
import { queueRules } from "../../../../lib/queue-rules";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

const euros = (v: string | undefined) => {
  if (v === undefined) return undefined;
  if (!/^[0-9]{1,7}$/.test(v)) throw new QueueRefused("bad_salary");
  return Number(v); // the database function checks the 1 to 1,000,000 range and that the top is not below the bottom
};

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["id", "occupationCode", "salaryLow", "salaryHigh", "contractConfirmed"]);
    if (!validId(q.id)) throw new BadRequest("bad_item_id");
    if (q.occupationCode === undefined || !/^[0-9]{4}$/.test(q.occupationCode)) throw new QueueRefused("bad_occupation_code");
    if (q.contractConfirmed !== undefined && q.contractConfirmed !== "true" && q.contractConfirmed !== "false") throw new QueueRefused("bad_input");
    const input = {
      occupationCode: q.occupationCode, salaryLow: euros(q.salaryLow), salaryHigh: euros(q.salaryHigh),
      contractConfirmed: q.contractConfirmed === undefined ? undefined : q.contractConfirmed === "true",
    };
    const db = getPool();
    return Response.json(await dryRunApprove(db, staff, q.id, input, await queueRules(db)), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return refuse(e, "fetched-jobs/dry-run");
  }
}
