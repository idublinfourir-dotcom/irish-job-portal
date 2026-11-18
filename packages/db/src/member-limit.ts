// P13: the member limit of a company (organisation.member_limit, 0013's TEAM_FULL check). An account reviewer or an administrator sets it from 1 to MAX_MEMBER_LIMIT,
// never below the company's active members, with a reason code. The role check, the bounds and the audit row are in private.member_limit_set (migration 0031).
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { companyRefusal } from "./merges";
import { validId } from "./search";

export const MAX_MEMBER_LIMIT = 50; // the hard maximum, also the column's check
const REASON = /^[a-z][a-z0-9_]{0,62}$/; // a reason code, never free text (#182)

/** True when `n` is a whole number from 1 to MAX_MEMBER_LIMIT. */
export const validLimit = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_MEMBER_LIMIT;

/** Refusals: bad_input, bad_limit, bad_reason, not_active_staff, not_limit_staff, not_found, below_active. */
export async function setMemberLimit(db: Pick<pg.Pool, "query">, staff: string, organisationId: string, limit: number, reason: string) {
  if (!validId(organisationId)) throw new QueueRefused("bad_input");
  if (!validLimit(limit)) throw new QueueRefused("bad_limit");
  if (!REASON.test(reason)) throw new QueueRefused("bad_reason");
  try {
    const r = (await db.query<{ r: { organisationId: number; memberLimit: number; activeMembers: number } }>(
      "select private.member_limit_set($1, $2::bigint, $3::integer, $4) r", [staff, organisationId, limit, reason])).rows[0]!.r;
    return { organisationId: String(r.organisationId), memberLimit: r.memberLimit, activeMembers: r.activeMembers };
  } catch (e) {
    return companyRefusal(e);
  }
}
