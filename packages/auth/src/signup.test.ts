// No database: the sign-up answer checks and the fake email sender.
import { describe, expect, it } from "vitest";
import { checkSignup, createFakeEmail, readAnswers } from ".";

const yes = { needsPermit: true, over18: true, acceptsTerms: true };

describe("the three sign-up answers", () => {
  it("pass only when each one is the plain value true", () => {
    expect(readAnswers(yes).answers).toEqual(yes);
    expect(readAnswers({ ...yes, extra: "ignored" }).answers).toEqual(yes);
  });
  it("a 'no' to needing a permit says so, and anything else not true is refused", () => {
    expect(readAnswers({ ...yes, needsPermit: false }).error).toMatch(/need a work permit/);
    const odd = [false, undefined, null, 0, 1, "true", "yes", "on", [], [true], {}, { value: true }, { $ne: null }, "'; drop table x;--", "x".repeat(100000)];
    for (const field of ["needsPermit", "over18", "acceptsTerms"])
      for (const v of odd) expect(readAnswers({ ...yes, [field]: v }).answers, `${field}=${JSON.stringify(v)?.slice(0, 20)}`).toBeUndefined();
  });
  it("a missing, empty or non-object body is refused", () => {
    for (const body of [undefined, null, "", "true", 5, [], [yes], {}]) expect(readAnswers(body).answers, JSON.stringify(body)).toBeUndefined();
  });
  it("checkSignup throws a 400 for bad answers and for a name that is empty, blank or over 100 characters", () => {
    expect(checkSignup({ ...yes, name: "Fake Person" }, true)).toEqual(yes);
    expect(() => checkSignup({ ...yes, over18: false, name: "A" }, true)).toThrow(/18/);
    for (const name of ["", "   ", "x".repeat(101), 5, null, undefined, { a: 1 }]) expect(() => checkSignup({ ...yes, name }, true), String(name)).toThrow(/Name/);
    expect(checkSignup({ ...yes, name: "x".repeat(100) }, true)).toEqual(yes);
    expect(checkSignup(yes, false)).toEqual(yes); // the account step (and Google) have no name to check
  });
});

describe("the fake email sender (#174)", () => {
  it("keeps each email in memory and prints the link", async () => {
    const lines: string[] = [];
    const mail = createFakeEmail("http://localhost:3000", (l) => lines.push(l));
    await mail.send("candidate", "verify", "a@example.test", "http://localhost:3000/api/auth/candidate/verify-email?token=t");
    await mail.send("candidate", "reset", "b@example.test", "http://localhost:3000/r");
    expect(mail.outbox).toEqual([
      { pool: "candidate", kind: "verify", to: "a@example.test", link: "http://localhost:3000/api/auth/candidate/verify-email?token=t" },
      { pool: "candidate", kind: "reset", to: "b@example.test", link: "http://localhost:3000/r" },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("verify-email?token=t");
  });
  it("starts for localhost and 127.0.0.1 only, so a deploy can never quietly send nothing", () => {
    expect(() => createFakeEmail("http://127.0.0.1:3000")).not.toThrow();
    for (const bad of ["https://candidate.example.test", "https://localhost.example.test", "http://localhost.example.test", "https://127.0.0.1.example.test"])
      expect(() => createFakeEmail(bad), bad).toThrow(/only on localhost/);
    expect(() => createFakeEmail("not a url")).toThrow();
  });
});
