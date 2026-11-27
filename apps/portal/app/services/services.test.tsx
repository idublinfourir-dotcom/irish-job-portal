// P20, unit: the employer's permit services pages. Every state of the list and the case page rendered to HTML, the model's words, the request body, the success and refusal words for every
// code of the portal case routes (read from docs/openapi/portal.yaml), and the page files with the data layer stood in. No browser, network or database.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { parse } from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({ role: "account_owner", reads: {} as Record<string, { status: number; body: Record<string, unknown> }>, calls: [] as string[], to: "" }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, redirect: (u: string) => { throw new Error(`NEXT_REDIRECT ${u}`); }, useRouter: () => ({ refresh() {} }) }));
vi.mock("../_jobs/guard", () => ({ member: async () => ({ role: st.role }), bodyOf: (r: { status: number; body: Record<string, unknown> } | null, k: string) => (r?.status === 200 ? r.body[k] : undefined) }));
vi.mock("../../lib/data", () => {
  const rd = (k: string) => async (a?: unknown) => { st.calls.push(`${k}${a && typeof a === "object" ? JSON.stringify(a) : a ?? ""}`); return st.reads[k] ?? { status: 404, body: { code: "NOT_FOUND" } }; };
  return { readCases: rd("cases"), readCase: rd("case"), readCaseTimeline: rd("timeline"), readCaseDocuments: rd("docs"), readPermitNotice: rd("notice"), readOccupations: rd("occupations"), readJobs: rd("jobs") };
});
import CasePage from "./[id]/page";
import ListPage from "./page";
import RequestPage from "./request/page";
import { buildRequest } from "./request/build";
import { ResultView, RequestView } from "./request/views";
import { CODE_TEXT, say } from "./messages";
import { asked, banner, canUpload, caseState, fmtSize, permitFeeLabel, reached, PRICE_LINE, SERVICE_FEE, steps, updateLine, type CaseEvent, type CaseRow } from "./model";
import { CaseProblem, CasesView, CaseView, RoleRefused } from "./views";

