// No database: the request body check and the free check's input (services-request.ts), and the services text seed's command line.
import { describe, expect, it } from "vitest";
import { BadEligibilityInput } from "@portal/rules";
import { checkCaseRequest, freeCheckInput, OFFER_KEYS } from "./services-request";
import { main, SERVICES_TEXTS, SERVICES_TEXT_VERSION } from "./services-texts-cli.ts";

const base = { permitType: "critical_skills", offerDetails: { notes: " Start in March " }, servicesConsent: true };

describe("checkCaseRequest", () => {
  it("takes a good candidate body, trims the values and defaults the tick to false", () => {
    expect(checkCaseRequest("candidate", base)).toEqual({ permitType: "critical_skills", jobId: null, offerDetails: { notes: "Start in March" }, employerContact: false, idempotencyKey: null });
    expect(checkCaseRequest("candidate", { ...base, jobId: "12", employerContact: true })).toMatchObject({ jobId: "12", employerContact: true });
    expect(checkCaseRequest("candidate", { ...base, jobId: null })).toMatchObject({ jobId: null });
  });
  it("the portal needs an idempotency key and has no HR-contact tick", () => {
    expect(checkCaseRequest("portal", { ...base, idempotencyKey: "k".repeat(16) })).toMatchObject({ idempotencyKey: "k".repeat(16), employerContact: false });
    for (const b of [base, { ...base, idempotencyKey: "k".repeat(15) }, { ...base, idempotencyKey: "k".repeat(65) }, { ...base, idempotencyKey: "k".repeat(16), employerContact: false }])
      expect(checkCaseRequest("portal", b)).toBeNull();
    expect(checkCaseRequest("candidate", { ...base, idempotencyKey: "k".repeat(16) })).toBeNull();
  });
  it("refuses every bad shape", () => {
    const bad = [
      null, [], "x", { ...base, servicesConsent: false }, { ...base, servicesConsent: undefined }, { ...base, permitType: "x" }, { ...base, extra: 1 },
      { ...base, jobId: 5 }, { ...base, jobId: "0x1" }, { ...base, jobId: "99999999999999999999" }, { ...base, employerContact: true }, { ...base, employerContact: 1, jobId: "1" },
      { ...base, offerDetails: null }, { ...base, offerDetails: [] }, { ...base, offerDetails: { other: "x" } }, { ...base, offerDetails: { notes: "" } },
      { ...base, offerDetails: { notes: "x".repeat(501) } }, { ...base, offerDetails: { notes: "a\tb" } }, { ...base, offerDetails: { notes: "a​b" } },
      { ...base, offerDetails: { notes: 1 } }, { ...base, offerDetails: { notes: { a: "b" } } },
    ];
    for (const b of bad) expect(checkCaseRequest("candidate", b), JSON.stringify(b)).toBeNull();
    expect(checkCaseRequest("candidate", { ...base, offerDetails: { notes: "x".repeat(500) } })).not.toBeNull();
    expect(checkCaseRequest("candidate", { ...base, offerDetails: Object.fromEntries(OFFER_KEYS.map((k) => [k, "1"])) })).not.toBeNull();
  });
});

describe("freeCheckInput", () => {
  it("is null without code, pay and degree; the checker's input with them; a bad shape throws", () => {
    expect(freeCheckInput({ occupationCode: "2136", annualPay: "50000" })).toBeNull();
    expect(freeCheckInput({ occupationCode: "2136", annualPay: "50000", relevantDegree: "true", notes: "x", weeklyHours: "40", title: "Dev" }))
      .toEqual({ input: { occupationCode: "2136", annualPay: 50000, relevantDegree: true, degreeAwardMonth: null, contractMonths: null, weeklyHours: 40 }, title: "Dev" });
    for (const d of [{ occupationCode: "21", annualPay: "1", relevantDegree: "true" } as Record<string, string>, { occupationCode: "2136", annualPay: "1", relevantDegree: "yes" }, { occupationCode: "2136", annualPay: "1", relevantDegree: "true", contractMonths: "two" }])
      expect(() => freeCheckInput(d)).toThrow(BadEligibilityInput);
  });
});

describe("services-texts-cli", () => {
  it("the texts are placeholder wording for the two services purposes", () => {
    expect(SERVICES_TEXT_VERSION).toMatch(/^placeholder-/);
    expect(Object.keys(SERVICES_TEXTS)).toEqual(["services_request", "employer_contact"]);
    for (const body of Object.values(SERVICES_TEXTS)) expect(body).toMatch(/^PLACEHOLDER TEXT/);
  });
  it("refuses arguments and a missing login before it connects", async () => {
    const lines: string[] = [];
    expect(await main(["x"], { DATABASE_URL: "postgres://x@127.0.0.1:1/x" }, (l) => lines.push(l))).toBe(2);
    expect(await main([], {}, (l) => lines.push(l))).toBe(2);
    expect(lines.join("\n")).not.toMatch(/postgres:\/\//);
  });
});
