// Unit: store.ts holds no SQL built from a value. Every statement is a constant, every value goes in as a parameter.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");

describe("store.ts", () => {
  it("every SQL constant is a plain string with no placeholder for a value", () => {
    const consts = [...src.matchAll(/^const ([A-Z_]+) =\s*([\s\S]*?);$/gm)];
    expect(consts.length).toBeGreaterThanOrEqual(12);
    for (const [, name, body] of consts) {
      expect(body, name).not.toContain("`");
      expect(body, name).not.toContain("${");
    }
  });

  it("every query call passes a constant, or begin, commit or rollback", () => {
    const calls = [...src.matchAll(/\bquery(?:<[^(]*?>)?\(\s*([^,)\s]+)/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThanOrEqual(12);
    for (const first of calls) expect(first).toMatch(/^([A-Z_]+|"begin"|"commit"|"rollback")$/);
  });
});
