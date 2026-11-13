// A limit per email address on the routes that send an email (slice 2 review finding 5), on top of Better Auth's per-IP limits: someone
// with many IP addresses still cannot flood one inbox. The count lives in the pool's own rate limit table under a key made from a keyed
// hash of the lower-cased address, never the address itself. It is counted before the address is looked up, so the reply is the same
// whether the address has an account or not.
import { createHmac, randomUUID } from "node:crypto";
import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";

export const EMAIL_LIMIT = { max: 3, windowMs: 3600_000 };
// Sign-up is left out: it sends only when it makes the account, so one address gets at most one sign-up email.
export const EMAIL_LIMIT_PATHS = ["/request-password-reset", "/send-verification-email"];

// One statement, atomic under concurrent requests. last_request holds the END of the window, not the last request: Better Auth prunes
// rows whose last_request is older than its longest window (5 minutes), and an hour-long count must not be pruned early.
const consume = (table: string) =>
  `insert into ${table} as r (id, key, count, last_request) values ($1, $2, 1, $3::bigint + $4::bigint)
   on conflict (key) do update set count = case when r.last_request <= $3::bigint then 1 else r.count + 1 end,
     last_request = case when r.last_request <= $3::bigint then $3::bigint + $4::bigint else r.last_request end
   returning count`;

export const emailLimitKey = (secret: string, path: string, email: string) =>
  `email:${path}:${createHmac("sha256", secret).update(email.toLowerCase()).digest("hex")}`;

export function emailLimitPlugin(database: Pool, pool: "candidate" | "portal", secret: string): BetterAuthPlugin {
  const sql = consume(`${pool}_rate_limit`);
  return {
    id: `${pool}-email-limit`,
    hooks: {
      before: [{
        matcher: (ctx) => EMAIL_LIMIT_PATHS.includes(ctx.path ?? ""),
        handler: createAuthMiddleware(async (ctx) => {
          const email = (ctx.body as { email?: unknown } | undefined)?.email;
          if (typeof email !== "string") return; // Better Auth's own body check refuses it
          // An address is at most 254 characters (RFC 5321); a longer one is refused before it is hashed or looked up.
          if (email.length > 254) throw new APIError("BAD_REQUEST", { message: "Invalid email address.", code: "INVALID_EMAIL" });
          const { rows } = await database.query<{ count: number }>(sql, [randomUUID(), emailLimitKey(secret, ctx.path, email), Date.now(), EMAIL_LIMIT.windowMs]);
          if (rows[0]!.count > EMAIL_LIMIT.max) throw new APIError("TOO_MANY_REQUESTS", { message: "Too many requests. Please try again later." });
        }),
      }],
    },
  };
}
