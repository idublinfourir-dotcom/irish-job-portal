import { betterAuth, type DBFieldAttribute } from "better-auth";
import { APIError } from "better-auth/api";
import type { Pool } from "pg";

// The pool is called portal, not employer: its tables are portal_user and so on (23-database-design.md).
export type LoginPool = "candidate" | "portal" | "staff";
export type EmailKind = "verify" | "reset";
// Email is an outside service, so the caller passes the sender in; tests pass a fake.
export type SendEmail = (pool: LoginPool, kind: EmailKind, to: string, link: string) => Promise<void>;
export type AuthOptions = { database: Pool; baseURL: string; secret: string; sendEmail: SendEmail };

// Better Auth's camelCase fields mapped to the lowercase columns of the migrations.
const snake = {
  user: { emailVerified: "email_verified", createdAt: "created_at", updatedAt: "updated_at" },
  session: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at", ipAddress: "ip_address", userAgent: "user_agent", userId: "user_id" },
  account: { accountId: "account_id", providerId: "provider_id", userId: "user_id", accessToken: "access_token", refreshToken: "refresh_token", idToken: "id_token", accessTokenExpiresAt: "access_token_expires_at", refreshTokenExpiresAt: "refresh_token_expires_at", createdAt: "created_at", updatedAt: "updated_at" },
  verification: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" },
};
// The columns we add to each user table. input: false, so no sign-up or profile call can set them.
const d = (fieldName: string): DBFieldAttribute => ({ type: "date", required: false, input: false, fieldName });
const status: DBFieldAttribute = { type: "string", required: false, input: false, defaultValue: "active", fieldName: "status" };
const added: Record<LoginPool, Record<string, DBFieldAttribute>> = {
  candidate: { suspendedAt: d("suspended_at"), deletedAt: d("deleted_at"), lastActiveAt: d("last_active_at"), inactiveWarnedAt: d("inactive_warned_at") },
  portal: { status, blockedAt: d("blocked_at"), blockedReasonCode: { type: "string", required: false, input: false, fieldName: "blocked_reason_code" }, lastActiveAt: d("last_active_at"), deletedAt: d("deleted_at") },
  staff: { status },
};
// The Identity module's rule, used by the session hook: who may not hold a session.
const refusedSql: Record<LoginPool, string> = {
  candidate: "select 1 from candidate_user where id=$1 and (suspended_at is not null or deleted_at is not null)",
  portal: "select 1 from portal_user where id=$1 and (status='blocked' or deleted_at is not null)",
  staff: "select 1 from staff_user where id=$1 and status='disabled'",
};

// Bad settings fail closed: a short secret, or plain http anywhere but this machine.
export function checkSettings(baseURL: string, secret: string): { secure: boolean } {
  if (secret.length < 32) throw new Error("Auth secret must be at least 32 characters.");
  const url = new URL(baseURL);
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !local) throw new Error("Auth base URL must be https:// (http only for localhost or 127.0.0.1).");
  return { secure: url.protocol === "https:" };
}

// Three separate login pools in one database (#97): the same email can exist once in each, with its own
// tables and its own cookie. The options are the ones the tests in packages/db/test/better-auth.test.ts prove
// (23-database-design.md section 2.2).
export function createAuth(name: LoginPool, { database, baseURL, secret, sendEmail }: AuthOptions) {
  const { secure } = checkSettings(baseURL, secret);
  return betterAuth({
    appName: `portal-${name}`,
    baseURL,
    basePath: `/api/auth/${name}`,
    secret,
    database,
    emailAndPassword: {
      enabled: true,
      disableSignUp: name === "staff",
      requireEmailVerification: name !== "staff", // #54
      sendResetPassword: ({ user, url }) => sendEmail(name, "reset", user.email, url),
    },
    emailVerification: { sendVerificationEmail: ({ user, url }) => sendEmail(name, "verify", user.email, url) },
    // Counts live in the database: the default memory store is per instance, which does not hold on serverless.
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: `${name}_rate_limit`,
      fields: { lastRequest: "last_request" },
      customRules: { "/sign-in/email": { window: 60, max: 5 }, "/sign-up/email": { window: 60, max: 5 }, "/request-password-reset": { window: 300, max: 3 } },
    },
    trustedOrigins: [baseURL],
    user: { modelName: `${name}_user`, fields: snake.user, additionalFields: added[name] },
    // The cookie cache stays off, so every request reads the session and user from the database.
    session: { modelName: `${name}_session`, cookieCache: { enabled: false }, fields: snake.session },
    account: { modelName: `${name}_account`, fields: snake.account },
    verification: { modelName: `${name}_verification`, fields: snake.verification },
    // Better Auth ignores the added status columns, so this refuses a session to a flagged person.
    databaseHooks: {
      session: {
        create: {
          before: async (s) => {
            const r = await database.query(refusedSql[name], [s.userId]);
            if (r.rowCount) throw new APIError("FORBIDDEN", { message: "This account cannot sign in." });
            return { data: s };
          },
        },
      },
    },
    // The client address comes from the header Vercel sets, not X-Forwarded-For, which any client can send.
    advanced: { cookiePrefix: name, useSecureCookies: secure, ipAddress: { ipAddressHeaders: ["x-vercel-forwarded-for"] } },
  });
}
