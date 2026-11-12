// The pure parts of the pay floor check route (#82, #104): the body check and the refusal-to-status map. No database, so unit tests cover them alone.
// The Origin check, the length check and BadRequest come from the account review route's file.
import { StaffRefused } from "@portal/auth";
import { QueueRefused } from "@portal/db";
import { BadRequest } from "./account-review";

export const MAX_BODY = 500; // characters; the biggest real body is about 80

export type Body = { action: "propose" | "confirm" | "reject"; floorId: string; reason?: string };
const ACTIONS: readonly string[] = ["propose", "confirm", "reject"];
const REASON = /^[a-z][a-z0-9_]{0,62}$/; // a reason code, never free text (#182)

/** Strict check of the POST body text: a plain object, a known action, a floor id, and a reason code on reject only. */
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
  if (Object.keys(b).some((k) => k !== "action" && k !== "floorId" && k !== "reason")) throw new BadRequest("bad_body");
  if (typeof b.action !== "string" || !ACTIONS.includes(b.action)) throw new BadRequest("bad_action");
  if (typeof b.floorId !== "string" || !/^[1-9][0-9]{0,18}$/.test(b.floorId)) throw new BadRequest("bad_floor_id");
  if (b.action === "reject" ? typeof b.reason !== "string" || !REASON.test(b.reason) : b.reason !== undefined) throw new BadRequest("bad_reason");
  return b as Body;
}

const STATUS = new Map<string, number>(Object.entries({
  bad_body: 400, bad_action: 400, bad_floor_id: 400, bad_reason: 400, bad_cursor: 400,
  bad_origin: 403, not_rules_editor: 403, not_administrator: 403, not_floor_staff: 403, not_active_staff: 403,
  not_found: 404,
  floor_not_pending: 409, floor_expired: 409, not_big_company: 409, organisation_not_active: 409, decision_pending: 409, nothing_pending: 409, same_person: 409,
  no_session: 401, not_active: 401,
}));

/** A refusal as a short code and status; anything unknown is a plain 500 with the reason kept in the server log only. */
export function refuse(e: unknown): Response {
  const why = e instanceof QueueRefused || e instanceof BadRequest ? e.message.split(":")[0]! : e instanceof StaffRefused ? e.message : null;
  const status = why === null ? undefined : STATUS.get(why);
  if (why === null || status === undefined) {
    console.error("pay-floors failed:", e instanceof Error ? e.message : "unknown");
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  return Response.json({ error: why }, { status });
}
