// The contact inbox (#55), for staff holding services_case_handler or content_editor (an administrator may read): GET lists the new and claimed messages
// (?after=) or shows one in full (?id=, logged); POST claims, or marks a claimed message answered, closed or spam. The role check is inside each database call.
import { staffSettings } from "@portal/auth";
import { claimContact, decideContact, getContact, getPool, listContact, type ContactAction } from "@portal/db";
import { checkLength, checkOrigin, id19, parseBody, readQuery, refuse, type Field, type Spec } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 200;
const ACTIONS: Record<string, Spec> = { claim: { need: ["messageId"] }, answer: { need: ["messageId"] }, close: { need: ["messageId"] }, spam: { need: ["messageId"] } };
const FIELDS: Record<string, Field> = { messageId: [id19, "bad_message_id"] };

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["id", "after"]);
    if (q.id !== undefined) {
      const found = await getContact(getPool(), staff, q.id);
      return found ? Response.json({ item: found }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(await listContact(getPool(), staff, { after: q.after }));
  } catch (e) {
    return refuse(e, "contact");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    const id = b.messageId as string;
    if (b.action === "claim") await claimContact(getPool(), staff, id);
    else await decideContact(getPool(), staff, id, b.action as ContactAction);
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "contact");
  }
}
