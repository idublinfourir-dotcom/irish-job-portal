// The step 13d routes' shared body check, query check and refusal map. No database.
import { StaffRefused } from "@portal/auth";
import { QueueRefused } from "@portal/db";
import { describe, expect, it, vi } from "vitest";
import { BadRequest, checkLength, id19, parseBody, readQuery, reasonCode, refuse, staffIdOk, type Field, type Spec } from "./admin-api";

const ACTIONS: Record<string, Spec> = { one: { need: ["id"] }, two: { need: ["id"], may: ["reason"] } };
const FIELDS: Record<string, Field> = { id: [id19, "bad_id"], reason: [reasonCode, "bad_reason"] };
const why = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof BadRequest ? e.message : "other"; } return "ok"; };
const body = (b: unknown, max = 100) => why(() => parseBody(typeof b === "string" ? b : JSON.stringify(b), max, ACTIONS, FIELDS));

describe("parseBody", () => {
  it("accepts each action with exactly its fields", () => {
    expect(body({ action: "one", id: "12" })).toBe("ok");
    expect(body({ action: "two", id: "12", reason: "no_evidence" })).toBe("ok");
  });
  it("refuses hostile bodies", () => {
    for (const b of ["", "x", "null", "[]", "1", '"one"', "{", "x".repeat(101)]) expect(body(b), b).toBe("bad_body");
    for (const a of ["toString", "constructor", "__proto__", "", null, 5, "drop"]) expect(body({ action: a, id: "1" }), String(a)).toBe("bad_action");
    expect(body({ action: "one", id: "1", extra: 1 })).toBe("bad_body");
    expect(body({ action: "one", id: "1", reason: "x" })).toBe("bad_body"); // a field of another action
    expect(body({ action: "one" })).toBe("bad_id");
    for (const id of [12, null, "", "0", "01", "-1", "1.5", "1e3", "1 or 1=1", "12345678901234567890", ["1"], { a: 1 }]) expect(body({ action: "one", id }), String(id)).toBe("bad_id");
    for (const r of ["", "Bad", "has space", "1abc", "a;b", "a‮b", "a".repeat(64), 5, null]) expect(body({ action: "two", id: "1", reason: r }, 500), String(r)).toBe("bad_reason");
  });
  it("ids and codes are checked as text", () => {
    expect(staffIdOk("abc_DEF-123")).toBe(true);
    for (const v of ["", "a b", "a".repeat(65), "ａ", 5, null]) expect(staffIdOk(v), String(v)).toBe(false);
  });
});

describe("checkLength and readQuery", () => {
  it("refuses a declared length over the limit, and passes a missing or odd header", () => {
    expect(why(() => checkLength("101", 100))).toBe("bad_body");
    for (const h of [null, "", "100", "x"]) expect(why(() => checkLength(h, 100)), String(h)).toBe("ok");
  });
  it("allows only the named parameters, each once", () => {
    expect(readQuery("http://x.test/a?id=1&after=abc", ["id", "after"])).toEqual({ id: "1", after: "abc" });
    expect(readQuery("http://x.test/a", [])).toEqual({});
    for (const url of ["http://x.test/a?x=1", "http://x.test/a?id=1&id=2", "http://x.test/a?id=1&kind=x"]) expect(why(() => readQuery(url, ["id"])), url).toBe("bad_query");
    // hostile spellings of a key are other keys; an empty key and a key with no value are keys too
    for (const url of ["http://x.test/a?ID=1", "http://x.test/a?id%00=1", "http://x.test/a?=1", "http://x.test/a?after", "http://x.test/a?__proto__=1", "http://x.test/a?after=a&after=b"])
      expect(why(() => readQuery(url, ["id"])), url).toBe("bad_query");
  });
  it("lets a name in `many` repeat (the merge preview's two ids) and still refuses unknown keys", () => {
    expect(readQuery("http://x.test/a?id=1&id=2", ["id"], ["id"])).toEqual({ id: "1" });
    expect(why(() => readQuery("http://x.test/a?id=1&id=2&x=3", ["id"], ["id"]))).toBe("bad_query");
  });
  it("id19 is the shared id check: no 0, no leading zeros, at most the bigint top", () => {
    for (const v of ["1", "42", "9223372036854775807"]) expect(id19(v), v).toBe(true);
    for (const v of ["0", "00", "07", "9223372036854775808", "9".repeat(19), "1".repeat(20), "", " 1", "1 ", "-1", "1.0", "1e3", 1, null]) expect(id19(v), String(v)).toBe(false);
  });
});

