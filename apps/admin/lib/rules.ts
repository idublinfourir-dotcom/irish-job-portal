// The pure parts of the rules route (#229, #230): the body check and the refusal-to-status map. No database, so unit tests cover them alone.
// The data inside a proposal is checked for its kind by cleanData in @portal/db; here only the body's shape. The Origin check and BadRequest come
// from the account review route's file.
import { StaffRefused } from "@portal/auth";
import { QueueRefused, validId } from "@portal/db";
import { BadRequest } from "./account-review";

// characters; the biggest real body is the whole Ineligible list, about 35,000, or the big-company names with links and dates
export const MAX_BODY = 300_000;

/** The content-length header, when there is one, must not be over the limit: checked before the body is read. */
export function checkLength(header: string | null): void {
  if (Number(header ?? 0) > MAX_BODY) throw new BadRequest("bad_body");
}

export type Body =
  | { action: "propose"; kind: string; effectiveFrom: string; data: unknown }
  | { action: "propose_flag"; organisationId: string }
  | { action: "confirm" | "refuse" | "withdraw"; requestId: string };
const FIELDS: Record<string, string[]> = {
  propose: ["kind", "effectiveFrom", "data"], propose_flag: ["organisationId"], confirm: ["requestId"], refuse: ["requestId"], withdraw: ["requestId"],
};

/** Strict check of the POST body text: a plain object, a known action and exactly that action's fields. */
export function parseBody(text: string): Body {
  if (text.length > MAX_BODY) throw new BadRequest("bad_body");
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new BadRequest("bad_body");
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new BadRequest("bad_body");
  const b = o as Record<string, unknown>;
  if (typeof b.action !== "string" || !Object.hasOwn(FIELDS, b.action)) throw new BadRequest("bad_action");
  const need = FIELDS[b.action]!;
  if (Object.keys(b).some((k) => k !== "action" && !need.includes(k)) || need.some((k) => b[k] === undefined)) throw new BadRequest("bad_body");
  for (const k of ["requestId", "organisationId"]) if (b[k] !== undefined && !validId(b[k])) throw new BadRequest("bad_id");
  if (b.action === "propose" && (typeof b.kind !== "string" || typeof b.effectiveFrom !== "string")) throw new BadRequest("bad_body");
  return b as Body;
}

const STATUS = new Map<string, number>(Object.entries({
  bad_body: 400, bad_action: 400, bad_id: 400, bad_kind: 400, bad_date: 400, bad_data: 400, bad_query: 400, bad_cursor: 400, bad_file: 400, empty_file: 400,
  no_session: 401, not_active: 401,
  bad_origin: 403, not_active_staff: 403, not_rules_editor: 403, not_administrator: 403, not_proposer: 403, not_rules_viewer: 403,
  not_found: 404,
  date_in_past: 409, date_passed: 409, no_change: 409, decision_pending: 409, not_pending: 409, same_person: 409, already_big: 409, no_name_match: 409,
  scan_pending: 409, file_blocked: 409, file_too_large: 413, wrong_file_type: 415, file_active_content: 422,
}));

/** A refusal as a short code and status (bad_data also says which entry); anything unknown is a plain 500 with the reason kept in the server log only. */
export function refuse(e: unknown): Response {
  const why = e instanceof QueueRefused || e instanceof BadRequest ? e.message.split(":")[0]! : e instanceof StaffRefused ? e.message : null;
  const status = why === null ? undefined : STATUS.get(why);
  if (why === null || status === undefined) {
    console.error("rules failed:", e instanceof Error ? e.message : "unknown");
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  return Response.json(why === "bad_data" && e instanceof QueueRefused ? { error: why, detail: e.stage } : { error: why }, { status });
}
