// The pay floor check queue (#82, #104): GET lists the floors waiting for a check or shows one (?id= the floor id); POST proposes (a rules data editor),
// confirms (an administrator who did not propose) or rejects (either). Every call needs a signed-in staff member; the role check is inside each database call.
import { staffSettings } from "@portal/auth";
import { confirmFloor, getFloorCheck, getPool, listFloorChecks, proposeFloor, rejectFloor } from "@portal/db";
import { checkLength, checkOrigin } from "../../../lib/account-review";
import { parseBody, refuse } from "../../../lib/pay-floors";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    if (id !== null) {
      const found = await getFloorCheck(getPool(), staff, id);
      return found ? Response.json({ item: found }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(await listFloorChecks(getPool(), staff, { after: params.get("after") ?? undefined }));
  } catch (e) {
    return refuse(e);
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"));
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text());
    const db = getPool();
    if (b.action === "propose") return Response.json({ ok: true, ...(await proposeFloor(db, staff, b.floorId)) });
    if (b.action === "confirm") return Response.json({ ok: true, ...(await confirmFloor(db, staff, b.floorId)) });
    await rejectFloor(db, staff, b.floorId, b.reason!);
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e);
  }
}
