// An owner who cannot be reached (step 13 part 13c; #234 D6, 20b "Account owner leaves"). An account reviewer records a member's request to become the account
// owner after checking the company domain and the CRO number; the old owner gets a notice in the outbox; after 7 days an account reviewer completes it (the old
// owner becomes a recruiter and keeps the signer switch, as the owner's own transfer does); any account reviewer may cancel it. One open request per company.
// The work is three database functions (migration 0022) that check the role themselves and make every membership write (#184); these wrappers give the codes.
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { companyRefusal } from "./merges";
import { PAGE_SIZE, validId } from "./search";
import { decodeIdCursor, encodeIdCursor } from "./wire";

type Q = Pick<pg.Pool, "query">;
export const REASSIGN_WAIT_DAYS = 7;

export type Requested = { requestId: string; organisationId: string; completesAfter: string };

/** Records the request. Both ticks must be exactly `true`. Refusals: not_active_staff, not_account_reviewer, not_checked, member_not_found, already_owner, company_not_open, no_owner, user_not_active, request_open. */
export async function requestOwnerReassign(db: Q, staff: string, membershipId: string, checks: { domainChecked: boolean; croChecked: boolean }): Promise<Requested> {
  if (!validId(membershipId)) throw new QueueRefused("bad_input");
  try {
    const r = (await db.query<{ r: { requestId: number; organisationId: number; completesAfter: string } }>(
      "select private.owner_reassign_request($1, $2::bigint, $3::boolean, $4::boolean) r", [staff, membershipId, checks.domainChecked === true, checks.croChecked === true])).rows[0]!.r;
    return { requestId: String(r.requestId), organisationId: String(r.organisationId), completesAfter: r.completesAfter };
  } catch (e) {
    return companyRefusal(e);
  }
}

/** Completes a request after its 7 days. Refusals: not_found, not_open, too_early, company_not_open, owner_changed, member_gone, user_not_active (and the role codes). */
export async function completeOwnerReassign(db: Q, staff: string, requestId: string): Promise<{ requestId: string; organisationId: string; ownerMembershipId: string }> {
  if (!validId(requestId)) throw new QueueRefused("bad_input");
  try {
    const r = (await db.query<{ r: { requestId: number; organisationId: number; ownerMembershipId: number } }>("select private.owner_reassign_complete($1, $2::bigint) r", [staff, requestId])).rows[0]!.r;
    return { requestId: String(r.requestId), organisationId: String(r.organisationId), ownerMembershipId: String(r.ownerMembershipId) };
  } catch (e) {
    return companyRefusal(e);
  }
}

/** Cancels an open request. Refusals: not_found, not_open (and the role codes). */
export async function cancelOwnerReassign(db: Q, staff: string, requestId: string): Promise<{ requestId: string }> {
  if (!validId(requestId)) throw new QueueRefused("bad_input");
  try {
    const r = (await db.query<{ r: { requestId: number } }>("select private.owner_reassign_cancel($1, $2::bigint) r", [staff, requestId])).rows[0]!.r;
    return { requestId: String(r.requestId) };
  } catch (e) {
    return companyRefusal(e);
  }
}

// The open requests, oldest first, for account reviewers only: the list shows the two people's emails (like the account review list shows the claimant's).
const LIST =
  "select r.id::text as id, r.organisation_id::text as organisation_id, o.display_name, r.new_owner_membership_id::text as new_owner_membership_id, nu.email as new_owner_email, " +
  "r.old_owner_membership_id::text as old_owner_membership_id, ou.email as old_owner_email, r.requested_by_staff_user_id, r.requested_at::text as requested_at, " +
  "r.completes_after::text as completes_after, r.completes_after <= now() as can_complete " +
  "from owner_reassign r join organisation o on o.id = r.organisation_id " +
  "join membership nm on nm.id = r.new_owner_membership_id join portal_user nu on nu.id = nm.portal_user_id " +
  "join membership om on om.id = r.old_owner_membership_id left join portal_user ou on ou.id = om.portal_user_id where r.status = 'open'";
export const OWNER_LIST_FIRST = `${LIST} order by r.id limit ${PAGE_SIZE + 1}`;
export const OWNER_LIST_AFTER = `${LIST} and r.id > $1::bigint order by r.id limit ${PAGE_SIZE + 1}`;
export type OpenRequest = {
  id: string; organisation_id: string; display_name: string; new_owner_membership_id: string; new_owner_email: string; old_owner_membership_id: string;
  old_owner_email: string | null; requested_by_staff_user_id: string; requested_at: string; completes_after: string; can_complete: boolean;
};

export async function listOwnerReassigns(db: Q, staff: string, opts: { after?: string } = {}): Promise<{ items: OpenRequest[]; next: string | null }> {
  const after = opts.after === undefined ? undefined : decodeIdCursor("owner_reassign", opts.after);
  try {
    await db.query("select private.companies_staff_check($1, array['account_reviewer'], 'NOT_ACCOUNT_REVIEWER')", [staff]);
  } catch (e) {
    return companyRefusal(e);
  }
  const all = (after === undefined ? await db.query<OpenRequest>(OWNER_LIST_FIRST) : await db.query<OpenRequest>(OWNER_LIST_AFTER, [after])).rows;
  const rows = all.slice(0, PAGE_SIZE);
  return { items: rows, next: all.length > PAGE_SIZE ? encodeIdCursor("owner_reassign", rows.at(-1)!.id) : null };
}
