// The Postgres image tag is written in two places (4a open item 1). They must be the same.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

it("the Postgres image tag in test-db.sh and .github/workflows/check.yml is the same", () => {
  const sh = read("./test-db.sh").match(/^IMAGE=(?:docker\.io\/)?(supabase\/postgres:\S+)/m)?.[1];
  const yml = read("../../../.github/workflows/check.yml").match(/^\s*image:\s*(?:docker\.io\/)?(supabase\/postgres:\S+)/m)?.[1];
  expect(sh).toBeTruthy();
  expect(yml).toBe(sh);
});
