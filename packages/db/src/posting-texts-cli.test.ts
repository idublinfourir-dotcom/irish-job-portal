// No database: the two command lines refuse before they connect. The end-to-end runs are in packages/db/test/job-posting.test.ts.
import { expect, it } from "vitest";
import { main as expiry } from "./job-expiry-cli.ts";
import { main as texts, POSTING_TEXTS, POSTING_TEXT_VERSION } from "./posting-texts-cli.ts";

it("the texts are marked placeholder wording", () => {
  expect(POSTING_TEXT_VERSION).toBe("placeholder-2026-11-12");
  for (const body of Object.values(POSTING_TEXTS)) expect(body).toMatch(/^PLACEHOLDER TEXT/);
  expect(Object.keys(POSTING_TEXTS)).toEqual(["sponsorship_statement", "pay_floor"]);
});
it("both commands refuse arguments and a missing login before they connect", async () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  expect(await texts(["x"], { DATABASE_URL: "postgres://x@127.0.0.1:1/x" }, log)).toBe(2);
  expect(await texts([], {}, log)).toBe(2);
  expect(await expiry(["x"], { EXPIRY_ADMIN_DATABASE_URL: "postgres://x@127.0.0.1:1/x" }, log)).toBe(2);
  expect(await expiry([], { DATABASE_URL: "postgres://x@127.0.0.1:1/x" }, log)).toBe(2); // only its own setting counts
  expect(lines.join("\n")).not.toMatch(/postgres:\/\//);
});
