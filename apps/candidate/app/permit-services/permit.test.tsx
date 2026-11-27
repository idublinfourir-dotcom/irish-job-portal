// P12, unit: the permit services landing (every variant), the request form (every state), the result screen (every state), the body the form sends, and the
// words for every code of the request and upload routes. react-dom/server, no browser, no network, no database. Only Next's pieces and the data layer are stood in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ signedIn: false, notice: null as unknown, cases: [] as { id: string; status: string }[], jobs: new Map<string, unknown>(), occupations: [{ code: "2231", title: "Nurses" }, { code: "2136", title: "Programmers" }] }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("../../lib/data", () => ({
  readSignedIn: async () => state.signedIn,
  readPermitNotice: async () => ({ ok: true, data: state.notice }),
  readCases: async () => ({ ok: true, data: { cases: state.cases, next: null } }),
  readOccupations: async () => ({ ok: true, data: { occupations: state.occupations } }),
  readJob: async ({ id }: { id: string }) => (state.jobs.has(id) ? { ok: true, data: state.jobs.get(id) } : { ok: false, status: 404, code: "NOT_FOUND" }),
}));
import { descriptionProblem, titleProblem } from "../../lib/seo";
import { say, type Flow } from "../(auth)/messages";
import { LandingView, noticeOf, type LandingProps } from "./landing";
import LandingPage, { generateMetadata as landingMeta } from "./page";
import RequestPage, { generateMetadata as requestMeta } from "./request/page";
import { buildRequest } from "./request/build";
import { Aside, MAX_FILE_BYTES, RequestView, ResultView, type FreeCheck } from "./request/views";

