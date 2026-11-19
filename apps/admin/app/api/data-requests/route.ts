// Data requests (step 15 Q2), administrators only: GET lists the open data_request items and the erasures waiting for a second administrator;
// POST send_confirm {itemId, purpose} emails the matched login's own address a one-time link (its owner confirms, and downloads an export, on their
// own site: staff never get the data), close {itemId} ends the item, erase_propose {itemId}, erase_confirm and erase_refuse {requestId} erase the
// account through two administrators once the request is proved. The role check is inside each database call.
import { staffSettings } from "@portal/auth";
import { getPool } from "@portal/db";
import { closeDataRequest, confirmDataRequestErase, DR_PURPOSES, listDataRequests, proposeDataRequestErase, refuseDataRequestErase, sendDataRequestConfirm } from "@portal/db/staff-tools";
import { checkLength, checkOrigin, id19, parseBody, readQuery, refuse, type Field, type Spec } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 200;
const byItem: Spec = { need: ["itemId"] }, byRequest: Spec = { need: ["requestId"] };
const ACTIONS: Record<string, Spec> = { send_confirm: { need: ["itemId", "purpose"] }, close: byItem, erase_propose: byItem, erase_confirm: byRequest, erase_refuse: byRequest };
const FIELDS: Record<string, Field> = { itemId: [id19, "bad_item_id"], requestId: [id19, "bad_request_id"], purpose: [(v) => (DR_PURPOSES as readonly unknown[]).includes(v), "bad_purpose"] };

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
    if (b.action === "send_confirm") return Response.json({ ok: true, ...(await sendDataRequestConfirm(db, staff, b.itemId, b.purpose)) });
    if (b.action === "erase_propose") return Response.json({ ok: true, ...(await proposeDataRequestErase(db, staff, b.itemId)) });
    if (b.action === "erase_confirm") return Response.json({ ok: true, ...(await confirmDataRequestErase(db, staff, b.requestId)) });
    if (b.action === "close") await closeDataRequest(db, staff, b.itemId);
    else await refuseDataRequestErase(db, staff, b.requestId);
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "data-requests");
  }
}
