// The pure parts of the company routes (step 13 part 13c): name merges, an owner who cannot be reached, and manual posting. The body checks and the
// refusal-to-status map. No database, so unit tests cover them alone. The Origin check and BadRequest come from the account review route's file.
import { StaffRefused } from "@portal/auth";
import { QueueRefused } from "@portal/db";
import { BadRequest } from "./account-review";

export const MAX_BODY = 30_000; // characters: the biggest real body is a manual post, an advert of 10,000 characters with its JSON escaping and the other fields
export const MAX_SMALL_BODY = 1000; // the merge and owner routes: the biggest real body is about 100

/** The content-length header, when there is one, must not be over the limit: checked before the body is read (a missing or odd header passes; parseObject still checks the text). */
export function checkLength(header: string | null, max = MAX_BODY): void {
  if (Number(header ?? 0) > max) throw new BadRequest("bad_body");
}

const ID = /^[1-9][0-9]{0,18}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

/** A plain JSON object no longer than `max` characters. */
export function parseObject(text: string, max: number): Record<string, unknown> {
  if (text.length > max) throw new BadRequest("bad_body");
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new BadRequest("bad_body");
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new BadRequest("bad_body");
  return o as Record<string, unknown>;
}

const only = (b: Record<string, unknown>, keys: string[]) => Object.keys(b).every((k) => keys.includes(k));

export function parseMerge(text: string): { absorbedId: string; survivorId: string } {
  const b = parseObject(text, MAX_SMALL_BODY);
  if (!only(b, ["absorbedId", "survivorId"])) throw new BadRequest("bad_body");
  if (!isId(b.absorbedId) || !isId(b.survivorId)) throw new BadRequest("bad_input");
  return { absorbedId: b.absorbedId, survivorId: b.survivorId };
}

export type OwnerBody =
  | { action: "request"; membershipId: string; domainChecked: boolean; croChecked: boolean }
  | { action: "complete" | "cancel"; requestId: string };
export function parseOwner(text: string): OwnerBody {
  const b = parseObject(text, MAX_SMALL_BODY);
  if (b.action === "request") {
    if (!only(b, ["action", "membershipId", "domainChecked", "croChecked"])) throw new BadRequest("bad_body");
    if (!isId(b.membershipId)) throw new BadRequest("bad_input");
    if (typeof b.domainChecked !== "boolean" || typeof b.croChecked !== "boolean") throw new BadRequest("bad_body");
    return { action: "request", membershipId: b.membershipId, domainChecked: b.domainChecked, croChecked: b.croChecked };
  }
  if (b.action === "complete" || b.action === "cancel") {
    if (!only(b, ["action", "requestId"])) throw new BadRequest("bad_body");
    if (!isId(b.requestId)) throw new BadRequest("bad_input");
    return { action: b.action, requestId: b.requestId };
  }
  throw new BadRequest("bad_action");
}

export type ManualBody = { action: "create"; post: Record<string, unknown> } | { action: "close"; jobId: string };
/** `create` carries the post's own fields beside `action` (checked field by field by checkManualPost); `close` carries a job id. */
export function parseManual(text: string): ManualBody {
  const { action, ...rest } = parseObject(text, MAX_BODY);
  if (action === "create") return { action, post: rest };
  if (action === "close") {
    if (!only(rest, ["jobId"])) throw new BadRequest("bad_body");
    if (!isId(rest.jobId)) throw new BadRequest("bad_input");
    return { action, jobId: rest.jobId };
  }
  throw new BadRequest("bad_action");
}

const STATUS = new Map<string, number>(Object.entries({
  same_company: 400, not_checked: 400,
  bad_origin: 403, not_active_staff: 403, not_company_staff: 403, not_company_viewer: 403, not_account_reviewer: 403, not_manual_viewer: 403, not_poster: 403,
  not_found: 404, company_not_found: 404, member_not_found: 404,
  already_merged: 409, target_merged: 409, not_mergeable: 409, kind_mismatch: 409, active_members: 409, has_applications: 409, company_not_postable: 409, bad_state: 409,
  already_owner: 409, company_not_open: 409, no_owner: 409, user_not_active: 409, request_open: 409, not_open: 409, too_early: 409, owner_changed: 409, member_gone: 409,
  no_session: 401, not_active: 401,
}));
/** The HTTP status for a refusal code: any `bad_` code is 400 except bad_origin; null for a code the routes do not know, which the caller turns into a plain 500. */
export const statusFor = (why: string): number | null => STATUS.get(why) ?? (why.startsWith("bad_") ? 400 : null);

/** A refusal as a short code and status; anything unknown is a plain 500 with the reason kept in the server log only. */
export function refuse(e: unknown, route: string): Response {
  const why = e instanceof QueueRefused ? e.why : e instanceof BadRequest ? e.message : e instanceof StaffRefused ? e.message : null;
  const status = why === null ? null : statusFor(why);
  if (why === null || status === null) {
    console.error(`${route} failed:`, e instanceof Error ? e.message : "unknown");
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  return Response.json({ error: why }, { status });
}
