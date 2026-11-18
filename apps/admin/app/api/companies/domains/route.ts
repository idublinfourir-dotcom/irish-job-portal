// A company's email domains (Q13, #186), outside the approve step. GET ?organisationId=n lists them; POST adds one ({action: "add", organisationId, domain,
// reason}) or removes one ({action: "remove", ...}). Account reviewers and administrators only; the role check is inside each database call. A domain
// lets a claimant on it be verified with no review, so add is refused for a free-mail, malformed or other company's domain (the reply names that company).
import { staffSettings } from "@portal/auth";
import { addDomain, DomainTaken, getPool, listDomains, removeDomain } from "@portal/db";
import { checkLength, checkOrigin, id19, parseBody, readQuery, reasonCode, refuse, type Field, type Spec } from "../../../../lib/admin-api";
import { requireStaff } from "../../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 1000; // the biggest real body is about 400: a 253-character domain, an id and a reason code
const ACTIONS: Record<string, Spec> = { add: { need: ["organisationId", "domain", "reason"] }, remove: { need: ["organisationId", "domain", "reason"] } };
const FIELDS: Record<string, Field> = {
  organisationId: [id19, "bad_organisation_id"], domain: [(v) => typeof v === "string" && v.length <= 253, "bad_domain"], reason: [reasonCode, "bad_reason"],
};

function fail(e: unknown): Response {
  if (e instanceof DomainTaken) return Response.json({ error: e.why, owner: e.owner }, { status: 409 });
  return refuse(e, "companies/domains");
}

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["organisationId"]);
    return Response.json({ domains: await listDomains(getPool(), staff, q.organisationId ?? "") });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS) as { action: "add" | "remove"; organisationId: string; domain: string; reason: string };
    const go = b.action === "add" ? addDomain : removeDomain;
    return Response.json({ ok: true, ...(await go(getPool(), staff, b.organisationId, b.domain, b.reason)) });
  } catch (e) {
    return fail(e);
  }
}
