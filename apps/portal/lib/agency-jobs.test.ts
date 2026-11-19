// No database: the query and body checks of the agency jobs routes. The routes end to end: packages/db/test/agency-jobs-route.test.ts.
import { describe, expect, it } from "vitest";
import { checkAgencyQuery, checkNotRecognised } from "./agency-jobs";

const token = Buffer.from(JSON.stringify({ t: "2026-11-18 09:30:00.123456+00", i: "42" })).toString("base64url");
describe("checkAgencyQuery", () => {
  it("takes nothing or one good after token", () => {
    expect(checkAgencyQuery(new URLSearchParams())).toEqual({ after: null });
    expect(checkAgencyQuery(new URLSearchParams({ after: token }))).toEqual({ after: ["2026-11-18 09:30:00.123456+00", "42"] });
  });
  it.each(["", "x", "%00", "a".repeat(201), Buffer.from('{"t":"nope","i":"1"}').toString("base64url"), Buffer.from('{"t":"2026-11-18","i":"0"}').toString("base64url")])(
    "refuses after=%s", (a) => expect(checkAgencyQuery(new URLSearchParams({ after: a }))).toBeNull());
  it("refuses other or repeated keys", () => {
    expect(checkAgencyQuery(new URLSearchParams("x=1"))).toBeNull();
    expect(checkAgencyQuery(new URLSearchParams(`after=${token}&after=${token}`))).toBeNull();
    expect(checkAgencyQuery(new URLSearchParams(`after=${token}&organisationId=1`))).toBeNull();
  });
});
describe("checkNotRecognised", () => {
  it("takes one job id and nothing else", () => {
    expect(checkNotRecognised({ jobId: "5" })).toEqual({ jobId: "5" });
    for (const b of [null, [], {}, { jobId: 5 }, { jobId: "0" }, { jobId: "-1" }, { jobId: "05" }, { jobId: "5\u0000" }, { jobId: "9".repeat(30) }, { jobId: "5", reason: "other" }])
      expect(checkNotRecognised(b), JSON.stringify(b)).toBeNull();
  });
});