const clean = (s: string) => expect(s).not.toMatch(/[–—]|undefined|\[object|Sample|Launch B|dangerouslySetInnerHTML|<img/);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
beforeEach(() => Object.assign(state, { signedIn: false, notice: null, cases: [], jobs: new Map() }));

const landing = (o: Partial<LandingProps> = {}): LandingProps => ({ variant: "visitor", notice: null, startHref: "/login?next=%2Fpermit-services%2Frequest", loginHref: "/login?next=%2Fpermit-services%2Frequest", signupHref: "/signup?next=%2Fpermit-services%2Frequest", trackHref: "/login?next=%2Faccount", ...o });

describe("the services landing (DD26, from the old text of C19)", () => {
  it("a visitor: one H1, both price lists, how a case moves, the three promises, the join band, and a way to log in or sign up before the request", () => {
    const p = html(<LandingView {...landing()} />);
    expect(p.match(/<h1/g)).toHaveLength(1);
    expect(text(p)).toMatch(/Got an offer\? We can handle your permit/);
    expect(text(p)).toMatch(/For employers and agencies/);
    expect(text(p)).toMatch(/For candidates/);
    for (const row of ["EPOS set-up", "Application handling", "Labour Market Needs Test guidance", "Renewals", "Eligibility check", "Document checklist", "First consultation"]) expect(p).toContain(row);
    expect(text(p)).toMatch(/Our help with the application or renewal Paid by your employer/);
    expect(text(p)).toMatch(/Critical Skills permit fee \(DETE\) Paid by the employee or employer/); // #297
    expect(text(p)).toMatch(/General permit fee \(DETE\) Usually paid by the employer/);
    for (const step of ["Received", "Documents needed", "Submitted", "Decision"]) expect(p).toContain(step);
    expect(p).toMatch(/Updates by email/);
    expect(p).toMatch(/Copies only, never originals/);
    expect(p).toMatch(/data-join/);
    expect(p).toContain('href="/login?next=%2Fpermit-services%2Frequest"');
    expect(p).toContain('href="/signup?next=%2Fpermit-services%2Frequest"');
    expect(p).toMatch(/Track an existing case/);
    clean(p);
  });
  it("leaves out the Stamp 4 line and anything a candidate would pay (#84, L47), the booking and emailed checklist (L33), the handler's name (L61) and the section 55 sentence (Q130)", () => {
    const p = html(<LandingView {...landing()} />);
    expect(p).not.toMatch(/Stamp 4|family reunification|Paid by you(?!r)|book a|booking|section 55|Robin|named case handler|message your/i);
    expect(text(p)).toMatch(/Candidates never pay for our permit services/);
    expect(text(p)).toMatch(/Prices and invoices: coming soon\. We agree the price with your employer or agency before any work starts\./);
    expect(text(p).replace("Prices and invoices: coming soon.", "")).not.toMatch(/coming soon|placeholder|TBC/i); // #307: only the price line may say it
  });
  it("words the promises to what is built: 1 working day is an aim, emails go out once a day, copies are kept 30 days after close", () => {
    const t = text(html(<LandingView {...landing()} />));
    expect(t).toMatch(/aim to come back to you within 1 working day/);
    expect(t).toMatch(/Emails go out once a day/);
    expect(t).toMatch(/keep them for 30 days after your case closes/);
    expect(t).not.toMatch(/same day|never keep a passport|We confirm within/i);
  });
  it("a signed-in candidate with no request goes straight to the form, with no join band and no log in prompt", () => {
    const p = html(<LandingView {...landing({ variant: "no-case", startHref: "/permit-services/request" })} />);
    expect(p).toContain('href="/permit-services/request"');
    expect(p).not.toMatch(/data-join|New here\?|Track an existing case|You have/);
  });
  it("one open request offers to track that case, several offer the account", () => {
    const one = html(<LandingView {...landing({ variant: "open-case", startHref: "/permit-services/request", open: { count: 1, href: "/account/cases/31" } })} />);
    expect(one).toMatch(/You have an open request/);
    expect(one).toContain('href="/account/cases/31"');
    expect(one).toMatch(/Track your request/);
    const many = html(<LandingView {...landing({ variant: "open-case", startHref: "/permit-services/request", open: { count: 3, href: "/account" } })} />);
    expect(many).toMatch(/You have 3 open requests/);
    expect(many).toContain('href="/account"');
  });
  it("the DETE closed notice (#291) shows its title and text as plain text, and is hidden when null", () => {
    expect(html(<LandingView {...landing()} />)).not.toMatch(/data-notice="closed"/);
    const p = html(<LandingView {...landing({ notice: { title: "DETE portal closed", body: "Line one.\nLine two <b>x</b>" } })} />);
    expect(p).toMatch(/data-notice="closed"/);
    expect(p).toMatch(/DETE portal closed/);
    expect(p).not.toContain("<b>x</b>"); // staff text is never HTML
    expect(p).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
  it("noticeOf takes only a title and a body that are text", () => {
    expect(noticeOf(null)).toBeNull();
    expect(noticeOf({ title: 1, body: "x" })).toBeNull();
    expect(noticeOf({ title: "T", body: "B", slug: "dete-portal-closed" })).toEqual({ title: "T", body: "B" });
  });
});

describe("the landing page (server component)", () => {
  it("a visitor gets the visitor variant, with every start link going through log in and back to the form", async () => {
    const el = await LandingPage();
    expect(el.props).toMatchObject({ variant: "visitor", startHref: "/login?next=%2Fpermit-services%2Frequest", trackHref: "/login?next=%2Faccount", open: undefined, notice: null });
  });
  it("a signed-in candidate with no open request, with only closed ones, with one, with several", async () => {
    state.signedIn = true;
    expect((await LandingPage()).props).toMatchObject({ variant: "no-case", startHref: "/permit-services/request" });
    state.cases = [{ id: "5", status: "closed" }];
    expect((await LandingPage()).props.variant).toBe("no-case");
    state.cases = [{ id: "31", status: "received" }, { id: "5", status: "closed" }];
    expect((await LandingPage()).props).toMatchObject({ variant: "open-case", open: { count: 1, href: "/account/cases/31" } });
    state.cases = [{ id: "31", status: "received" }, { id: "32", status: "decision" }];
    expect((await LandingPage()).props).toMatchObject({ variant: "open-case", open: { count: 2, href: "/account" } });
  });
  it("shows the notice while staff have it on, hides it while off", async () => {
    state.notice = { id: "9", kind: "notice", slug: "dete-portal-closed", title: "Closed", body: "Wait." };
    expect((await LandingPage()).props.notice).toEqual({ title: "Closed", body: "Wait." });
    state.notice = null;
    expect((await LandingPage()).props.notice).toBeNull();
  });
  it("title is 60 characters or fewer, the description 120 to 160", () => {
    const m = landingMeta();
    expect(titleProblem(String(m.title).replace(" | Irish Work Permit", ""))).toBeNull();
    expect(descriptionProblem(String(m.description))).toBeNull();
  });
});

const view = (o: Partial<Parameters<typeof RequestView>[0]> = {}) => (
  <RequestView who="candidate" occupations={state.occupations} job={null} degree={null} notice={null} employersHref="http://localhost:3001/" {...o} />
);
const JOB = { id: "1042", title: "Fake Developer", employerName: "Example Care Ltd", occupationCode: "2136", contractMonths: 24 };

describe("the request form (C20)", () => {
  it("has one H1, the four steps, the three people, the two permit types and every occupation, with the side cards", () => {
    const p = html(view());
    expect(p.match(/<h1/g)).toHaveLength(1);
    expect(text(p)).toMatch(/Start a permit request/);
    for (const s of ["Who is asking?", "The permit", "The job offer", "Documents"]) expect(p).toContain(s);
    for (const w of ["I am the candidate", "I am the employer", "I am an agency"]) expect(p).toContain(w);
    expect(p).toMatch(/Critical Skills Employment Permit/);
    expect(p).toMatch(/General Employment Permit/);
    expect(p).toMatch(/<option value="2231">Nurses<\/option>/);
    expect(p).toMatch(/You will not be charged/);
    expect(p).toMatch(/What happens next/);
    expect(p).toMatch(/Free for you/);
    clean(p);
  });
  it("asks only what the route takes: no employer email, no service kind, no save for later (#287, L24)", () => {
    const p = html(view());
    expect(p).not.toMatch(/Employer contact email|New application|Renewal|Not sure|Save for later/);
    expect(p).toMatch(/name="annualPay"/);
    expect(p).toMatch(/name="relevantDegree"/);
    expect(p).not.toMatch(/name="degreeAwardMonth"/); // only once the degree answer is Yes
    expect(html(view({ degree: "yes" }))).toMatch(/name="degreeAwardMonth"/);
    expect(p).not.toMatch(/name="employerContact"/); // only with a job
  });
  it("says 4 MB and the 30 day rule, never the frame's 10 MB or 'never keep a passport'", () => {
    const t = text(html(view()));
    expect(t).toMatch(/up to 4 MB each/);
    expect(t).toMatch(/30 days after your case closes/);
    expect(t).not.toMatch(/10 MB|never keep/);
  });
  it("with a job: the job is named, employer and title are filled in, the HR contact tick is offered (CF59), the occupation is chosen", () => {
    const p = html(view({ job: JOB }));
    expect(text(p)).toMatch(/This request is about the Fake Developer job at Example Care Ltd/);
    expect(p).toMatch(/value="Example Care Ltd"/);
    expect(p).toMatch(/value="Fake Developer"/);
    expect(p).toMatch(/name="employerContact"/);
    expect(p).toMatch(/<option value="2136" selected="">Programmers<\/option>/);
    expect(p).toMatch(/value="24"/);
  });
  it("an employer or an agency is sent to the employer portal, and with no portal setting there is no link, never one that points nowhere", () => {
    for (const who of ["employer", "agency"] as const) {
      const p = html(view({ who }));
      expect(p).toMatch(/Open the employer portal/);
      expect(p).toContain('href="http://localhost:3001/"');
      expect(p).not.toMatch(/name="annualPay"|Send request/);
      const none = html(view({ who, employersHref: null }));
      expect(none).not.toMatch(/Open the employer portal|href="http:\/\/localhost/);
      expect(text(none)).toMatch(/ask for permit services in the employer portal/);
    }
  });
  it("the closed notice shows above the form, an error shows as an alert, NOT_VERIFIED shows the verify email prompt, pending disables the button", () => {
    expect(html(view({ notice: { title: "DETE portal closed", body: "Cases wait." } }))).toMatch(/data-notice="closed"/);
    expect(html(view({ error: say("request", { ok: false, status: 409, code: "CASE_LIMIT" }).text }))).toMatch(/role="alert"/);
    const v = html(view({ flashCheckEmail: true, error: say("request", { ok: false, status: 403, code: "NOT_VERIFIED" }).text }));
    expect(v).toMatch(/Verify your email first/);
    expect(v).toContain('href="/verify"');
    expect(v).not.toMatch(/data-notice="error"/);
    expect(html(view({ pending: true }))).toMatch(/disabled=""[^>]*>Sending/);
  });
  it("the consent tick is required, and each field has a label", () => {
    const p = html(view());
    expect(p).toMatch(/name="servicesConsent"[^>]*required|required[^>]*name="servicesConsent"/);
    expect(p.match(/<input/g)!.length).toBeGreaterThan(5);
    for (const name of ["annualPay", "startDate", "title", "employerName", "contractMonths", "weeklyHours", "servicesConsent", "permitType", "occupationCode"]) {
      const tag = new RegExp(`<(?:input|select)[^>]*name="${name}"[^>]*>`).exec(p)?.[0] ?? "";
      const id = /id="([^"]+)"/.exec(tag)?.[1];
      expect(id, name).toBeTruthy();
      expect(p, name).toContain(`for="${id}"`);
    }
  });
  it("the aside marks the current step", () => {
    expect(html(<Aside step={1} />)).toMatch(/bg-deep-green[^>]*>1</);
    expect(html(<Aside step={3} />)).toMatch(/bg-deep-green[^>]*>3</);
  });
});

const FC: NonNullable<FreeCheck> = { qualifies: true, reason: "listed_degree", minimum: 40904, why: "On the Critical Skills list with a relevant degree: the minimum is EUR 40,904.", standingLine: "Our check is guidance, not a permit decision. Only DETE decides. Rules last checked on 12 November 2026.", rulesCheckedOn: "2026-11-12", registration: null };
const result = (o: Partial<Parameters<typeof ResultView>[0]> = {}) => <ResultView caseHref="/account/cases/31" jobLine={null} freeCheck={FC} docs={[]} notice={null} {...o} />;

describe("the screen after a request (DD31)", () => {
  it("says the case is in, shows the free check with why, the minimum and the standing line, and links to the case", () => {
    const p = html(result());
    expect(p.match(/<h1/g)).toHaveLength(1);
    expect(text(p)).toMatch(/Request received/);
    expect(text(p)).toMatch(/aim to come back to you within 1 working day/);
    expect(p).toMatch(/Looks eligible/);
    expect(p).toContain(FC.why);
    expect(p).toContain(FC.standingLine);
    expect(text(p)).toMatch(/Minimum salary for this route: €40,904 a year/);
    expect(p).toContain('href="/account/cases/31"');
    clean(p);
  });
  it("a check that does not qualify says so without a green sign, and no minimum when there is none", () => {
    const p = html(result({ freeCheck: { ...FC, qualifies: false, reason: "below_minimum", minimum: null, why: "The pay is below the minimum." } }));
    expect(p).toMatch(/May not qualify/);
    expect(p).not.toMatch(/Looks eligible|Minimum salary for this route/);
  });
  it("no free check (null) is said plainly, a registration body is linked safely", () => {
    expect(text(html(result({ freeCheck: null })))).toMatch(/could not run the free check/);
    const p = html(result({ freeCheck: { ...FC, registration: { status: "required", line: "You must be registered with the Fake Board.", body: { name: "Fake Board", url: "https://example.test/board" } } } }));
    expect(p).toMatch(/rel="noopener noreferrer"/);
    expect(p).toContain("Fake Board");
  });
  it("the upload area names the 4 MB limit and the types, lists what was uploaded, and shows uploading and error states", () => {
    const p = html(result({ docs: [{ fileName: "offer.pdf", sizeBytes: 212_000 }, { fileName: "<b>x</b>.png", sizeBytes: 3_000_000 }], uploading: true, uploadError: say("upload", { ok: false, status: 413, code: "FILE_TOO_LARGE" }).text }));
    expect(p).toMatch(/type="file"/);
    expect(p).toMatch(/accept="\.pdf,\.jpg,\.jpeg,\.png/);
    expect(p).toMatch(/up to 4 MB each/);
    expect(p).toContain("offer.pdf");
    expect(p).toContain("207 KB");
    expect(p).toContain("2.9 MB");
    expect(p).not.toContain("<b>x</b>");
    expect(p).toMatch(/Uploading/);
    expect(p).toMatch(/role="alert"/);
    expect(MAX_FILE_BYTES).toBe(4_194_304);
  });
  it("names the job when the request was about one, and keeps the closed notice", () => {
    expect(text(html(result({ jobLine: "About the Fake Developer job at Example Care Ltd.", notice: { title: "Closed", body: "Wait." } })))).toMatch(/About the Fake Developer job at Example Care Ltd\. Our team has your request/);
    expect(html(result({ notice: { title: "Closed", body: "Wait." } }))).toMatch(/data-notice="closed"/);
  });
});

describe("the body the form sends (POST /api/candidate/cases)", () => {
  const f = { permitType: "critical_skills", occupationCode: "2136", annualPay: " 45000 ", relevantDegree: "yes", degreeAwardMonth: "2025-06", employerName: "Example Care Ltd", title: "Fake Developer", startDate: "2027-01-04", contractMonths: "", weeklyHours: "39", servicesConsent: "on" };
  it("holds only documented keys, trimmed, with empty ones left out and the degree as the text true or false", () => {
    const b = buildRequest(f, null);
    expect(b).toEqual({ permitType: "critical_skills", offerDetails: { occupationCode: "2136", annualPay: "45000", relevantDegree: "true", degreeAwardMonth: "2025-06", employerName: "Example Care Ltd", title: "Fake Developer", startDate: "2027-01-04", weeklyHours: "39" }, servicesConsent: true });
    expect(buildRequest({ ...f, relevantDegree: "no" }, null).offerDetails).toMatchObject({ relevantDegree: "false" });
    expect(buildRequest({ ...f, relevantDegree: "no" }, null).offerDetails).not.toHaveProperty("degreeAwardMonth");
  });
  it("names the job only when there is one, and the HR contact tick only with a job (the route refuses it without)", () => {
    expect(buildRequest({ ...f, employerContact: "on" }, null)).not.toHaveProperty("employerContact");
    expect(buildRequest({ ...f, employerContact: "on" }, null)).not.toHaveProperty("jobId");
    expect(buildRequest({ ...f, employerContact: "on" }, "1042")).toMatchObject({ jobId: "1042", employerContact: true });
    expect(buildRequest(f, "1042")).not.toHaveProperty("employerContact");
  });
  it("an unknown permit type falls back to the first, a value is cut to the route's 500 characters, a hostile value stays a plain string", () => {
    expect(buildRequest({ ...f, permitType: "<script>" }, null).permitType).toBe("critical_skills");
    expect(buildRequest({ ...f, permitType: "general" }, null).permitType).toBe("general");
    expect(buildRequest({ ...f, title: "x".repeat(900) }, null).offerDetails.title).toHaveLength(500);
    expect(buildRequest({ ...f, title: "<img src=x onerror=alert(1)>" }, null).offerDetails.title).toBe("<img src=x onerror=alert(1)>");
    expect(Object.keys(buildRequest({ ...f, __proto__: "x", constructor: "y" } as never, null).offerDetails).sort()).not.toContain("constructor");
  });
});

describe("words for every code of the request and upload routes (docs/openapi/candidate.yaml)", () => {
  const yaml = readFileSync(join(import.meta.dirname, "../../../../docs/openapi/candidate.yaml"), "utf8");
  const section = (from: string, to: string) => yaml.slice(yaml.indexOf(from), yaml.indexOf(to, yaml.indexOf(from) + from.length));
  const codesIn = (s: string) => [...new Set([...s.matchAll(/`([A-Z][A-Z_]{4,})`/g)].map((m) => m[1]!))];
  const generic = (flow: Flow) => say(flow, { ok: false, status: 400, code: "ZZZ_NOT_A_CODE" }).text;
  it("each code the request route answers with has its own sentence", () => {
    const codes = codesIn(section("operationId: requestCandidateServicesCase", "/api/candidate/cases/{id}:")).filter((c) => !["BOT_SUSPECTED"].includes(c));
    expect(codes).toEqual(expect.arrayContaining(["NOT_VERIFIED", "REFUSED", "JOB_NOT_FOUND", "CASE_ALREADY_OPEN", "CASE_LIMIT", "SERVICES_UNAVAILABLE"]));
    for (const code of codes) expect(say("request", { ok: false, status: 400, code }).text, code).not.toBe(generic("request"));
    expect(say("request", { ok: false, status: 403, code: "NOT_VERIFIED" }).screen).toBe("check-email");
  });
  it("each code the upload route answers with has its own sentence", () => {
    const codes = codesIn(section("operationId: uploadCaseDocument", "/api/candidate/cases/{id}/documents/{docId}:") + yaml.slice(yaml.indexOf("    UploadBadRequest:"), yaml.indexOf("    FilesUnavailable:") + 400));
    expect(codes).toEqual(expect.arrayContaining(["CASE_CLOSED", "DOCUMENT_LIMIT", "FILE_TOO_LARGE", "WRONG_FILE_TYPE", "FILE_ACTIVE_CONTENT", "FILES_UNAVAILABLE", "EMPTY_FILE"]));
    for (const code of codes) expect(say("upload", { ok: false, status: 400, code }).text, code).not.toBe(generic("upload"));
    expect(say("upload", { ok: false, status: 413, code: "FILE_TOO_LARGE" }).text).toMatch(/4 MB/);
    expect(say("request", { ok: false, status: 429, code: "TOO_MANY_REQUESTS" }).text).toMatch(/Too many tries/);
  });
});

describe("the request page (server component)", () => {
  const search = (q: Record<string, string | string[] | undefined>) => ({ searchParams: Promise.resolve(q) });
  const redirectsTo = async (run: () => Promise<unknown>) => { try { await run(); } catch (e) { return String((e as Error).message).replace("NEXT_REDIRECT ", ""); } return null; };
  it("a visitor goes to log in and comes back to the form, with the job kept only when it is digits", async () => {
    expect(await redirectsTo(() => RequestPage(search({})))).toBe("/login?next=%2Fpermit-services%2Frequest");
    expect(await redirectsTo(() => RequestPage(search({ job: "1042" })))).toBe("/login?next=%2Fpermit-services%2Frequest%3Fjob%3D1042");
    for (const bad of ["1042x", "../1", "1".repeat(19), "1&next=//evil.example", ["1", "2"]]) expect(await redirectsTo(() => RequestPage(search({ job: bad as string }))), JSON.stringify(bad)).toBe("/login?next=%2Fpermit-services%2Frequest");
  });
  it("a signed-in candidate gets the form with the occupations; a live job fills it in; a missing job or a bad id is ignored", async () => {
    state.signedIn = true;
    state.jobs.set("1042", { id: "1042", title: "Fake Developer", employerName: "Example Care Ltd", occupationCode: "2136", contractMonths: 24, advertText: "SECRET ADVERT", salaryLow: 1 });
    const a = await RequestPage(search({ job: "1042" }));
    expect(a.props.job).toEqual({ id: "1042", title: "Fake Developer", employerName: "Example Care Ltd", occupationCode: "2136", contractMonths: 24 }); // only these five reach the browser
    expect(a.props.occupations).toEqual(state.occupations);
    expect((await RequestPage(search({ job: "999" }))).props.job).toBeNull();
    expect((await RequestPage(search({ job: "abc" }))).props.job).toBeNull();
    expect((await RequestPage(search({}))).props.job).toBeNull();
    state.notice = { title: "Closed", body: "Wait." };
    expect((await RequestPage(search({}))).props.notice).toEqual({ title: "Closed", body: "Wait." });
  });
  it("is noindex, its title and description keep the size rules", () => {
    const m = requestMeta();
    expect(m.robots).toEqual({ index: false, follow: false });
    expect(titleProblem(String(m.title).replace(" | Irish Work Permit", ""))).toBeNull();
    expect(descriptionProblem(String(m.description))).toBeNull();
  });
});
