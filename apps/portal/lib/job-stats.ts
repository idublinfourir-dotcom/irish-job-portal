// Job stats (#56, #227 D6): GET ?days=1..90 (default 30) and optional &jobId= reads the views and apply clicks, by day, of the signed-in member's own company's
// jobs. The company always comes from the session. Every active member may read (a viewer too, 20b section 4.2).
import { getPool, jobStats, MAX_DAYS, validId } from "@portal/db";
import { no, ok, portalLogin } from "./company";

const DAYS = /^\d{1,3}$/;

export async function statsGet(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  const params = new URL(request.url).searchParams;
  const d = params.get("days"), job = params.get("jobId");
  const days = d === null ? 30 : DAYS.test(d) ? Number(d) : 0;
  if (days < 1 || days > MAX_DAYS || (job !== null && !validId(job)) || [...params.keys()].some((k, i, all) => (k !== "days" && k !== "jobId") || all.indexOf(k) !== i)) return no(400, "BAD_REQUEST");
  if (!login.membership) return ok({ days, stats: [] });
  return ok({ days, stats: await jobStats(getPool(), login.membership.organisationId, { days, jobId: job ?? undefined }) });
}
