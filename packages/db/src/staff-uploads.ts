// Staff uploads (step 15 staff tools C, audit rows Q6 and Q7), run as app_admin on the file store of the storage wave (#240: files.ts, the same limits,
// memoryStore() in tests). Every call checks the acting member's roles in the database first (STAFF_WHO also sets app.staff_user_id, as the guards
// expect), and checks the role and the target again before the upload body is read. Each stored file is removed when its row write fails.
//   Q6 "Sponsor confirmed" on a manual post (#16, 20c "Manual posting": the account reviewer edits, the administrator approves): the account reviewer
//      uploads the employer's written confirmation on a live manual post, which makes an approval_request (manual_post_sponsor_confirmed, target
//      sponsorship_statement/<job id>, change: the stored file). A different administrator reads the file and confirms: in one transaction the request is
//      confirmed and used once (approval_check on the statement insert), the admin_on_behalf statement is written with the file key, and the badge becomes
//      sponsor_confirmed. No signer: staff never sign for the employer. Refused (an administrator) or withdrawn (the proposer), the stored file is removed.
//   Q7 evidence on a report or a strike case (trust_and_safety only, #91, #99): one stored file each, set only while empty and while the report is open
//      or the case's appeal is not decided; it follows the row's retention (rules 21 to 23 return the key, 0052).
//   B66 evidence for a pay-deal entry of the rules data (a rules data editor uploads; proposeRules puts the file on an entry, two people as any rules change): key
//      `rules/<uuid>.<ext>`, its audit row holding the name. ponytail: a file no version names stays in the store (the business record rule keeps them); a sweep of
//      rules/ ids no version or pending request names would clear them.
// Opening any of these files answers the file itself through the admin route once the malware scan passed (files.ts staffFileView, S-Q6), with
// one data_access audit row, as the written authority (job-queues.ts).
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { keyKind } from "./file-check";
import { staffFileView, storeStaffDocument } from "./files";
import { fileStore } from "./file-store";
import { MANUAL_VIEWERS } from "./manual-posting";
import { EVIDENCE_FILE } from "./rules-data";
import { validId } from "./search";
import { endRequest, inTransaction, lockRequest, propose, SET_STATUS } from "./staff-tools";
import { AUDIT } from "./trust-safety";

type Db = Pick<pg.Pool, "query" | "connect">;
const audit = (c: pg.PoolClient, staff: string, action: string, type: string, id: string, after: object, second: string | null = null, caseId: string | null = null) =>
  c.query(AUDIT, [staff, action, type, id, JSON.stringify(after), null, second, caseId]);
const OPENED =
  "insert into audit_event(kind, actor_staff_user_id, role_in_force, action, object_type, object_id, after, source) values ('data_access', $1, $2, $3, $4, $5, $6::jsonb, 'panel')";
const viewOf = (key: string, name: string) => staffFileView(key, keyKind(key) ?? "unknown", `${name}.${key.split(".").pop()}`);
const removeLater = (key: unknown) => {
  if (typeof key === "string") fileStore().remove(key).catch(() => console.error("staff upload: stored file not removed, the weekly orphan sweep removes it"));
};

// ===== Q6: the employer's written confirmation on a manual post =====
export const SPONSOR_KIND = "manual_post_sponsor_confirmed";
export const SPONSOR_PROPOSERS = ["account_reviewer"] as const;
const SPONSOR_JOB =
  "select j.status, j.badge, coalesce(o.restricted_until > now(), false) as restricted from job j join organisation o on o.id = j.organisation_id " +
  "where j.id = $1::bigint and j.source = 'admin_manual'";
const TEXT = "select id from consent_text where purpose = 'sponsorship_statement' order by published_at desc, id desc limit 1";
const STATEMENT =
  "insert into sponsorship_statement(job_id, organisation_id, kind, consent_text_id, confirmation_file_key, entered_by_staff_id, approval_request_id) " +
  "select id, organisation_id, 'admin_on_behalf', $2::bigint, $3, $4, $5::bigint from job where id = $1::bigint";
