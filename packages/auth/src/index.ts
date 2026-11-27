import { betterAuth, getCurrentAdapter, type DBFieldAttribute } from "better-auth";
import { APIError, getOAuthState } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { generateRandomString } from "better-auth/crypto";
import type { Pool } from "pg";
import { COUNT_NO, checkPortalSignup, checkSignup, signupPlugin, writeConsent, type Answers } from "./signup";
import { emailLimitPlugin } from "./email-limit";
import { isFresh, reauthPlugin } from "./reauth";
import { UNVERIFIED_PATH, unverifiedEmailPlugin } from "./unverified-email";

export { readAnswers, readPortalAnswers, checkSignup, checkPortalSignup, currentTermsId, writeConsent, type Answers, type PortalAnswers } from "./signup";
export { createFakeEmail, type FakeEmail } from "./fake-email";
export { accountEmail, createMail } from "./mail";
export { createBrevoMail, type SendMail } from "./brevo";
export { EMAIL_LIMIT, emailLimitKey } from "./email-limit";
export { isFresh, ownPath, REAUTH_CODE, REAUTH_SECONDS } from "./reauth";

// The pool is called portal, not employer: its tables are portal_user and so on (23-database-design.md).
export type LoginPool = "candidate" | "portal" | "staff";
// invite: a portal team invite (apps/portal/lib/team.ts). change-email: to the OLD address, which must confirm a change first (C4);
// new-email: then the link to the NEW address, which makes the change.
export type EmailKind = "verify" | "reset" | "invite" | "change-email" | "new-email";
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
// The verify token is a signed JWT; only its (already signed) payload is read here, to pick the wording. Never trusted for anything else.
const changeTo = (token: string): boolean => {
  try { return typeof JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).updateTo === "string"; } catch { return false; }
};
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
  // B55: the portal's team list shows "last active", so a portal sign-in and refresh set portal_user.last_active_at the same way (no dormant rule reads it).
  const touchActive = async (s: { userId: string } | null) => void (s && (await database.query(`update ${name}_user set last_active_at = now() where id = $1`, [s.userId])));
  // The unverified-email plugin sends the confirmation through the finished instance (set just below), so the link is Better Auth's own.
  const later: { send?: (body: { email: string; callbackURL?: string }) => Promise<unknown> } = {};
  const auth = betterAuth({
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
    // The second step of an email change comes here too, its token naming the new address (updateTo); it gets its own wording.
    emailVerification: { sendVerificationEmail: ({ user, url, token }) => sendEmail(name, changeTo(token) ? "new-email" : "verify", user.email, url) },
    // Counts live in the database: the default memory store is per instance, which does not hold on serverless.
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: `${name}_rate_limit`,
      fields: { lastRequest: "last_request" },
      customRules: {
        "/sign-in/email": { window: 60, max: 5 }, "/sign-up/email": { window: 60, max: 5 }, "/sign-in/social": { window: 60, max: 5 },
        "/request-password-reset": { window: 300, max: 3 }, "/send-verification-email": { window: 300, max: 3 }, "/change-email": { window: 300, max: 3 }, [UNVERIFIED_PATH]: { window: 300, max: 5 },
      },
    },
    ...(name === "candidate" && google ? { socialProviders: { google } } : {}),
    trustedOrigins: [baseURL],
    // C4: an email change takes effect only when the NEW address follows its link, and that link is sent only after the OLD address has
    // confirmed (Better Auth's sendChangeEmailConfirmation). A change to an address that has an account here answers the same and sends nothing.
    // Staff emails are changed by administrators, so the staff pool has no change-email.
    user: {
      modelName: `${name}_user`, fields: snake.user, additionalFields: added[name],
      ...(name !== "staff" ? { changeEmail: { enabled: true, sendChangeEmailConfirmation: ({ user, url }: { user: { email: string }; url: string }) => sendEmail(name, "change-email", user.email, url) } } : {}),
    },
    // The cookie cache stays off, so every request reads the session and user from the database.
    session: {
      modelName: `${name}_session`, cookieCache: { enabled: false }, fields: snake.session,
      ...(name === "staff" ? { expiresIn: STAFF_IDLE_SECONDS, updateAge: STAFF_REFRESH_SECONDS } : {}),
    },
    // Staff: server calls (requireStaff) refresh the session row, and this sends the new cookie back in Next.js route handlers and server actions.
    plugins: name === "staff" ? [nextCookies()] : name === "candidate" || name === "portal"
      ? [emailLimitPlugin(database, name, secret), signupPlugin(database, name), reauthPlugin(name, secret), ...(name === "candidate" ? [unverifiedEmailPlugin((b) => later.send!(b))] : [])] : [],
    // A Google sign-in joins an existing account with the same email only when Google says the email is verified AND that account's
    // email was confirmed here (Better Auth's defaults, written out so a change shows in review). No trusted providers: Google's word
    // alone is not enough for an unconfirmed email-and-password account, so there is no silent takeover.
    account: { modelName: `${name}_account`, fields: snake.account, accountLinking: { enabled: true, requireLocalEmailVerified: true, trustedProviders: [] } },
    // SEC-9: tokens (reset links, Google sign-in state) are stored as a hash, so a read of the table cannot use them. Better Auth 1.7.17 still
    // finds and consumes a row stored plain before this setting, so links sent before the deploy keep working until they expire.
    verification: { modelName: `${name}_verification`, fields: snake.verification, storeIdentifier: "hashed" },
    // SEC-10: Better Auth's /update-user takes any name and image. Staff names are set by administrators, so the staff pool has no such route;
    // candidate and portal keep it behind the name rule (signupPlugin).
    ...(name === "staff" ? { disabledPaths: ["/update-user"] } : {}),
    // Better Auth ignores the added status columns, so this refuses a session to a flagged person.
    databaseHooks: {
      // Candidate sign-up: the consent row is written here, in the sign-up transaction, right after the user row and before the
      // account (password or Google). A failure rolls the new account back. Email sign-up reads the answers from the request body;
      // a Google sign-in reads them from the sign-in state (additionalData), checked by the user-create step before any row exists.
      ...(name === "candidate" ? {
        user: { create: { before: async (u: { emailVerified?: unknown }, ctx: Ctx | null) => {
          if (ctx?.path === "/sign-up/email") return;
          if (u.emailVerified !== true) throw new APIError("FORBIDDEN", { message: "Google has not confirmed this email address.", code: "EMAIL_NOT_VERIFIED_BY_PROVIDER" });
          const state = await getOAuthState();
          // C5 (#253): a new person's "no" counts here, once Google has proved the account. On the pool, not the sign-up transaction, so the
          // refusal's rollback keeps it. Once per attempt: this step runs once per callback and a state is used once. The start, POST
          // /sign-in/social, is bot-checked and limited per IP (5 a minute), so each count costs a checked start and a Google round trip.
          // The id-token sign-in reads no state, so its answers come from the body; it is refused below either way.
          const said = state ?? (ctx?.body as { additionalData?: unknown } | undefined)?.additionalData;
          if ((said as { needsPermit?: unknown } | null | undefined)?.needsPermit === false) await database.query(COUNT_NO);
          fromGoogle.set(ctx as object, checkSignup(state, false));
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
          ...(name !== "staff" ? { after: touchActive } : {}),
        },
        // Better Auth refreshes a session in use once a day (updateAge), so this marks a signed-in candidate active at most daily.
        ...(name !== "staff" ? { update: { after: touchActive } } : {}),
      },
    },
    // PERF-4: no schema read on each new instance (about 900 catalog rows, 48 ms, before the first auth call). The same check runs in CI on the
    // migrated test database instead (packages/db/test/auth-settings.test.ts, through $context.explicitSchemaCheck).
    // The client address comes from the header Vercel sets, not X-Forwarded-For, which any client can send.
    // consent_record's id is made by the database (identity column); every other table keeps Better Auth's own ids.
    advanced: { ...(background ? { backgroundTasks: { handler: background } } : {}), disableOriginCheck: false, database: { validateSchema: false, generateId: ({ model }: { model: string }) => (model === "consentRecord" ? false : generateRandomString(32, "a-z", "A-Z", "0-9")) }, cookiePrefix: name, useSecureCookies: secure, ipAddress: { ipAddressHeaders: ["x-vercel-forwarded-for"] } },
  });
  later.send = (body) => auth.api.sendVerificationEmail({ body });
  return auth;
}

type Auth = ReturnType<typeof createAuth>;
type Session = Awaited<ReturnType<Auth["api"]["getSession"]>>;
// PERF-6: one session read per request. The app gives a per-request Map (React cache in the apps; this package does not load React, the CLIs and
// database tests run it outside Next). With no scope, every call reads the session, as before. Only the raw read is shared: status and
// freshness are checked on each call, so a fresh check is never answered by a plain one. The key is the pool and the cookie header, so two
// requests, or two people, never share an entry (each request has its own Map).
let scope: () => Map<string, Promise<Session>> | undefined = () => undefined;
export const setSessionScope = (s: typeof scope): void => void (scope = s);
export function sessionOnce(auth: Auth, headers: Headers): Promise<Session> {
  const memo = scope();
  if (!memo) return auth.api.getSession({ headers });
  const key = `${auth.options.appName}\n${headers.get("cookie") ?? ""}`;
  let p = memo.get(key);
  if (!p) memo.set(key, (p = auth.api.getSession({ headers })));
  return p;
}

/** A request with no usable staff session. `why` is "no_session" or "not_active". */
export class StaffRefused extends Error {}

// Every admin call starts here. The session read also reads staff_user.status (the cookie cache is off), so a person disabled
// after signing in is refused on their next request even if their session row was not deleted. Returns the id the admin
// queue functions take. ponytail: no roles yet (#172 adds the queue role check later; reading them costs one more statement).
// C4: `fresh` (a sensitive action) also refuses a session older than REAUTH_SECONDS with "reauth_required".
export async function requireStaff(auth: ReturnType<typeof createAuth>, headers: Headers, fresh = false): Promise<string> {
  return (await staffSession(auth, headers, fresh)).id;
}
/** requireStaff with the session's freshness, for a route where only some actions are sensitive. */
export async function staffSession(auth: ReturnType<typeof createAuth>, headers: Headers, fresh = false): Promise<{ id: string; fresh: boolean }> {
  const s = await sessionOnce(auth, headers);
  if (!s) throw new StaffRefused("no_session");
  if ((s.user as { status?: unknown }).status !== "active") throw new StaffRefused("not_active");
  const f = isFresh(s.session);
  if (fresh && !f) throw new StaffRefused("reauth_required");
  return { id: s.user.id, fresh: f };
}

/** A request with no usable portal session. `why` is "no_session" or "not_active". */
export class PortalRefused extends Error {}
export type PortalMembership = { id: number; organisationId: number; role: string; isSigner: boolean; organisationStatus: string; organisationKind: string };
// fresh: the session was made by a sign-in less than REAUTH_SECONDS ago; the sensitive portal actions (C4) refuse it otherwise.
export type PortalLogin = { userId: string; email: string; fresh: boolean; membership: PortalMembership | null };

// Every portal call starts here. Like requireStaff, a login blocked or deleted after signing in is refused on its next request
// (the cookie cache is off, so the status fields are read fresh). Then one more statement reads the login's active membership.
// membership is null for a login with no company yet: such a login may only claim or register a company, every other portal
// action must refuse it.
export async function requirePortal(auth: ReturnType<typeof createAuth>, headers: Headers): Promise<PortalLogin> {
  const s = await sessionOnce(auth, headers);
  if (!s) throw new PortalRefused("no_session");
  const u = s.user as { status?: unknown; deletedAt?: unknown };
  if (u.status !== "active" || u.deletedAt) throw new PortalRefused("not_active");
  const { rows } = await (auth.options.database as Pool).query(
    `select m.id, m.organisation_id, m.role, m.is_signer, o.status, o.kind from membership m join organisation o on o.id = m.organisation_id
      where m.portal_user_id = $1 and m.status = 'active'`, [s.user.id]);
  const m = rows[0];
  return {
    userId: s.user.id, email: s.user.email, fresh: isFresh(s.session),
    membership: m ? { id: Number(m.id), organisationId: Number(m.organisation_id), role: m.role, isSigner: m.is_signer, organisationStatus: m.status, organisationKind: m.kind } : null,
  };
}
