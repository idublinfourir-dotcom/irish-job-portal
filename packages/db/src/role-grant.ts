// The two halves of a role grant under the two-person rule (#136 c, #137 b), shared by the owner's command (role-grant-cli.ts) and the admin staff route
// (staff-admin.ts). Both run inside a transaction the caller opened. No imports besides the pg type, so the command can load this file directly with node.
import type pg from "pg";

/** The proposer's half, inside an open transaction: one pending request that names the role. Returns the request id. */
export async function proposeGrant(client: pg.ClientBase, proposer: string, staff: string, role: string, reason = "role grant by command"): Promise<string> {
  const kind = role === "administrator" ? "grant_administrator" : "grant_role";
  await client.query("select set_config('app.staff_user_id', $1, true)", [proposer]);
  return (await client.query(
    "insert into approval_request(kind, target_table, target_id, change, reason) values ($1, 'staff_role', $2, $3::jsonb, $4) returning id",
    [kind, staff, JSON.stringify({ role }), reason],
  )).rows[0].id as string;
}

/** The confirmer's half, inside an open transaction: confirms the request, writes the role (the database checks the request is used once) and one audit row. */
export async function confirmGrant(client: pg.ClientBase, i: { confirmer: string; proposer: string; staff: string; role: string; request: string }): Promise<void> {
  await client.query("select set_config('app.staff_user_id', $1, true)", [i.confirmer]);
  await client.query("update approval_request set status='confirmed' where id=$1", [i.request]);
  const row = (await client.query(
    "insert into staff_role(staff_user_id, role, granted_by_staff_user_id, approval_request_id) values ($1,$2,$3,$4) returning id", [i.staff, i.role, i.confirmer, i.request])).rows[0].id as string;
  await client.query(
    "insert into audit_event(kind, actor_staff_user_id, second_staff_user_id, action, object_type, object_id, after, source) values ('admin_action', $1, $2, 'staff.role_grant', 'staff_role', $3, $4::jsonb, 'panel')",
    [i.confirmer, i.proposer, row, JSON.stringify({ role: i.role, approvalRequestId: i.request })]);
}
