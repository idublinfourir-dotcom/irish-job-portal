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
