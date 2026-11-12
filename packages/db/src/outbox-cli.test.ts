// No database: the outbox command's input checks. The end-to-end run is packages/db/test/outbox.test.ts.
import { describe, expect, it } from "vitest";
import { main, noticeText, parseBatch } from "./outbox-cli.ts";

describe("outbox command input checks", () => {
  it("takes no argument or --batch 1..200", () => {
    expect(parseBatch([])).toBe(50);
    expect(parseBatch(["--batch", "7"])).toBe(7);
    for (const bad of [["--batch"], ["--batch", "0"], ["--batch", "201"], ["--batch", "-1"], ["--batch", "5; drop table x"], ["--batches", "5"], ["5"], ["--batch", "5", "x"], ["--batch", "1e2"]])
      expect(parseBatch(bad), bad.join(" ")).toBeUndefined();
  });
  it("refuses before it connects when the input or a setting is missing, and never falls back to a fake sender", async () => {
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    expect(await main(["--batch", "0"], { DATABASE_URL: "postgres://x@127.0.0.1:1/x" }, log)).toBe(2);
    expect(await main([], {}, log)).toBe(2);
    expect(await main([], { DATABASE_URL: "postgres://x@127.0.0.1:1/x" }, log)).toBe(2);
    expect(await main([], { DATABASE_URL: "postgres://x@127.0.0.1:1/x", BREVO_API_KEY: "k" }, log)).toBe(2);
    expect(lines.join("\n")).toMatch(/usage[\s\S]*DATABASE_URL is not set[\s\S]*nothing was sent[\s\S]*nothing was sent/);
  });
  it("keeps odd characters of a template name out of the text", () => {
    expect(noticeText("strike_case_opened")[1]).toContain("(strike_case_opened)");
    expect(noticeText("x\r\nBcc: a@b.com <script>")[1]).not.toMatch(/[\r<@]|Bcc: /);
  });
});