type PEl = ReactElement<Record<string, unknown>>;
const html = (e: ReactElement) => renderToStaticMarkup(e).replaceAll("<!-- -->", "");
const text = (e: ReactElement) => html(e).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'");
const clean = (s: string) => expect(s).not.toMatch(/[–—]|undefined|\[object|Sample|Launch B|dangerouslySetInnerHTML|<img|Robin|Message your case handler|Needed from|PS-0|\bPayer\b/);
const C = (o: Partial<CaseRow> = {}): CaseRow => ({ id: "31", status: "received", decisionOutcome: null, permitType: "critical_skills", jobId: "5", jobTitle: "Fake Nurse", createdAt: "2026-11-01T09:00:00Z", lastChangeAt: "2026-11-02T09:00:00Z", documentCount: 0, ...o });
const E = (kind: string, status: string, at = "2026-11-02T09:00:00Z", extra: Partial<CaseEvent> = {}): CaseEvent => ({ at, kind, status, ...extra });
const ask = [E("received", "received", "2026-11-01T09:00:00Z"), E("documents_needed", "documents_needed", "2026-11-03T09:00:00Z", { documentsNeeded: [{ code: "offer_letter", label: "Job offer letter" }, { code: "zz", label: null }] })];
beforeEach(() => { st.role = "account_owner"; st.reads = {}; st.calls = []; });

describe("the model", () => {
  it("names each end state from the decision and the timeline", () => {
    expect(caseState(C(), [])).toBe("open");
    expect(caseState(C({ status: "decision", decisionOutcome: "granted" }), [])).toBe("granted");
    expect(caseState(C({ status: "closed", decisionOutcome: "refused" }), [])).toBe("refused");
    expect(caseState(C({ status: "closed" }), [E("withdrawn", "closed")])).toBe("withdrawn");
    expect(caseState(C({ status: "closed" }), [E("referred", "closed")])).toBe("referred");
    expect(caseState(C({ status: "closed" }), [])).toBe("closed");
  });
  it("asks for documents only while the case waits on them; the steps carry dates and counts read from the case", () => {
    expect(asked(C({ status: "documents_needed" }), ask).map((d) => d.label)).toEqual(["Job offer letter", null]);
    expect(asked(C({ status: "submitted" }), ask)).toEqual([]);
    expect(asked(C({ status: "closed" }), ask)).toEqual([]);
    expect(reached(C({ status: "submitted" }), [])).toBe(3);
    const s = steps(C({ status: "documents_needed", documentCount: 2 }), ask);
    expect(s.map((x) => x.state)).toEqual(["done", "now", "todo", "todo"]);
    expect(s[0]!.detail).toBe("1 Nov 2026");
    expect(s[1]!.detail).toBe("2 uploaded");
    expect(canUpload(C({ status: "decision" }))).toBe(false);
    expect(canUpload(C({ status: "submitted" }))).toBe(true);
    expect(canUpload(C({ status: "closed" }))).toBe(false);
  });
  it("words each state; our fee is the employer or agency's, DETE's fee has the two decided labels, and no claim is made about who pays elsewhere", () => {
    expect(banner(C({ status: "documents_needed" }), "open", 2).action).toBe("Action needed from you");
    expect(banner(C({ status: "documents_needed" }), "open", 0).action).toBeNull();
    for (const s of ["granted", "refused", "referred", "withdrawn", "closed"] as const) expect(banner(C(), s, 0).title.length).toBeGreaterThan(5);
    expect(SERVICE_FEE).toBe("Our service fee is paid by the employer or agency, never the candidate.");
    expect(PRICE_LINE.replace("Prices and invoices: coming soon.", "")).not.toMatch(/placeholder|coming soon|lorem|draft|TBC|[\u2013\u2014]/i); // the live check's banned words, and no dashes
    expect(permitFeeLabel("critical_skills")).toBe("Paid by the employee or employer");
    expect(permitFeeLabel("general")).toBe("Usually paid by the employer");
    expect(fmtSize(2048)).toBe("2 KB");
  });
  it("an update line holds only the kind, the status, the labels and the outcome", () => {
    expect(updateLine(ask[1]!)).toBe("We asked you for: Job offer letter, Another document");
    expect(updateLine(E("decision", "decision", "2026-11-04T09:00:00Z", { outcome: { code: "granted", label: "Granted" } }))).toBe("A decision was made: Granted");
    expect(updateLine(E("status_changed", "submitted"))).toBe("The case moved to: Submitted");
    expect(updateLine(E("assigned", "received"))).toBe("Our team took the case");
  });
});

describe("the list", () => {
  it("empty, with cases (the job only on a card), full, an error, and Previous and Next", () => {
    const empty = text(<CasesView cases={[]} nextHref={null} notice={null} />);
    expect(empty).toContain("Cases our team is handling for you.");
    expect(empty).toContain("No permit cases yet");
    expect(html(<CasesView cases={[]} nextHref={null} notice={null} />).match(/<h1/g)).toHaveLength(1);
    const many = html(<CasesView cases={[C(), C({ id: "32", jobTitle: null, status: "documents_needed" }), C({ id: "33", status: "closed", decisionOutcome: "granted" })]} nextHref="/services?after=abc" prevHref="/services" notice={{ title: "DETE portal closed", body: "Back soon." }} />);
    const t = many.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const w of ["Fake Nurse", "Permit request", "Critical Skills Employment Permit", "Case 31", "Documents needed", "Granted", "DETE portal closed", "Payment", "Prices and invoices: coming soon", "What we handle", "Previous", "Next"]) expect(t).toContain(w);
    expect(many).toContain('href="/services/31"');
    expect(many).toContain('href="/services?after=abc"');
    clean(many);
    expect(text(<CasesView cases={[1, 2, 3, 4, 5].map((i) => C({ id: String(i) }))} nextHref={null} notice={null} />)).toContain("You have 5 open cases");
    const bad = html(<CasesView cases={[]} nextHref={null} notice={null} error="Boom." />);
    expect(bad).toContain('role="alert"');
    expect(bad).not.toContain("New request");
  });
  it("the role refusal names no data", () => { expect(text(<RoleRefused />)).toContain("Not open to your role"); clean(html(<RoleRefused />)); });
});

