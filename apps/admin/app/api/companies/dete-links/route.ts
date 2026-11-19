// Step 15 Q5: DETE name links by staff. GET ?page=n lists suggested links (DETE names no row of which is linked, matched to a company's names, best first,
// 50 a page); POST links a DETE name to a company ({action: "link", deteName, organisationId}), unlinks one ({action: "unlink", deteName}) or turns a
// suggestion down ({action: "reject", deteName, organisationId}). The account reviewer acts; trust and safety and administrators read. Role checks are in the database.
import { staffSettings } from "@portal/auth";
import { deteLinkSuggestions, getPool, linkDeteName, rejectDeteSuggestion, unlinkDeteName } from "@portal/db";
import { checkLength, checkOrigin, id19, parseBody, readQuery, refuse, type Field, type Spec } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 2000; // a DETE name is at most 300 characters; JSON escaping can make it longer
const ACTIONS: Record<string, Spec> = { link: { need: ["deteName", "organisationId"] }, unlink: { need: ["deteName"] }, reject: { need: ["deteName", "organisationId"] } };
const FIELDS: Record<string, Field> = { deteName: [(v) => typeof v === "string" && v.length <= 300, "bad_name"], organisationId: [id19, "bad_organisation_id"] };

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["page"]);
    const page = q.page === undefined ? 1 : /^[1-9]\d{0,3}$/.test(q.page) ? Number(q.page) : 0;
    return Response.json(await deteLinkSuggestions(getPool(), staff, page));
  } catch (e) {
    return refuse(e, "companies/dete-links");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS) as { action: "link" | "unlink" | "reject"; deteName: string; organisationId?: string };
    const db = getPool();
    const r = b.action === "link" ? await linkDeteName(db, staff, b.deteName, b.organisationId)
      : b.action === "reject" ? await rejectDeteSuggestion(db, staff, b.deteName, b.organisationId) : await unlinkDeteName(db, staff, b.deteName);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return refuse(e, "companies/dete-links");
  }
}