describe("refuse", () => {
  const status = async (e: unknown) => { const r = refuse(e, "test"); return [r.status, (await r.json()) as Record<string, unknown>] as const; };
  it("maps known codes to their statuses", async () => {
    expect(await status(new BadRequest("bad_origin"))).toEqual([403, { error: "bad_origin" }]);
    expect(await status(new BadRequest("bad_query"))).toEqual([400, { error: "bad_query" }]);
    expect(await status(new QueueRefused("not_administrator"))).toEqual([403, { error: "not_administrator" }]);
    expect(await status(new QueueRefused("not_reviewer"))).toEqual([403, { error: "not_reviewer" }]);
    expect(await status(new QueueRefused("last_administrator"))).toEqual([409, { error: "last_administrator" }]);
    expect(await status(new QueueRefused("already_held"))).toEqual([409, { error: "already_held" }]); // C3, /api/accounts
    expect(await status(new QueueRefused("not_held"))).toEqual([409, { error: "not_held" }]);
    expect(await status(new QueueRefused("same_account"))).toEqual([400, { error: "same_account" }]); // C6, the candidate merge
    for (const c of ["kept_account_deleted", "open_services_case", "open_report"]) expect(await status(new QueueRefused(c))).toEqual([409, { error: c }]);
    for (const c of ["no_account", "several_accounts", "sender_not_account", "not_open", "account_changed", "owner_with_members"]) // Q2, /api/data-requests
      expect(await status(new QueueRefused(c))).toEqual([409, { error: c }]);
    expect(await status(new QueueRefused("bad_user_id"))).toEqual([400, { error: "bad_user_id" }]);
    expect(await status(new QueueRefused("not_found"))).toEqual([404, { error: "not_found" }]);
    expect(await status(new StaffRefused("no_session"))).toEqual([401, { error: "no_session" }]);
    expect(await status(new StaffRefused("not_active"))).toEqual([401, { error: "not_active" }]);
    expect(await status(new QueueRefused("rules_failed", "8 salary below"))).toEqual([409, { error: "rules_failed", stage: "8 salary below" }]);
  });
  it("answers an unknown failure with a plain 500 and keeps the reason in the log only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await status(new Error("connection string postgres://user:secret@host"))).toEqual([500, { error: "server_error" }]);
    expect(await status(new QueueRefused("a_code_nobody_mapped"))).toEqual([500, { error: "server_error" }]);
    expect(await status("text")).toEqual([500, { error: "server_error" }]);
    expect(log).toHaveBeenCalledTimes(3);
    log.mockRestore();
  });
  it("has a status for every code the database modules can throw", async () => {
    const { readFileSync } = await import("node:fs");
    const codes = new Set<string>();
    for (const f of ["staff-admin", "audit-read", "content-admin", "admin-queue"]) {
      const src = readFileSync(new URL(`../../../packages/db/src/${f}.ts`, import.meta.url), "utf8");
      for (const m of src.matchAll(/QueueRefused\(\s*"([a-z_]+)"/g)) codes.add(m[1]!);
      for (const m of src.matchAll(/QueueRefused\(\s*`not_\$\{PUBLISHER\[[^`]*`/g)) { codes.add("not_content_editor"); codes.add("not_rules_data_editor"); void m; }
    }
    const missing: string[] = [];
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const c of codes) if ((await status(new QueueRefused(c))) [0] === 500) missing.push(c);
    quiet.mockRestore();
    expect(missing).toEqual([]);
  });
});
