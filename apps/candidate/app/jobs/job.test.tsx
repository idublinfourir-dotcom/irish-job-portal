// Unit: the job page body rendered to HTML for every state (Critical Skills and General, each salary state, quota, registration, closed, signed in and out),
// and the closed-job state with fixture data (B27 is not built yet).
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClosedJob, CLOSED_WORDS } from "./closed";
import { JobView, LAUNCH_B_APPLY, safeApplyUrl, type JobViewProps } from "./job-view";
import { NOW, card, job } from "./test-fixtures";

const view = (o: Partial<JobViewProps> = {}) => html(<JobView job={job()} now={NOW} path="/jobs/staff-nurse-cork-1042" signedIn={false} saved={false} stage={null} degree="relevant" prompt={null} similar={[]} {...o} />);

describe("Critical Skills job", () => {
  it("shows the badge, the degree box with the read minimums, the permit notes and the standing line", () => {
    const h = view();
    for (const t of ["Critical Skills eligible", "Our rule check, not an employer promise", "Your degree", "I have a relevant degree", "I got my degree in the last 12 months", "I don&#x27;t have a relevant degree",
      "€40,904", "This job clears it.", "Critical Skills permit needs a job offer of at least 2 years.", "or a salary of €68,911 or more", "Rules last checked on 16 Nov 2026"]) expect(h).toContain(t);
    expect(h).toMatch(/value="relevant"[^>]*checked=""|checked=""[^>]*value="relevant"/);
  });
  it("preselects the profile's degree answer", () => {
    expect(view({ degree: "last_12_months" })).toContain("€36,848");
    expect(view({ degree: "none", job: job({ salaryLow: 50000, salaryHigh: 50000 }) })).toContain("This job is below that minimum.");
  });
  it("is one H1 and one main-level heading structure", () => {
    expect(view().match(/<h1\b/g)).toHaveLength(1);
  });
});

describe("the two heads and the frame parts", () => {
  it("a Critical Skills job has the dark head (N03) with a neutral photo block; any other job has the light head (C07) and no photo block", () => {
    const dark = view();
    expect(dark).toContain('data-head="dark"');
    expect(dark).toContain("data-photo-block");
    const light = view({ job: job({ permitType: "general", badge: "sponsor_confirmed" }) });
    expect(light).toContain('data-head="light"');
    expect(light).not.toContain("data-photo-block");
    expect(dark).not.toContain("<img"); // NS6: no photo ships
  });
  it("shows the join band to a visitor only", () => {
    expect(view()).toContain("data-join");
    expect(view({ signedIn: true })).not.toContain("data-join");
  });
  it("has the apply card for desktop and the sticky bar for phones, and the dark head's price from the read", () => {
    const h = view();
    expect(h).toContain("data-apply-card");
    expect(h).toContain("data-apply-bar");
    expect(h).toContain("€52,000");
    expect(h).toContain("clears the €40,904 minimum");
  });
  it("shows the pay card under a dark head when the pay is not a plain stated figure, and the light head always", () => {
    expect(view({ job: job({ passRoute: "big_company", salaryLow: null, salaryHigh: null, salaryLine: null, badge: null }) })).toContain('data-pay="big_company"');
    expect(view({ job: job({ permitType: "general", badge: null }) })).toContain('data-pay="stated"');
  });
});

describe("General job", () => {
  const general = job({ permitType: "general", badge: "sponsor_confirmed", salaryLow: 40000, salaryHigh: 40000, salaryLine: "€40,000" });
  it("has no degree box and no Critical Skills notes, only the General minimum", () => {
    const h = view({ job: general });
    expect(h).toContain("€36,605");
    expect(h).toContain("Sponsor confirmed");
    expect(h).toContain("The employer&#x27;s claim, not our check");
    for (const t of ["Your degree", "Critical Skills permit needs", "Permit notes"]) expect(h).not.toContain(t);
  });
  it("shows no minimum line until the rules carry the General figures", () => {
    expect(view({ job: { ...general, minimums: { ...general.minimums, general: null } } })).not.toContain("General permit minimum");
  });
});

