// The scheduled reminders (step 15 Q3): GET lists the open scheduled_check items for the roles the staff member holds (rules data editor, fetched
// job reviewer; an administrator sees them all); POST { action: "done", itemId } closes one. The items are written daily by scheduled-checks-cli.ts.
import { staffSettings } from "@portal/auth";
import { getPool } from "@portal/db";
import { doneScheduledCheck, listScheduledChecks } from "@portal/db/staff-tools";
import { checkLength, checkOrigin, id19, parseBody, readQuery, refuse, type Field, type Spec } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 200;
const ACTIONS: Record<string, Spec> = { done: { need: ["itemId"] } };
const FIELDS: Record<string, Field> = { itemId: [id19, "bad_item_id"] };

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await listScheduledChecks(getPool(), staff));
  } catch (e) {
    return refuse(e, "scheduled-checks");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    await doneScheduledCheck(getPool(), staff, b.itemId);
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "scheduled-checks");
  }
}
