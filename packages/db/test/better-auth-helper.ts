/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// Ported unchanged from schema-trial-2/auth.mjs (only the imports differ).
// The three pools as the design describes them in section 2.2: lowercase `fields` mappings, the added
// columns as additionalFields with input: false, a database rate limit store per pool, a session hook that
// refuses flagged people, and sign-up off for staff. Fake secrets and fake users only.
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
export const snake = {
  user: { emailVerified: "email_verified", createdAt: "created_at", updatedAt: "updated_at" },
  session: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at", ipAddress: "ip_address", userAgent: "user_agent", userId: "user_id" },
  account: { accountId: "account_id", providerId: "provider_id", userId: "user_id", accessToken: "access_token", refreshToken: "refresh_token", idToken: "id_token", accessTokenExpiresAt: "access_token_expires_at", refreshTokenExpiresAt: "refresh_token_expires_at", createdAt: "created_at", updatedAt: "updated_at" },
  verification: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" },
};
const d = (fieldName) => ({ type: "date", required: false, input: false, fieldName });
export const added = {
  candidate: { suspendedAt: d("suspended_at"), deletedAt: d("deleted_at"), lastActiveAt: d("last_active_at"), inactiveWarnedAt: d("inactive_warned_at") },
  portal: { status: { type: "string", required: false, input: false, defaultValue: "active", fieldName: "status" }, blockedAt: d("blocked_at"), blockedReasonCode: { type: "string", required: false, input: false, fieldName: "blocked_reason_code" }, lastActiveAt: d("last_active_at"), deletedAt: d("deleted_at") },
  staff: { status: { type: "string", required: false, input: false, defaultValue: "active", fieldName: "status" } },
};
// The Identity module's rule, used by the session hook: who may not hold a session.
const refusedSql = {
  candidate: "select 1 from candidate_user where id=$1 and (suspended_at is not null or deleted_at is not null)",
  portal: "select 1 from portal_user where id=$1 and (status='blocked' or deleted_at is not null)",
  staff: "select 1 from staff_user where id=$1 and status='disabled'",
};
export const mail = []; // verification and reset links Better Auth would have emailed
export function makeAuth(name, database, o = {}) {
  const mapped = o.mapped !== false;
  return betterAuth({
    appName: `portal-${name}`, baseURL: "http://localhost:3000", basePath: `/api/auth/${name}`,
    secret: "trial-only-secret-trial-only-secret-32", database,
    emailAndPassword: { enabled: true, disableSignUp: name === "staff", requireEmailVerification: name !== "staff" && o.verify !== false,
      sendResetPassword: async ({ user, url }) => { mail.push({ pool: name, kind: "reset", email: user.email, url }); } },
    emailVerification: { sendVerificationEmail: async ({ user, url }) => { mail.push({ pool: name, kind: "verify", email: user.email, url }); } },
    rateLimit: { enabled: o.rateLimit !== false, storage: "database", modelName: `${name}_rate_limit`, ...(mapped ? { fields: { lastRequest: "last_request" } } : {}),
      customRules: { "/sign-in/email": { window: 60, max: 5 }, "/sign-up/email": { window: 60, max: 5 }, "/request-password-reset": { window: 300, max: 3 } } },
    trustedOrigins: ["http://localhost:3000"],
    user: { modelName: `${name}_user`, ...(mapped ? { fields: snake.user } : {}), additionalFields: added[name] },
    session: { modelName: `${name}_session`, cookieCache: { enabled: false }, ...(mapped ? { fields: snake.session } : {}) },
    account: { modelName: `${name}_account`, ...(mapped ? { fields: snake.account } : {}) },
    verification: { modelName: `${name}_verification`, ...(mapped ? { fields: snake.verification } : {}) },
    databaseHooks: o.hook === false ? {} : { session: { create: { before: async (s) => {
      const r = await database.query(refusedSql[name], [s.userId]);
      if (r.rowCount) throw new APIError("FORBIDDEN", { message: "This account cannot sign in." });
      return { data: s };
    } } } },
    advanced: { cookiePrefix: name, useSecureCookies: false, ipAddress: { ipAddressHeaders: ["x-vercel-forwarded-for"] } },
    logger: { level: o.quiet === false ? "warn" : "error" },
  });
}