describe("salary states (C08)", () => {
  it("stated", () => expect(view()).toContain("€52,000"));
  it("range that crosses the minimum", () => {
    const h = view({ job: job({ salaryLow: 38166, salaryHigh: 56592, salaryLine: "€38,166 to €56,592", salaryRangeCrosses: true, badge: null }) });
    expect(h).toContain("Depends on starting point");
    expect(h).toContain("The top of the range clears the minimum");
    expect(h).toContain("Pay depends on where you start in this range.");
  });
  it("public pay deal", () => {
    const h = view({ job: job({ passRoute: "public_pay", salaryLow: null, salaryHigh: null, salaryLine: "Grade 5", payGrade: "Grade 5", badge: null, payScale: { code: "5", title: "Grade 5", firstEur: 38166, lastEur: 56592, line: "Pay scale for this grade: EUR 38,166 to 56,592" } }) });
    for (const t of ["Public sector pay scale applies", "Pay scale for this grade: €38,166 to €56,592", "Salary minimum does not apply"]) expect(h).toContain(t);
  });
  it.each([
    ["HSE Dublin and North East", ["Salary minimum does not apply", "No salary minimum applies to this job", "It needs a relevant degree."], ["Salary is not stated, so we cannot say"]],
    ["Beaumont Hospital", ["€68,911 a year", "Salary is not stated, so we cannot say if it clears the minimum."], ["Salary minimum does not apply", "No salary minimum applies"]],
    ["Acme HSE Contractors", ["€68,911 a year"], ["Salary minimum does not apply", "No salary minimum applies"]],
  ])("a public pay job at %s, seen without a relevant degree (#300); with one it says only that no minimum applies", (employerName, has, hasNot) => {
    const pub = job({ employerName, passRoute: "public_pay", salaryLow: null, salaryHigh: null, salaryLine: null, payGrade: null });
    const none = view({ job: pub, degree: "none" }), withDegree = view({ job: pub });
    expect(none).toContain("Public sector pay scale applies");
    for (const t of has) expect(none).toContain(t);
    for (const t of hasNot) expect(none).not.toContain(t);
    expect(withDegree).toContain("No salary minimum applies to this job");
    expect(withDegree).not.toContain("It needs a relevant degree.");
  });
  it("big company, pay floor and not stated", () => {
    const none = { salaryLow: null, salaryHigh: null, salaryLine: null, badge: null };
    expect(view({ job: job({ ...none, passRoute: "big_company" }) })).toContain("This employer is on our list of large companies");
    expect(view({ job: job({ ...none, passRoute: "pay_floor" }) })).toContain("signed a pay floor");
    const h = view({ job: job({ ...none, passRoute: "stated_pay" }) });
    expect(h).toContain("Salary not stated");
    expect(h).toContain("so we cannot say if it clears the minimum");
  });
  it("employer-paid health insurance counts", () => expect(view({ job: job({ healthInsuranceEur: 1200 }) })).toContain("health insurance of €1,200 a year also counts"));
});

