import { describe, expect, it } from "vitest";
import { checkContact, CONTACT_TOPICS, handleContact, MAX_CONTACT_BODY, MAX_EMAIL, MAX_MESSAGE, MAX_NAME } from "./contact";

const visitor = { topic: "general", name: "Fake Person", email: "fake.person@example.test", body: "Hello" };
const ok = (b: unknown, signedIn = false) => checkContact(b, signedIn);
const without = (k: string) => Object.fromEntries(Object.entries(visitor).filter(([x]) => x !== k));

describe("checkContact", () => {
  it("accepts every topic, and the length edges", () => {
    for (const topic of CONTACT_TOPICS) expect(ok({ ...visitor, topic })).toEqual({ ...visitor, topic });
    for (const n of [1, MAX_MESSAGE]) expect(ok({ ...visitor, body: "x".repeat(n) })?.body.length).toBe(n);
    for (const n of [1, MAX_NAME]) expect(ok({ ...visitor, name: "n".repeat(n) })?.name?.length).toBe(n);
  });
  it("refuses a body of 0 or 5,001 characters, a blank one, and a name over 120", () => {
    for (const body of ["", " \n\t ", "x".repeat(MAX_MESSAGE + 1)]) expect(ok({ ...visitor, body }), String(body.length)).toBeNull();
    for (const name of ["", "  ", "n".repeat(MAX_NAME + 1)]) expect(ok({ ...visitor, name }), String(name.length)).toBeNull();
  });
  it("counts characters as the database does: an emoji is one", () => {
    expect(ok({ ...visitor, body: "😀".repeat(MAX_MESSAGE) })).not.toBeNull();
    expect(ok({ ...visitor, body: "😀".repeat(MAX_MESSAGE + 1) })).toBeNull();
  });
  it("an email of 254 characters is allowed, 255 is not, and it must look like an address", () => {
    const local = (n: number) => `${"a".repeat(n - "@example.test".length)}@example.test`;
    expect(ok({ ...visitor, email: local(MAX_EMAIL) })).not.toBeNull();
    expect(ok({ ...visitor, email: local(MAX_EMAIL + 1) })).toBeNull();
    for (const email of ["", "plain", "a@b", "@example.test", "a@@example.test", "a b@example.test", "a@example.test\nBcc: x@example.test", "a@exa mple.test", 5, null, ["a@example.test"]])
      expect(ok({ ...visitor, email }), String(email)).toBeNull();
  });
  it("a visitor needs a name and an email; a signed-in sender may leave them out", () => {
    for (const k of ["name", "email"]) {
      expect(ok(without(k)), k).toBeNull();
      expect(ok(without(k), true), k).not.toBeNull();
    }
    expect(ok(without("name"), true)).toMatchObject({ name: null });
    expect(ok({ ...visitor, name: "" }, true)).toBeNull(); // given, so it must be good
  });
  it("refuses unknown fields, including ids and statuses", () => {
    for (const extra of [{ candidateUserId: "x" }, { portalUserId: "x" }, { status: "answered" }, { surface: "portal" }, { id: 1 }, { claimed_by_staff_user_id: "x" }, { extra: 1 }])
      expect(ok({ ...visitor, ...extra }), JSON.stringify(extra)).toBeNull();
    expect(ok(JSON.parse('{"topic":"general","name":"a","email":"a@example.test","body":"b","__proto__":{"a":1}}'))).toBeNull();
  });
  it("refuses the wrong types, topics and shapes", () => {
    const bad: unknown[] = [null, undefined, "text", 5, [], [visitor], {}, { ...visitor, topic: "spam" }, { ...visitor, topic: "GENERAL" }, { ...visitor, topic: ["general"] }, { ...visitor, topic: null }, { ...visitor, topic: "constructor" },
      { ...visitor, body: 5 }, { ...visitor, body: null }, { ...visitor, body: ["a"] }, { ...visitor, body: { a: 1 } }, { ...visitor, name: { a: 1 } }, { ...visitor, name: ["a"] }, { ...visitor, name: null }];
    for (const b of bad) expect(ok(b), JSON.stringify(b)).toBeNull();
  });
  it("the message may hold newline and tab; no other control or format character, in any field", () => {
    expect(ok({ ...visitor, body: "line one\n\tline two" })?.body).toBe("line one\n\tline two");
    for (const c of ["\u0000", "\r", "\u001b", "\u007f", "‮", "​", "⁦", "﻿", "\ud800"]) {
      expect(ok({ ...visitor, body: `a${c}b` }), `body ${c.charCodeAt(0)}`).toBeNull();
      expect(ok({ ...visitor, name: `a${c}b` }), `name ${c.charCodeAt(0)}`).toBeNull();
      expect(ok({ ...visitor, email: `a${c}b@example.test` }), `email ${c.charCodeAt(0)}`).toBeNull();
    }
    expect(ok({ ...visitor, name: "a\nb" })).toBeNull();
  });
});

// These refusals come before any database call, so no database is needed.
describe("handleContact, before the database", () => {
  const ORIGIN = "https://candidates.example.test";
  const env = { origin: ORIGIN, side: "candidate" as const, secret: "s", login: async () => ({ refused: "no_session" as const }) };
  const post = (body: string, headers: Record<string, string> = { origin: ORIGIN }) => handleContact(new Request(`${ORIGIN}/api/contact`, { method: "POST", body, headers }), env);
  const code = async (r: Response) => [r.status, ((await r.json()) as { code: string }).code];
  it("refuses a foreign or missing Origin, an oversized body and bad JSON", async () => {
    expect(await code(await post("{}", { origin: "https://evil.example" }))).toEqual([403, "BAD_ORIGIN"]);
    expect(await code(await post("{}", {}))).toEqual([403, "BAD_ORIGIN"]);
    expect(await code(await post("{}", { origin: ORIGIN, "content-length": String(MAX_CONTACT_BODY + 1) }))).toEqual([413, "BODY_TOO_LARGE"]);
    expect(await code(await post(" ".repeat(MAX_CONTACT_BODY + 1)))).toEqual([413, "BODY_TOO_LARGE"]);
    expect(await code(await post("not json"))).toEqual([400, "BAD_REQUEST"]);
  });
  it("the cap lets the largest good body through", () => {
    const biggest = JSON.stringify({ topic: "general", name: "n".repeat(MAX_NAME), email: `${"a".repeat(MAX_EMAIL - 13)}@example.test`, body: "\n".repeat(MAX_MESSAGE) });
    expect(biggest.length).toBeLessThan(MAX_CONTACT_BODY);
  });
  it("the portal side needs a login", async () => {
    const r = await handleContact(new Request(`${ORIGIN}/api/portal/contact`, { method: "POST", body: JSON.stringify(visitor), headers: { origin: ORIGIN } }), { ...env, side: "portal" });
    expect(await code(r)).toEqual([401, "NO_SESSION"]);
  });
});
