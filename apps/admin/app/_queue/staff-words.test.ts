// The words for the contact, employer job, pay floor, account, company and seed routes: every refusal code the contract names has its own plain sentence (the codes
// are read from docs/openapi/admin.yaml, not typed here), and the form body the Act component builds. No database, no network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { bodyOf, signInAgain } from "./act";
import { staffWords } from "./staff-words";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));

const SPEC = parse(readFileSync(join(import.meta.dirname, "../../../../docs/openapi/admin.yaml"), "utf8")) as { paths: Record<string, Record<string, { responses?: Record<string, { description?: string; $ref?: string }> }>> };
const ROUTES = ["/api/contact", "/api/employer-jobs", "/api/employer-jobs/authority", "/api/pay-floors", "/api/accounts", "/api/companies/domains", "/api/companies/member-limit", "/api/companies/owner-reassign", "/api/companies/seed", "/api/companies/dete-links"];
// words in backticks in a response description that are request fields or scan states, not refusal codes
const NOT_CODES = new Set(["queue", "id", "after", "stage", "link", "unlink", "reject", "page"]);
const codesOf = (path: string): { code: string; status: number }[] =>
  Object.values(SPEC.paths[path]!).flatMap((op) => Object.entries(op.responses ?? {}).filter(([s]) => Number(s) >= 400).flatMap(([s, r]) => [...(r.description ?? "").matchAll(/`([a-z][a-z_]*)`/g)].map((m) => ({ code: m[1]!, status: Number(s) }))))
    .filter((c) => !NOT_CODES.has(c.code));
const GENERIC = staffWords("zz_not_a_code", 400);

describe("the words of every refusal the contract names", () => {
  for (const path of ROUTES)
    it(`${path}: each code has its own sentence, no dash and no code text`, () => {
      const codes = codesOf(path);
      expect(codes.length, path).toBeGreaterThan(3);
      for (const { code, status } of codes) {
        const w = staffWords(code, status);
        expect(w, `${path} ${code}`).not.toBe(GENERIC);
        expect(w, `${path} ${code}`).not.toMatch(/[\u2013\u2014]|undefined|\[object/);
        if (code !== "server_error") expect(w, `${path} ${code}`).not.toContain(code);
      }
    });
  it("an answer with no answer at all, too many requests, a code nobody knows and a fault each get a plain sentence", () => {
    expect(staffWords("", 0)).toMatch(/Could not reach the server/);
    expect(staffWords("", 429)).toMatch(/Too many requests/);
    expect(staffWords("zz_not_a_code", 409)).toBe(GENERIC);
    expect(staffWords("", 500)).toMatch(/Something went wrong/);
    expect(staffWords("bad_data", 400, "line 2: kind must be employer")).toMatch(/refused.*line 2: kind must be employer/);
  });
});

describe("the form body", () => {
  const data = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  it("joins the fixed part and the fields: numbers as numbers, ticks as booleans, text trimmed, an empty optional text left out", () => {
    const fields = [
      { name: "n", label: "n", kind: "number", min: 1, max: 50 }, { name: "t", label: "t", kind: "text", maxLength: 9 }, { name: "o", label: "o", kind: "text", maxLength: 9, optional: true },
      { name: "c", label: "c", kind: "check" }, { name: "s", label: "s", kind: "select", options: [["a", "A"]] }, { name: "x", label: "x", kind: "textarea", maxLength: 99 },
    ] as const;
    expect(bodyOf({ action: "go" }, [...fields], data({ n: "7", t: "  hi ", o: " ", c: "on", s: "a", x: " keep\tthe spaces " }))).toEqual({ action: "go", n: 7, t: "hi", c: true, s: "a", x: " keep\tthe spaces " });
    expect(bodyOf({}, [...fields], data({ n: "7", t: "hi", s: "a", x: "z" })).c).toBe(false);
  });
  it("a fresh sign-in comes back to the same page, and the address is encoded", () => {
    expect(signInAgain("/accounts")).toBe("/sign-in?next=%2Faccounts");
    expect(signInAgain("/employer-jobs?queue=scam_flag&id=4")).toBe("/sign-in?next=%2Femployer-jobs%3Fqueue%3Dscam_flag%26id%3D4");
  });
});
