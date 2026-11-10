import { describe, expect, it } from "vitest";
import { FetchFailedError } from "./index";

describe("@portal/sources types", () => {
  it("tells a failed fetch apart from an empty board", () => {
    const err = new FetchFailedError("stripe", "HTTP 429");
    expect(err).toBeInstanceOf(Error);
    expect(err.board).toBe("stripe");
  });
});
