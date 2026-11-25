// Manual posting (frame D10): the body the form sends, the checks panel's words, and the page for each role and state (react-dom/server: no browser, no network, no database).
import type { ManualRow } from "@portal/db";
import type { SponsorPending } from "@portal/db/staff-uploads";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChecksPanel, CompanyList } from "./form";
import { checkText, manualBody, verdict, type Check, type DryRun } from "./text";
import { ManualPosting, type Who } from "./view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/manual-posting" }));

const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const clean = (t: string) => expect(t).not.toMatch(/[\u2013\u2014]|undefined|\[object|Launch B|Sample|NaN|Named person|Save draft/);
const FIELDS = { title: "Fake Care Assistant", description: " Fake description of the job. ", county: "Limerick", occupationCode: "6145", weeklyHours: "39", closesOn: "2026-12-31", applyUrl: "https://example.test/apply" };
const REVIEWER: Who = { id: "rev", roles: ["account_reviewer"] }, ADMIN: Who = { id: "adm", roles: ["administrator"] }, TS: Who = { id: "ts", roles: ["trust_and_safety"] };
const row = (o: Partial<ManualRow> = {}): ManualRow => ({ id: "7", organisation_id: "3", display_name: "Fake Care Ltd", title: "Fake Care Assistant", status: "live", badge: "critical_skills_eligible", pass_route: "stated_pay", posted_by_staff_id: "rev", posted_at: "2026-11-24 09:00:00+00", closes_at: "2026-12-31 23:59:59+00", closed_at: null, reason: null, sponsor_request_id: null, ...o });
const pending = (o: Partial<SponsorPending> = {}): SponsorPending => ({ requestId: "90", jobId: "7", title: "Fake Care Assistant", organisationId: "3", displayName: "Fake Care Ltd", fileName: "letter.pdf", contentType: "pdf", sizeBytes: 100, proposedBy: "rev", proposedByName: "Fake Reviewer", createdAt: "2026-11-25 09:00:00+00", ...o });
const FORM = { occupations: [{ code: "6145", title: "Fake care roles" }], hours: 39, today: "2026-11-25", last: "2027-02-23" };
const page = (who: Who, items: ManualRow[] = [row()], sponsor: SponsorPending[] = [], o: { form?: typeof FORM } = { form: FORM }) => html(<ManualPosting who={who} items={items} sponsor={sponsor} form={o.form} />);

describe("the body of the form", () => {
  it("numbers are whole, blank optional ones are null, a blank contract is permanent", () => {
    expect(manualBody(form({ ...FIELDS, salaryLow: "33100" }), "3")).toEqual({ ok: true, body: { organisationId: "3", title: "Fake Care Assistant", description: "Fake description of the job.", county: "Limerick", occupationCode: "6145", contractMonths: null, salaryLow: 33100, salaryHigh: null, payGrade: null, healthInsuranceEur: null, weeklyHours: 39, closesOn: "2026-12-31", applyUrl: "https://example.test/apply" } });
    expect(manualBody(form({ ...FIELDS, salaryLow: "1", contractMonths: "24", payGrade: " G1 " }), "3")).toMatchObject({ body: { contractMonths: 24, payGrade: "G1" } });
  });
  it("no employer, a decimal or letters, and no hours are caught before the route", () => {
    expect(manualBody(form(FIELDS), null)).toMatchObject({ ok: false, error: /employer/ });
    for (const bad of ["33.5", "abc", "-1", "99999999"]) expect(manualBody(form({ ...FIELDS, salaryLow: bad }), "3"), bad).toMatchObject({ ok: false });
    expect(manualBody(form({ ...FIELDS, weeklyHours: "" }), "3")).toMatchObject({ ok: false });
  });
});

describe("the checks panel", () => {
  const dry = (o: Partial<DryRun> = {}): DryRun => ({ status: "live", badge: "critical_skills_eligible", passRoute: "stated_pay", reason: null, closesAt: "2026-12-31T23:59:59.000Z", checks: [
    { id: "occupation", state: "pass", detail: { occupationCode: "6145", list: "critical_skills" } }, { id: "contract", state: "pass", detail: { months: null, minimumMonths: 24 } },
    { id: "wording", state: "pass", detail: { stage: "PASS" } }, { id: "money", state: "pass", detail: { phrase: null } },
    { id: "pay", state: "pass", detail: { minimumEur: 32691, countedEur: 33100, healthInsuranceEur: 0, weeklyHours: 39, route: "stated_pay" } }], ...o });
  it("before a run it says how to run it; a failed run shows the route's refusal in words", () => {
    expect(html(<ChecksPanel result={null} failed={null} back="/manual-posting" />)).toMatch(/Run the checks to see/);
    const f = html(<ChecksPanel result={null} failed={{ code: "company_not_postable", status: 409 }} back="/manual-posting" />); expect(f).toMatch(/cannot be posted for that company/); expect(f).not.toMatch(/company_not_postable/);
  });
  it("a passing run lists all five checks with their facts and what posting would do", () => {
    const p = html(<ChecksPanel result={dry()} failed={null} back="/x" />); clean(p);
    for (const t of ["Occupation eligible", "Contract length", "Advert wording", "No request for money", "Salary"]) expect(p).toMatch(new RegExp(t));
    expect(p).toMatch(/It would be listed now/); expect(p).toMatch(/€33,100 clears €32,691/); expect(p).toMatch(/Permanent/); expect(p).toMatch(/On the Critical Skills list \(code 6145\)/);
  });
  it("a blocked check says why in words, with the figures, and the verdict is a draft", () => {
    const blocked: Check = { id: "pay", state: "blocked", code: "pay_below_minimum", detail: { minimumEur: 40904, countedEur: 30000, healthInsuranceEur: 0, weeklyHours: 39, route: null } };
    const d = dry({ status: "draft", badge: null, passRoute: null, reason: { code: "pay_below_minimum" }, checks: [...dry().checks.slice(0, 4), blocked] });
    const p = html(<ChecksPanel result={d} failed={null} back="/x" />); clean(p);
    expect(p).toMatch(/It would stay a draft and not be listed: The pay is below the minimum/); expect(p).toMatch(/The minimum is €40,904, counted pay is €30,000/); expect(p).not.toMatch(/pay_below_minimum/);
    expect(verdict(d)).toMatch(/draft/); expect(checkText({ id: "pay", state: "pass", detail: { route: "public_pay" } })).toMatch(/pay scale applies/); expect(checkText({ id: "contract", state: "pass", detail: { months: 30, minimumMonths: 24 } })).toBe("30 months, at least 24 needed");
  });
});

describe("the employer picker", () => {
  it("lists the matches with kind, county and CRO number; more matches and no match are said; a hostile name is escaped", () => {
    const c = { id: "1", displayName: "<script>x</script> Fake Co", kind: "agency", croNumber: "123456", status: "verified", county: "Cork" };
    const p = html(<CompanyList items={[c]} more onPick={() => {}} />);
    expect(p).toMatch(/Agency · Cork · CRO 123456/); expect(p).toMatch(/Type more of the name/); expect(p).not.toMatch(/<script>x/);
    expect(html(<CompanyList items={[]} more={false} onPick={() => {}} />)).toMatch(/Staff do not create companies here/);
  });
});

describe("the page", () => {
  it("an account reviewer sees the form (Critical Skills only, no badge choice, no named person, no draft button) and their own posts", () => {
    const p = page(REVIEWER); clean(p);
    expect(p).toMatch(/Manual posting/); expect(p).toMatch(/Employer/); expect(p).toMatch(/6145 · Fake care roles/); expect(p).toMatch(/Critical Skills Employment Permit/); expect(p).toMatch(/>Publish</); expect(p).toMatch(/Run the checks/);
    expect(p).toMatch(/Your posts/); expect(p).toMatch(/Fake Care Assistant/); expect(p).toMatch(/Sponsor confirmed<\/p>|Sponsor confirmed/); expect(p).not.toMatch(/Create a company|Create one/);
    expect(p).toMatch(/value="39"/); // the hours come from the rules read
    expect(p).toMatch(/max="2027-02-23"/);
  });
  it("trust and safety and an administrator get no form: they read every post", () => {
    for (const w of [TS, ADMIN]) { const p = page(w, [row()], [], { form: undefined }); expect(p).not.toMatch(/>Publish</); expect(p).toMatch(/Only an account reviewer posts a job/); expect(p).toMatch(/>Manual posts</); }
  });
  it("Close is offered to the poster of a live post only", () => {
    expect(page(REVIEWER)).toMatch(/Close this post/);
    expect(page(REVIEWER, [row({ posted_by_staff_id: "other" })])).not.toMatch(/Close this post/);
    expect(page(REVIEWER, [row({ status: "closed", closed_at: "2026-11-25 08:00:00+00" })])).not.toMatch(/Close this post/);
    expect(page(ADMIN, [row()], [], { form: undefined })).not.toMatch(/Close this post/);
  });
  it("a draft shows why it is not listed, in words", () => {
    const p = page(REVIEWER, [row({ status: "draft", badge: null, reason: "pay_below_minimum" })]); expect(p).toMatch(/Draft, not listed/); expect(p).toMatch(/Not listed: The pay is below the minimum/); expect(p).not.toMatch(/pay_below_minimum/);
    expect(page(REVIEWER, [])).toMatch(/You have not posted a job by hand yet/);
  });
  it("Sponsor confirmed: the reviewer uploads on a live post; the proposer can only withdraw; a different administrator confirms or refuses; others see nothing to press", () => {
    const up = page(REVIEWER); expect(up).toMatch(/Employer&#x27;s written confirmation|Employer's written confirmation/); expect(up).toMatch(/>Upload</);
    const waiting = row({ sponsor_request_id: "90" });
    const mine = page(REVIEWER, [waiting], [pending()]); expect(mine).toMatch(/waits for a different administrator/); expect(mine).toMatch(/You cannot confirm your own upload/); expect(mine).toMatch(/>Withdraw</); expect(mine).not.toMatch(/>Confirm</);
    const adm = page(ADMIN, [waiting], [pending()], { form: undefined }); expect(adm).toMatch(/>Confirm</); expect(adm).toMatch(/>Refuse</); expect(adm).not.toMatch(/>Withdraw</); expect(adm).toMatch(/requestId=90/);
    const same = page({ id: "rev", roles: ["account_reviewer", "administrator"] }, [waiting], [pending()]); expect(same).not.toMatch(/>Confirm</); // the proposer is never offered Confirm
    const ts = page(TS, [waiting], [pending()], { form: undefined }); expect(ts).not.toMatch(/<button/);
    expect(page(REVIEWER, [row({ badge: "sponsor_confirmed" })])).not.toMatch(/>Upload</);
    expect(page(REVIEWER, [row({ status: "draft", badge: null })])).not.toMatch(/>Upload</);
  });
  it("a hostile title is escaped; Previous and Next are links, no page numbers", () => {
    const p = html(<ManualPosting who={ADMIN} items={[row({ title: "<script>x</script>" })]} sponsor={[]} next="/manual-posting?after=1" prev="/manual-posting" />);
    expect(p).not.toMatch(/<script>x/); expect(p).toMatch(/>Previous</); expect(p).toMatch(/>Next</);
  });
});
