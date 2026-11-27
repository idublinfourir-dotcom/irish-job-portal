// The shared parts of the staff queue pages: ages and dates, the answer words, the audit sentences, the guard and the query reader. No database, no network.
import { describe, expect, it, vi } from "vitest";
import { ageSeconds, ageText, clock, today, when } from "./age";
import { auditInitials, auditSentence } from "./audit-text";
import { guarded, one } from "./guard";
import { errorWords } from "./messages";

vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));

const NOW = new Date("2026-11-24T12:00:00Z");
const noDash = (s: string) => expect(s).not.toMatch(/[\u2013\u2014]/);

describe("ages and dates", () => {
  it("reads the database's text, with its short offset", () => {
    expect(ageText("2026-11-24 06:59:59.123456+00", NOW)).toBe("5 h");
    expect(ageText("2026-11-24 11:30:00+00", NOW)).toBe("30 min");
    expect(ageText("2026-11-21 12:00:00+00", NOW)).toBe("3 d");
    expect(ageText("2026-11-23 13:00:00+00", NOW)).toBe("23 h");
    expect(ageText("2026-11-22 11:59:00+00", NOW)).toBe("2 d");
  });
  it("a time in the future is 0 min, never negative", () => {
    expect(ageText("2026-11-25 12:00:00+00", NOW)).toBe("0 min");
  });
  it("ageSeconds uses the same units", () => {
    expect(ageSeconds(9 * 3600)).toBe("9 h");
    expect(ageSeconds(120)).toBe("2 min");
  });
  it("shows Irish time: winter is UTC, summer is one hour on", () => {
    expect(when("2026-11-09 10:42:00+00")).toBe("9 Nov 2026, 10:42");
    expect(clock("2026-07-01 10:58:00+00")).toBe("11:58");
    expect(today(new Date("2026-11-09T09:00:00Z"))).toBe("Monday 9 Nov 2026");
  });
});

describe("words for every answer", () => {
  const CODES = ["no_session", "not_active", "not_active_staff", "not_reviewer", "not_found", "already_decided", "not_claimed", "not_claimer", "claimed_by_other", "organisation_not_pending",
    "has_permit_history", "free_email_domain", "domain_owned_by_other", "bad_domain", "no_claimant", "claimant_not_active", "bad_question", "job_not_in_review", "no_advert_text", "bad_occupation_code",
    "bad_salary", "bad_input", "reauth_required", "bad_stage", "bad_tab", "bad_cursor", "bad_origin", "bad_body", "bad_action", "bad_item_id", "bad_reason", "server_error", "rules_failed", "unknown_code", ""];
  it("every code and status gives a plain sentence, never the code, and no dash", () => {
    for (const status of [0, 400, 401, 403, 404, 409, 429, 500, 502])
      for (const code of CODES) {
        const w = errorWords(code, status, "7 contract unclear");
        expect(w.length, `${status} ${code}`).toBeGreaterThan(15);
        expect(w).not.toMatch(/undefined|\[object|[a-z]+_[a-z_]+/);
        noDash(w);
      }
  });
  it("names the rules stage that stopped an approve, and says offline for status 0", () => {
    expect(errorWords("rules_failed", 409, "8 salary below 40,904")).toMatch(/8 salary below 40,904/);
    expect(errorWords("anything", 0)).toMatch(/Could not reach the server/);
    expect(errorWords("claimed_by_other", 409)).toMatch(/24 hours/);
    expect(errorWords("reauth_required", 403)).toMatch(/Sign in again/); // SEC-12: a stale approve
  });
});

describe("audit sentences", () => {
  it("a known action reads as a sentence, an unknown one as its own words", () => {
    expect(auditSentence("account_review.approved")).toBe("approved an account");
    expect(auditSentence("fetched_job.reject")).toBe("rejected a fetched job");
    expect(auditSentence("something.new_thing")).toBe("something new thing");
    for (const a of ["account_review.approved", "fetched_job.approve", "trust_safety.report_hide", "audit.export"]) noDash(auditSentence(a));
  });
  it("initials come from the name, and a missing name is a question mark", () => {
    expect(auditInitials("Dara Kelly")).toBe("DK");
    expect(auditInitials("Cher")).toBe("C");
    expect(auditInitials(null)).toBe("?");
  });
});

describe("the guard", () => {
  const fail = (code: string) => async () => { throw new Error(code); };
  it("a visitor, an ended session and a disabled login go to the sign-in page", async () => {
    for (const code of ["no_session", "not_active", "not_active_staff"]) await expect(guarded(fail(code))).rejects.toThrow("REDIRECT:/sign-in");
  });
  it("a wrong role is `refused`, with nothing read", async () => {
    for (const code of ["not_reviewer", "not_administrator", "no_role"]) expect(await guarded(fail(code))).toEqual({ refused: true });
    expect(await guarded(fail("not_reviewer: with a stage"))).toEqual({ refused: true });
  });
  it("anything else is a real fault and stays one", async () => {
    await expect(guarded(fail("connection refused"))).rejects.toThrow("connection refused");
    await expect(guarded(async () => { throw "text"; })).rejects.toBe("text");
  });
  it("a good read gives its value", async () => {
    expect(await guarded(async () => 7)).toEqual({ refused: false, value: 7 });
  });
});

describe("one query value", () => {
  it("takes a single text, and drops a repeated key or a missing one (so a hostile query falls back)", () => {
    expect(one("a")).toBe("a");
    expect(one(["a", "b"])).toBeUndefined();
    expect(one(undefined)).toBeUndefined();
  });
});