describe("one case", () => {
  const docs = [{ id: "7", fileName: "offer.pdf", contentType: "pdf", sizeBytes: 90_000, uploadedAt: "2026-11-05T09:00:00Z", copyDeleted: false }, { id: "8", fileName: null, contentType: "png", sizeBytes: 500, uploadedAt: "2026-11-05T09:00:00Z", copyDeleted: true }];
  const view = (c: CaseRow, o: { events?: CaseEvent[]; docs?: typeof docs; requester?: boolean; docsError?: string } = {}) =>
    html(<CaseView c={c} events={o.events ?? ask} docs={o.docs ?? []} docsError={o.docsError} requester={o.requester ?? true} notice={null} upload={<p>UPLOAD</p>} withdraw={<p>WITHDRAW</p>} />);
  it("the requester: what we asked for, the copies with an open link, the upload with its wording, our fee and DETE's, the updates newest first, withdraw", () => {
    const h = view(C({ status: "documents_needed", documentCount: 1 }), { docs });
    const t = h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'");
    for (const w of ["Fake Nurse", "Critical Skills Employment Permit · Case 31", "Documents needed", "Action needed from you", "We asked you for", "Job offer letter", "Another document", "offer.pdf", "Copy removed", "UPLOAD", "WITHDRAW",
      "Our service fee is paid by the employer or agency, never the candidate.", "DETE's permit fee for this permit: Paid by the employee or employer", "30 days after the case closes"]) expect(t).toContain(w);
    expect(h).toContain('href="/api/portal/cases/31/documents/7"');
    expect(h).not.toContain('documents/8"');
    expect(h.indexOf("We asked you for: ")).toBeLessThan(h.indexOf("Request received"));
    expect(h.match(/<h1/g)).toHaveLength(1);
    clean(h);
  });
  it("someone else of the company: no copies, no upload, no withdraw, and a plain line why", () => {
    const t = text(<CaseView c={C({ status: "documents_needed" })} events={ask} docs={[]} requester={false} notice={null} upload={<p>UPLOAD</p>} withdraw={<p>WITHDRAW</p>} />);
    expect(t).toContain("Copies belong to the person who asked for this case");
    expect(t).not.toContain("UPLOAD");
    expect(t).not.toContain("WITHDRAW");
    expect(t).toContain("Job offer letter"); // what we asked for is the case's, not the copies'
  });
  it("each end state shows its headline with no upload or withdraw; a case at decision takes no more copies", () => {
    const ended: [CaseRow, CaseEvent[], string][] = [
      [C({ status: "closed", decisionOutcome: "granted" }), [E("decision", "decision", "2026-11-04T09:00:00Z", { outcome: { code: "granted", label: "Granted" } })], "Permit granted"],
      [C({ status: "closed", decisionOutcome: "refused" }), [E("decision", "decision")], "Permit refused"],
      [C({ status: "closed" }), [E("referred", "closed", "2026-11-04T09:00:00Z")], "Referred to a solicitor"],
      [C({ status: "closed" }), [E("withdrawn", "closed")], "Request withdrawn"],
      [C({ status: "closed" }), [E("closed", "closed")], "Case closed"],
    ];
    for (const [c, ev, head] of ended) { const h = view(c, { events: ev }); expect(h).toContain(head); expect(h).not.toContain("WITHDRAW"); expect(h).not.toContain("UPLOAD"); }
    const d = view(C({ status: "decision" }), { events: [E("received", "received")] });
    expect(d).toContain("Waiting for a decision");
    expect(d).toContain("takes no more documents");
    expect(d).not.toContain("UPLOAD");
  });
  it("a failed copies read is an alert and the case still shows; file names and hostile text are text, never markup", () => {
    expect(view(C({ status: "submitted" }), { docsError: "Docs failed." })).toContain('role="alert"');
    const h = view(C({ jobTitle: "<script>x</script>" }), { docs: [{ ...docs[0]!, fileName: "<img src=x onerror=1>.pdf" }] });
    expect(h).not.toContain("<script>x");
    expect(h).not.toContain("<img src=x");
    expect(html(<CaseProblem message="Gone." />)).toContain("All permit cases");
  });
});

