// What the step 13 staff routes share (staff, audit, content, fetched jobs): the strict POST body check, the length check and the refusal-to-status map.
// No database, so unit tests cover them alone. The Origin check and BadRequest come from the account review route's file.
import { StaffRefused } from "@portal/auth";
import { QueueRefused, validId } from "@portal/db";
import { BadRequest } from "./account-review";

export { BadRequest, checkOrigin } from "./account-review";

/** The content-length header, when there is one, must not be over the limit: checked before the body is read. */
export function checkLength(header: string | null, max: number): void {
  if (Number(header ?? 0) > max) throw new BadRequest("bad_body");
}

/** A field check and the code a failure gives. */
export type Field = readonly [check: (v: unknown) => boolean, code: string];
export type Spec = { need: string[]; may?: string[] };
export type Body = { action: string } & Record<string, unknown>;

/** Strict check of a POST body: a plain object, a known action, exactly that action's fields (anything else is refused), each of the right shape. */
export function parseBody(text: string, max: number, actions: Record<string, Spec>, fields: Record<string, Field>): Body {
  if (text.length > max) throw new BadRequest("bad_body");
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new BadRequest("bad_body");
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new BadRequest("bad_body");
  const b = o as Record<string, unknown>;
  if (typeof b.action !== "string" || !Object.hasOwn(actions, b.action)) throw new BadRequest("bad_action");
  const spec = actions[b.action]!;
  const allowed = new Set(["action", ...spec.need, ...(spec.may ?? [])]);
  if (Object.keys(b).some((k) => !allowed.has(k))) throw new BadRequest("bad_body");
  for (const k of spec.need) if (b[k] === undefined) throw new BadRequest(fields[k]![1]);
  for (const k of allowed) if (k !== "action" && b[k] !== undefined && !fields[k]![0](b[k])) throw new BadRequest(fields[k]![1]);
  return b as Body;
}

export const id19: Field["0"] = validId;
export const staffIdOk: Field["0"] = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
export const reasonCode: Field["0"] = (v) => typeof v === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(v);

const STATUS = new Map<string, number>(Object.entries({
  bad_body: 400, bad_action: 400, bad_cursor: 400, bad_query: 400, bad_staff_id: 400, bad_request_id: 400, bad_role: 400, bad_id: 400, bad_item_id: 400, bad_reason: 400, bad_input: 400,
  bad_kind: 400, bad_status: 400, bad_slug: 400, bad_title: 400, bad_body_text: 400, bad_source_url: 400, bad_checked_on: 400, nothing_to_change: 400,
  bad_object_type: 400, bad_object_id: 400, bad_from: 400, bad_to: 400, bad_range: 400,
  bad_occupation_code: 400, bad_salary: 400, bad_user_id: 400, bad_message_id: 400, bad_queue: 400, bad_domain: 400, bad_organisation_id: 400,
  bad_text: 400, bad_data: 400, bad_key: 400, bad_value: 400,
  no_session: 401, not_active: 401,
  bad_origin: 403, not_contact_staff: 403, not_contact_reader: 403, not_active_staff: 403, not_administrator: 403, not_content_staff: 403, not_content_editor: 403, not_rules_data_editor: 403, not_publisher: 403, not_reviewer: 403, not_domain_staff: 403,
  not_scheduled_staff: 403, not_seed_staff: 403,
  not_found: 404, domain_not_found: 404,
  target_not_active: 409, already_holds: 409, grant_pending: 409, request_not_pending: 409, same_person: 409, last_administrator: 409, not_disabled: 409, already_disabled: 409, holds_roles: 409, already_held: 409, not_held: 409,
  slug_taken: 409, not_editable: 409, already_published: 409, not_published: 409, needs_source_and_checked_on: 409,
  not_claimed: 409, not_claimer: 409, claimed_by_other: 409, already_decided: 409, job_not_in_review: 409, no_advert_text: 409, rules_failed: 409, company_not_active: 409,
  free_email_domain: 409, domain_owned_by_other: 409, already_added: 409, open_ban_case: 409, company_merged: 409,
  decision_pending: 409, no_change: 409,
  same_account: 400, kept_account_deleted: 409, open_services_case: 409, open_report: 409,
  no_account: 409, several_accounts: 409, sender_not_account: 409, not_open: 409, account_changed: 409, owner_with_members: 409,
}));

/** A refusal as a short code and status; anything unknown is a plain 500 with the reason kept in the server log only. A failed rules check also names its stage. */
export function refuse(e: unknown, route: string): Response {
  const why = e instanceof QueueRefused || e instanceof BadRequest ? e.message.split(":")[0]! : e instanceof StaffRefused ? e.message : null;
  const status = why === null ? undefined : STATUS.get(why);
  if (why === null || status === undefined) {
    console.error(`${route} failed:`, e instanceof Error ? e.message : "unknown");
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  return Response.json({ error: why, ...(e instanceof QueueRefused && e.stage ? { stage: e.stage } : {}) }, { status });
}

/** The query string may hold only the named parameters, each once (a name in `many` may repeat): anything else is "bad_query". Returns the values that are present (the first of a repeated one). */
export function readQuery(url: string, allowed: readonly string[], many: readonly string[] = []): Record<string, string> {
  const params = new URL(url).searchParams;
  const out: Record<string, string> = {};
  for (const k of new Set(params.keys())) {
    if (!allowed.includes(k) || (params.getAll(k).length !== 1 && !many.includes(k))) throw new BadRequest("bad_query");
    out[k] = params.get(k)!;
  }
  return out;
}
