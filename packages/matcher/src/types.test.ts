import { describe, expect, it } from "vitest";
import type { Matcher } from "./index";

describe("@portal/matcher types", () => {
  it("lets a fake matcher stand in", async () => {
    const m: Matcher = async () => ({ occupationCode: "none", onCriticalSkillsList: "unknown", confidence: "none" });
    expect((await m("x", "y")).confidence).toBe("none");
  });
});