describe("the request form", () => {
  const occ = [{ code: "2231", title: "Nurses" }];
  it("the form: the fields of the route, our fee and DETE's, the 30 day and copies wording, no who-is-asking step, no employer email, no save for later", () => {
    const h = html(<RequestView occupations={occ} jobs={[{ id: "5", title: "Fake Cook", occupationCode: "2231" }]} degree="yes" notice={null} error="Nope." />);
    const t = h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const w of ["New permit request", "Permit type", "Critical Skills Employment Permit", "Fake Cook", "Nurses", "Salary offered", "Month the degree was awarded", "Send request", "Copies only, never originals.", "30 days", "Paid by the employee or employer", "Nope."]) expect(t).toContain(w);
    for (const w of ["Who is asking", "Employer contact email", "Save for later", "I am the candidate"]) expect(t).not.toContain(w);
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(html(<RequestView occupations={occ} jobs={[]} degree="no" notice={null} />)).not.toContain("Month the degree");
    clean(h);
  });
  it("the result: the free check (eligible and not, none), the upload with its wording and the copies sent", () => {
    const fc = { qualifies: true, reason: "x", minimum: 40904, why: "The pay is above the minimum.", standingLine: "Rules checked.", rulesCheckedOn: "2026-11-12", registration: null };
    const ok = text(<ResultView caseHref="/services/31" freeCheck={fc} docs={[{ fileName: "a.pdf", sizeBytes: 2048 }]} notice={null} />);
    for (const w of ["Request received", "Looks eligible", "€40,904", "Copies only, never originals.", "a.pdf", "2 KB", "Track this request"]) expect(ok).toContain(w);
    expect(text(<ResultView caseHref="/services/31" freeCheck={{ ...fc, qualifies: false }} docs={[]} notice={null} />)).toContain("May not qualify");
    expect(text(<ResultView caseHref="/services/31" freeCheck={null} docs={[]} notice={null} uploadError="Bad file." />)).toContain("could not run the free check");
  });
  it("the body: only the documented keys, 1 to 500 characters, the degree as true or false, the award month only with a degree, a job only when it is an id, the key as given", () => {
    const key = "k".repeat(20);
    const b = buildRequest({ permitType: "general", occupationCode: " 2231 ", annualPay: "45000", relevantDegree: "yes", degreeAwardMonth: "2020-06", contractMonths: "", jobId: "12", title: "x".repeat(900), evil: "1" }, key);
    expect(b).toEqual({ permitType: "general", jobId: "12", offerDetails: { occupationCode: "2231", annualPay: "45000", relevantDegree: "true", degreeAwardMonth: "2020-06", title: "x".repeat(500) }, servicesConsent: true, idempotencyKey: key });
    const n = buildRequest({ permitType: "other", relevantDegree: "no", degreeAwardMonth: "2020-06", jobId: "1; drop" }, key);
    expect(n).toEqual({ permitType: "critical_skills", offerDetails: { relevantDegree: "false" }, servicesConsent: true, idempotencyKey: key });
  });
});

describe("words for every code of the routes these pages call (docs/openapi/portal.yaml)", () => {
  const y = parse(readFileSync(join(import.meta.dirname, "../../../../docs/openapi/portal.yaml"), "utf8")) as { paths: Record<string, unknown>; components: { responses: Record<string, unknown> } };
  const codes = (v: unknown, out = new Set<string>()): Set<string> => {
    if (typeof v === "string") for (const m of v.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)) out.add(m[1]!);
    else if (Array.isArray(v)) v.forEach((x) => codes(x, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "code" && typeof x === "string" && /^[A-Z_]+$/.test(x)) out.add(x); codes(x, out); }
    return out;
  };
  const PATHS = ["/api/portal/cases", "/api/portal/cases/{id}", "/api/portal/cases/{id}/withdraw", "/api/portal/cases/{id}/documents", "/api/portal/cases/{id}/documents/{docId}", "/api/portal/cases/{id}/timeline"];
  it("every code a case route names, and every shared response, has its own sentence that never shows a raw code", () => {
    const all = new Set<string>();
    for (const p of PATHS) codes(y.paths[p], all);
    for (const r of ["NoSession", "BadRequest", "TooMany", "BodyTooLarge", "ReadForbidden"]) codes(y.components.responses[r], all);
    expect(all.size).toBeGreaterThan(15); // the walk finds them
    expect([...all].filter((c) => !(c in CODE_TEXT))).toEqual([]);
    for (const c of all) { expect(CODE_TEXT[c]!.length).toBeGreaterThan(15); expect(CODE_TEXT[c]).not.toMatch(/[A-Z]{3,}_[A-Z_]{3,}/); clean(CODE_TEXT[c]!); }
  });
  it("an unknown code gets the general line of its status, never server text; no answer is offline; a limit is a limit", () => {
    expect(say({ status: 0 })).toMatch(/could not reach/);
    expect(say({ status: 500, code: "SOMETHING" })).toMatch(/our side/);
    expect(say({ status: 429 })).toBe(CODE_TEXT.TOO_MANY_REQUESTS);
    expect(say({ status: 418, code: "X" })).toMatch(/did not work/);
    expect(say({ status: 409, code: "CASE_LIMIT" })).toContain("5 open cases");
  });
});

