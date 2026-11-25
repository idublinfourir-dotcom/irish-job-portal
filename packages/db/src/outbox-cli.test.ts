// No database: the outbox command's input checks. The end-to-end run is packages/db/test/outbox.test.ts.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { DECISION_TEMPLATE } from "./account-review.ts";
import { confirmEmail, digestLines, limitWarning, main, noticeEmail, NOTICE_TEMPLATES, parseBatch, sendOrder } from "./outbox-cli.ts";

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
    queued.delete("data_request_confirm"); // its own email (confirmEmail, below)
    expect(queued.size).toBeGreaterThanOrEqual(25);
    expect([...queued].filter((t) => !NOTICE_TEMPLATES.includes(t))).toEqual([]);
  });
  it("the data request confirm email (0050): one button to the site's /data-request page with the token, the link in the text, no dash", () => {
    const token = "A".repeat(43), m = confirmEmail("https://www.example.test", token);
    expect(m.subject).toBe("Please confirm your data request");
    expect([...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1])).toEqual([`https://www.example.test/data-request?token=${token}`]);
    expect(m.text).toContain(`https://www.example.test/data-request?token=${token}`);
    for (const part of [m.subject, m.text, m.html]) expect(part).not.toMatch(/PLACEHOLDER|[\u2013\u2014]/);
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
      else { expect(links, t).toHaveLength(1); expect(m.text, t).toContain(`Sign in: ${SITE}/`); }
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
  it("the staff digest shows only whole numbers above zero under fixed labels, and nothing else from params (Q11)", () => {
    expect(digestLines({ scam_flag: 2, reportsOpen: 1, contact: 0, appeals: -1, approvals: 1.5, fetched_job: "3", unknown: 9, data_request: Number.MAX_SAFE_INTEGER + 2 }))
      .toEqual(["Jobs flagged for scam wording: 2", "Open reports: 1"]);
    for (const p of [null, "x", [1], 5]) expect(digestLines(p)).toEqual([]);
    const m = noticeEmail("staff_digest", null, digestLines({ "<script>": 1, reportsNew: 4 }));
    expect(m.text).toContain("Reports in the last 24 hours: 4");
    expect(m.html + m.text).not.toMatch(/<script|href=/);
  });
  it("a candidate notice (settings on) ends with a Notification settings link on the site; with no site, or off, there is none (B75)", () => {
    const m = noticeEmail("account_merged", SITE, [], true);
    expect(m.html).toContain(`href="${SITE}/account/settings"`);
    expect(m.text).toContain(`Notification settings: ${SITE}/account/settings`);
    expect(noticeEmail("account_merged", SITE).html).not.toContain("/account/settings");
    expect(noticeEmail("account_merged", null, [], true).html).not.toContain("href=");
    for (const part of [m.text, m.html]) expect(part).not.toMatch(/Unsubscribe|[\u2013\u2014]/);
  });
  it("with no site known (a staff or contact row) there is no button and no link", () => {
    expect(noticeEmail("team_removed", null).html).not.toContain("href=");
  });
});

// #275: the send order and the limit warning, no database.
describe("the email limit (#275)", () => {
  const r = (id: number, template: string, minsAgo: number) => ({ id: String(id), template, send_after: new Date(Date.UTC(2026, 10, 19) - minsAgo * 60_000) });
  it("every row that is not a job alert goes first, then oldest first, then by id", () => {
    const rows = [r(1, "job_alert", 90), r(2, "staff_digest", 1), r(3, "job_alert", 100), r(4, "data_request_confirm", 5), r(5, "account_approved", 5), r(6, "job_alert", 100)];
    expect(rows.sort(sendOrder).map((x) => x.id)).toEqual(["4", "5", "2", "3", "6", "1"]);
  });
  it("warns only when rows are left or an alert went stale, with counts only", () => {
    const res = { sent: 200, retry: 0, failed: 0, dropped: 0, old: 0 };
    expect(limitWarning(res, 0)).toBeNull();
    expect(limitWarning({ ...res, dropped: 3 }, 0)).toBeNull(); // no address or nothing to send: not a limit problem
    expect(limitWarning(res, 70)).toBe("::warning::email outbox (#275, Brevo Free 300 a day): 70 emails left unsent; dropped this run: 0 job alerts too old (over 3 days), 0 with no address or nothing to send");
    expect(limitWarning({ ...res, dropped: 5, old: 2 }, 0)).toMatch(/^::warning::.* 0 emails left unsent; dropped this run: 2 job alerts too old .*, 3 with no address/);
  });
  it("the digest shows the email limit numbers with fixed labels, and nothing else from params", () => {
    expect(digestLines({ emailsLeft: 70, alertsTooOld: 2, alertSubscribers: 151, email: "x@example.test" })).toEqual([
      "Emails left unsent by the last send run: 70", "Job alerts dropped as too old in the last send run: 2", "Active job alert subscribers: 151"]);
  });
});
