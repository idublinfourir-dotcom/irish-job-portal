// M4: the staff view of a services case's stored copies (S-Q6, S-Q8 A, S-Q11 B), run as app_admin. Only a services_case_handler ASSIGNED to the
// case (services_case.assigned_staff_user_id) lists or opens them; every other role is refused, administrator included (S-Q11 B: an administrator
// may reassign a case, not read its documents). A handler whose staff email is the requester's account email is refused too (20c:231: never
// one's own case). The list is metadata only; each open is the file itself through files.ts staffFileView (scan gate, fixed type, nosniff,
// no-store) and one data_access audit row with reason services_case and the case id, codes and ids only, in the same transaction.
import type pg from "pg";
import { QueueRefused } from "./admin-queue";
import { staffFileView } from "./files";
import { validId } from "./search";
import { inTransaction } from "./staff-tools";

type Db = Pick<pg.Pool, "query" | "connect">;
export const CASE_HANDLER = ["services_case_handler"] as const;
export const CASE_FILES_SQL = {
  // one row: is it assigned to this member, and is it the member's own case (the requester's address on either side)
  case: `select c.assigned_staff_user_id = $2 as assigned,
      exists (select 1 from staff_user s where s.id = $2 and lower(s.email) in (
        select lower(email) from candidate_user where id = c.candidate_user_id union all select lower(email) from portal_user where id = c.portal_user_id)) as own
    from services_case c where c.id = $1::bigint`,
  list: `select id::text as id, file_name as "fileName", content_type as "contentType", byte_size as "sizeBytes", uploaded_at as "uploadedAt",
      copy_deleted_at is not null as "copyDeleted",
      case when candidate_user_id is not null then 'candidate' when portal_user_id is not null then 'portal' when staff_user_id is not null then 'staff' else 'gone' end as "uploadedBy"
    from case_document where services_case_id = $1::bigint order by id`,
  one: "select storage_key, file_name, content_type from case_document where id = $2::bigint and services_case_id = $1::bigint and storage_key is not null",
  audit: "insert into audit_event(kind, actor_staff_user_id, role_in_force, action, object_type, object_id, reason_code, related_case, source) " +
    "values ('data_access', $1, 'services_case_handler', 'case_document.open', 'case_document', $2, 'services_case', $3, 'panel')",
};
export type CaseDocument = { id: string; fileName: string | null; contentType: string | null; sizeBytes: number | null; uploadedAt: string; copyDeleted: boolean; uploadedBy: string };

/** The handler's own assigned case, or a refusal: case_not_found (also a case assigned to someone else, so nothing is told), own_case. */
async function handled(c: pg.PoolClient, staff: string, caseId: unknown): Promise<string> {
  if (!validId(caseId)) throw new QueueRefused("bad_id");
  const r = (await c.query<{ assigned: boolean | null; own: boolean }>(CASE_FILES_SQL.case, [caseId, staff])).rows[0];
  if (!r?.assigned) throw new QueueRefused("case_not_found");
  if (r.own) throw new QueueRefused("own_case");
  return caseId;
}

/** The case's copies (metadata only, every side's, removed copies marked). */
export async function listCaseDocuments(db: Db, staff: string, caseId: unknown): Promise<{ documents: CaseDocument[] }> {
  return inTransaction(db, staff, CASE_HANDLER, "not_case_handler", async (c) => {
    const id = await handled(c, staff, caseId);
    return { documents: (await c.query<CaseDocument>(CASE_FILES_SQL.list, [id])).rows };
  });
}

/** One stored copy of the case, then its data_access row. document_not_found for a copy of another case or a removed copy; scan_pending, file_blocked. */
export async function openCaseDocument(db: Db, staff: string, caseId: unknown, docId: unknown): Promise<Response> {
  return inTransaction(db, staff, CASE_HANDLER, "not_case_handler", async (c) => {
    const id = await handled(c, staff, caseId);
    if (!validId(docId)) throw new QueueRefused("bad_id");
    const d = (await c.query<{ storage_key: string; file_name: string; content_type: string }>(CASE_FILES_SQL.one, [id, docId])).rows[0];
    if (!d) throw new QueueRefused("document_not_found");
    const file = await staffFileView(d.storage_key, d.content_type, d.file_name);
    await c.query(CASE_FILES_SQL.audit, [staff, docId, `services_case:${id}`]);
    return file;
  });
}
