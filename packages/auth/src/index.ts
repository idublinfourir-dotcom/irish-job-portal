import { betterAuth, getCurrentAdapter, type DBFieldAttribute } from "better-auth";
import { APIError, getOAuthState } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { generateRandomString } from "better-auth/crypto";
import type { Pool } from "pg";
import { checkPortalSignup, checkSignup, signupPlugin, writeConsent, type Answers } from "./signup";
import { emailLimitPlugin } from "./email-limit";

export { readAnswers, readPortalAnswers, checkSignup, checkPortalSignup, currentTermsId, writeConsent, type Answers, type PortalAnswers } from "./signup";
export { createFakeEmail, type FakeEmail } from "./fake-email";
export { createMail, emailText } from "./mail";
export { createBrevoMail, type SendMail } from "./brevo";
export { EMAIL_LIMIT, emailLimitKey } from "./email-limit";

// The pool is called portal, not employer: its tables are portal_user and so on (23-database-design.md).
export type LoginPool = "candidate" | "portal" | "staff";
export type EmailKind = "verify" | "reset" | "invite"; // invite: a portal team invite (apps/portal/lib/team.ts)
// Email is an outside service, so the caller passes the sender in; tests pass a fake.
export type SendEmail = (pool: LoginPool, kind: EmailKind, to: string, link: string) => Promise<void>;
export type GoogleSettings = { clientId: string; clientSecret: string };
// google is for the candidate pool only, and only when set; without it the Google routes answer "provider not found".
// background: how the app keeps a task alive after the reply (Next's after() in the apps). With it, sign-up and reset answer without
// waiting for the email send (slice 2 review finding 4), so the reply time does not show whether an address has an account.
export type AuthOptions = { database: Pool; baseURL: string; secret: string; sendEmail: SendEmail; google?: GoogleSettings; background?: (task: Promise<unknown>) => void };

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

// Staff idle limit (#172): a staff session ends after 8 idle hours. Each use more than 5 minutes after the last refresh
// moves the end out to 8 hours from now, so the session ends between 7 h 55 min and 8 h after the last use.
export const STAFF_IDLE_SECONDS = 8 * 3600;
export const STAFF_REFRESH_SECONDS = 300;

// An app's settings for one pool (STAFF_AUTH_URL and STAFF_AUTH_SECRET, CANDIDATE_..., PORTAL_...), read from its environment.
// Missing ones fail closed, like checkSettings.
export function authSettings(prefix: "STAFF" | "CANDIDATE" | "PORTAL", env: NodeJS.ProcessEnv): { baseURL: string; secret: string } {
  const baseURL = env[`${prefix}_AUTH_URL`], secret = env[`${prefix}_AUTH_SECRET`];
  if (!baseURL || !secret) throw new Error(`${prefix}_AUTH_URL and ${prefix}_AUTH_SECRET must be set.`);
  checkSettings(baseURL, secret);
  return { baseURL, secret };
}
export const staffSettings = (env: NodeJS.ProcessEnv) => authSettings("STAFF", env);
export const candidateSettings = (env: NodeJS.ProcessEnv) => authSettings("CANDIDATE", env);
export const portalSettings = (env: NodeJS.ProcessEnv) => authSettings("PORTAL", env);
// Google sign-in is on only when both variables are set (and not empty); otherwise undefined and the Google routes do not exist.
export function googleSettings(env: NodeJS.ProcessEnv): GoogleSettings | undefined {
  const clientId = env.GOOGLE_CLIENT_ID, clientSecret = env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}
// Staff reset links go nowhere yet (no outside email service in step 7 slice 1), so the staff pool refuses to send.
export const refuseEmail: SendEmail = async (pool, kind) => {
  throw new Error(`Email is not set up for the ${pool} pool (${kind} link not sent).`);
};

type Ctx = { path?: string; body?: unknown; context: { adapter: unknown } };
// The answers of a Google sign-up that passed the user-create step, until its account row is made (same request, same context object).
const fromGoogle = new WeakMap<object, Answers>();

