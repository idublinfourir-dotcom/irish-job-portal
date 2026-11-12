// Staff review of employer and agency accounts (#186, #187). GET lists the open items or shows one (?id=); POST claims, releases, approves,
// asks for more or rejects. Every call needs a signed-in staff member; the account_reviewer role check is inside each database call.
import { StaffRefused, staffSettings } from "@portal/auth";
import { approveAccount, askForMoreInfo, claimReview, getAccountReview, getPool, listAccountReviews, QueueRefused, rejectAccount, releaseReview } from "@portal/db";
import { BadRequest, checkOrigin, parseBody, statusFor } from "../../../lib/account-review";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const fail = (why: string, status: number) => Response.json({ error: why }, { status });
function refusal(e: unknown): Response {
  const why = e instanceof QueueRefused || e instanceof BadRequest ? e.message.split(":")[0]! : e instanceof StaffRefused ? e.message : null;
  const status = why === null ? null : statusFor(why);
  if (why === null || status === null) {
    console.error("account-review failed:", e instanceof Error ? e.message : "unknown"); // the reason stays in the server log, never in the answer
    return fail("server_error", 500);
  }
  return fail(why, status);
}

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    if (id !== null) {
      const found = await getAccountReview(getPool(), staff, id);
      return found ? Response.json({ item: found }) : fail("not_found", 404);
    }
    return Response.json(await listAccountReviews(getPool(), staff, { after: params.get("after") ?? undefined }));
  } catch (e) {
    return refusal(e);
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text());
    const db = getPool();
    if (b.action === "claim") await claimReview(db, staff, b.itemId);
    else if (b.action === "release") await releaseReview(db, staff, b.itemId);
    else {
      const d =
        b.action === "approve" ? await approveAccount(db, staff, b.itemId, { addDomain: b.addDomain })
        : b.action === "ask_more" ? await askForMoreInfo(db, staff, b.itemId, b.reason)
        : await rejectAccount(db, staff, b.itemId, b.reason!);
      return Response.json({ ok: true, ...d });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return refusal(e);
  }
}
