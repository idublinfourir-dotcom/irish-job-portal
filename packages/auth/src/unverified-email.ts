// B40: "Wrong address? Change it" on the check-your-email screen (C27). An account whose email is not confirmed cannot sign in
// (requireEmailVerification), so change-email, which needs a session, cannot serve it. This route takes the old address and the password the person just chose
// (that is the proof, as at sign-in), moves the unconfirmed account to the new address and sends the confirmation link there. Candidate pool only.
// - A wrong password or an address with no password account is the same 401 as sign-in's; an account already confirmed is 400 ALREADY_VERIFIED (only after
//   the right password, so it tells nobody anything); an address that already has an account answers 200 and changes nothing (as change-email does).
// - The old link dies with the old address (the token names the address). Limits: 5 in 5 minutes per client address (Better Auth's, in index.ts), 3 an hour
//   per old address (emailLimitPlugin, EMAIL_LIMIT_PATHS), the bot check (packages/db/src/bot-check.ts CHECKED) and the verification resend's own limits.
import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { ownPath } from "./reauth";

export const UNVERIFIED_PATH = "/change-unverified-email";
const ADDRESS = /^[^\s@\p{Cc}\p{Cf}]{1,64}@[^\s@\p{Cc}\p{Cf}]{1,253}\.[^\s@\p{Cc}\p{Cf}]{2,63}$/u; // a plain shape check; the confirmation link is the real proof
const bad = (code: string) => new APIError("BAD_REQUEST", { message: "Invalid request.", code });
const WRONG = () => new APIError("UNAUTHORIZED", { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" });

export function unverifiedEmailPlugin(sendVerification: (body: { email: string; callbackURL?: string }) => Promise<unknown>): BetterAuthPlugin {
  return {
    id: "candidate-unverified-email",
    endpoints: {
      changeUnverifiedEmail: createAuthEndpoint(UNVERIFIED_PATH, { method: "POST" }, async (ctx) => {
        const b = ctx.body as { email?: unknown; password?: unknown; newEmail?: unknown; callbackURL?: unknown } | undefined;
        const { email, password, newEmail, callbackURL } = b ?? {};
        if (typeof email !== "string" || typeof password !== "string" || typeof newEmail !== "string") throw bad("BAD_REQUEST");
        // An address is at most 254 characters (RFC 5321); a password at most Better Auth's 128 (it would refuse a longer one at sign-up).
        if (email.length > 254 || newEmail.length > 254 || password.length < 1 || password.length > 128 || !ADDRESS.test(newEmail)) throw bad("INVALID_EMAIL");
        const found = await ctx.context.internalAdapter.findUserByEmail(email.toLowerCase(), { includeAccounts: true });
        const hash = found?.accounts.find((a) => a.providerId === "credential")?.password;
        if (!found || !hash) { await ctx.context.password.hash(password); throw WRONG(); } // the same work whether or not the address exists
        if (!(await ctx.context.password.verify({ hash, password }))) throw WRONG();
        if (found.user.emailVerified) throw bad("ALREADY_VERIFIED");
        const to = newEmail.toLowerCase();
        if (to !== found.user.email.toLowerCase()) {
          if (await ctx.context.internalAdapter.findUserByEmail(to)) return ctx.json({ status: true }); // taken: the same answer, nothing changes or is sent
          try { await ctx.context.internalAdapter.updateUser(found.user.id, { email: to }); } catch (e) {
            if ((e as { code?: string }).code === "23505") return ctx.json({ status: true }); // taken a moment ago: the unique index says so
            throw e;
          }
        }
        // The link ends on the page the form names (our own path only; anything else is dropped and the link ends on the home page).
        await sendVerification({ email: to, ...(ownPath(callbackURL, new URL(ctx.context.baseURL).origin) ? { callbackURL } : {}) });
        return ctx.json({ status: true });
      }),
    },
  };
}
