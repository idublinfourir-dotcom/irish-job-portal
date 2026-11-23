// The fetched-job queue (#193, #234 D7), for staff holding fetched_job_reviewer: GET lists the open and claimed items (?after=) or shows one with the advert
// text, the quoted evidence and the matcher model (?id=); the list takes ?stage= (one category tab) and gives the count per stage; POST claims, releases, approves (the claimer's occupation code, pay and contract; the rules re-run) or rejects (a reason code). The role check is
// inside each database call, reads included.
import { staffSettings } from "@portal/auth";
import { approve, claim, getItem, getPool, listQueue, reject, release } from "@portal/db";
import { checkLength, checkOrigin, id19, parseBody, readQuery, reasonCode, refuse, type Field, type Spec } from "../../../lib/admin-api";
import { queueRules } from "../../../lib/queue-rules";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 600;
const ACTIONS: Record<string, Spec> = {
  claim: { need: ["itemId"] },
  release: { need: ["itemId"] },
  approve: { need: ["itemId", "occupationCode"], may: ["salaryLow", "salaryHigh", "contractConfirmed"] },
  reject: { need: ["itemId", "reason"] },
};
const pay: Field["0"] = (v) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 1_000_000;
const FIELDS: Record<string, Field> = {
  itemId: [id19, "bad_item_id"], occupationCode: [(v) => typeof v === "string" && /^[0-9]{4}$/.test(v), "bad_occupation_code"], salaryLow: [pay, "bad_salary"], salaryHigh: [pay, "bad_salary"],
  contractConfirmed: [(v) => typeof v === "boolean", "bad_input"], reason: [reasonCode, "bad_reason"],
};

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["id", "after", "stage"]);
    if (q.id !== undefined) {
      const found = await getItem(getPool(), staff, q.id);
      return found ? Response.json({ item: found }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(await listQueue(getPool(), staff, { after: q.after, stage: q.stage }));
  } catch (e) {
    return refuse(e, "fetched-jobs");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    const db = getPool();
    const id = b.itemId as string;
    switch (b.action) {
      case "claim": await claim(db, staff, id); break;
      case "release": await release(db, staff, id); break;
      case "approve":
        return Response.json({ ok: true, ...(await approve(db, staff, id, {
          occupationCode: b.occupationCode as string, salaryLow: b.salaryLow as number | undefined, salaryHigh: b.salaryHigh as number | undefined, contractConfirmed: b.contractConfirmed as boolean | undefined,
        }, await queueRules(db))) });
      case "reject": await reject(db, staff, id, b.reason as string); break;
    }
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "fetched-jobs");
  }
}
