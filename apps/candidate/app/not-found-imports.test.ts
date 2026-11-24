// Security: the 404 and error pages read nothing (no data layer, no database).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("not-found and error pages", () => {
  for (const f of ["not-found.tsx", "error.tsx"]) it(`${f} imports no data layer`, () => expect(readFileSync(new URL(f, import.meta.url), "utf8")).not.toMatch(/lib\/|@portal\/db/));
});
