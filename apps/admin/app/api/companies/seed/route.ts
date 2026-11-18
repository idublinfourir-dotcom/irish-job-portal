// The company seed (brand list) bulk import through the two-person rule (step 15 Q14): GET shows the pending import with its rows; POST proposes a
// file in the company-seed-cli.ts format (a rules data editor), confirms it (an administrator who did not propose; the seed runs at once) or refuses
// it (withdrawn when the proposer does it). The role checks are inside the database calls.
import { staffSettings } from "@portal/auth";
import { getPool } from "@portal/db";
import { confirmCompanySeed, listCompanySeed, MAX_SEED_TEXT, proposeCompanySeed, refuseCompanySeed } from "@portal/db/staff-tools";
import { checkLength, checkOrigin, id19, parseBody, readQuery, refuse, type Field, type Spec } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 1_100_000; // a 1,000,000-character file with its JSON escaping
const ACTIONS: Record<string, Spec> = { propose: { need: ["text"] }, confirm: { need: ["requestId"] }, refuse: { need: ["requestId"] } };
const FIELDS: Record<string, Field> = { text: [(v) => typeof v === "string" && v.length <= MAX_SEED_TEXT, "bad_text"], requestId: [id19, "bad_request_id"] };

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    readQuery(request.url, []);
    return Response.json(await listCompanySeed(getPool(), staff));
  } catch (e) {
    return refuse(e, "companies/seed");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    const db = getPool();
    if (b.action === "propose") return Response.json({ ok: true, ...(await proposeCompanySeed(db, staff, b.text)) });
    if (b.action === "confirm") return Response.json({ ok: true, ...(await confirmCompanySeed(db, staff, b.requestId)) });
    await refuseCompanySeed(db, staff, b.requestId);
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "companies/seed");
  }
}
