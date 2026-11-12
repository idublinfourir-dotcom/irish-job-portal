// The tests build each pool from the real package, packages/auth (createAuth), with a fake secret and a fake
// mail sender. Fake users only.
import type { Pool } from "pg";
import { createAuth, type EmailKind, type LoginPool } from "../../auth/src";

// verification and reset links Better Auth would have emailed
export const mail: { pool: LoginPool; kind: EmailKind; email: string; url: string }[] = [];
export function makeAuth(name: LoginPool, database: Pool) {
  return createAuth(name, {
    database,
    baseURL: "http://localhost:3000",
    secret: "trial-only-secret-trial-only-secret-32",
    sendEmail: async (pool, kind, email, url) => { mail.push({ pool, kind, email, url }); },
  });
}

// Candidate sign-up needs the three answers and a saved signup_terms text (step 7 slice 2). Tests that sign candidates up
// call seedSignupTerms(superuserPool) once and add `answers` to the body.
export const answers = { needsPermit: true, over18: true, acceptsTerms: true };
export async function seedSignupTerms(su: Pool): Promise<void> {
  const c = await su.connect();
  try {
    await c.query("begin");
    for (const [id, role] of [["terms-proposer", "content_editor"], ["terms-confirmer", "administrator"]] as const) {
      await c.query("insert into staff_user(id,name,email,email_verified) values($1,'Fake Staff',$2,true)", [id, `${id}@example.test`]);
      await c.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,$2,true)", [id, role]);
    }
    await c.query("select set_config('app.staff_user_id', 'terms-proposer', true)");
    const { rows } = await c.query("insert into approval_request(kind,target_table,target_id) values ('terms_privacy_page','consent_text','signup_terms:test') returning id");
    await c.query("select set_config('app.staff_user_id', 'terms-confirmer', true)");
    await c.query("update approval_request set status='confirmed' where id=$1", [rows[0].id]);
    await c.query("insert into consent_text(purpose,version,body,approval_request_id) values ('signup_terms','test','Test text',$1)", [rows[0].id]);
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