describe("notices, labels and blocks", () => {
  it("quota full", () => {
    const h = view({ job: job({ quotaFull: true }) });
    expect(h).toContain("Quota notice: places for this occupation are full");
    expect(h).toContain("Permit quota full");
    expect(h).not.toContain("nearly full"); // L19
    expect(view()).not.toContain("Quota notice");
  });
  it("permit snapshot: per-year bars, peak, trend, latest month, link; and the labels", () => {
    const h = view({ job: job({ employerLabels: ["First-time sponsor", "Sponsorship claims removed"] }) });
    for (const t of ["Employer permit snapshot", "2025: 12 permits", "Peak 2025", "Trend: rising", "Latest month: 2 permits in September 2026", "Sponsored 12 permits since 2022", "First-time sponsor", "Sponsorship claims removed", 'href="/companies/example-care"']) expect(h).toContain(t);
    expect(view({ job: job({ permits: null, sponsored: null, employerLabels: ["Permit history not linked yet"] }) })).toContain("Permit history not linked yet");
    // never both statements: a job that shows the employer's permits does not also say its permit history is not linked
    const both = view({ job: job({ employerLabels: ["Permit history not linked yet", "Sponsorship claims removed"] }) });
    expect(both).toContain("Sponsored 12 permits since 2022");
    expect(both).not.toContain("Permit history not linked yet");
    expect(both).toContain("Sponsorship claims removed");
  });
  it("registration and conditions", () => {
    const h = view({ job: job({ condition: "A made-up condition.", registration: { status: "required", body: { id: "nmbi", name: "Nursing and Midwifery Board of Ireland (NMBI)", url: "https://www.nmbi.ie/x", readOn: "2026-11-19" }, line: "You must be registered.", steps: ["Apply to NMBI."], degreeNote: "A degree or diploma accepted by NMBI." } }) });
    for (const t of ["A made-up condition.", "You must be registered.", "Apply to NMBI.", 'href="https://www.nmbi.ie/x" target="_blank" rel="noopener noreferrer"', "A degree or diploma accepted by NMBI."]) expect(h).toContain(t);
  });
  it("source line differs for fetched, employer and agency jobs", () => {
    expect(view({ job: job({ source: "fetched" }) })).toContain("Collected from the employer&#x27;s own site");
    expect(view({ job: job({ source: "employer" }) })).toContain("Posted by the employer");
    expect(view({ job: job({ source: "agency", permitEmployerName: "Named Ltd" }) })).toContain("Permit employer: Named Ltd");
  });
  it("prints the advert as text with its line breaks and never as html", () => {
    const h = view({ job: job({ advertText: "<img src=x onerror=alert(1)>" }) });
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(h).not.toContain("<img");
  });
  it("shows similar jobs and the report and permit-services blocks", () => {
    const h = view({ similar: [card({ id: "2", title: "Care Assistant" })] });
    for (const t of ["More jobs <span", "like this</span>", "Care Assistant", "Got an offer? We can handle your permit", "No genuine employer asks you to pay for a job offer.", "Log in to report this job"]) expect(h).toContain(t);
    expect(h).toContain("the employer or agency pays for that. Permit fee: paid by the employee or employer."); // #297: a Critical Skills job; our service fee stays the employer's (#3)
    expect(view({ job: job({ permitType: "general" }) })).toContain("Permit fee: usually paid by the employer.");
  });
});

