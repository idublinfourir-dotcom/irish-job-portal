// Data requests (step 15 Q2), administrators only: GET lists the open data_request items and the erasures waiting for a second administrator;
// POST export {itemId} returns the requester's own export to the staff member, close {itemId} ends the item, erase_propose {itemId},
// erase_confirm and erase_refuse {requestId} erase the requester's account through two administrators. The role check is inside each database call.
import { staffSettings } from "@portal/auth";
import { getPool } from "@portal/db";
import { closeDataRequest, confirmDataRequestErase, exportDataRequest, listDataRequests, proposeDataRequestErase, refuseDataRequestErase } from "@portal/db/staff-tools";
import { checkLength, checkOrigin, id19, parseBody, readQuery, refuse, type Field, type Spec } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 200;
const byItem: Spec = { need: ["itemId"] }, byRequest: Spec = { need: ["requestId"] };
const ACTIONS: Record<string, Spec> = { export: byItem, close: byItem, erase_propose: byItem, erase_confirm: byRequest, erase_refuse: byRequest };
const FIELDS: Record<string, Field> = { itemId: [id19, "bad_item_id"], requestId: [id19, "bad_request_id"] };

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await listDataRequests(getPool(), staff));
  } catch (e) {
    return refuse(e, "data-requests");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    const db = getPool();
    if (b.action === "export") return Response.json({ ok: true, ...(await exportDataRequest(db, staff, b.itemId)) }, { headers: { "cache-control": "no-store" } });
    if (b.action === "erase_propose") return Response.json({ ok: true, ...(await proposeDataRequestErase(db, staff, b.itemId)) });
    if (b.action === "erase_confirm") return Response.json({ ok: true, ...(await confirmDataRequestErase(db, staff, b.requestId)) });
    if (b.action === "close") await closeDataRequest(db, staff, b.itemId);
    else await refuseDataRequestErase(db, staff, b.requestId);
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "data-requests");
  }
}
