// No database: the outbox command's input checks. The end-to-end run is packages/db/test/outbox.test.ts.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { DECISION_TEMPLATE } from "./account-review.ts";
import { main, noticeEmail, NOTICE_TEMPLATES, parseBatch } from "./outbox-cli.ts";

const SITE = "https://employers.example.ie";

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
});

// E1: every notice the code queues has its own subject and sentence, links only to the person's own site, and carries nothing stored.
describe("notice emails", () => {
  const src = (dir: string) => readdirSync(new URL(dir, import.meta.url)).filter((f) => /\.(sql|ts)$/.test(f) && !f.includes(".test.")).map((f) => readFileSync(new URL(dir + f, import.meta.url), "utf8")).join("\n");
  const code = (src("../migrations/") + src("./")).replace(/"\s*\+\s*"/g, ""); // join the SQL strings split over lines
  it("covers every template the migrations and the code queue (literal names, the decision and floor names, the strike notices)", () => {
    const queued = new Set([
      ...[...code.matchAll(/into email_outbox\s*\(template[^)]*\)\s*(?:values\s*\(|select)\s*'([a-z_-]+)'/g)].map((m) => m[1]!),
      ...[...code.matchAll(/notice\(c, id, "([a-z_]+)"\)/g)].map((m) => m[1]!),
      ...Object.values(DECISION_TEMPLATE), "pay_floor_approved", "pay_floor_rejected", // made from codes in account-review.ts and pay-floors.ts
      "owner_reassign_done", // the second row of a two-row insert in 0036_portal_notices.sql
    ]);
    queued.delete("job_alert"); // its own email (job-alert-email.ts)
    expect(queued.size).toBeGreaterThanOrEqual(25);
    expect([...queued].filter((t) => !NOTICE_TEMPLATES.includes(t))).toEqual([]);
  });
  it("each has its own subject, a sentence, a sign-in button to the given site, and no placeholder, template name or dash", () => {
    const subjects = new Set<string>();
    for (const t of NOTICE_TEMPLATES) {
      const m = noticeEmail(t, SITE);
      subjects.add(m.subject);
      for (const part of [m.subject, m.text, m.html]) {
        expect(part, t).not.toMatch(/PLACEHOLDER|[\u2013\u2014]/);
        expect(part, t).not.toContain(t);
      }
      const links = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]!);
      expect(links.every((l) => l === `${SITE}/`), t).toBe(true);
      if (t === "account_deleted") expect(links, t).toEqual([]);
      else { expect(links, t).toHaveLength(2); expect(m.text, t).toContain(`Sign in: ${SITE}/`); }
    }
    expect(subjects.size).toBe(NOTICE_TEMPLATES.length);
  });
  it("an unknown or hostile template name gets the general notice and nothing of the name", () => {
    for (const t of ["t", "x\r\nBcc: a@b.com <script>", "\"><img src=x onerror=1>"]) {
      const m = noticeEmail(t, SITE);
      expect(m.subject).toBe("News about your account");
      expect(m.subject + m.text + m.html).not.toMatch(/Bcc|<script|<img|onerror/);
    }
  });
  it("with no site known (a staff or contact row) there is no button and no link", () => {
    expect(noticeEmail("team_removed", null).html).not.toContain("href=");
  });
});