const PENDING_FOR = "select 1 from approval_request where kind = $1 and target_table = 'sponsorship_statement' and target_id = $2 and status = 'pending'";
const BADGE = "update job set badge = 'sponsor_confirmed' where id = $1::bigint";
const SPONSOR_FILE =
  "select a.change->>'key' as key from approval_request a where a.id = $1::bigint and a.kind = 'manual_post_sponsor_confirmed' " +
  "and (a.status = 'pending' or exists (select 1 from sponsorship_statement s where s.approval_request_id = a.id))";

/** A live manual post that does not show Sponsor confirmed and whose company is not restricted; `lock` locks the job for the write. */
async function sponsorable(c: pg.PoolClient, jobId: string, lock = ""): Promise<void> {
  const j = (await c.query<{ status: string; badge: string | null; restricted: boolean }>(SPONSOR_JOB + lock, [jobId])).rows[0];
  if (!j) throw new QueueRefused("not_found");
  if (j.badge === "sponsor_confirmed") throw new QueueRefused("already_confirmed");
  if (j.status !== "live") throw new QueueRefused("job_not_live");
  if (j.restricted) throw new QueueRefused("company_restricted");
}

/** The account reviewer uploads the confirmation (multipart, field `file`) on a manual post. Refusals: not_found, already_confirmed, job_not_live, company_restricted, decision_pending, and the file codes. */
export async function proposeSponsorConfirmation(db: Db, staff: string, jobId: unknown, request: Request): Promise<{ requestId: string }> {
  if (!validId(jobId)) throw new QueueRefused("bad_input");
  const ar = (fn: (c: pg.PoolClient) => Promise<unknown>) => inTransaction(db, staff, SPONSOR_PROPOSERS, "not_account_reviewer", fn);
  await ar(async (c) => {
    await sponsorable(c, jobId);
    if ((await c.query(PENDING_FOR, [SPONSOR_KIND, jobId])).rowCount) throw new QueueRefused("decision_pending"); // before the body is read; propose checks again
  });
  return storeStaffDocument(request, "sponsor", (d) => inTransaction(db, staff, SPONSOR_PROPOSERS, "not_account_reviewer", async (c) => {
    await sponsorable(c, jobId, " for share of j");
    const requestId = await propose(c, [SPONSOR_KIND, "sponsorship_statement", jobId, JSON.stringify(d), "manual post sponsor confirmed"]);
    await audit(c, staff, "job.sponsor_confirmation_propose", "job", jobId, { request_id: requestId, content_type: d.contentType, size_bytes: d.sizeBytes });
    return { requestId };
  }));
}

export const SPONSOR_PENDING =
  "select a.id::text as id, a.target_id, a.change, a.proposed_by_staff_user_id as proposed_by, u.name as proposed_by_name, a.created_at::text as created_at, j.title, o.id::text as org, o.display_name " +
  "from approval_request a join job j on j.id = a.target_id::bigint join organisation o on o.id = j.organisation_id left join staff_user u on u.id = a.proposed_by_staff_user_id " +
  "where a.kind = 'manual_post_sponsor_confirmed' and a.target_table = 'sponsorship_statement' and a.status = 'pending' order by a.id limit 200";
export type SponsorPending = {
  requestId: string; jobId: string; title: string; organisationId: string; displayName: string; fileName: string; contentType: string; sizeBytes: number;
  proposedBy: string; proposedByName: string | null; createdAt: string;
};
/** The confirmations waiting for an administrator (the manual posting viewers: account reviewer, trust and safety, administrator). */
export async function listSponsorConfirmations(db: Db, staff: string): Promise<{ pending: SponsorPending[] }> {
  return inTransaction(db, staff, MANUAL_VIEWERS, "not_manual_viewer", async (c) => {
    const p = await c.query(SPONSOR_PENDING);
    return { pending: p.rows.map((x) => ({ requestId: x.id, jobId: x.target_id, title: x.title, organisationId: x.org, displayName: x.display_name, fileName: String(x.change.fileName), contentType: String(x.change.contentType),
      sizeBytes: Number(x.change.sizeBytes), proposedBy: x.proposed_by, proposedByName: x.proposed_by_name, createdAt: x.created_at })) };
  });
}

