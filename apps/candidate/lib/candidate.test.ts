// No database: the candidate login fails closed. Each case stops before a connection is made.
import { afterEach, describe, expect, it, vi } from "vitest";

const good = { CANDIDATE_AUTH_URL: "http://localhost:3000", CANDIDATE_AUTH_SECRET: "a".repeat(32) };
afterEach(() => vi.unstubAllEnvs());
async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ["CANDIDATE_AUTH_URL", "CANDIDATE_AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) vi.stubEnv(k, env[k] ?? "");
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
  it("Google sign-in is on only when both GOOGLE_ variables are set", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://nobody:none@127.0.0.1:1/none");
    const google = async (env: Record<string, string>) => ((await (await load({ ...good, ...env })).candidateAuth().$context).socialProviders.map((p) => p.id));
    expect(await google({})).toEqual([]);
    expect(await google({ GOOGLE_CLIENT_ID: "fake-id" })).toEqual([]);
    expect(await google({ GOOGLE_CLIENT_SECRET: "fake-secret" })).toEqual([]);
    expect(await google({ GOOGLE_CLIENT_ID: "fake-id", GOOGLE_CLIENT_SECRET: "fake-secret" })).toEqual(["google"]);
  });
});
