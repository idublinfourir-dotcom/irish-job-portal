// Unit (Stage 3 step 4): the hint cookie follows the session cookie on the auth routes' answers, and the page script reads only an exact cand_in=1.
// The hint is a display switch, never a credential: the server reads no hint anywhere (the grep below).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HINT_COOKIE, HINT_SCRIPT, HINT_SET, withHint } from "./hint";

const answer = (...cookies: string[]) => { const h = new Headers(); for (const c of cookies) h.append("set-cookie", c); return new Response("{}", { headers: h }); };
const hint = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith(`${HINT_COOKIE}=`));

describe("withHint", () => {
  it("sets the hint with the session's lifetime and Secure when a sign-in sets the session", () => {
    expect(hint(withHint(answer("candidate.session_token=abc.def; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax")))).toBe("cand_in=1; Path=/; SameSite=Lax; Max-Age=604800");
    expect(hint(withHint(answer("__Secure-candidate.session_token=abc; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax")))).toBe("cand_in=1; Path=/; SameSite=Lax; Max-Age=3600; Secure");
  });
  it("clears the hint when the session cookie is cleared (sign-out, a deleted or expired session)", () => {
    for (const c of ["candidate.session_token=; Max-Age=0; Path=/", "candidate.session_token=x; Max-Age=0", "candidate.session_token=; Path=/"]) expect(hint(withHint(answer(c))), c).toMatch(/^cand_in=; Path=\/; SameSite=Lax; Max-Age=0/);
  });
  it("leaves an answer that sets no session cookie as it was, another pool's included", () => {
    for (const r of [answer(), answer("portal.session_token=abc; Max-Age=60"), answer("staff.session_token=abc"), answer("candidate.session_data=abc")]) expect(withHint(r)).toBe(r);
  });
  it("works on a redirect (the Google callback), whose headers cannot be changed, and keeps its status and other cookies", () => {
    const r = Response.redirect("http://localhost:3000/account", 302);
    const withSession = new Response(null, { status: 302, headers: [["location", "/account"], ["set-cookie", "candidate.session_token=abc; Max-Age=60"], ["set-cookie", "candidate.state=; Max-Age=0"]] });
    expect(withHint(r)).toBe(r);
    const out = withHint(withSession);
    expect([out.status, out.headers.get("location"), out.headers.getSetCookie().length, hint(out)]).toEqual([302, "/account", 3, "cand_in=1; Path=/; SameSite=Lax; Max-Age=60"]);
  });
});

describe("the page scripts", () => {
  const run = (script: string, cookie: string) => {
    const attrs = new Set<string>(); let written = "";
    const document = { get cookie() { return cookie; }, set cookie(v: string) { written = v; }, documentElement: { setAttribute: (k: string) => attrs.add(k) } };
    new Function("document", "location", script)(document, { protocol: "https:" });
    return { on: attrs.has("data-in"), written };
  };
  it("marks html[data-in] only for an exact cand_in=1", () => {
    for (const c of ["cand_in=1", "a=b; cand_in=1", "cand_in=1; a=b", "a=b;cand_in=1"]) expect(run(HINT_SCRIPT, c).on, c).toBe(true);
    for (const c of ["", "cand_in=", "cand_in=0", "cand_in=10", "xcand_in=1", "a=cand_in=1", "cand_in =1"]) expect(run(HINT_SCRIPT, c).on, c).toBe(false);
  });
  it("the account frame's script sets the hint, Secure over HTTPS", () => {
    expect(run(HINT_SET, "")).toEqual({ on: true, written: "cand_in=1; Path=/; SameSite=Lax; Max-Age=604800; Secure" });
  });
  it("security: no server code reads the hint", () => {
    for (const f of ["data.ts", "candidate.ts", "account.ts"]) expect(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"), f).not.toContain(HINT_COOKIE);
  });
});
