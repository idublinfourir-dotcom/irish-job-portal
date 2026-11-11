// No database: the seed command's input checks. The end-to-end run is packages/db/test/staff-login.test.ts.
import { describe, expect, it } from "vitest";
import { main, parseSeedArgs, passwordProblem, STAFF_ROLES } from "./staff-seed-cli.ts";

const ok = (email: string, name = "Fake Person", roles = "administrator") => parseSeedArgs([email, name, roles]);

describe("staff seed input checks", () => {
  it("takes a plain email (lowercased), a name and known roles (deduplicated)", () => {
    expect(ok("  Fake.Owner@Example.TEST ", " Fake Owner ", "administrator,fetched_job_reviewer,administrator").input)
      .toEqual({ email: "fake.owner@example.test", name: "Fake Owner", roles: ["administrator", "fetched_job_reviewer"] });
    for (const r of STAFF_ROLES) expect(ok("a@example.test", "A", r).input?.roles).toEqual([r]);
  });
  it("refuses odd emails", () => {
    for (const bad of ["", "no-at-sign", "a@b", "a@@example.test", "a b@example.test", "a@example.test\nb@example.test", "a@example.test;drop", "'or'1'='1@x.test",
      "a@-", `${"a".repeat(250)}@example.test`, "a@example.test,b@example.test", "<a@example.test>", "a@exa mple.test"])
      expect(ok(bad).error, bad).toMatch(/email/);
  });
  it("refuses an empty or very long name, or one with control characters", () => {
    for (const bad of ["", "   ", "x".repeat(101), "Fake\nName", "Fake\u0000", "Fake\u001b[31m"]) expect(ok("a@example.test", bad).error, JSON.stringify(bad)).toMatch(/name/);
    expect(ok("a@example.test", "x".repeat(100)).input).toBeDefined();
    // SQL-looking text is only text: it is passed as a parameter, never pasted into SQL
    expect(ok("a@example.test", "Robert'); drop table staff_user;--").input?.name).toBe("Robert'); drop table staff_user;--");
  });
  it("refuses unknown roles, an empty role list and SQL-looking roles", () => {
    for (const bad of ["", ",", "owner", "Administrator", "administrator,owner", "administrator'); --", "fetched_job_reviewer ;drop"])
      expect(ok("a@example.test", "A", bad).error, bad).toMatch(/unknown role/);
  });
  it("refuses the wrong number of arguments", () => {
    expect(parseSeedArgs([]).error).toMatch(/usage/);
    expect(parseSeedArgs(["a@example.test", "A", "administrator", "--password=x"]).error).toMatch(/usage/);
  });
  it("passwords: 12 to 128 characters", () => {
    expect(passwordProblem("")).toMatch(/at least 12/);
    expect(passwordProblem("a".repeat(11))).toMatch(/at least 12/);
    expect(passwordProblem("a".repeat(12))).toBeNull();
    expect(passwordProblem("a".repeat(128))).toBeNull();
    expect(passwordProblem("a".repeat(129))).toMatch(/at most 128/);
  });
  it("main refuses before asking for the password or connecting when the input or the owner login is missing", async () => {
    const lines: string[] = [];
    let asked = 0;
    const read = async () => (asked++, "a-strong-password-123");
    expect(await main(["bad", "A", "administrator"], { DATABASE_URL_MIGRATE: "postgres://x@127.0.0.1:1/x" }, (l) => lines.push(l), read)).toBe(2);
    expect(await main(["a@example.test", "A", "administrator"], {}, (l) => lines.push(l), read)).toBe(2);
    expect(asked).toBe(0);
    expect(await main(["a@example.test", "A", "administrator"], { DATABASE_URL_MIGRATE: "postgres://x@127.0.0.1:1/x" }, (l) => lines.push(l), async () => "short")).toBe(2);
    expect(lines.join("\n")).toMatch(/email[\s\S]*DATABASE_URL_MIGRATE[\s\S]*at least 12/);
  });
});
