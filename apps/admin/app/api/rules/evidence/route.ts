// B66: the evidence files of the pay-deal entries. POST multipart (field `file`, PDF, JPEG or PNG up to 4 MB): a rules data editor uploads one, and its id then goes
// on an entry through a `propose` on /api/rules. GET ?file=<id> answers the file itself once the malware scan passed (409 scan_pending or file_blocked before; one
// data_access audit row). The role checks are inside each database call.
import { staffSettings } from "@portal/auth";
import { FilesUnavailable, getPool, MAX_UPLOAD_BODY } from "@portal/db";
import { openRulesEvidence, uploadRulesEvidence } from "@portal/db/staff-uploads";
import { checkOrigin } from "../../../../lib/account-review";
import { readQuery } from "../../../../lib/admin-api";
import { refuse } from "../../../../lib/rules";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

const failed = (e: unknown) => (e instanceof FilesUnavailable ? Response.json({ error: "files_unavailable" }, { status: 503 }) : refuse(e));

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    return (await openRulesEvidence(getPool(), staff, readQuery(request.url, ["file"]).file)) ?? Response.json({ error: "not_found" }, { status: 404 });
  } catch (e) {
    return failed(e);
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BODY) return Response.json({ error: "file_too_large" }, { status: 413 });
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json({ ok: true, ...(await uploadRulesEvidence(getPool(), staff, request)) });
  } catch (e) {
    return failed(e);
  }
}
