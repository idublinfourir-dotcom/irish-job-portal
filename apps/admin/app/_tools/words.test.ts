// Every refusal code of every route the tool pages call has a plain sentence (wave 3 rule). The codes are read from docs/openapi/admin.yaml, not typed here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { toolWords, WORD_CODES } from "./words";

type Obj = Record<string, unknown>;
const spec = parse(readFileSync(join(__dirname, "../../../../docs/openapi/admin.yaml"), "utf8")) as { paths: Record<string, Obj>; components: { responses: Record<string, Obj> } };
const ROUTES = ["/api/settings", "/api/legal-texts", "/api/data-requests", "/api/services/solicitors", "/api/scheduled-checks", "/api/staff/me/export", "/api/signup-no-counts", "/api/permit-rises", "/api/targets", "/api/overdue", "/api/accuracy-sample", "/api/fetched-jobs/decisions"];
const NOT_CODES = new Set(["after", "done"]); // words in backticks that are a query key or an action, not an answer

/** Every code a non-200 response of these routes names: backticked words in its description and `error:` in its examples. */
function codesOf() {
  const found = new Set<string>();
  const scan = (o: unknown) => {
    if (typeof o === "string") for (const m of o.matchAll(/`([a-z][a-z0-9_]{2,})`/g)) found.add(m[1]!);
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (k === "error" && typeof v === "string") found.add(v); scan(v); }
  };
  for (const route of ROUTES) for (const op of Object.values(spec.paths[route]!) as Obj[])
    for (const [status, r] of Object.entries((op.responses ?? {}) as Record<string, Obj>)) {
      if (status === "200") continue;
      scan(typeof r.$ref === "string" ? spec.components.responses[r.$ref.split("/").pop()!] : r);
    }
  return [...found].filter((c) => !NOT_CODES.has(c)).sort();
}

describe("the words for the tool routes' refusals", () => {
  const codes = codesOf();
  const generic = toolWords("not_a_code", 400);
  it("reads a sensible set of codes from the yaml", () => {
    for (const c of ["same_person", "reauth_required", "not_administrator", "version_taken", "not_confirmed", "close_company_first", "bad_value", "decision_pending", "no_role", "bad_cursor"]) expect(codes, c).toContain(c);
  });
  it.each(codes)("%s has its own sentence, never the general one or the code", (code) => {
    const text = toolWords(code, 403);
    expect(text).not.toBe(generic);
    expect(text).toMatch(/^[A-Z].*[.]$/);
    expect(text).not.toContain(code);
  });
  it("every word of ours is plain: no dash, no raw text", () => {
    for (const c of WORD_CODES) expect(toolWords(c, 400), c).not.toMatch(/[–—]|undefined|\[object/);
  });
  it("a lost connection, a rate limit and a server fault each have words, and an unknown code is general", () => {
    expect(toolWords("", 0)).toMatch(/Could not reach the server/);
    expect(toolWords("", 429)).toMatch(/Too many requests/);
    expect(toolWords("whatever", 500)).toMatch(/our side/);
    expect(generic).toMatch(/Reload the page/);
  });
});
