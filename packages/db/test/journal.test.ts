import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const dir = new URL("../migrations/", import.meta.url);
const entries: { tag: string; when: number }[] = JSON.parse(readFileSync(new URL("meta/_journal.json", dir), "utf8")).entries;

// drizzle only applies a migration whose time is later than the last one applied, and only if it is in the journal.
// Either mistake skips a migration silently, so check both.
test("every migration file is in the journal, and the journal times only go up", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, ""));
  expect(entries.map((e) => e.tag)).toEqual(files.sort());
  const times = entries.map((e) => e.when);
  expect(times).toEqual([...times].sort((a, b) => a - b));
  expect(new Set(times).size).toBe(times.length);
});
