// The pure parts of the account review route (#186, #187): the body check, the refusal-to-status map and the Origin test. No database, so
// unit tests cover them alone.
import { validId } from "@portal/db";

export type Action = "claim" | "release" | "approve" | "ask_more" | "reject";
export type Body = { action: Action; itemId: string; addDomain?: boolean; reason?: string; question?: string };

/** A body or Origin problem, as a short code the route turns into 400 or 403. */
export class BadRequest extends Error {}

const ACTIONS: readonly string[] = ["claim", "release", "approve", "ask_more", "reject"];
const FIELDS = new Set(["action", "itemId", "addDomain", "reason", "question"]);
export const MAX_BODY = 4500; // bytes by header, characters by text; the biggest real body is ask for more with a 1,000 character question (up to 4 bytes each)

/** The content-length header, when there is one, must not be over the limit: checked before the body is read (a missing or odd header passes; parseBody still checks the text). */
export function checkLength(header: string | null): void {
  if (Number(header ?? 0) > MAX_BODY) throw new BadRequest("bad_body");
}

/** Strict check of the POST body text: a plain object with only the known fields, of the right types. Anything else is "bad_body". */
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
  if (Object.keys(b).some((k) => !FIELDS.has(k))) throw new BadRequest("bad_body");
  if (typeof b.action !== "string" || !ACTIONS.includes(b.action)) throw new BadRequest("bad_action");
  if (!validId(b.itemId)) throw new BadRequest("bad_item_id");
  if (b.addDomain !== undefined && (typeof b.addDomain !== "boolean" || b.action !== "approve")) throw new BadRequest("bad_body");
  if (b.reason !== undefined && (typeof b.reason !== "string" || (b.action !== "ask_more" && b.action !== "reject"))) throw new BadRequest("bad_body");
  if (b.question !== undefined && (typeof b.question !== "string" || b.action !== "ask_more")) throw new BadRequest("bad_body"); // its text is checked by checkQuestion
  if (b.action === "reject" && b.reason === undefined) throw new BadRequest("bad_reason");
  return b as Body;
}

/** The POST must come from the admin app's own origin: a missing or different Origin header is refused. */
export function checkOrigin(origin: string | null, own: string): void {
  if (origin === null || origin !== own) throw new BadRequest("bad_origin");
}

const STATUS = new Map<string, number>(Object.entries({
  bad_body: 400, bad_action: 400, bad_item_id: 400, bad_reason: 400, bad_question: 400, bad_tab: 400, bad_cursor: 400, bad_input: 400, bad_query: 400, bad_domain: 400,
  bad_origin: 403, not_reviewer: 403, not_active_staff: 403,
  not_found: 404,
  already_decided: 409, not_claimed: 409, not_claimer: 409, claimed_by_other: 409, organisation_not_pending: 409, has_permit_history: 409,
  free_email_domain: 409, domain_owned_by_other: 409, no_claimant: 409, claimant_not_active: 409,
  no_session: 401, not_active: 401, reauth_required: 403,
}));
/** The HTTP status for a refusal code; null for a code this route does not know, which the caller turns into a plain 500. */
export const statusFor = (why: string): number | null => STATUS.get(why) ?? null;
