// A company's email domains (Q13, #186): staff list, add and remove them outside the approve step.
// Why it matters: claim_organisation verifies a claim with no staff review when the claimant's confirmed email domain is one of the company's
// organisation_domain rows and no other company's, so a wrong domain hands the company to a stranger. Every domain passes domainProblem (domain-check.ts). The file seed is domain-seed.ts.
// Run as app_admin. The staff functions check, in their first statement, that the person is active staff with account_reviewer or administrator.
import type pg from "pg";
import { DOMAIN_LOCK, domainProblem, REASON } from "./account-review";
import { QueueRefused } from "./admin-queue";
import { inOneTransaction } from "./dete";
import { validId } from "./search";
import { NEEDS_ACTION } from "./trust-safety";

type Db = Pick<pg.Pool, "query" | "connect">;

/** A domain another company already has: the refusal names that company, so staff can see which one. */
export class DomainTaken extends QueueRefused {
  constructor(readonly owner: { organisationId: string; displayName: string }) {
    super("domain_owned_by_other");
  }
}

export const DOMAIN_ROLES = ["account_reviewer", "administrator"];
// One statement: sets the acting id for the transaction and answers both questions.
export const DOMAIN_ACT =
  "select set_config('app.staff_user_id', $1, true), exists (select 1 from staff_user where id = $1 and status = 'active') as active, " +
  "exists (select 1 from staff_user u join staff_role r on r.staff_user_id = u.id where u.id = $1 and u.status = 'active' and r.role = any($2::text[])) as allowed";

async function check(q: Pick<pg.Pool, "query">, staff: string): Promise<void> {
  if (typeof staff !== "string" || staff.length === 0 || staff.length > 200) throw new QueueRefused("not_active_staff");
  const r = (await q.query<{ active: boolean; allowed: boolean }>(DOMAIN_ACT, [staff, DOMAIN_ROLES])).rows[0]!;
  if (!r.active) throw new QueueRefused("not_active_staff");
  if (!r.allowed) throw new QueueRefused("not_domain_staff");
}

export type DomainRow = { id: string; domain: string; source: string; addedBy: string | null; createdAt: string };
export const DOMAIN_LIST =
  "select o.id::text as org, d.id::text, d.domain, d.source, d.added_by_staff_id as added_by, d.created_at::text as created_at " +
  "from organisation o left join organisation_domain d on d.organisation_id = o.id where o.id = $1::bigint order by d.domain";

/** The company's domains, by name. not_found when there is no such company. */
export async function listDomains(db: Pick<pg.Pool, "query">, staff: string, organisationId: string): Promise<DomainRow[]> {
  if (!validId(organisationId)) throw new QueueRefused("bad_organisation_id");
  await check(db, staff);
  const rows = (await db.query(DOMAIN_LIST, [organisationId])).rows;
  if (rows.length === 0) throw new QueueRefused("not_found");
  return rows.filter((r) => r.id !== null).map((r) => ({ id: r.id, domain: r.domain, source: r.source, addedBy: r.added_by, createdAt: r.created_at }));
}

async function acting<T>(db: Db, staff: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return inOneTransaction(db, async (c) => {
    await check(c, staff);
    return fn(c);
  });
}

const ORG_LOCK = "select merged_into_id is not null as merged from organisation where id = $1::bigint for update";
async function lockOrg(c: pg.PoolClient, organisationId: string): Promise<void> {
  const o = (await c.query<{ merged: boolean }>(ORG_LOCK, [organisationId])).rows[0];
  if (!o) throw new QueueRefused("not_found");
  if (o.merged) throw new QueueRefused("company_merged");
}

function checkInput(organisationId: string, domain: unknown, reason: unknown): string {
  if (!validId(organisationId)) throw new QueueRefused("bad_organisation_id");
  const why = domainProblem(domain);
  if (why) throw new QueueRefused(why);
  if (typeof reason !== "string" || !REASON.test(reason)) throw new QueueRefused("bad_reason");
  return domain as string;
}

