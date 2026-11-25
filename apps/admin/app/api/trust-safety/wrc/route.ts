// B70 (frame D09, "Reported to the WRC"): the agency cases staff ticked off as reported to the WRC (#214 d), newest first, with the date. Reads only.
import { getPool, listWrcReported } from "@portal/db";
import { readQuery } from "../../../../lib/admin-api";
import { refusal } from "../../../../lib/refusal";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    return Response.json(await listWrcReported(getPool(), staff, { after: readQuery(request.url, ["after"]).after }));
  } catch (e) {
    return refusal(e, "wrc");
  }
}
