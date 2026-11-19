// R5: the legal texts (sign-up terms for candidates, sign-up terms for employers and agencies, the privacy notice) through the panel instead of a
// command. A content editor proposes a body and a version label; an administrator who did not propose confirms, and the consent_text row is written
// in that transaction (20c: "Terms and privacy pages: CE edit, AD approve"; #104 two-person). The database stays the last guard: approval_request_guard
// (only an administrator confirms terms_privacy_page, never the proposer) and approval_check's consent_text branch (the row must use a confirmed,
// unused request naming "<purpose>:<version>"). New sign-ups consent to the newest text of their purpose (signup.ts picks the newest published_at).
// The public read of the text in force is in public-read.ts (legalRead, portalLegalRead).
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { requireRole } from "./staff-admin";
import { endRequest, inTransaction, lockRequest, PENDING_OF, propose, SET_STATUS } from "./staff-tools";
import { AUDIT } from "./trust-safety";

type Q = Pick<pg.Pool, "query">;
type Db = Pick<pg.Pool, "query" | "connect">;

export const LEGAL_PURPOSES = ["signup_terms", "portal_signup_terms", "privacy_notice"] as const;
export type LegalPurpose = (typeof LEGAL_PURPOSES)[number];
export const MAX_LEGAL_BODY = 100_000; // characters
const KIND = "terms_privacy_page";
const READERS = ["content_editor", "administrator"] as const;
const VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ctrl = /[\p{Cc}\p{Cf}]/u; // control characters and format characters (bidi marks and overrides, zero-width)

export const isLegalPurpose = (p: unknown): p is LegalPurpose => typeof p === "string" && (LEGAL_PURPOSES as readonly string[]).includes(p);
export const validVersion = (v: unknown): v is string => typeof v === "string" && VERSION.test(v);
/** Plain text: not blank, at most MAX_LEGAL_BODY characters, line breaks and tabs kept and nothing else invisible. */
export const validLegalBody = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= MAX_LEGAL_BODY && !ctrl.test(v.replace(/[\n\r\t]/g, ""));

const audit = (c: Q, staff: string, action: string, id: string, after: object, second: string | null = null) =>
  c.query(AUDIT, [staff, `legal_text.${action}`, "consent_text", id, JSON.stringify(after), null, second, null]);

// ponytail: every version with its body in one answer; legal texts change a few times a year. Add paging if a purpose ever passes a few dozen.
export const LEGAL_VERSIONS =
  "select id::text as id, purpose, version, body, published_at::text as published_at, approval_request_id::text as request_id from consent_text " +
  "where purpose = any($1::text[]) order by purpose, published_at desc, id desc";

/** Every version of each legal purpose (newest first; the first of a purpose is in force) and the proposals waiting for an administrator. */
export async function listLegal(db: Q, staff: string) {
  await requireRole(db, staff, READERS, "not_legal_staff");
  const [v, p] = await Promise.all([db.query(LEGAL_VERSIONS, [LEGAL_PURPOSES]), db.query(PENDING_OF, [KIND])]);
  return {
    versions: v.rows.map((r) => ({ id: r.id, purpose: r.purpose, version: r.version, body: r.body, publishedAt: r.published_at, requestId: r.request_id })),
    pending: p.rows.map((x) => ({ requestId: x.id, purpose: x.change.purpose, version: x.change.version, body: x.change.body, proposedBy: x.proposed_by, createdAt: x.created_at })),
  };
}

const TAKEN = "select exists (select 1 from consent_text where purpose = $1 and version = $2) as taken, " +
  "exists (select 1 from approval_request where kind = 'terms_privacy_page' and status = 'pending' and change->>'purpose' = $1) as pending";

/** A content editor proposes a new version of one purpose. Refused when the label is used, or a proposal for the purpose already waits. */
export async function proposeLegal(db: Db, staff: string, input: { purpose: unknown; version: unknown; body: unknown }): Promise<{ requestId: string }> {
  const { purpose, version, body } = input;
  if (!isLegalPurpose(purpose)) throw new QueueRefused("bad_purpose");
  if (!validVersion(version)) throw new QueueRefused("bad_version");
  if (!validLegalBody(body)) throw new QueueRefused("bad_body_text");
  return inTransaction(db, staff, ["content_editor"], "not_content_editor", async (c) => {
    const t = (await c.query<{ taken: boolean; pending: boolean }>(TAKEN, [purpose, version])).rows[0]!;
    if (t.taken) throw new QueueRefused("version_taken");
    if (t.pending) throw new QueueRefused("decision_pending");
    const requestId = await propose(c, [KIND, "consent_text", `${purpose}:${version}`, JSON.stringify({ purpose, version, body }), "legal text"]);
    await audit(c, staff, "propose", `${purpose}:${version}`, { request_id: requestId, chars: body.length });
    return { requestId };
  });
}

const PUBLISH =
  "insert into consent_text(purpose, version, body, approval_request_id) values ($1, $2, $3, $4::bigint) returning id::text as id, published_at::text as published_at";

/** An administrator who did not propose confirms: the text is published in the same transaction and new sign-ups consent to it from then on. */
export async function confirmLegal(db: Db, staff: string, requestId: unknown): Promise<{ id: string; purpose: string; version: string; publishedAt: string }> {
  return inTransaction(db, staff, ["administrator"], "not_administrator", async (c) => {
    const r = await lockRequest(c, KIND, requestId);
    if (r.proposed_by === staff) throw new QueueRefused("same_person");
    const { purpose, version, body } = r.change as { purpose: string; version: string; body: string };
    await c.query(SET_STATUS, [r.id, "confirmed"]);
    let row: { id: string; published_at: string };
    try {
      row = (await c.query(PUBLISH, [purpose, version, body, r.id])).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new QueueRefused("version_taken"); // the command line wrote that label since
      throw e;
    }
    await audit(c, staff, "confirm", `${purpose}:${version}`, { request_id: r.id, consent_text_id: row.id }, r.proposed_by);
    return { id: row.id, purpose, version, publishedAt: row.published_at };
  });
}

/** The proposer withdraws; an administrator refuses. Any other content editor is refused. */
export const refuseLegal = (db: Db, staff: string, requestId: unknown) =>
  inTransaction(db, staff, READERS, "not_legal_staff", async (c, held) => {
    const r = await lockRequest(c, KIND, requestId);
    if (r.proposed_by !== staff && !held.includes("administrator")) throw new QueueRefused("not_administrator");
    await endRequest(c, staff, KIND, r.id, "consent_text");
  });
