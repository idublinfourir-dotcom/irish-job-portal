// The staff services board (M3, M9): GET lists open cases at one status (?status=, ?after=) or shows one case (?id=, logged as data_access with
// reason services_case); POST assigns, moves the status, sets the documents needed, records the outcome, closes, refers or adds a note.
// The roles (services_case_handler works the case it holds; an administrator views and reassigns) are checked inside each database call.
import { staffSettings } from "@portal/auth";
import {
  addCaseNote, assignCase, closeCase, getServiceCase, getPool, listServiceCases, MAX_NOTE, recordDecision, referCase, setCaseStatus, setDocumentsNeeded,
} from "@portal/db";
import { checkLength, checkOrigin, id19, parseBody, readQuery, reasonCode, refuse, staffIdOk, type Field, type Spec } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 3000; // a note of MAX_NOTE characters plus the JSON around it
const ACTIONS: Record<string, Spec> = {
  assign: { need: ["caseId", "staffUserId"] },
  status: { need: ["caseId", "status"] },
  documents: { need: ["caseId", "codes"] },
  decision: { need: ["caseId", "outcome"] },
  close: { need: ["caseId", "reason"] },
  refer: { need: ["caseId"], may: ["solicitorId"] },
  note: { need: ["caseId", "body"] },
};
const FIELDS: Record<string, Field> = {
  caseId: [id19, "bad_case_id"], staffUserId: [staffIdOk, "bad_staff_id"], status: [reasonCode, "bad_status"],
  codes: [(v) => Array.isArray(v) && v.length <= 30 && v.every((x) => typeof x === "string" && x.length <= 40), "bad_codes"],
  outcome: [reasonCode, "bad_outcome"], reason: [reasonCode, "bad_reason"], solicitorId: [id19, "bad_solicitor_id"],
  body: [(v) => typeof v === "string" && v.length <= MAX_NOTE, "bad_text"],
};

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["id", "status", "after"]);
    if (q.id !== undefined) {
      if (q.status !== undefined || q.after !== undefined) return Response.json({ error: "bad_query" }, { status: 400 });
      const found = await getServiceCase(getPool(), staff, q.id);
      return found ? Response.json({ item: found }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(await listServiceCases(getPool(), staff, { status: q.status, after: q.after }));
  } catch (e) {
    return refuse(e, "services cases");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    const db = getPool(), id = b.caseId as string;
    if (b.action === "assign") await assignCase(db, staff, id, b.staffUserId as string);
    else if (b.action === "status") await setCaseStatus(db, staff, id, b.status as string);
    else if (b.action === "documents") await setDocumentsNeeded(db, staff, id, b.codes);
    else if (b.action === "decision") await recordDecision(db, staff, id, b.outcome as string);
    else if (b.action === "close") await closeCase(db, staff, id, b.reason as string);
    else if (b.action === "refer") await referCase(db, staff, id, b.solicitorId as string | undefined);
    else await addCaseNote(db, staff, id, b.body as string);
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "services cases");
  }
}
