// The referral solicitor list (S-Q10 B): GET lists it (services case handlers and administrators); POST adds, edits or deactivates a firm
// (administrators only; nothing is deleted). The role check is inside each database call.
import { staffSettings } from "@portal/auth";
import { addSolicitor, editSolicitor, getPool, listSolicitors } from "@portal/db";
import { checkLength, checkOrigin, id19, parseBody, readQuery, refuse, type Field, type Spec } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 1000;
const ACTIONS: Record<string, Spec> = {
  add: { need: ["firm", "contact"] },
  edit: { need: ["solicitorId"], may: ["firm", "contact"] },
  deactivate: { need: ["solicitorId"] },
};
const text = (max: number) => (v: unknown) => typeof v === "string" && v.length <= max;
const FIELDS: Record<string, Field> = { solicitorId: [id19, "bad_solicitor_id"], firm: [text(200), "bad_firm"], contact: [text(300), "bad_contact"] };

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await listSolicitors(getPool(), staff));
  } catch (e) {
    return refuse(e, "services solicitors");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    if (b.action === "add") return Response.json({ ok: true, id: await addSolicitor(getPool(), staff, b.firm as string, b.contact as string) });
    if (b.action === "edit" && b.firm === undefined && b.contact === undefined) return Response.json({ error: "nothing_to_change" }, { status: 400 });
    await editSolicitor(getPool(), staff, b.solicitorId as string, b.action === "deactivate" ? { active: false } : { firm: b.firm as string | undefined, contact: b.contact as string | undefined });
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "services solicitors");
  }
}