describe("small fixes", () => {
  it("the company link does not carry the name (it cannot wrap)", () => {
    const h = view({ job: job({ employer: { id: "7", slug: "example-care", name: "A Very Long Employer Name That Would Wrap Over Two Lines Ltd", website: null, logoUrl: null, shortDescription: null, kind: "employer" } }) });
    expect(h).toContain("See company page");
    expect(h).not.toMatch(/See A Very Long/);
  });
  it("shows similar jobs as tiles: the first light, the others dark, a round arrow and no View job text", () => {
    const h = view({ similar: [card({ id: "2", title: "One" }), card({ id: "3", title: "Two" }), card({ id: "4", title: "Three" })] });
    expect(h.match(/data-tile="light"/g)).toHaveLength(1);
    expect(h.match(/data-tile="dark"/g)).toHaveLength(2);
    expect(h).not.toContain("View job");
    expect(h.match(/data-icon="up-right"/g)!.length).toBeGreaterThanOrEqual(3);
  });
  it("gives Mark applied and Save the same width", () => {
    const h = view({ signedIn: true });
    expect(h).toMatch(/<span class="inline-flex flex-col flex-1 items-stretch[^"]*"><button[^>]*aria-label="Save Staff Nurse"/);
    expect(h).toMatch(/<button[^>]*class="[^"]*flex-1[^"]*"[^>]*><svg[^>]*data-icon="check"[^>]*>.*<\/svg>Mark applied/);
  });
  it("writes the date of the standing line out", () => {
    expect(view()).toContain("Rules last checked on 16 Nov 2026.");
    expect(view()).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("apply", () => {
  it("opens the employer's page in a new tab for a visitor, with no tracking words", () => {
    const h = view();
    expect(h).toContain('href="https://jobs.example.test/nurse"');
    expect(h).toContain('target="_blank"');
    expect(h).toContain('rel="noopener noreferrer"');
    expect(h).toContain("Log in first if you want us to track it.");
    expect(h).toContain("create a free account");
    expect(h).not.toContain("Mark applied");
  });
  it("gives a signed-in candidate Mark applied, Save and the tracking line", () => {
    const h = view({ signedIn: true });
    for (const t of ["Mark applied", "Save Staff Nurse", "When you come back we ask if you applied", "Report this job", "data-apply-bar"]) expect(h).toContain(t);
  });
  it("shows Applied for a tracked job and the saved state", () => {
    const h = view({ signedIn: true, saved: true, stage: "applied" });
    expect(h).toContain("Applied");
    expect(h).not.toContain(">Mark applied<");
    expect(h).toContain("Saved: Staff Nurse");
  });
  it("shows the Did you apply prompt when the read has one for this job", () => {
    const h = view({ signedIn: true, prompt: { clickId: "501", title: "Staff Nurse", employerName: "Example Care Ltd", county: "Cork" } });
    for (const t of ["Did you apply?", "A click alone never counts.", "Not yet", "No, not for me", "Yes, I applied"]) expect(h).toContain(t);
    expect(view({ signedIn: true })).not.toContain("Did you apply?");
  });
  it("refuses an apply address that is not http or https and shows no apply button", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "//evil.test/x", "ftp://x.test/", "https://a b.test"]) {
      expect(safeApplyUrl({ applicationRoute: "own_page", ownPageUrl: url })).toBeNull();
      expect(view({ job: job({ ownPageUrl: url }) })).not.toContain("Apply on employer");
    }
    expect(safeApplyUrl({ applicationRoute: "own_page", ownPageUrl: "https://ok.test/a?b=1" })).toBe("https://ok.test/a?b=1");
  });
  it("shows no on-site apply while Launch B is off", () => {
    expect(LAUNCH_B_APPLY).toBe(false);
    const h = view({ job: job({ applicationRoute: "on_site", ownPageUrl: null }), signedIn: true });
    expect(h).toContain("Applying for this job is not open yet.");
    for (const t of ["Apply on Permitly", "Your profile and CV go to the employer", "Launch B", "screening"]) expect(h).not.toContain(t);
  });
});

describe("nothing from a frame ships", () => {
  it("has no sample tag, job reference, signer box, old brand, hybrid or work-pattern tag, or currency line", () => {
    const h = view({ signedIn: true });
    for (const t of ["Sample", "Job ref", "Signed by", "Permitly", "Hybrid", "Full time", "in your currency", "Trusted Partner", "Quota notice", "Launch B"]) expect(h).not.toContain(t);
  });
  it("escapes hostile text from the read", () => {
    const evil = "<script>alert(1)</script>";
    const h = view({ job: job({ title: evil, employerName: evil, county: evil, sector: evil, employer: { id: "7", slug: "x", name: evil, website: null, logoUrl: null, shortDescription: null, kind: "employer" } }) });
    expect(h).not.toContain("<script>alert");
  });
});

describe("closed job", () => {
  const similar = [card({ id: "2", title: "Care Assistant" })];
  it.each(Object.keys(CLOSED_WORDS))("words %s and lists similar jobs", (reason) => {
    const h = html(<ClosedJob reason={reason} title="Staff Nurse" employerName="Example Care Ltd" similar={similar} signedIn />);
    expect(h).toContain(CLOSED_WORDS[reason]!.label);
    expect(h).toContain("Care Assistant");
    expect(h).toContain("Staff Nurse");
    expect(h).toContain("Example Care Ltd");
    expect(h.match(/<h1\b/g)).toHaveLength(1);
  });
  it("falls back to the closed wording for a reason it does not know, and works with no similar jobs", () => {
    const h = html(<ClosedJob reason="something_new" similar={[]} signedIn={false} />);
    expect(h).toContain("This job has closed");
    expect(h).not.toContain("like this");
    expect(h).not.toContain("under review"); // never a report or staff note
  });
});
