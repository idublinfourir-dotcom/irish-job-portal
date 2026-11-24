// Unit (check 3): the occupation page body (P10, frame C14) for every state: listed with the registration steps, quota full, the ineligible list (no minimums), no jobs, the visitor limit,
// a team note, signed in. Every figure is a prop (the read's): the test changes them and sees the page follow. Fixtures only.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NOW, card } from "../jobs/test-fixtures";
import { OccupationView, headingOf, searchHref, titleOf, type OccupationData } from "./occupation-view";

vi.mock("server-only", () => ({}));

const occ = (o: Partial<OccupationData> = {}): OccupationData => ({
  code: "2231", entries: [{ list: "critical-skills", title: "Nursing professionals" }], listStatus: "critical-skills",
  minimums: { withDegree: 41111, recentGraduate: 37222, graduateMonths: 12, withoutDegreeOrNotListed: 69333, minContractMonths: 24, basedOnWeekHours: 39 },
  jobs: { jobs: [card({ id: "1", title: "Ward Nurse" }), card({ id: "2", title: "Theatre Nurse", badge: "sponsor_confirmed" })], count: { n: 2, more: false }, signInForMore: false },
  quota: "none", text: null, rulesCheckedOn: "2026-11-12",
  registration: { status: "required", body: { id: "nmbi", name: "Nursing Board", url: "https://nmbi.example/", readOn: "2026-11-19" }, line: "Register first.", steps: ["Apply", "Wait", "Register"], degreeNote: "For nurses, a degree accepted by the board." }, ...o,
});
const view = (o: Partial<Parameters<typeof OccupationView>[0]> = {}) => html(<OccupationView occupation={occ()} name="Nurses" now={NOW} path="/occupations/nurses" signedIn={false} {...o} />);

describe("a listed occupation", () => {
  const h = view();
  it("is named after its SOC title, with the frame's heading words", () => {
    expect(h).toMatch(/<h1[^>]*>Nurses <span[^>]*>visa sponsorship<\/span> jobs in Ireland<\/h1>/);
    expect(headingOf("Nurses")).toBe("Nurses visa sponsorship jobs in Ireland");
    expect(titleOf(occ(), "Nurses")).toBe("Nurses");
    expect(titleOf(occ())).toBe("Nursing professionals");
    expect(titleOf({ entries: [{ list: "ineligible", title: "A" }, { list: "critical-skills", title: "B" }] })).toBe("B");
  });
  it("shows every figure from the minimums it was given, the checked day, and the contract length", () => {
    for (const t of ["€41,111", "€37,222", "€69,333", "Degree in the last 12 months", "checked 12 Nov 2026", "From the rules table, checked 12 Nov 2026.", "at least 2 years", "or a salary of €69,333 or more", "instead of the €41,111 minimum", "SOC 2231"]) expect(h).toContain(t);
    for (const t of ["40,904", "36,848", "68,911"]) expect(h).not.toContain(t);
    expect(view({ occupation: occ({ minimums: { ...occ().minimums!, withDegree: 99999 } }) })).toContain("€99,999");
  });
  it("shows the registration body with the steps the read returns and its guide", () => {
    expect(h).toContain("Registration body");
    expect(h).toContain(">NMBI<");
    expect(h.match(/<ol[^>]*aria-label="How to register[\s\S]*?<\/ol>/)![0].match(/<li /g)).toHaveLength(3);
    expect(h).toContain("For nurses, a degree accepted by the board.");
    expect(h).toContain('href="https://nmbi.example/"');
  });
  it("links to the search for the code, with the job count from the read", () => {
    expect(h).toContain(`href="${searchHref("2231")}"`);
    expect(h).toContain("See 2 jobs");
    expect(h).toContain("Live jobs in this occupation");
    expect(view({ occupation: occ({ jobs: { jobs: [card()], count: { n: 1, more: false }, signInForMore: false } }) })).toContain("See 1 job ");
  });
  it("shows nothing the decisions dropped (related occupations, sector, the occupations index) and no typed 2027 date", () => {
    for (const t of ["Related occupations", "Health", "Occupations<", "2027", "Sample"]) expect(h).not.toContain(t);
  });
  it("shows the join band to a visitor and the bookmark as a login link, and to a signed-in candidate a save button", () => {
    expect(h).toContain("data-join");
    expect(h).toContain("Log in to save Ward Nurse");
    const s = view({ signedIn: true, savedIds: ["1"] });
    expect(s).not.toContain("data-join");
    expect(s).toContain("Saved: Ward Nurse");
    expect(s).toContain("Save Theatre Nurse");
  });
});

describe("the other states", () => {
  it("quota full is said, and 'no quota' otherwise", () => {
    expect(view({ occupation: occ({ quota: "full" }) })).toContain("The quota is full");
    expect(view()).toContain("No quota applies");
  });
  it("a route that is closed without a degree says so", () => {
    const h = view({ occupation: occ({ minimums: { ...occ().minimums!, withoutDegreeOrNotListed: null } }) });
    expect(h).toContain("Not open");
    expect(h).not.toContain("or a salary of");
  });
  it("an occupation on the ineligible list has no minimums, no notes and no registration, and says so", () => {
    const h = view({ occupation: occ({ listStatus: "ineligible", minimums: null, registration: null, entries: [{ list: "ineligible", title: "Cooks" }] }), name: "Cooks" });
    expect(h).toContain("Ineligible Occupations List");
    expect(h).toContain("On the Ineligible list");
    for (const t of ["Salary minimums for this occupation", "Permit notes", "Registration body"]) expect(h).not.toContain(t);
  });
  it("no live job is said in words", () => {
    expect(view({ occupation: occ({ jobs: { jobs: [], count: { n: 0, more: false }, signInForMore: false } }) })).toContain("There are no live jobs for this occupation right now.");
  });
  it("the visitor limit shows the sign-in box", () => {
    const h = view({ occupation: occ({ jobs: { jobs: Array.from({ length: 6 }, (_, i) => card({ id: String(i) })), count: { n: 30, more: false }, signInForMore: true } }) });
    expect(h).toContain("data-sign-in-for-more");
    expect(h.match(/data-job-card=/g)).toHaveLength(6);
  });
  it("shows the team's note with its checked day and source, as plain text", () => {
    const h = view({ occupation: occ({ text: { title: "Nurse notes", body: "A note.\n\n<b>not html</b>", sourceUrl: "https://enterprise.gov.ie/x", checkedOn: "2026-11-01" } }) });
    expect(h).toContain("Nurse notes");
    expect(h).toContain("Checked on 1 Nov 2026");
    expect(h).toContain("&lt;b&gt;not html&lt;/b&gt;");
  });
});
