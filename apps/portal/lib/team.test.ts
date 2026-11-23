// No database: the team POST body checks per action, the invite token, and the refusal codes. The 7-day expiry is the database's
// (team_invite), tested in packages/db/test/teams.test.ts.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkTeam, hashToken, newToken, teamRefusal } from "./team";

const token = newToken().token;

describe("checkTeam", () => {
  it("takes each action with exactly its own fields", () => {
    expect(checkTeam({ action: "invite", email: "  Fake.One@Example.TEST ", role: "poster", isSigner: true })).toEqual({ action: "invite", email: "fake.one@example.test", role: "poster", isSigner: true });
    expect(checkTeam({ action: "accept", token })).toEqual({ action: "accept", token });
    expect(checkTeam({ action: "request", organisationId: "7" })).toEqual({ action: "request", organisationId: "7" });
    for (const action of ["refuse", "remove", "transfer", "resend"]) expect(checkTeam({ action, membershipId: "3" })).toEqual({ action, membershipId: "3" });
    expect(checkTeam({ action: "approve", membershipId: "3", role: "poster", isSigner: true })).toEqual({ action: "approve", membershipId: "3", role: "poster", isSigner: true });
    expect(checkTeam({ action: "leave" })).toEqual({ action: "leave" });
    expect(checkTeam({ action: "role", membershipId: "3", role: "viewer", isSigner: false })).toEqual({ action: "role", membershipId: "3", role: "viewer", isSigner: false });
  });
  it("refuses an unknown action, a missing field and any extra field, a user or company id above all", () => {
    for (const bad of [null, [], "leave", 1, {}, { action: "LEAVE" }, { action: "delete" }, { action: ["leave"] },
      { action: "leave", portalUserId: "x" }, { action: "remove", membershipId: "3", organisationId: 9 }, { action: "transfer", membershipId: "3", userId: "x" },
      { action: "accept", token, email: "x@example.test" }, { action: "request", organisationId: "7", role: "account_owner" },
      { action: "invite", email: "a@example.test", role: "poster" }, { action: "invite", email: "a@example.test", role: "poster", isSigner: true, organisationId: 2 },
      { action: "role", membershipId: "3", role: "poster" }, { action: "approve" }, { action: "approve", membershipId: "3" },
      { action: "approve", membershipId: "3", role: "account_owner", isSigner: false }, { action: "approve", membershipId: "3", role: "poster", isSigner: "yes" }, { action: "remove", membershipId: "3", ...JSON.parse('{"__proto__": {"x": 1}}') }])
      expect(checkTeam(bad), JSON.stringify(bad)).toBeNull();
  });
  it("never takes the owner role, and only the three others", () => {
    for (const role of ["account_owner", "owner", "admin", "Viewer", "", null, 1, ["poster"]]) {
      expect(checkTeam({ action: "invite", email: "a@example.test", role, isSigner: false }), String(role)).toBeNull();
      expect(checkTeam({ action: "role", membershipId: "3", role, isSigner: false }), String(role)).toBeNull();
    }
  });
  it("refuses odd ids, odd switches and odd emails", () => {
    for (const membershipId of [0, -1, 1.5, 3, "0", "03", "9".repeat(19), 2 ** 53, Infinity, null, [3], { id: 3 }, "3 or 1=1"])
      for (const action of ["remove", "resend"]) expect(checkTeam({ action, membershipId }), `${action} ${String(membershipId)}`).toBeNull();
    for (const extra of [{ email: "a@b.test" }, { role: "poster" }, { token: "x" }, { isSigner: true }]) expect(checkTeam({ action: "resend", membershipId: "3", ...extra })).toBeNull(); // a resend takes only the id, never a new address or role
    for (const isSigner of ["true", 1, null]) expect(checkTeam({ action: "invite", email: "a@example.test", role: "poster", isSigner })).toBeNull();
    for (const email of ["", "a", "a@b", "@example.test", "a@@example.test", "a b@example.test", `${"x".repeat(250)}@example.test`, "a@example.test\u0000",
      "a​@example.test", "a\n@example.test", 42, null, ["a@example.test"], "x'; drop table membership;--@example.test x"])
      expect(checkTeam({ action: "invite", email, role: "viewer", isSigner: false }), JSON.stringify(email)).toBeNull();
    // SQL-looking but a valid address shape: kept as plain text for the parameterised call
    expect(checkTeam({ action: "invite", email: "o'brien@example.test", role: "viewer", isSigner: false })).not.toBeNull();
  });
  it("refuses a token that is not 32 bytes of base64url", () => {
    for (const t of ["", "x", token.slice(1), `${token}x`, token.replace(/.$/, "="), token.replace(/^./, "+"), "' or 1=1 --".padEnd(43, "x"), 43, null])
      expect(checkTeam({ action: "accept", token: t }), String(t)).toBeNull();
  });
});

describe("the invite token", () => {
  it("is 32 random bytes as base64url, and the database gets only its sha256 in hex", () => {
    const a = newToken(), b = newToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.token, "base64url")).toHaveLength(32);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(createHash("sha256").update(a.token).digest("hex"));
    expect(hashToken(a.token)).toBe(a.hash);
    expect(a.hash).not.toContain(a.token);
    expect([a.token === b.token, a.hash === b.hash]).toEqual([false, false]);
  });
});

describe("teamRefusal", () => {
  const p = (message: string) => ({ code: "P0001", message });
  it("maps each function refusal to its code and status", () => {
    const want: [string, number][] = [["NOT_OWNER", 403], ["NOT_A_MEMBER", 403], ["MEMBER_NOT_FOUND", 404], ["TEAM_FULL", 409], ["ALREADY_IN_TEAM", 409],
      ["INVITE_NOT_VALID", 404], ["ALREADY_IN_A_COMPANY", 409], ["NOT_ALLOWED_DOMAIN", 403], ["OWNER_MUST_TRANSFER", 409], ["VIEWER_NOT_SIGNER", 400],
      ["ORGANISATION_NOT_AVAILABLE", 409], ["EMAIL_NOT_VERIFIED", 403], ["BAD_REQUEST", 400]];
    for (const [code, status] of want) expect(teamRefusal(p(`team refused: ${code} some detail`)), code).toEqual({ status, code });
    expect(teamRefusal({ code: "23505", constraint: "one_company_per_login" })).toEqual({ status: 409, code: "ALREADY_IN_A_COMPANY" });
    expect(teamRefusal({ code: "23505", constraint: "membership_org_user_unique" })?.code).toBe("ALREADY_IN_A_COMPANY");
    expect(teamRefusal({ code: "23505", constraint: "membership_org_invite_unique" })).toEqual({ status: 409, code: "ALREADY_IN_TEAM" });
  });
  it("gives a banned domain, a blocked login, an unknown code and any other function refusal the same REFUSED (#191)", () => {
    for (const m of ["team refused: REFUSED banned email domain", "team refused: REFUSED unknown, blocked or deleted login", "team refused: SOMETHING_NEW", "team refused: lower", "other refusal"])
      expect(teamRefusal(p(m)), m).toEqual({ status: 403, code: "REFUSED" });
  });
  it("leaves every other error alone, so it is a 500 and not a quiet refusal", () => {
    for (const e of [{ code: "23505", constraint: "one_owner_per_org" }, { code: "42501" }, { code: "40P01" }, new Error("boom"), null, undefined]) expect(teamRefusal(e)).toBeNull();
  });
});
