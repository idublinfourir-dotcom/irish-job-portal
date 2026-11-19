// The pure parts of the trust and safety routes (reports and cases): the body checks and the refusal-to-status map. No database, so unit tests
// cover them alone. The Origin check and BadRequest come from the account review route's file.
import { validId } from "@portal/db";
import { BadRequest } from "./account-review";

export const MAX_BODY = 12_000; // characters; the biggest real body is a 5,000-character reply or appeal plus the other fields
export const MAX_TEXT = 5000;
export const MAX_SUMMARY = 1000;

/** The content-length header, when there is one, must not be over the limit: checked before the body is read. */
export function checkLength(header: string | null): void {
  if (Number(header ?? 0) > MAX_BODY) throw new BadRequest("bad_body");
}

type Field = "id" | "kind" | "reason" | "summary" | "text" | "time" | "outcome" | "flag" | "result";
const CODE = /^[a-z][a-z0-9_]{0,40}$/;
// ISO date and time with a zone, as a browser's date input plus time sends it
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/;
// Free text written by staff: printable, with new lines and tabs, no other control or format characters
const plain = (s: string, max: number) => s.trim().length > 0 && s.length <= max && !/[\p{Cc}\p{Cf}]/u.test(s.replace(/[\n\r\t]/g, ""));
const valid: Record<Field, (v: unknown) => boolean> = {
  id: validId,
  kind: (v) => typeof v === "string" && CODE.test(v),
  reason: (v) => typeof v === "string" && CODE.test(v),
  summary: (v) => typeof v === "string" && plain(v, MAX_SUMMARY),
  text: (v) => typeof v === "string" && plain(v, MAX_TEXT),
  time: (v) => typeof v === "string" && TIME.test(v) && !Number.isNaN(Date.parse(v)),
  outcome: (v) => v === "cleared" || v === "strike" || v === "ban",
  flag: (v) => typeof v === "boolean",
  result: (v) => v === "upheld" || v === "overturned",
};
const TYPES: Record<string, Field> = {
  reportId: "id", caseId: "id", organisationId: "id", jobId: "id", caseKind: "kind", reasonCode: "reason", noticeSummary: "summary",
  text: "text", receivedAt: "time", outcome: "outcome", conclusive: "flag", result: "result",
};

// Each action's required and optional fields. Anything else in the body is refused.
type Spec = { need: string[]; may?: string[] };
export const REPORT_ACTIONS: Record<string, Spec> = {
  hide: { need: ["reportId"] },
  clear: { need: ["reportId"] },
  uphold: { need: ["reportId", "caseKind", "reasonCode"], may: ["noticeSummary"] },
};
export const CASE_ACTIONS: Record<string, Spec> = {
  open: { need: ["organisationId", "caseKind", "reasonCode"], may: ["jobId", "noticeSummary"] },
  notify: { need: ["caseId"] },
  record_reply: { need: ["caseId", "text", "receivedAt"] },
  decide: { need: ["caseId", "outcome"], may: ["conclusive"] },
  confirm: { need: ["caseId"] },
  refuse: { need: ["caseId"] },
  record_appeal: { need: ["caseId", "text", "receivedAt"] },
  decide_appeal: { need: ["caseId", "result"] },
  propose_ban_lift: { need: ["caseId"] },
  mark_wrc: { need: ["caseId"] },
};

export type Body = { action: string } & Record<string, string | boolean | undefined>;

/** Strict check of a POST body: a plain object, a known action, exactly that action's fields, each of the right shape. */
export function parseBody(text: string, actions: Record<string, Spec>): Body {
  if (text.length > MAX_BODY) throw new BadRequest("bad_body");
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
  for (const k of spec.need) if (b[k] === undefined) throw new BadRequest("bad_body");
  for (const k of allowed) if (k !== "action" && b[k] !== undefined && !valid[TYPES[k]!](b[k])) throw new BadRequest(`bad_${TYPES[k]}`);
  if (b.conclusive !== undefined && b.outcome !== "ban") throw new BadRequest("bad_body");
  return b as Body;
}

const STATUS = new Map<string, number>(Object.entries({
  bad_body: 400, bad_action: 400, bad_id: 400, bad_kind: 400, bad_reason: 400, bad_summary: 400, bad_text: 400, bad_time: 400, bad_outcome: 400,
  bad_flag: 400, bad_result: 400, bad_cursor: 400, bad_input: 400, bad_query: 400,
  no_session: 401, not_active: 401,
  bad_origin: 403, not_active_staff: 403, not_trust_and_safety: 403,
  not_found: 404,
  already_decided: 409, already_hidden: 409, not_a_job_report: 409, job_not_live: 409, job_not_in_organisation: 409, already_notified: 409, not_notified: 409,
  reply_window_open: 409, decision_pending: 409, other_case_pending: 409, same_person: 409, entered_reply: 409, entered_appeal: 409, decided_case: 409,
  nothing_pending: 409, nothing_to_ban: 409, no_appeal_window: 409, already_appealed: 409, no_appeal: 409, appeal_decided: 409, window_closed: 409,
  no_ban: 409, not_agency_ban: 409, already_marked: 409,
  already_attached: 409, bad_file: 400, empty_file: 400, file_too_large: 413, wrong_file_type: 415,
}));
/** The HTTP status for a refusal code; null for a code these routes do not know, which the caller turns into a plain 500. */
export const statusFor = (why: string): number | null => STATUS.get(why) ?? null;
