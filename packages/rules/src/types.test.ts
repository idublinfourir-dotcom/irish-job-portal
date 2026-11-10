import { describe, expect, it } from "vitest";
import type { Assessment } from "./index";

describe("@portal/rules types", () => {
  it("accepts the stage 'PASS (salary stated)'", () => {
    const stage: Assessment["stage"] = "PASS (salary stated)";
    expect(stage).toBe("PASS (salary stated)");
  });
});
