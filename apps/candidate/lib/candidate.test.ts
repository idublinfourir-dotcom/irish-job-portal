// No database: the candidate login fails closed. Each case stops before a connection is made.
import { afterEach, describe, expect, it, vi } from "vitest";

const good = { CANDIDATE_AUTH_URL: "http://localhost:3000", CANDIDATE_AUTH_SECRET: "a".repeat(32) };
afterEach(() => vi.unstubAllEnvs());
async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ["CANDIDATE_AUTH_URL", "CANDIDATE_AUTH_SECRET"]) vi.stubEnv(k, env[k] ?? "");
  return import("./candidate");
}

describe("the candidate login settings", () => {
  it("a missing URL or secret fails closed", async () => {
    expect((await load({})).candidateAuth).toThrow(/CANDIDATE_AUTH_URL and CANDIDATE_AUTH_SECRET/);
    expect((await load({ CANDIDATE_AUTH_URL: good.CANDIDATE_AUTH_URL })).candidateAuth).toThrow(/must be set/);
    expect((await load({ ...good, CANDIDATE_AUTH_SECRET: "short" })).candidateAuth).toThrow(/32 characters/);
  });
  it("a deployed (non-local) address is refused, because the fake email sender runs on localhost only", async () => {
    expect((await load({ ...good, CANDIDATE_AUTH_URL: "https://candidate.example.test" })).candidateAuth).toThrow(/only on localhost/);
    expect((await load({ ...good, CANDIDATE_AUTH_URL: "https://candidate.example.test" })).candidateMail).toThrow(/only on localhost/);
  });
});
