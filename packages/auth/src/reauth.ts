// C4 (#270): sensitive actions need a session made by a sign-in in the last 10 minutes. Signing in again is the re-ask: the password, or a
// fresh Google sign-in for a candidate with no password. A session refresh (updateAge) moves expires_at only, never created_at, so it does
// not count. Our own routes read the session anyway, so they check its age and answer REAUTH_REQUIRED; the page then asks for a sign-in.
// Better Auth's own freshAge (default 1 day, read by list-sessions and unlink-account) is left alone; changeEmail does not read it, hence the hook.
import { createHmac, timingSafeEqual } from "node:crypto";
import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

export const REAUTH_SECONDS = 600;
export const REAUTH_CODE = "REAUTH_REQUIRED";

/** True when the session was made by a sign-in less than REAUTH_SECONDS ago. A bad date (NaN) is never fresh; a date a little ahead (another
 *  server's clock) counts as fresh, as only Better Auth writes created_at. */
export const isFresh = (session: { createdAt: Date | string }, now = Date.now()) => now - new Date(session.createdAt).getTime() < REAUTH_SECONDS * 1000;

const domain = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

// Email change (/change-email) and linking a Google account (/link-social, candidate only: an attacker's own Google would keep access after a
// password reset) are sensitive actions too. On the portal the new address must keep the domain: the company tie, the claim and the domain
// bans were all checked on it (0013, 0015), and a new domain could step around a domain ban.
const FRESH_PATHS = { candidate: ["/change-email", "/link-social"], portal: ["/change-email"] };

// The payload of a verify token, only when its HS256 signature is ours and it has not expired (Better Auth signs it with the pool secret).
// Checked here so a forged token can never learn whether an address has an account.
export function verifiedPayload(token: string, secret: string, now = Date.now()): Record<string, unknown> | null {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  const want = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const body = JSON.parse(Buffer.from(p, "base64url").toString());
    return typeof body === "object" && body && !(typeof body.exp === "number" && body.exp * 1000 <= now) ? body : null;
  } catch { return null; }
}
// Only a path on our own site gets the redirect: one leading "/", not followed by "/" or "\\", printable ASCII only (no space, tab, newline
// or other control character, which the URL parser strips, so "/\t/evil.example" would become "//evil.example"), no backslash anywhere, at most
// 1,000 characters, and it must still resolve to our own origin. Anything else gets the plain 409 instead (review of 07f9a8c: an open redirect).
export const ownPath = (u: unknown, origin: string): u is string => {
  if (typeof u !== "string" || u.length > 1000 || !/^\/(?![/\\])[!-~]*$/.test(u) || u.includes("\\")) return false;
  try { return new URL(u, origin).origin === origin; } catch { return false; }
};

export function reauthPlugin(pool: "candidate" | "portal", secret: string): BetterAuthPlugin {
  return {
    id: `${pool}-reauth`,
    hooks: {
      before: [{
        matcher: (ctx) => FRESH_PATHS[pool].includes(ctx.path ?? ""),
        handler: createAuthMiddleware(async (ctx) => {
          const s = await getSessionFromCtx(ctx);
          if (!s) return; // Better Auth's own session check answers 401
          if (!isFresh(s.session)) throw new APIError("FORBIDDEN", { message: "Please sign in again.", code: REAUTH_CODE });
          if (ctx.path !== "/change-email") return;
          const to = (ctx.body as { newEmail?: unknown } | undefined)?.newEmail;
          // Better Auth's own check takes any length; an address is at most 254 characters (RFC 5321), as in email-limit.ts.
          if (typeof to === "string" && to.length > 254) throw new APIError("BAD_REQUEST", { message: "Invalid email address.", code: "INVALID_EMAIL" });
          if (pool === "portal" && typeof to === "string" && domain(to) !== domain(s.user.email))
            throw new APIError("BAD_REQUEST", { message: "The new address must be on the same domain.", code: "DOMAIN_CHANGE_REFUSED" });
        }),
      }, {
        // The race: the new address got an account after the change was asked for (checked on both links). Better Auth would hit the unique email index
        // (a 500); this answers EMAIL_TAKEN instead and nothing changes. Two clicks in the same instant can still reach the index (a 500, no change).
        matcher: (ctx) => ctx.path === "/verify-email",
        handler: createAuthMiddleware(async (ctx) => {
          const q = ctx.query as { token?: unknown; callbackURL?: unknown } | undefined;
          const t = typeof q?.token === "string" ? verifiedPayload(q.token, secret) : null;
          if (!String(t?.requestType).startsWith("change-email-") || typeof t?.updateTo !== "string") return; // either link of a change
          if (!(await ctx.context.internalAdapter.findUserByEmail(t.updateTo.toLowerCase()))) return;
          if (ownPath(q?.callbackURL, new URL(ctx.context.baseURL).origin)) throw ctx.redirect(`${q.callbackURL}${q.callbackURL.includes("?") ? "&" : "?"}error=EMAIL_TAKEN`);
          throw new APIError("CONFLICT", { message: "This address already has an account.", code: "EMAIL_TAKEN" });
        }),
      }],
    },
  };
}
