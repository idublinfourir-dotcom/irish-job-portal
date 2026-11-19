import { describe, expect, it } from "vitest";
import { REGISTRATION_BODIES, registrationFor } from "./registration";

const at = (code: string | null, title?: string | null) => { const r = registrationFor(code, title); return r && [r.status, r.body.id]; };

describe("registrationFor (S6)", () => {
  it("maps each researched code to its body", () => {
    expect([at("2211"), at("2231"), at("2232"), at("2213"), at("2214"), at("2223"), at("2442"), at("3213"), at("6142")]).toEqual([
      ["required", "medical_council"], ["required", "nmbi"], ["required", "nmbi"], ["required", "psi"], ["required", "coru"], ["required", "coru"],
      ["required", "coru"], ["required", "phecc"], ["required", "phecc"],
    ]);
  });
  it("gives nothing for a code with no body, and for bad codes", () => {
    for (const c of ["2136", "2229", "3218", "", "22311", null, 2231 as unknown as string, "__proto__", "constructor", "toString"]) expect(registrationFor(c, "Nurse"), String(c)).toBeNull();
  });
  it("shows psychologists that the register is not open yet", () => {
    const r = registrationFor("2212", "Clinical Psychologist")!;
    expect([r.status, r.body.id, r.steps, r.line]).toEqual(["not_open", "coru", [], expect.stringMatching(/2027/)]);
    expect(r.body.url).toMatch(/psychologists-registration-board/);
  });
  it("mixed codes: a regulated title gets CORU's steps, an unregulated one nothing, any other or no title the cautious line", () => {
    expect([at("2217", "Senior Radiographer"), at("2217", "Radiation Therapist"), at("2219", "Dietician"), at("2219", "Senior Medical Scientist"),
      at("2112", "Medical Laboratory Scientist"), at("2219", "Biomedical Scientist")]).toEqual(Array(6).fill(["required", "coru"]));
    for (const [c, t] of [["2217", "Cardiac Physiologist"], ["2217", "Vascular Technologist"], ["2219", "Audiologist"], ["2219", "Clinical Perfusionist"],
      ["2112", "Research Scientist"], ["2112", "Biochemist"], ["2112", "Bioprocess Engineer"]]) expect(registrationFor(c!, t), t).toBeNull();
    for (const t of ["Sonographer", "Lab Analyst", "", null, undefined, 42 as unknown as string]) expect(at("2217", t), String(t)).toEqual(["may_need", "coru"]);
  });
  it("uses the matcher's normalisation: case and word edges count, not substrings", () => {
    expect(at("2217", "RADIOGRAPHER")).toEqual(["required", "coru"]);
    expect(at("2217", "Radiographers")).toEqual(["may_need", "coru"]); // \b like the matcher: a plural is not the word
  });
  it("only the nursing codes carry the NMBI degree or diploma note; required ones carry steps", () => {
    expect(registrationFor("2231")!.degreeNote).toBe("For nurses and midwives, a relevant degree means a degree or diploma accepted by NMBI.");
    expect(registrationFor("2232")!.degreeNote).toBeDefined();
    expect(registrationFor("2211")!.degreeNote).toBeUndefined();
    for (const c of ["2211", "2231", "2213", "2214", "3213"]) expect(registrationFor(c)!.steps.length, c).toBeGreaterThan(0);
  });
  it("every body has a https link, a read date and a review date 6 months on", () => {
    for (const b of Object.values(REGISTRATION_BODIES)) {
      expect(b.url, b.id).toMatch(/^https:\/\//);
      const r = new Date(`${b.readOn}T00:00:00Z`);
      r.setUTCMonth(r.getUTCMonth() + 6);
      expect(b.reviewOn, b.id).toBe(r.toISOString().slice(0, 10));
    }
  });
  it("a hostile long title is cut and answered fast (budget: 10,000 calls of a 100 kB title under 500 ms)", () => {
    const title = `${"(a+)+ radiographer".repeat(5000)}`;
    const t = performance.now();
    for (let i = 0; i < 10_000; i++) registrationFor("2217", title);
    const ms = performance.now() - t;
    console.log(`registrationFor: 10,000 hostile calls in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });
});
