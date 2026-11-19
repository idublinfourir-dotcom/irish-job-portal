// Staff accounts (#233, #234 D4 and D5), administrators only: GET lists the logins with their roles and the role grants waiting for a second administrator;
// POST proposes a role (one administrator), confirms or refuses it (a different one), removes a role, disables a login (its sessions end) or enables it again,
// or invites a new login (Q15): the login with no password and no role, its first role proposed for a second administrator, and a set-password email
// through Better Auth's reset (the security@ sender). Every call needs a signed-in staff member; the administrator check is inside each database call.
import { staffSettings } from "@portal/auth";
import {
  confirmRoleGrant, disableLogin, enableLogin, getPool, inviteStaff, listStaff, proposeRoleGrant, refuseRoleGrant, removeRole, validStaffName,
} from "@portal/db";
import { checkLength, checkOrigin, id19, parseBody, readQuery, refuse, staffIdOk, type Field, type Spec } from "../../../lib/admin-api";
import { requireStaff, staffAuth } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 1000;
const ACTIONS: Record<string, Spec> = {
  propose_role: { need: ["staffId", "role"] },
  confirm_role: { need: ["requestId"] },
  refuse_role: { need: ["requestId"] },
  remove_role: { need: ["staffId", "role"] },
  disable: { need: ["staffId"] },
  enable: { need: ["staffId"] },
  invite: { need: ["email", "name", "role"] },
};
const FIELDS: Record<string, Field> = {
  staffId: [staffIdOk, "bad_staff_id"], requestId: [id19, "bad_request_id"], role: [(v) => typeof v === "string" && /^[a-z_]{1,40}$/.test(v), "bad_role"],
  email: [(v) => typeof v === "string" && v.length <= 254, "bad_email"], name: [validStaffName, "bad_name"], // the database call checks the email's shape
};

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await listStaff(getPool(), staff));
  } catch (e) {
    return refuse(e, "staff");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    const db = getPool();
    const s = (k: string) => b[k] as string;
    switch (b.action) {
      case "propose_role": return Response.json({ ok: true, ...(await proposeRoleGrant(db, staff, s("staffId"), s("role"))) });
      case "confirm_role": return Response.json({ ok: true, ...(await confirmRoleGrant(db, staff, s("requestId"))) });
      case "refuse_role": await refuseRoleGrant(db, staff, s("requestId")); break;
      case "remove_role": await removeRole(db, staff, s("staffId"), s("role")); break;
      case "disable": return Response.json({ ok: true, ...(await disableLogin(db, staff, s("staffId"))) });
      case "enable": await enableLogin(db, staff, s("staffId")); break;
      case "invite": {
        const { staffId, requestId, email } = await inviteStaff(db, staff, b.email, b.name, b.role);
        // After the commit. Better Auth logs a failed send and still answers ok (as it does for any reset); the login stays and the invitee asks for a reset again.
        await staffAuth().api.requestPasswordReset({ body: { email } });
        return Response.json({ ok: true, staffId, requestId });
      }
    }
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "staff");
  }
}