/** The confirmation file of a pending or confirmed request, with its data_access audit row; null when there is none. scan_pending, file_blocked. */
export async function openSponsorConfirmation(db: Db, staff: string, requestId: unknown): Promise<Response | null> {
  return inTransaction(db, staff, MANUAL_VIEWERS, "not_manual_viewer", async (c, held) => {
    const key = validId(requestId) ? (await c.query<{ key: string | null }>(SPONSOR_FILE, [requestId])).rows[0]?.key : undefined;
    if (!key) return null;
    const file = await viewOf(key, "confirmation");
    await c.query(OPENED, [staff, MANUAL_VIEWERS.find((r) => held.includes(r)), "job.sponsor_confirmation_open", "approval_request", requestId, "{}"]);
    return file;
  });
}

/** A different administrator confirms: the statement is written and the job shows Sponsor confirmed. Refusals: not_found, request_not_pending, same_person, the job's, no_statement_text. */
export async function confirmSponsorConfirmation(db: Db, staff: string, requestId: unknown): Promise<{ jobId: string; badge: "sponsor_confirmed" }> {
  return inTransaction(db, staff, ["administrator"], "not_administrator", async (c) => {
    const r = await lockRequest(c, SPONSOR_KIND, requestId);
    if (r.proposed_by === staff) throw new QueueRefused("same_person");
    await sponsorable(c, r.target_id, " for update of j");
    const text = (await c.query<{ id: string }>(TEXT)).rows[0];
    if (!text) throw new QueueRefused("no_statement_text");
    await c.query(SET_STATUS, [r.id, "confirmed"]);
    await c.query(STATEMENT, [r.target_id, text.id, r.change.key, r.proposed_by, r.id]); // approval_check uses the request once
    await c.query(BADGE, [r.target_id]);
    await audit(c, staff, "job.sponsor_confirmed", "job", r.target_id, { request_id: r.id }, r.proposed_by);
    return { jobId: r.target_id, badge: "sponsor_confirmed" };
  });
}

/** An administrator refuses, or the proposer withdraws; the stored file is removed after the commit. */
export async function refuseSponsorConfirmation(db: Db, staff: string, requestId: unknown): Promise<void> {
  const key = await inTransaction(db, staff, ["account_reviewer", "administrator"], "not_sponsor_staff", async (c, held) => {
    const r = await lockRequest(c, SPONSOR_KIND, requestId);
    if (r.proposed_by !== staff && !held.includes("administrator")) throw new QueueRefused("not_administrator");
    await endRequest(c, staff, SPONSOR_KIND, r.id, "job");
    return r.change.key;
  });
  removeLater(key);
}

// ===== Q7: evidence on a report or a strike case =====
export type EvidenceOn = "report" | "strike";
const EVIDENCE: Record<EvidenceOn, { state: string; set: string; key: string }> = {
  report: {
    state: "select evidence_storage_key is not null as has, status in ('open','job_hidden') as open from report where id = $1::bigint",
    set: "update report set evidence_storage_key = $2 where id = $1::bigint and evidence_storage_key is null and status in ('open','job_hidden')",
    key: "select evidence_storage_key as key from report where id = $1::bigint",
  },
  strike: {
    state: "select evidence_storage_key is not null as has, stage not in ('upheld','overturned') as open from strike where id = $1::bigint",
    set: "update strike set evidence_storage_key = $2 where id = $1::bigint and evidence_storage_key is null and stage not in ('upheld','overturned')",
    key: "select evidence_storage_key as key from strike where id = $1::bigint",
  },
};
const ts = <T>(db: Db, staff: string, fn: (c: pg.PoolClient) => Promise<T>) => inTransaction(db, staff, ["trust_and_safety"], "not_trust_and_safety", fn);
async function attachable(c: pg.PoolClient, on: EvidenceOn, id: string): Promise<void> {
  const s = (await c.query<{ has: boolean; open: boolean }>(EVIDENCE[on].state, [id])).rows[0];
  if (!s) throw new QueueRefused("not_found");
  if (s.has) throw new QueueRefused("already_attached");
  if (!s.open) throw new QueueRefused("already_decided");
}

