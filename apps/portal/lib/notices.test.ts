// No database: the body check of the notices POST.
import { describe, expect, it } from "vitest";
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