// Three separate login pools in one database (#97): the same email can exist once in each, with its own
// tables and its own cookie. The options are the ones the tests in packages/db/test/better-auth.test.ts prove
// (23-database-design.md section 2.2).
export function createAuth(name: LoginPool, { database, baseURL, secret, sendEmail: send, google, background }: AuthOptions) {
  const { secure } = checkSettings(baseURL, secret);
  // A send that runs after the reply has no caller to fail, so its error is logged here (never the address). Without background the
  // error reaches the caller as before (staff: refuseEmail).
  const sendEmail: SendEmail = background
    ? (pool, kind, to, link) => send(pool, kind, to, link).catch((e) => console.error(`[auth] ${pool} ${kind} email not sent: ${(e as Error).message}`))
    : send;
  // C1: the dormant rules (retention rules 3 to 5, 0002_functions.sql) read last_active_at, so a sign-in and each session refresh set it;
  // a trigger then clears inactive_warned_at, which cancels a warning already sent. A refresh of a row deleted meanwhile passes null.
  const touchActive = async (s: { userId: string } | null) => void (s && (await database.query("update candidate_user set last_active_at = now() where id = $1", [s.userId])));
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
      revokeSessionsOnPasswordReset: true, // a reset ends every other session, so an intruder's session does not outlive the owner's reset
      sendResetPassword: ({ user, url }) => sendEmail(name, "reset", user.email, url),
    },
    emailVerification: { sendVerificationEmail: ({ user, url }) => sendEmail(name, "verify", user.email, url) },
    // Counts live in the database: the default memory store is per instance, which does not hold on serverless.
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: `${name}_rate_limit`,
      fields: { lastRequest: "last_request" },
      customRules: {
        "/sign-in/email": { window: 60, max: 5 }, "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 300, max: 3 }, "/send-verification-email": { window: 300, max: 3 },
      },
    },
    ...(name === "candidate" && google ? { socialProviders: { google } } : {}),
    trustedOrigins: [baseURL],
    user: { modelName: `${name}_user`, fields: snake.user, additionalFields: added[name] },
    // The cookie cache stays off, so every request reads the session and user from the database.
    session: {
      modelName: `${name}_session`, cookieCache: { enabled: false }, fields: snake.session,
      ...(name === "staff" ? { expiresIn: STAFF_IDLE_SECONDS, updateAge: STAFF_REFRESH_SECONDS } : {}),
    },
    // Staff: server calls (requireStaff) refresh the session row, and this sends the new cookie back in Next.js route handlers and server actions.
    plugins: name === "staff" ? [nextCookies()] : name === "candidate" || name === "portal" ? [emailLimitPlugin(database, name, secret), signupPlugin(database, name)] : [],
    // A Google sign-in joins an existing account with the same email only when Google says the email is verified AND that account's
    // email was confirmed here (Better Auth's defaults, written out so a change shows in review). No trusted providers: Google's word
    // alone is not enough for an unconfirmed email-and-password account, so there is no silent takeover.
    account: { modelName: `${name}_account`, fields: snake.account, accountLinking: { enabled: true, requireLocalEmailVerified: true, trustedProviders: [] } },
    verification: { modelName: `${name}_verification`, fields: snake.verification },
    // Better Auth ignores the added status columns, so this refuses a session to a flagged person.
    databaseHooks: {
      // Candidate sign-up: the consent row is written here, in the sign-up transaction, right after the user row and before the
      // account (password or Google). A failure rolls the new account back. Email sign-up reads the answers from the request body;
      // a Google sign-in reads them from the sign-in state (additionalData), checked by the user-create step before any row exists.
      ...(name === "candidate" ? {
        user: { create: { before: async (u: { emailVerified?: unknown }, ctx: Ctx | null) => {
          if (ctx?.path === "/sign-up/email") return;
          if (u.emailVerified !== true) throw new APIError("FORBIDDEN", { message: "Google has not confirmed this email address.", code: "EMAIL_NOT_VERIFIED_BY_PROVIDER" });
          fromGoogle.set(ctx as object, checkSignup(await getOAuthState(), false));
        } } },
        account: { create: { before: async (a: { userId: string }, ctx: Ctx | null) => {
          if (ctx?.path === "/sign-up/email") return void (await writeConsent(ctx.context.adapter, a.userId, checkSignup(ctx.body, false)));
          const answers = ctx && fromGoogle.get(ctx);
          if (answers) return void (await writeConsent(ctx.context.adapter, a.userId, answers));
          // No answers means Google is joining an existing candidate, who must already have a consent row. Checked through the same
          // transaction, so if the hand-off from the user-create step ever breaks, a new account with no consent row is refused (fail closed).
          const trx = (await getCurrentAdapter(ctx?.context.adapter as never)) as unknown as { count: (q: unknown) => Promise<number> };
          if (!(await trx.count({ model: "consentRecord", where: [{ field: "candidateUserId", value: a.userId }] })))
            throw new APIError("FORBIDDEN", { message: "Sign-up answers are missing.", code: "SIGNUP_CONSENT_MISSING" });
          // Pre-hijack (slice 2 review finding 3): someone may have signed up with this address and their own password before the owner
          // confirmed it. Google has now proved the owner holds the address, so the password goes and every earlier session ends, as
          // Better Auth's revokeUnprovenAccountAccess does for magic links. The owner can set a password again by reset. A link started
          // by a signed-in candidate (state.link, or the /link-social route) is the owner adding Google on purpose, so it is left alone.
          // Google joins on the redirect callback and on an id-token sign-in (/sign-in/social with idToken; without one, that route
          // only makes the Google address and writes no account row).
          if ((ctx?.path?.startsWith("/callback/") || ctx?.path === "/sign-in/social") && !(await getOAuthState())?.link) {
            const del = trx as unknown as { deleteMany: (q: unknown) => Promise<number> };
            if (await del.deleteMany({ model: "account", where: [{ field: "userId", value: a.userId }, { field: "providerId", value: "credential" }] }))
              await del.deleteMany({ model: "session", where: [{ field: "userId", value: a.userId }] });
          }
        } } },
      } : {}),
      // Portal sign-up (#194): the same, with the one tick. The portal has no Google (#190), so an account made by any other route is refused.
      ...(name === "portal" ? {
        account: { create: { before: async (a: { userId: string }, ctx: Ctx | null) => {
          if (ctx?.path !== "/sign-up/email") throw new APIError("FORBIDDEN", { message: "Sign-up answers are missing.", code: "SIGNUP_CONSENT_MISSING" });
          await writeConsent(ctx.context.adapter, a.userId, checkPortalSignup(ctx.body), "portal");
        } } },
      } : {}),
      session: {
        create: {
          before: async (s) => {
            const r = await database.query(refusedSql[name], [s.userId]);
            if (r.rowCount) throw new APIError("FORBIDDEN", { message: "This account cannot sign in." });
            // rememberMe: false gives a 1-day session that never refreshes; for staff it is capped at the idle limit too.
            if (name === "staff") return { data: { ...s, expiresAt: new Date(Math.min(+s.expiresAt, Date.now() + STAFF_IDLE_SECONDS * 1000)) } };
            return { data: s };
          },
          ...(name === "candidate" ? { after: touchActive } : {}),
        },
        // Better Auth refreshes a session in use once a day (updateAge), so this marks a signed-in candidate active at most daily.
        ...(name === "candidate" ? { update: { after: touchActive } } : {}),
      },
    },
    // The client address comes from the header Vercel sets, not X-Forwarded-For, which any client can send.
    // consent_record's id is made by the database (identity column); every other table keeps Better Auth's own ids.
    advanced: { ...(background ? { backgroundTasks: { handler: background } } : {}), disableOriginCheck: false, database: { generateId: ({ model }: { model: string }) => (model === "consentRecord" ? false : generateRandomString(32, "a-z", "A-Z", "0-9")) }, cookiePrefix: name, useSecureCookies: secure, ipAddress: { ipAddressHeaders: ["x-vercel-forwarded-for"] } },
  });
}