describe("the page files (data layer stood in)", () => {
  const okCase = { status: 200, body: { case: C({ status: "documents_needed" }) } }, okTimeline = { status: 200, body: { events: ask } };
  const prime = (docs: { status: number; body: Record<string, unknown> }) => { st.reads = { case: okCase, timeline: okTimeline, docs }; };
  it("the list: a poster is refused and nothing is read; an owner gets the cases and the next link; a forged token is not passed on; a failed read is an error", async () => {
    st.role = "poster";
    expect(text((await ListPage({ searchParams: Promise.resolve({}) })) as PEl)).toContain("Not open to your role");
    expect(st.calls).toEqual([]);
    st.role = "account_owner";
    st.reads = { cases: { status: 200, body: { cases: [C()], next: "abc_DEF-1" } } };
    const el = (await ListPage({ searchParams: Promise.resolve({ after: "bad token!" }) })) as PEl;
    expect(st.calls).toContain("cases");
    expect(el.props).toMatchObject({ nextHref: "/services?after=abc_DEF-1", prevHref: undefined });
    st.calls = [];
    expect(((await ListPage({ searchParams: Promise.resolve({ after: "tok_1" }) })) as PEl).props.prevHref).toBe("/services");
    expect(st.calls).toContain('cases{"after":"tok_1"}');
    st.reads = { cases: { status: 429, body: { code: "TOO_MANY_REQUESTS" } } };
    expect(((await ListPage({ searchParams: Promise.resolve({}) })) as PEl).props.error).toBe(CODE_TEXT.TOO_MANY_REQUESTS);
  });
  it("one case: a bad id and a missing case are 404 before and after a read; the requester is the one whose copies read answers; a poster is refused", async () => {
    const page = (id: string) => CasePage({ params: Promise.resolve({ id }) }) as Promise<PEl>;
    for (const bad of ["abc", "1 or 1=1", "-1", "1".repeat(30), "%00"]) await expect(page(bad)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(st.calls).toEqual([]);
    st.reads = { case: { status: 404, body: { code: "CASE_NOT_FOUND" } }, timeline: { status: 404, body: { code: "CASE_NOT_FOUND" } } };
    await expect(page("31")).rejects.toThrow("NEXT_NOT_FOUND");
    prime({ status: 200, body: { documents: [] } });
    expect((await page("31")).props.requester).toBe(true);
    prime({ status: 404, body: { code: "CASE_NOT_FOUND" } });
    const other = await page("31");
    expect(other.props).toMatchObject({ requester: false, docsError: undefined });
    prime({ status: 503, body: { code: "FILES_UNAVAILABLE" } });
    expect((await page("31")).props).toMatchObject({ requester: true, docsError: CODE_TEXT.FILES_UNAVAILABLE });
    st.reads = { case: { status: 500, body: {} }, timeline: okTimeline };
    expect(text(await page("31"))).toContain("could not be loaded");
    st.role = "viewer"; st.calls = [];
    expect(text(await page("31"))).toContain("Not open to your role");
    expect(st.calls).toEqual([]);
  });
  it("the request page: an owner gets only the live jobs; a poster is refused; a failed occupation read is an error", async () => {
    st.reads = { occupations: { status: 200, body: { occupations: [{ code: "2231", title: "Nurses", slug: "n", listStatus: "other" }] } }, jobs: { status: 200, body: { jobs: [{ id: "1", title: "Live", status: "live" }, { id: "2", title: "Old", status: "closed" }] } } };
    const el = (await RequestPage()) as PEl;
    expect(el.props).toMatchObject({ occupations: [{ code: "2231", title: "Nurses" }], jobs: [{ id: "1", title: "Live" }] });
    st.reads.occupations = { status: 500, body: {} };
    expect(text((await RequestPage()) as PEl)).toContain("could not be loaded");
    st.role = "poster";
    expect(text((await RequestPage()) as PEl)).toContain("Not open to your role");
  });
});
