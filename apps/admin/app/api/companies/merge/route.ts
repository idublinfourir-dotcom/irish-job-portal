// Company name merges (#234 D1): GET shows the companies with the given ids (?id=1&id=2) and what a merge would move; POST merges the absorbed company into the
// survivor. A call needs a signed-in staff member; the role check is inside each database call (an account reviewer or a fetched-job reviewer merges, the other
// roles of the matrix row only look). No suggestions and no undo.
import { staffSettings } from "@portal/auth";
import { getPool, mergeCompanies, previewCompanies } from "@portal/db";
import { checkOrigin } from "../../../../lib/account-review";
import { checkLength, MAX_SMALL_BODY, parseMerge, refuse } from "../../../../lib/companies";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    return Response.json({ companies: await previewCompanies(getPool(), staff, new URL(request.url).searchParams.getAll("id")) });
  } catch (e) {
    return refuse(e, "companies/merge");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_SMALL_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseMerge(await request.text());
    return Response.json({ ok: true, ...(await mergeCompanies(getPool(), staff, b.absorbedId, b.survivorId)) });
  } catch (e) {
    return refuse(e, "companies/merge");
  }
}
