// Every refusal code of every route the account pages call has a plain sentence (wave 3 rule). The codes are read from docs/openapi/candidate.yaml, not typed here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { messageFor } from "../jobs/api";
import { REASON_TEXT, STAGE_TEXT, noticeText, wording } from "./messages";

type Obj = Record<string, unknown>;
const spec = parse(readFileSync(join(__dirname, "../../../../docs/openapi/candidate.yaml"), "utf8")) as { paths: Record<string, Obj>; components: { responses: Record<string, Obj> } };
const ROUTES = ["/api/candidate/saved", "/api/candidate/tracker", "/api/candidate/did-you-apply", "/api/candidate/notices", "/api/candidate/alerts", "/api/candidate/alerts/pause", "/api/candidate/alerts/resume", "/api/candidate/apply-click"];

/** Every code a response of these routes names: backticked CODES in its description and `code:` in its examples. */
function codesOf() {
  const found = new Set<string>();
  const scan = (o: unknown) => {
    if (typeof o === "string") for (const m of o.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) found.add(m[1]!);
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (k === "code" && typeof v === "string" && /^[A-Z0-9_]+$/.test(v)) found.add(v); scan(v); }
  };
  for (const route of ROUTES) for (const op of Object.values(spec.paths[route]!) as Obj[]) {
    for (const r of Object.values((op.responses ?? {}) as Record<string, Obj>)) {
      const ref = typeof r.$ref === "string" ? spec.components.responses[r.$ref.split("/").pop()!] : r;
      scan(ref);
    }
  }
  return [...found];
}

describe("the words for the account routes' refusals", () => {
  const generic = messageFor("NOT_A_CODE");
  const codes = codesOf();
  it("reads a sensible set of codes from the yaml", () => {
    for (const c of ["NO_SESSION", "REFUSED", "BAD_ORIGIN", "BAD_REQUEST", "TOO_MANY_REQUESTS", "JOB_NOT_FOUND", "SAVED_LIMIT", "ALERT_LIMIT", "STAMP_4", "EMAIL_NOT_VERIFIED", "ALERT_NOT_FOUND", "NOT_TRACKED", "CLICK_NOT_FOUND", "BAD_CURSOR"]) expect(codes, c).toContain(c);
  });
  it.each(codes)("%s has its own sentence, never the general one or the server's text", (code) => {
    const text = wording(code);
    expect(text).not.toBe(generic);
    expect(text).toMatch(/^[A-Z].*[.]$/);
    expect(text).not.toContain(code);
  });
  it("an unknown code gets the general sentence", () => expect(wording("NEW_CODE")).toBe(generic));
  it("has words for every stage and reason the yaml lists, and a general line for an unknown notice", () => {
    const stages = ((spec.paths["/api/candidate/tracker"]!.put as Obj).requestBody as { content: { "application/json": { schema: { properties: { stage: { enum: string[] } } } } } }).content["application/json"].schema.properties.stage.enum;
    for (const s of stages) expect(STAGE_TEXT[s], s).toBeTruthy();
    for (const r of ["under_review", "hidden_after_report", "no_longer_available"]) expect(REASON_TEXT[r], r).toBeTruthy();
    expect(noticeText("something_new").title).toBe("You have an update");
  });
});
