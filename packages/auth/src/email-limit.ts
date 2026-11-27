// A limit per email address on the routes that send an email (slice 2 review finding 5), on top of Better Auth's per-IP limits: someone
// with many IP addresses still cannot flood one inbox. The count lives in the pool's own rate limit table under a key made from a keyed
// hash of the lower-cased address, never the address itself. It is counted before the address is looked up, so the reply is the same
// whether the address has an account or not.
import { createHmac, randomUUID } from "node:crypto";
import { APIError, BASE_ERROR_CODES, type BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";

export const EMAIL_LIMIT = { max: 3, windowMs: 3600_000 };
// Sign-up is left out: it sends only when it makes the account, so one address gets at most one sign-up email.
export const EMAIL_LIMIT_PATHS = ["/request-password-reset", "/send-verification-email", "/change-unverified-email"]; // the last: B40, counted on the old address

// One statement, atomic under concurrent requests. last_request holds the END of the window, not the last request: Better Auth prunes
// rows whose last_request is older than its longest window (5 minutes), and an hour-long count must not be pruned early.
export const consume = (table: string) =>
  `insert into ${table} as r (id, key, count, last_request) values ($1, $2, 1, $3::bigint + $4::bigint)
   on conflict (key) do update set count = case when r.last_request <= $3::bigint then 1 else r.count + 1 end,
     last_request = case when r.last_request <= $3::bigint then $3::bigint + $4::bigint else r.last_request end
   returning count`;

// SEC-2: a daily budget per pool for the account emails anyone can trigger without a session (the verify email of a sign-up or a resend, and the
// reset), so a flood of new addresses cannot use up Brevo Free's 300 a day, which every other email shares: the outbox keeps 200 a UTC day
// (packages/db/src/outbox-cli.ts DAILY_CAP), these 95, which leaves 5 for email changes and invites (signed-in actions, not budgeted). Verify and
// reset count apart, so a sign-up flood never stops resets. Over the budget the email is not sent and one line is logged; the reply is unchanged.
// The key carries the UTC date, so the day matches the outbox's and Brevo's. Not counted: an address with no account gets no email, so no count.
export const EMAIL_DAY_BUDGET = { candidate: { verify: 50, reset: 20 }, portal: { verify: 15, reset: 10 } } as const;
export const dayBudgetKey = (kind: string, now: Date) => `email-day:${kind}:${now.toISOString().slice(0, 10)}`;
/** Counts one email of `kind` today in the pool's table (one statement): true while within `max`. */
export async function withinDayBudget(database: Pool, pool: "candidate" | "portal", kind: string, max: number): Promise<boolean> {
  const now = new Date();
  const { rows } = await database.query<{ count: number }>(consume(`${pool}_rate_limit`), [randomUUID(), dayBudgetKey(kind, now), now.getTime(), 86_400_000]);
  return rows[0]!.count <= max;
}

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

// SEC-5: a limit per account on password sign-in, on all three pools (staff sign in with a password only, decision on SEC-4), on top of Better
// Auth's 5 a minute per IP. One atomic statement counts every attempt for the address before Better Auth looks it up, so parallel guesses
// cannot slip past; a sign-in that did not fail on the password (success, or the 403 of an unconfirmed email) takes its count back, so
// only failures add up. Past SIGN_IN_LIMIT.max failures the address is refused until the window ends (at most an hour after the first
// failure), the right password included, with Better Auth's own 401 for a wrong password. A locked reply hashes the password first, as
// Better Auth does for an unknown address, so its text and time are those of a wrong password: the lock shows neither that it is on nor
// whether the address has an account. ponytail: anyone who knows an address can keep it locked; the owner can still sign in with Google
// (candidate) or wait, and a reset does not clear the count. Add a clear on reset if that bites.
export const SIGN_IN_LIMIT = { max: 10, windowMs: 3600_000 };
export const signInLimitKey = (secret: string, email: string) => `signin:${createHmac("sha256", secret).update(email.toLowerCase()).digest("hex")}`;

export function signInLimitPlugin(database: Pool, pool: "candidate" | "portal" | "staff", secret: string): BetterAuthPlugin {
  const table = `${pool}_rate_limit`, sql = consume(table);
  const giveBack = `update ${table} set count = greatest(count - 1, 0) where key = $1`;
  const emailOf = (body: unknown) => {
    const email = (body as { email?: unknown } | undefined)?.email;
    return typeof email === "string" && email.length <= 254 ? email : null; // others: Better Auth's own checks refuse them
  };
  return {
    id: `${pool}-sign-in-limit`,
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/sign-in/email",
        handler: createAuthMiddleware(async (ctx) => {
          const email = emailOf(ctx.body);
          if (email === null) return;
          const { rows } = await database.query<{ count: number }>(sql, [randomUUID(), signInLimitKey(secret, email), Date.now(), SIGN_IN_LIMIT.windowMs]);
          if (rows[0]!.count <= SIGN_IN_LIMIT.max) return;
          const password = (ctx.body as { password?: unknown }).password;
          await ctx.context.password.hash(String(password ?? "").slice(0, 128)); // the cost of a wrong password's check
          throw APIError.from("UNAUTHORIZED", BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
        }),
      }],
      after: [{
        matcher: (ctx) => ctx.path === "/sign-in/email",
        handler: createAuthMiddleware(async (ctx) => {
          const email = emailOf(ctx.body), r = ctx.context.returned;
          if (email !== null && !(r instanceof APIError && r.statusCode === 401)) await database.query(giveBack, [signInLimitKey(secret, email)]);
        }),
      }],
    },
  };
}
