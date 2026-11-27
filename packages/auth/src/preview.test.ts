import { describe, expect, it } from "vitest";
import { authSettings } from ".";
import { createMail } from "./mail";

describe("preview settings and preview email mode (audit DEP-2)", () => {
  const secret = "s".repeat(32), preview = { VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "app-git-x.vercel.app", VERCEL_URL: "app-abc.vercel.app" };
  it("a preview takes the branch address, else the deployment address, only when no URL is set", () => {
    expect(authSettings("CANDIDATE", { ...preview, CANDIDATE_AUTH_SECRET: secret }).baseURL).toBe("https://app-git-x.vercel.app");
    expect(authSettings("CANDIDATE", { VERCEL_ENV: "preview", VERCEL_URL: "app-abc.vercel.app", CANDIDATE_AUTH_SECRET: secret }).baseURL).toBe("https://app-abc.vercel.app");
    expect(authSettings("CANDIDATE", { ...preview, CANDIDATE_AUTH_URL: "https://set.example.test", CANDIDATE_AUTH_SECRET: secret }).baseURL).toBe("https://set.example.test");
  });
  it("production, development and unset never take the branch address; short secrets are still refused", () => {
    for (const VERCEL_ENV of ["production", "development", undefined]) expect(() => authSettings("CANDIDATE", { ...preview, VERCEL_ENV, CANDIDATE_AUTH_SECRET: secret })).toThrow(/CANDIDATE_AUTH_URL/);
    expect(() => authSettings("CANDIDATE", { ...preview, CANDIDATE_AUTH_SECRET: "short" })).toThrow(/32 characters/);
    expect(() => authSettings("CANDIDATE", { ...preview, CANDIDATE_AUTH_URL: "http://x.example.test", CANDIDATE_AUTH_SECRET: secret })).toThrow(/https/);
  });
  it("PREVIEW_EMAIL=log prints the link on a preview and sends nothing; everywhere else it refuses", async () => {
    const lines: string[] = [], base = "https://app-git-x.vercel.app";
    const m = createMail(base, { ...preview, PREVIEW_EMAIL: "log", VERCEL: "1", NODE_ENV: "production" }, (l) => lines.push(l));
    await m.send("candidate", "verify", "a@example.test", `${base}/api/auth/verify-email?token=t`);
    expect(lines).toEqual([`[preview email] candidate verify for a@example.test: ${base}/api/auth/verify-email?token=t`]);
    await expect(m.send("candidate", "verify", "a@example.test", "https://evil.example.test/x")).rejects.toThrow("not on this site");
    for (const env of [{ VERCEL_ENV: "production" }, {}, { VERCEL_ENV: "development" }, { VERCEL_ENV: "preview", PREVIEW_EMAIL: "yes" }])
      expect(() => createMail(base, { ...env, PREVIEW_EMAIL: (env as { PREVIEW_EMAIL?: string }).PREVIEW_EMAIL ?? "log" })).toThrow(/PREVIEW_EMAIL=log is allowed only/);
  });
});
