// Unit tests (no database, network or browser) for step 15 Q11 and Q15's pure parts: which counts a staff member's roles cover (with a recording fake
// database), the digest's numbers, and the invite's input checks.
import { describe, expect, it } from "vitest";
import { digestParams, QUEUE_ROLES, staffCounts } from "./staff-counts";
import { inviteStaff, STAFF_EMAIL, STAFF_ROLE_LIST, validStaffName } from "./staff-admin";
import { PLAIN_EMAIL } from "./staff-seed-cli";
import { QueueRefused } from "./admin-queue";

const recorder = () => {
  const params: unknown[][] = [];
  const db = { query: async (_sql: string, p: unknown[]) => (params.push(p), { rows: [{ queues: {}, reports_open: null, reports_new: null, appeals: null, contact: null, approvals: null, cases_unassigned: null, cases_mine: null }] }) };
  return { db: db as never, params };
};

describe("staffCounts: what each role's counts cover", () => {
  it("passes each role only its own queues and flags", async () => {
    const seen = async (roles: string[]) => { const r = recorder(); await staffCounts(r.db, "s1", roles); return r.params[0]!; };
    expect(await seen(["trust_and_safety"])).toEqual([["scam_flag"], ["trust_and_safety"], true, true, false, false, "s1", false]);
    expect(await seen(["fetched_job_reviewer"])).toEqual([["fetched_job", "scheduled_check"], ["fetched_job_reviewer"], false, false, false, false, "s1", false]);
    expect(await seen(["content_editor"])).toEqual([[], ["content_editor"], false, false, true, false, "s1", false]);
    // an administrator: every queue but the two that need their own role, every reminder, appeals, contact and approvals, but not the report inbox
    const a = await seen(["administrator"]);
    expect(a[0]).toEqual(Object.keys(QUEUE_ROLES).filter((q) => q !== "fetched_job" && q !== "account_review"));
    expect(a.slice(1)).toEqual([QUEUE_ROLES.scheduled_check, false, true, true, true, "s1", false]);
    expect(await seen([])).toEqual([[], [], false, false, false, false, "s1", false]);
  });
  it("every role in the map is a real role", () => {
    for (const roles of Object.values(QUEUE_ROLES)) for (const r of roles) expect(STAFF_ROLE_LIST).toContain(r);
  });
});

describe("digestParams", () => {
  it("keeps only counts above zero, flat", () => {
    expect(digestParams({ queues: { scam_flag: 2, fetched_job: 0 }, reportsOpen: 3, reportsNew: 0, appeals: null, contact: 1, approvals: null, casesUnassigned: 2, casesMine: 0 }))
      .toEqual({ scam_flag: 2, reportsOpen: 3, contact: 1, casesUnassigned: 2 });
    expect(digestParams({ queues: {}, reportsOpen: null, reportsNew: null, appeals: 0, contact: null, approvals: null, casesUnassigned: null, casesMine: null })).toEqual({});
  });
});

describe("invite input checks (before any database call)", () => {
  const none = { query: async () => { throw new Error("the database was called"); }, connect: async () => { throw new Error("the database was called"); } } as never;
  it("uses the seed command's email rule", () => expect(STAFF_EMAIL.source).toBe(PLAIN_EMAIL.source));
  it("refuses a bad email, name or role", async () => {
    const why = (e: unknown, n: unknown, r: unknown) => inviteStaff(none, "s1", e, n, r).then(() => "ok", (x: QueueRefused) => x.why);
    for (const e of ["", "no-at", "a@b", "a b@example.test", `${"a".repeat(250)}@example.test`, "x@example.test'; drop table staff_user;--", 5, null, ["a@b.ie"]])
      expect(await why(e, "Fake", "content_editor"), String(e)).toBe("bad_email");
    for (const n of ["", "   ", "x".repeat(101), "a\nb", "a\u0000", 5, null]) expect(await why("ok@example.test", n, "content_editor"), String(n)).toBe("bad_name");
    for (const r of ["owner", "Administrator", "", 5]) expect(await why("ok@example.test", "Fake", r)).toBe("bad_role");
    expect(validStaffName("Fake Person")).toBe(true);
  });
});
