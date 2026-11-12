// Test helpers for the pay floor tests: a confirmed approval request written as the database owner, the way the migrations expect it
// (the proposer and the confirmer are read from `set local app.staff_user_id` and each must hold a role). Fake staff only.
import type pg from "pg";

export async function confirmedApproval(su: pg.Pool, newStaff: () => Promise<string>, kind: string, table: string, target: string | number): Promise<number> {
  const [a, b] = [await newStaff(), await newStaff()];
  for (const s of [a, b]) await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'administrator', true)", [s]);
  const c = await su.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.staff_user_id', $1, true)", [a]);
    const id = (await c.query("insert into approval_request(kind, target_table, target_id) values ($1, $2, $3) returning id", [kind, table, String(target)])).rows[0].id;
    await c.query("select set_config('app.staff_user_id', $1, true)", [b]);
    await c.query("update approval_request set status = 'confirmed' where id = $1", [id]);
    await c.query("commit");
    return Number(id);
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** Marks an organisation as on the big-company list (a confirmed, unused big_company_entry request first). */
export async function makeBig(su: pg.Pool, newStaff: () => Promise<string>, org: number | string): Promise<void> {
  await confirmedApproval(su, newStaff, "big_company_entry", "organisation", org);
  await su.query("update organisation set is_big_company = true where id = $1", [org]);
}