/** A request with no usable staff session. `why` is "no_session" or "not_active". */
export class StaffRefused extends Error {}

// Every admin call starts here. The session read also reads staff_user.status (the cookie cache is off), so a person disabled
// after signing in is refused on their next request even if their session row was not deleted. Returns the id the admin
// queue functions take. ponytail: no roles yet (#172 adds the queue role check later; reading them costs one more statement).
export async function requireStaff(auth: ReturnType<typeof createAuth>, headers: Headers): Promise<string> {
  const s = await auth.api.getSession({ headers });
  if (!s) throw new StaffRefused("no_session");
  if ((s.user as { status?: unknown }).status !== "active") throw new StaffRefused("not_active");
  return s.user.id;
}

/** A request with no usable portal session. `why` is "no_session" or "not_active". */
export class PortalRefused extends Error {}
export type PortalMembership = { id: number; organisationId: number; role: string; isSigner: boolean; organisationStatus: string; organisationKind: string };
export type PortalLogin = { userId: string; email: string; membership: PortalMembership | null };

// Every portal call starts here. Like requireStaff, a login blocked or deleted after signing in is refused on its next request
// (the cookie cache is off, so the status fields are read fresh). Then one more statement reads the login's active membership.
// membership is null for a login with no company yet: such a login may only claim or register a company, every other portal
// action must refuse it.
export async function requirePortal(auth: ReturnType<typeof createAuth>, headers: Headers): Promise<PortalLogin> {
  const s = await auth.api.getSession({ headers });
  if (!s) throw new PortalRefused("no_session");
  const u = s.user as { status?: unknown; deletedAt?: unknown };
  if (u.status !== "active" || u.deletedAt) throw new PortalRefused("not_active");
  const { rows } = await (auth.options.database as Pool).query(
    `select m.id, m.organisation_id, m.role, m.is_signer, o.status, o.kind from membership m join organisation o on o.id = m.organisation_id
      where m.portal_user_id = $1 and m.status = 'active'`, [s.user.id]);
  const m = rows[0];
  return {
    userId: s.user.id, email: s.user.email,
    membership: m ? { id: Number(m.id), organisationId: Number(m.organisation_id), role: m.role, isSigner: m.is_signer, organisationStatus: m.status, organisationKind: m.kind } : null,
  };
}
