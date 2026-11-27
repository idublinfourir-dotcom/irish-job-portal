// Stage 3 step 4: the hint cookie `cand_in` (HINT_COOKIE, packages/ui/src/candidate-shell.tsx) follows the session cookie on every answer of the
// candidate auth routes: set with the same lifetime when a sign-in, sign-up or the Google callback sets the session, cleared when sign-out (or a
// deleted or expired session) clears it. Not HttpOnly, so the page's script can read it; it says only "probably signed in", and the server never trusts it.
export const HINT_COOKIE = "cand_in";

const SESSION = /^(?:__Secure-)?candidate\.session_token=([^;]*)/;

/** The answer with the hint cookie added after the session cookie, or the answer as it was when it sets no session cookie. */
export function withHint(res: Response): Response {
  const session = res.headers.getSetCookie().find((c) => SESSION.test(c));
  if (!session) return res;
  const age = /;\s*max-age=(-?\d+)/i.exec(session)?.[1];
  const cleared = SESSION.exec(session)![1] === "" || (age !== undefined && Number(age) <= 0);
  const secure = /;\s*secure\b/i.test(session) ? "; Secure" : "";
  const out = new Response(res.body, res); // a redirect's headers can be immutable: a copy takes the cookie
  out.headers.append("set-cookie", `${HINT_COOKIE}=${cleared ? "" : "1"}; Path=/; SameSite=Lax; Max-Age=${cleared ? 0 : (age ?? 604800)}${secure}`);
  return out;
}

/** For a page that knows the session is live (the account frame): sets the hint in the browser too, 7 days as Better Auth's session. A fixed string. */
export const HINT_SET = `try{document.cookie="${HINT_COOKIE}=1; Path=/; SameSite=Lax; Max-Age=604800"+(location.protocol==="https:"?"; Secure":"");document.documentElement.setAttribute("data-in","")}catch(e){}`;
/** First in <body> (app/layout.tsx): marks <html data-in> from the hint before the header is painted; globals.css then shows the [data-in-only] parts and hides the [data-out-only] ones. No script: the visitor variant. A fixed string. */
export const HINT_SCRIPT = `try{if(/(?:^|;\\s*)${HINT_COOKIE}=1(?:;|$)/.test(document.cookie))document.documentElement.setAttribute("data-in","")}catch(e){}`;
