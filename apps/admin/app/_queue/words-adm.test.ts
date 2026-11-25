// The words of the name merges, content, staff and audit routes: every refusal code in the routes' contract (docs/openapi/admin.yaml, read here, not typed) has a plain sentence, never
// the code and never the catch-all. No database, no network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adminWords, KNOWN_CODES, needsSignIn } from "./words-adm";

const yaml = readFileSync(join(import.meta.dirname, "../../../../docs/openapi/admin.yaml"), "utf8");
const ROUTES = ["/api/companies/dete-links", "/api/companies/merge", "/api/content", "/api/staff", "/api/audit/export", "/api/audit"];
const NOT_CODES = new Set(["propose_role", "confirm_role", "refuse_role", "remove_role", "resend_invite"]); // the actions of a body, named in a 200 description
/** The backticked snake_case words in the response descriptions of one route, which are its error codes. */
function codesOf(route: string): string[] {
  const rest = yaml.slice(yaml.indexOf(`\n  ${route}:\n`) + 1);
  const end = rest.slice(2).search(/\n {2}\/[a-z]/); // the next path starts the next block
  const out = new Set<string>();
  for (const part of rest.slice(0, end + 2).split(/\n {6}responses:/).slice(1))
    for (const m of part.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)) if (!NOT_CODES.has(m[1]!)) out.add(m[1]!);
  return [...out];
}

describe("the codes of the routes the four pages call", () => {
  for (const route of ROUTES)
    it(`${route}: every code has its own sentence`, () => {
      const codes = codesOf(route);
      expect(codes.length, route).toBeGreaterThan(3);
      for (const c of codes) {
        const w = adminWords(c, 400);
        expect(w, c).not.toBe(adminWords("zz_unknown", 400)); // not the catch-all
        expect(w, c).not.toBe(adminWords("zz_unknown", 500));
        expect(w.includes(c), c).toBe(false);
        expect(w, c).not.toMatch(/[\u2013\u2014]/);
      }
    });
  it("an unknown code, a lost connection and too many requests still get a sentence", () => {
    expect(adminWords("zz_unknown", 400)).toMatch(/did not work/);
    expect(adminWords("", 0)).toMatch(/Could not reach the server/);
    expect(adminWords("", 429)).toMatch(/Too many requests/);
    expect(adminWords("zz_unknown", 500)).toMatch(/our side/);
  });
  it("reauth_required asks for a sign-in, and only it", () => {
    expect(needsSignIn("reauth_required")).toBe(true);
    expect(needsSignIn("not_administrator")).toBe(false);
    expect(adminWords("reauth_required", 403)).toMatch(/Sign in again/);
  });
  it("the words list holds no code the contract does not name (no stale entry)", () => {
    const all = new Set(ROUTES.flatMap(codesOf));
    const base = new Set(["bad_page", "bad_cursor", "bad_query"]);
    for (const c of KNOWN_CODES) expect(all.has(c) || base.has(c) || c === "reauth_required", c).toBe(true);
  });
});
