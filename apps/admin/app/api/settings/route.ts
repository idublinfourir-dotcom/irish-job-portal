// A setting's value through the two-person rule (step 15 R2): GET lists every setting and the pending changes; POST proposes a new value for a known
// key (an administrator), confirms it (a different administrator; the value is written at once) or refuses it (withdrawn when the proposer does it).
// Administrators only; the database refuses any other way to change a value (setting_guard, 0004).
import { StaffRefused, staffSettings } from "@portal/auth";
import { getPool } from "@portal/db";
import { confirmSetting, listSettings, proposeSetting, refuseSetting } from "@portal/db/staff-tools";
import { checkLength, checkOrigin, id19, parseBody, readQuery, refuse, type Field, type Spec } from "../../../lib/admin-api";
import { requireStaff, staffSession } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 300;
const ACTIONS: Record<string, Spec> = { propose: { need: ["key", "value"] }, confirm: { need: ["requestId"] }, refuse: { need: ["requestId"] } };
// value is required but may be null (not set): parseBody treats undefined as missing, and null passes to the database module's check.
const FIELDS: Record<string, Field> = {
  key: [(v) => typeof v === "string", "bad_key"], value: [(v) => v === null || typeof v === "number", "bad_value"], requestId: [id19, "bad_request_id"],
};

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await listSettings(getPool(), staff));
  } catch (e) {
    return refuse(e, "settings");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const { id: staff, fresh } = await staffSession(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    if (!fresh && b.action !== "refuse") throw new StaffRefused("reauth_required"); // SEC-12, C4: a setting's value changes on the confirm
    const db = getPool();
    if (b.action === "propose") return Response.json({ ok: true, ...(await proposeSetting(db, staff, b.key, b.value)) });
    if (b.action === "confirm") return Response.json({ ok: true, ...(await confirmSetting(db, staff, b.requestId)) });
    await refuseSetting(db, staff, b.requestId);
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "settings");
  }
}
