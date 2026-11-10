// The Postgres image tag is written in two places (4a open item 1). They must be the same.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

it("the Postgres image tag in test-db.sh and .github/workflows/check.yml is the same", () => {
  const sh = read("./test-db.sh").match(/^IMAGE=(?:docker\.io\/)?(supabase\/postgres:\S+)/m)?.[1];
  // every job in the workflow (check and perf) must use it
  const yml = [...read("../../../.github/workflows/check.yml").matchAll(/^\s*image:\s*(?:docker\.io\/)?(supabase\/postgres:\S+)/gm)].map((m) => m[1]);
  expect(sh).toBeTruthy();
  expect(yml.length).toBeGreaterThan(0);
  for (const tag of yml) expect(tag).toBe(sh);
});