export const DOMAIN_OWNER =
  "select o.id::text as organisation_id, o.display_name from organisation_domain d join organisation o on o.id = d.organisation_id where d.domain = $1 and d.organisation_id <> $2::bigint limit 1";
// The row and its audit row in one statement (#182: codes and the domain only, no free text). Nothing is written when the company has it already.
export const DOMAIN_INSERT =
  "with d as (insert into organisation_domain(organisation_id, domain, source, added_by_staff_id) values ($1::bigint, $2, 'admin', $3) " +
  "on conflict (organisation_id, domain) do nothing returning id) " +
  "insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, after, reason_code, source) " +
  "select 'admin_action', $3, 'organisation_domain.add', 'organisation', $1::text, '{domain}', jsonb_build_object('domain', $2::text, 'source', 'admin'), $4, 'panel' from d returning id";

/** Adds a domain (source admin). Refused: a bad or free-mail domain, a domain another company has (DomainTaken), one the company has already. */
export async function addDomain(db: Db, staff: string, organisationId: string, domain: unknown, reason: unknown): Promise<{ domain: string }> {
  const d = checkInput(organisationId, domain, reason);
  return acting(db, staff, async (c) => {
    await lockOrg(c, organisationId);
    await c.query(DOMAIN_LOCK, [d]); // the approve step takes the same lock, so two writers of one domain never both pass the check below
    const other = (await c.query<{ organisation_id: string; display_name: string }>(DOMAIN_OWNER, [d, organisationId])).rows[0];
    if (other) throw new DomainTaken({ organisationId: other.organisation_id, displayName: other.display_name });
    if ((await c.query(DOMAIN_INSERT, [organisationId, d, staff, reason])).rowCount !== 1) throw new QueueRefused("already_added");
    return { domain: d };
  });
}

// An open case (undecided, a decision or ban waiting for its second person, or an appeal waiting) opened after the domain was added: its ban would take
// that domain (ban_matches_case and BAN_DOMAINS read the domains from before the case opened), so removing it now would let the company slip the ban.
export const DOMAIN_IN_CASE =
  "select exists (select 1 from organisation_domain d join strike s on s.organisation_id = d.organisation_id " +
  `where d.organisation_id = $1::bigint and d.domain = $2 and d.created_at < s.created_at and ${NEEDS_ACTION}) as held`;
export const DOMAIN_DELETE =
  "with d as (delete from organisation_domain where organisation_id = $1::bigint and domain = $2 returning source, created_at) " +
  "insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, reason_code, source) " +
  "select 'admin_action', $3, 'organisation_domain.remove', 'organisation', $1::text, '{domain}', " +
  "jsonb_build_object('domain', $2::text, 'source', d.source, 'created_at', d.created_at), $4, 'panel' from d returning id";

/** Removes a domain. Refused while an open case would ban it (open_ban_case), and for a domain the company does not have (domain_not_found). */
export async function removeDomain(db: Db, staff: string, organisationId: string, domain: unknown, reason: unknown): Promise<{ domain: string }> {
  if (typeof domain !== "string" || domain.length > 253) throw new QueueRefused("bad_domain"); // no free-mail check: an old row must stay removable
  if (!validId(organisationId)) throw new QueueRefused("bad_organisation_id");
  if (typeof reason !== "string" || !REASON.test(reason)) throw new QueueRefused("bad_reason");
  return acting(db, staff, async (c) => {
    await lockOrg(c, organisationId);
    if ((await c.query<{ held: boolean }>(DOMAIN_IN_CASE, [organisationId, domain])).rows[0]!.held) throw new QueueRefused("open_ban_case");
    if ((await c.query(DOMAIN_DELETE, [organisationId, domain, staff, reason])).rowCount !== 1) throw new QueueRefused("domain_not_found");
    return { domain };
  });
}
