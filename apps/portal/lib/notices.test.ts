// No database: the body checks of the notices POST and the notice settings PUT.
import { describe, expect, it } from "vitest";
import { checkPortalSettings } from "@portal/db";
import { checkNotice } from "./notices";

describe("checkNotice", () => {
  it("takes mark one (a bigint id as text) and mark all", () => {
    expect(checkNotice({ action: "read", id: "42" })).toEqual({ action: "read", id: "42" });
    expect(checkNotice({ action: "read", id: "9223372036854775807" })).not.toBeNull();
    expect(checkNotice({ action: "read_all" })).toEqual({ action: "read_all" });
  });
  it("refuses bad ids, unknown actions, extra fields and non-objects", () => {
    const bad: unknown[] = [
      { action: "read" }, { action: "read", id: 42 }, { action: "read", id: "0" }, { action: "read", id: "-1" }, { action: "read", id: "1.5" }, { action: "read", id: " 1" },
      { action: "read", id: "9223372036854775808" }, { action: "read", id: "1; drop table notification" }, { action: "read", id: "1".repeat(30) },
      { action: "read_all", id: "1" }, { action: "read", id: "1", portalUserId: "someone" }, { action: "unread", id: "1" }, { action: "delete", id: "1" },
      {}, null, [], "read_all", 1,
    ];
    for (const b of bad) expect(checkNotice(b), JSON.stringify(b)).toBeNull();
  });
});

describe("checkPortalSettings", () => {
  it("takes one or both switches, account only as true", () => {
    expect(checkPortalSettings({ job_expiry_reminder: false })).toEqual({ job_expiry_reminder: false });
    expect(checkPortalSettings({ job_expiry_reminder: true, account: true })).toEqual({ job_expiry_reminder: true, account: true });
    expect(checkPortalSettings({ account: true })).toEqual({ account: true });
  });
  it("refuses account off, unknown keys, wrong types, empty and non-objects", () => {
    const bad: unknown[] = [{ account: false }, { job_expiry_reminder: true, account: false }, {}, { job_alerts: false }, { job_expiry_reminder: "false" },
      { job_expiry_reminder: 1 }, { job_expiry_reminder: null }, { job_expiry_reminder: false, portalUserId: "x" }, JSON.parse('{"__proto__": false}'), [], null, "x", 1];
    for (const b of bad) expect(checkPortalSettings(b), JSON.stringify(b)).toBeNull();
  });
});
