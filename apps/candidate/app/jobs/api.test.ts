// Unit: the writes of the job pages go to the documented routes with the documented bodies, every error code has words, and no test reaches the network.
import { describe, expect, it } from "vitest";
import { EVIDENCE_MAX, REPORT_REASONS, answerPrompt, createAlert, logApplyClick, markApplied, messageFor, reportJob, saveJob, send } from "./api";

type Call = { url: string; init: RequestInit };
function fake(status: number, body: unknown) {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit) => { calls.push({ url, init }); return { ok: status < 400, status, json: async () => body } as Response; };
  return { f, calls };
}
const sent = (c: Call) => JSON.parse(c.init.body as string);

describe("writes", () => {
  it("save and unsave use POST and DELETE on /api/candidate/saved", async () => {
    const a = fake(200, { ok: true });
    expect(await saveJob("1042", true, a.f)).toEqual({ ok: true, body: { ok: true } });
    expect(await saveJob("1042", false, a.f)).toMatchObject({ ok: true });
    expect(a.calls.map((c) => [c.init.method, c.url])).toEqual([["POST", "/api/candidate/saved"], ["DELETE", "/api/candidate/saved"]]);
    expect(sent(a.calls[0]!)).toEqual({ jobId: "1042" });
  });
  it("mark applied, apply click, answer and alert send the documented bodies", async () => {
    const a = fake(200, { ok: true });
    await markApplied("5", a.f);
    await logApplyClick("5", a.f);
    await answerPrompt("501", "yes", a.f);
    await createAlert({ sector: "health", salaryMin: 30000 }, "weekly", a.f);
    expect(a.calls.map((c) => c.url)).toEqual(["/api/candidate/tracker", "/api/candidate/apply-click", "/api/candidate/did-you-apply", "/api/candidate/alerts"]);
    expect(sent(a.calls[0]!)).toEqual({ jobId: "5" });
    expect(sent(a.calls[2]!)).toEqual({ clickId: "501", answer: "yes" });
    expect(sent(a.calls[3]!)).toEqual({ sector: "health", salaryMin: 30000, frequency: "weekly" });
    for (const c of a.calls) expect((c.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
  it("sends a report with trimmed evidence, and none when it is empty", async () => {
    const a = fake(200, { ok: true });
    await reportJob("1", "asks_for_money", "  paid  ", a.f);
    await reportJob("1", "other", "   ", a.f);
    expect(sent(a.calls[0]!)).toEqual({ jobId: "1", reason: "asks_for_money", evidence: "paid" });
    expect(sent(a.calls[1]!)).toEqual({ jobId: "1", reason: "other" });
    expect(REPORT_REASONS.map((r) => r[0])).toEqual(["asks_for_money", "no_sponsorship", "job_closed", "wrong_details", "other"]);
    expect(EVIDENCE_MAX).toBe(2000);
  });
});

describe("every error code a route can answer has words", () => {
  const codes = [
    ["NO_SESSION", 401], ["REFUSED", 403], ["BAD_ORIGIN", 403], ["BOT_SUSPECTED", 403], ["EMAIL_NOT_VERIFIED", 403], ["BAD_REQUEST", 400], ["BODY_TOO_LARGE", 413], ["TOO_MANY_REQUESTS", 429],
    ["JOB_NOT_FOUND", 404], ["CLICK_NOT_FOUND", 404], ["SAVED_LIMIT", 409], ["ALREADY_REPORTED", 409], ["ALERT_LIMIT", 409], ["STAMP_4", 409],
  ] as const;
  it.each(codes)("%s", async (code, status) => {
    const r = await send("POST", "/x", {}, fake(status, { code }).f);
    expect(r).toMatchObject({ ok: false, code });
    if (!r.ok) {
      expect(r.message.length).toBeGreaterThan(10);
      if (code !== "BAD_ORIGIN") expect(r.message).not.toBe(messageFor("SOMETHING_NEW")); // a known code is never the generic line
      expect(r.message).not.toContain(code); // no raw code shown to a person
    }
  });
  it("falls back to a generic line for an unknown code, a body that is not JSON, and a lost connection", async () => {
    expect(await send("POST", "/x", {}, fake(500, { code: "WEIRD" }).f)).toMatchObject({ ok: false, code: "WEIRD", message: messageFor("WEIRD") });
    expect(await send("POST", "/x", {}, async () => ({ ok: false, status: 502, json: async () => { throw new Error("no json"); } }))).toMatchObject({ ok: false, code: "ERROR" });
    expect(await send("POST", "/x", {}, async () => { throw new TypeError("network"); })).toMatchObject({ ok: false, code: "NETWORK" });
  });
});
