// "Jobs posted for you by agencies" (P11, 20b "Client is also an employer", #89): a client company's read-only list of the agency jobs that name it,
// and "I don't recognise this", which files a report and hides the job at once (private.client_not_recognised, migration 0059). The company always
// comes from the session. The link is the job's matched client name (job.permit_employer_name_id) to that name's company; nothing else.
import { decodeReviewCursor, getPool, QueueRefused, RATE, validId } from "@portal/db";
import { isObject, no, ok, only, portalLogin, readPost, withinLimit } from "./company";

export const AGENCY_PAGE = 20;
// Newest first on job_client_name_idx: at most a page per name of the company (a company has a few names), then the newest page of those.
// The agency is any other company.
export const AGENCY_JOBS =
  "select j.id, j.title, j.status, j.posted_text, o.id::text as agency_id, o.display_name as agency_name from organisation_name n cross join lateral (" +
  "select j.id, j.title, j.status, j.posted_at, j.posted_at::text as posted_text, j.organisation_id from job j where j.permit_employer_name_id = n.id " +
  "and j.source = 'agency' and j.permit_employer_kind = 'client' and j.status in ('live','under_review') and j.organisation_id <> $1 " +
  `and ($2::timestamptz is null or (j.posted_at, j.id) < ($2::timestamptz, $3::bigint)) order by j.posted_at desc, j.id desc limit ${AGENCY_PAGE + 1}) j ` +
  `join organisation o on o.id = j.organisation_id where n.organisation_id = $1 order by j.posted_at desc, j.id desc limit ${AGENCY_PAGE + 1}`;

type Row = { id: string; title: string; status: string; posted_text: string; agency_id: string; agency_name: string };
const encode = (r: Row) => Buffer.from(JSON.stringify({ t: r.posted_text, i: r.id })).toString("base64url");

/** The query of the list: no parameter, or `after` (a token from the last page). Null for anything else. Pure. */
export function checkAgencyQuery(params: URLSearchParams): { after: [string, string] | null } | null {
  const keys = [...params.keys()];
  if (keys.length === 0) return { after: null };
  if (keys.length !== 1 || keys[0] !== "after") return null;
  try { return { after: decodeReviewCursor(params.get("after")) }; } catch (e) {
    if (e instanceof QueueRefused) return null;
    throw e;
  }
}

/** GET /api/portal/agency-jobs: any active member of the client company, viewers too. No company is 404 NO_COMPANY, as the job list. */
export async function agencyJobs(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  const q = checkAgencyQuery(new URL(request.url).searchParams);
  if (!q) return no(400, "BAD_REQUEST");
  if (!login.membership) return no(404, "NO_COMPANY");
  const all = (await getPool().query<Row>(AGENCY_JOBS, [login.membership.organisationId, ...(q.after ?? [null, null])])).rows;
  const rows = all.slice(0, AGENCY_PAGE);
  return ok({
    jobs: rows.map((r) => ({ id: r.id, title: r.title, agencyId: r.agency_id, agencyName: r.agency_name, status: r.status, postedAt: r.posted_text })),
    next: all.length > AGENCY_PAGE ? encode(rows.at(-1)!) : null,
  });
}

export function checkNotRecognised(b: unknown): { jobId: string } | null {
  return isObject(b) && only(b, ["jobId"]) && validId(b.jobId) ? { jobId: b.jobId } : null;
}

/** POST /api/portal/agency-jobs/not-recognised { jobId }: an account owner of the client company. A second press answers the same and writes nothing. */
export async function notRecognised(request: Request): Promise<Response> {
  const read = await readPost(request, checkNotRecognised);
  if (read instanceof Response) return read;
  const { login, body } = read;
  if (!login.membership) return no(403, "NOT_A_MEMBER");
  if (login.membership.role !== "account_owner") return no(403, "NOT_OWNER");
  if (!(await withinLimit(`report:${login.userId}`, RATE))) return no(429, "TOO_MANY_REQUESTS"); // the report limit, shared with the report route
  try {
    const r = (await getPool().query("select private.client_not_recognised($1, $2) r", [login.userId, body.jobId])).rows[0].r as { hidden: boolean };
    return ok({ ok: true, hidden: r.hidden });
  } catch (e) {
    const { code, message = "" } = (e ?? {}) as { code?: string; message?: string };
    if (code !== "P0001") throw e;
    if (message.includes("ORGANISATION_NOT_AVAILABLE")) return no(409, "ORGANISATION_NOT_AVAILABLE"); // SEC-1: only a verified company
    if (message.includes("JOB_NOT_FOUND")) return no(404, "JOB_NOT_FOUND");
    if (message.includes("NOT_OWNER")) return no(403, "NOT_OWNER");
    if (message.includes("NOT_A_MEMBER")) return no(403, "NOT_A_MEMBER");
    return no(403, "REFUSED");
  }
}
