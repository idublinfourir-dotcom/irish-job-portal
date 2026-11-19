// "Sponsor confirmed" on a manual post (Q6, #16): GET lists the confirmations waiting for an administrator, or (?requestId=) answers 302 to a 60-second
// link to one confirmation file (one data_access audit row). POST multipart (?jobId=, field `file`, PDF, JPEG or PNG up to 4 MB): the account reviewer
// uploads the employer's written confirmation. POST JSON {action: "confirm" | "refuse", requestId}: a different administrator confirms (the post then shows
// Sponsor confirmed) or refuses; the proposer may withdraw with "refuse". The role checks are inside each database call.
import { staffSettings } from "@portal/auth";
import { FilesUnavailable, getPool, MAX_UPLOAD_BODY } from "@portal/db";
import {
  confirmSponsorConfirmation, listSponsorConfirmations, openSponsorConfirmation, proposeSponsorConfirmation, refuseSponsorConfirmation,
} from "@portal/db/staff-uploads";
import { checkOrigin } from "../../../../lib/account-review";
import { id19, parseBody, readQuery, type Field, type Spec } from "../../../../lib/admin-api";
import { checkLength, MAX_SMALL_BODY, refuse } from "../../../../lib/companies";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

const ACTIONS: Record<string, Spec> = { confirm: { need: ["requestId"] }, refuse: { need: ["requestId"] } };
const FIELDS: Record<string, Field> = { requestId: [id19, "bad_request_id"] };
const failed = (e: unknown) => (e instanceof FilesUnavailable ? Response.json({ error: "files_unavailable" }, { status: 503 }) : refuse(e, "manual-jobs/sponsor-confirmation"));

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["requestId"]);
    if (q.requestId === undefined) return Response.json(await listSponsorConfirmations(getPool(), staff));
    const url = await openSponsorConfirmation(getPool(), staff, q.requestId);
    if (!url) return Response.json({ error: "not_found" }, { status: 404 });
    return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  } catch (e) {
    return failed(e);
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    const upload = /^multipart\/form-data;/i.test(request.headers.get("content-type") ?? "");
    if (upload && Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BODY) return Response.json({ error: "file_too_large" }, { status: 413 });
    if (!upload) checkLength(request.headers.get("content-length"), MAX_SMALL_BODY);
    const staff = await requireStaff(request.headers);
    const db = getPool();
    if (upload) {
      const q = readQuery(request.url, ["jobId"]);
      return Response.json({ ok: true, ...(await proposeSponsorConfirmation(db, staff, q.jobId, request)) });
    }
    const b = parseBody(await request.text(), MAX_SMALL_BODY, ACTIONS, FIELDS);
    if (b.action === "confirm") return Response.json({ ok: true, ...(await confirmSponsorConfirmation(db, staff, b.requestId)) });
    await refuseSponsorConfirmation(db, staff, b.requestId);
    return Response.json({ ok: true });
  } catch (e) {
    return failed(e);
  }
}
