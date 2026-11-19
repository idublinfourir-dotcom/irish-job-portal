// R5: the legal texts (sign-up terms for candidates and for employers, the privacy notice). GET lists every version and the pending proposals (a
// content editor or an administrator). POST proposes a new version (a content editor), confirms it (an administrator who did not propose; the text
// is published at once) or refuses it (an administrator; withdrawn when the proposer does it). Proposing and confirming publish legal text, so they
// need a sign-in in the last 10 minutes (C4, #270). The role checks are inside each database call.
import { StaffRefused, staffSettings } from "@portal/auth";
import { getPool } from "@portal/db";
import { confirmLegal, listLegal, proposeLegal, refuseLegal } from "@portal/db/legal-texts";
import { checkLength, checkOrigin, id19, parseBody, readQuery, refuse, type Field, type Spec } from "../../../lib/admin-api";
import { requireStaff, staffSession } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 400_000; // a 100,000-character text, its JSON escapes and the other fields
const ACTIONS: Record<string, Spec> = { propose: { need: ["purpose", "version", "body"] }, confirm: { need: ["requestId"] }, refuse: { need: ["requestId"] } };
const str = (v: unknown) => typeof v === "string";
const FIELDS: Record<string, Field> = { purpose: [str, "bad_purpose"], version: [str, "bad_version"], body: [str, "bad_body_text"], requestId: [id19, "bad_request_id"] };

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await listLegal(getPool(), staff));
  } catch (e) {
    return refuse(e, "legal-texts");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const { id: staff, fresh } = await staffSession(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    if (!fresh && b.action !== "refuse") throw new StaffRefused("reauth_required");
    const db = getPool();
    if (b.action === "propose") return Response.json({ ok: true, ...(await proposeLegal(db, staff, { purpose: b.purpose, version: b.version, body: b.body })) });
    if (b.action === "confirm") return Response.json({ ok: true, ...(await confirmLegal(db, staff, b.requestId)) });
    await refuseLegal(db, staff, b.requestId);
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "legal-texts");
  }
}