/** Trust and safety attach the one evidence file (multipart, field `file`). Refusals: not_found, already_attached, already_decided, and the file codes. */
export async function attachEvidence(db: Db, staff: string, on: EvidenceOn, id: unknown, request: Request): Promise<{ contentType: string; sizeBytes: number }> {
  if (!validId(id)) throw new QueueRefused("not_found");
  await ts(db, staff, (c) => attachable(c, on, id));
  return storeStaffDocument(request, "evidence", (d) => ts(db, staff, async (c) => {
    if (!(await c.query(EVIDENCE[on].set, [id, d.key])).rowCount) await attachable(c, on, id); // lost a race, or the state moved: the reason
    await audit(c, staff, "trust_safety.evidence_attach", on, id, { content_type: d.contentType, size_bytes: d.sizeBytes }, null, on === "strike" ? `strike:${id}` : null);
    return { contentType: d.contentType, sizeBytes: d.sizeBytes };
  }));
}

/** The evidence file, with its data_access audit row; null when the row or its file does not exist. scan_pending, file_blocked. */
export async function openEvidence(db: Db, staff: string, on: EvidenceOn, id: unknown): Promise<Response | null> {
  if (!validId(id)) return null;
  return ts(db, staff, async (c) => {
    const key = (await c.query<{ key: string | null }>(EVIDENCE[on].key, [id])).rows[0]?.key;
    if (!key) return null;
    const file = await viewOf(key, "evidence");
    await c.query(OPENED, [staff, "trust_and_safety", "trust_safety.evidence_open", on, id, "{}"]);
    return file;
  });
}

// ===== B66: evidence for a pay-deal entry (rules data) =====
// 20c "Public pay-deal employer list": every staff role views it but the content editor.
export const RULES_EVIDENCE_VIEWERS = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "administrator"] as const;

/** A rules data editor uploads one evidence file (multipart, field `file`); its id then goes on an entry through proposeRules. The file codes. */
export async function uploadRulesEvidence(db: Db, staff: string, request: Request): Promise<{ file: { id: string; name: string }; contentType: string; sizeBytes: number }> {
  const editor = <T>(fn: (c: pg.PoolClient) => Promise<T>) => inTransaction(db, staff, ["rules_data_editor"], "not_rules_editor", fn);
  await editor(async () => {}); // before the body is read
  return storeStaffDocument(request, "rules", (d) => editor(async (c) => {
    const id = d.key.slice("rules/".length);
    await audit(c, staff, "rules.evidence_upload", "rules_evidence", id, { file_name: d.fileName, content_type: d.contentType, size_bytes: d.sizeBytes });
    return { file: { id, name: d.fileName }, contentType: d.contentType, sizeBytes: d.sizeBytes };
  }));
}

/** One evidence file, with its data_access audit row; null for an id that is not one (the id is the whole name under rules/, so it reaches no other file). scan_pending, file_blocked. */
export async function openRulesEvidence(db: Db, staff: string, id: unknown): Promise<Response | null> {
  return inTransaction(db, staff, RULES_EVIDENCE_VIEWERS, "not_rules_viewer", async (c, held) => {
    if (typeof id !== "string" || !EVIDENCE_FILE.test(id)) return null;
    const file = await viewOf(`rules/${id}`, "evidence");
    await c.query(OPENED, [staff, RULES_EVIDENCE_VIEWERS.find((r) => held.includes(r)), "rules.evidence_open", "rules_evidence", id, "{}"]);
    return file;
  });
}
