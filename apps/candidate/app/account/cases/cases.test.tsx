// P17c, unit: the permit case pages (frame A08, BA1, BA5, BA6, BA29, DD1, DD37, B32; conflicts CF1, CF15, CF58, CF93) rendered to HTML for every state, the model
// behind them, the words for every code of the routes they call (read from docs/openapi/candidate.yaml), and the two page files with the data layer stood in.
// react-dom/server, no browser, no network, no database (the real-database run is packages/db/test/p17c-pages.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ read: {} as Record<string, unknown> }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {} }),
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("../../../lib/data", () => ({
  readCases: async () => state.read.cases, readCase: async () => state.read.case, readCaseTimeline: async () => state.read.timeline,
  readCaseDocuments: async () => state.read.docs, readPermitNotice: async () => ({ ok: true, data: state.read.notice ?? null }),
}));
import { descriptionProblem, titleProblem } from "../../../lib/seo";
import { say } from "../../(auth)/messages";
import { caseSay } from "./messages";
import { banner, caseState, fmtDate, steps, updateLine, whoPays, type CaseDoc, type CaseEvent, type CaseRow } from "./model";
import CasePage, { generateMetadata as caseMeta } from "./[id]/page";
import CasesPage, { generateMetadata as casesMeta } from "./page";
import { CaseProblem, CasesView, CaseView } from "./views";

const clean = (s: string) => expect(s).not.toMatch(/[–—]|undefined|\[object|Sample|Launch B|dangerouslySetInnerHTML|<img|Robin|Message your case handler|Needed from:|PS-0/);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const row = (o: Partial<CaseRow> = {}): CaseRow => ({ id: "31", status: "received", decisionOutcome: null, permitType: "critical_skills", jobId: "1042", jobTitle: "Fake Developer", employerName: "Example Care Ltd", payer: "employer", documentsNeeded: [], createdAt: "2026-11-02T09:00:00.000Z", lastChangeAt: "2026-11-04T09:00:00.000Z", documentCount: 0, ...o });
const ev = (kind: string, status: string, at = "2026-11-02T09:00:00.000Z", more: Partial<CaseEvent> = {}): CaseEvent => ({ at, kind, status, ...more });
const doc = (o: Partial<CaseDoc> = {}): CaseDoc => ({ id: "9", fileName: "offer.pdf", contentType: "pdf", sizeBytes: 90211, uploadedAt: "2026-11-03T10:00:00.000Z", copyDeleted: false, ...o });
const view = (c: CaseRow, events: CaseEvent[] = [ev("received", "received")], docs: CaseDoc[] = [], extra: { docsError?: string; notice?: { title: string; body: string } | null } = {}) =>
  html(<CaseView c={c} events={events} docs={docs} notice={extra.notice ?? null} docsError={extra.docsError} upload={<span data-x="upload" />} withdraw={<span data-x="withdraw" />} />);
beforeEach(() => { state.read = {}; });

describe("the model (DD1 states, steps, words)", () => {
  it("names each end state from the decision and the timeline", () => {
    expect(caseState(row(), [])).toBe("open");
    expect(caseState(row({ status: "decision", decisionOutcome: "granted" }), [])).toBe("granted");
    expect(caseState(row({ status: "closed", decisionOutcome: "refused" }), [])).toBe("refused");
    expect(caseState(row({ status: "closed" }), [ev("withdrawn", "closed")])).toBe("withdrawn");
    expect(caseState(row({ status: "closed" }), [ev("referred", "closed")])).toBe("referred");
    expect(caseState(row({ status: "closed" }), [ev("closed", "closed")])).toBe("closed");
  });
  it("marks the furthest step reached, also for a closed case, with a date and a count read from the case", () => {
    const s = steps(row({ status: "documents_needed", documentCount: 2, documentsNeeded: [{ code: "x", label: "X" }] }), [ev("received", "received"), ev("documents_needed", "documents_needed")]);
    expect(s.map((x) => x.state)).toEqual(["done", "now", "todo", "todo"]);
    expect(s[0]!.detail).toBe(fmtDate("2026-11-02T09:00:00.000Z"));
    expect(s[1]!.detail).toBe("2 uploaded");
    expect(steps(row({ status: "closed" }), [ev("received", "received"), ev("status_changed", "submitted"), ev("withdrawn", "closed")]).map((x) => x.state)).toEqual(["done", "done", "done", "todo"]);
    expect(steps(row({ status: "decision", decisionOutcome: "granted" }), []).map((x) => x.state)).toEqual(["done", "done", "done", "done"]);
    expect(steps(row({ status: "waiting_for_employer" }), [ev("status_changed", "waiting_for_employer")])[1]!.detail).toBe("Waiting for your employer");
  });
  it("words each state (DD1), and who pays in the decided words with no claim about the DETE fee (CF1)", () => {
    for (const [st, c] of [["granted", row({ decisionOutcome: "granted" })], ["refused", row({ decisionOutcome: "refused" })], ["referred", row({ status: "closed" })], ["withdrawn", row({ status: "closed" })], ["closed", row({ status: "closed" })]] as const) expect(banner(c, st).lead, st).toBeTruthy();
    expect(banner(row({ status: "documents_needed", documentsNeeded: [{ code: "a", label: "A" }] }), "open").action).toBe("Action needed from you");
    expect(banner(row({ status: "documents_needed" }), "open").action).toBeNull();
    expect(banner(row({ status: "waiting_for_employer" }), "open").title).toBe("Waiting for your employer");
    expect(whoPays("employer")).toMatch(/your employer, never by you/);
    expect(whoPays("agency")).toMatch(/agency, never by you/);
    expect(whoPays(null)).toMatch(/free for candidates/);
    for (const p of ["employer", "agency", null] as const) expect(whoPays(p)).not.toMatch(/Critical Skills|DETE fee|[–—]/);
  });
  it("an update line holds only the kind, the status, the labels and the outcome", () => {
    expect(updateLine(ev("documents_needed", "documents_needed", "x", { documentsNeeded: [{ code: "a", label: "Passport copy" }, { code: "old", label: null }] }))).toBe("We asked you for: Passport copy, Another document");
    expect(updateLine(ev("decision", "decision", "x", { outcome: { code: "granted", label: "Granted" } }))).toBe("A decision was made: Granted");
    expect(updateLine(ev("referred", "closed", "x", { referral: { code: "referred_to_solicitor", firm: "Some Firm LLP" } }))).not.toMatch(/Firm/);
    for (const k of ["received", "assigned", "status_changed", "closed", "withdrawn"]) expect(updateLine(ev(k, "submitted"))).toBeTruthy();
  });
});

describe("the list (BA29, BA6)", () => {
  it("empty: one H1, a plain sentence and the way to start", () => {
    const h = html(<CasesView cases={[]} olderHref={null} notice={null} />);
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(h).toContain("You have no permit requests");
    expect(h).toContain('href="/permit-services/request"');
    clean(h);
  });
  it("several cases: each links to its page with status, last change and documents needed; an ended case says how; older requests link", () => {
    const cases = [row({ id: "5", status: "documents_needed", documentsNeeded: [{ code: "a", label: "A" }, { code: "b", label: "B" }] }), row({ id: "4", status: "closed", decisionOutcome: "granted" }), row({ id: "3", status: "closed", jobTitle: null, employerName: null })];
    const h = html(<CasesView cases={cases} olderHref="/account/cases?after=abc" notice={null} />);
    expect(h).toContain('href="/account/cases/5"');
    expect(h).toContain("2 documents needed");
    expect(h).toContain("Granted");
    expect(h).toContain("Permit request");
    expect(h).toContain('href="/account/cases?after=abc"');
    expect(h).toContain('href="/permit-services/request"');
    clean(h);
  });
  it("five open cases: the limit is said and the start button is gone (CASE_LIMIT)", () => {
    const h = html(<CasesView cases={Array.from({ length: 5 }, (_, i) => row({ id: String(i + 1) }))} olderHref={null} notice={null} />);
    expect(h).toContain("You have 5 open requests");
    expect(h).not.toContain("Start a permit request");
    expect(html(<CasesView cases={Array.from({ length: 6 }, (_, i) => row({ id: String(i + 1), status: i < 4 ? "received" : "closed" }))} olderHref={null} notice={null} />)).toContain("Start a permit request");
  });
  it("an error shows as an alert with no list, and the DETE notice (DD37) shows as plain text", () => {
    const h = html(<CasesView cases={[]} olderHref={null} notice={{ title: "DETE closed", body: "Cases wait.\n<b>x</b>" }} error="Nope." />);
    expect(h).toContain('role="alert"');
    expect(h).toContain("DETE closed");
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(h).not.toContain("You have no permit requests");
  });
});

describe("one case (A08)", () => {
  it("documents needed: title, the four steps, what we asked for, the uploaded copy with its open link, who pays, the updates newest first, the 30 day rule", () => {
    const c = row({ status: "documents_needed", documentCount: 1, documentsNeeded: [{ code: "passport_copy", label: "Passport copy" }] });
    const h = view(c, [ev("received", "received"), ev("documents_needed", "documents_needed", "2026-11-04T09:00:00.000Z", { documentsNeeded: c.documentsNeeded })], [doc()]);
    expect(h.match(/<h1/g)).toHaveLength(1);
    for (const w of ["Permit case", "Critical Skills Employment Permit", "Example Care Ltd", "Case 31", "Documents needed", "Action needed from you", "Received", "Submitted", "Decision", "Passport copy", "offer.pdf", "Who pays", "Updates", "We keep them for 30 days after your case closes"]) expect(text(h)).toContain(w);
    expect(h).toContain('href="/api/candidate/cases/31/documents/9"');
    expect(h).toContain('data-x="upload"');
    expect(text(h)).toContain("Copies only, never originals."); // decision #297, next to the upload
    expect(h).toContain('data-x="withdraw"');
    expect(text(h).indexOf("We asked you for: Passport copy")).toBeLessThan(text(h).indexOf("Request received"));
    clean(h);
  });
  it("no handler name, message box or 'needed from' party (CF93, CF15), and no staff field in the HTML", () => {
    const h = view(row({ status: "documents_needed", documentsNeeded: [{ code: "x", label: "Degree or qualification" }] }));
    expect(h.match(/handler|Message your|Needed from:|staff|Robin|assigned/i)).toBeNull();
  });
  it("each end state shows its own headline with no upload or withdraw (DD1)", () => {
    const cases: [string, CaseRow, CaseEvent[], string][] = [
      ["granted", row({ status: "decision", decisionOutcome: "granted" }), [ev("decision", "decision", "2026-11-09T09:00:00.000Z", { outcome: { code: "granted", label: "Granted" } })], "Permit granted"],
      ["refused", row({ status: "closed", decisionOutcome: "refused" }), [], "Permit refused"],
      ["referred", row({ status: "closed" }), [ev("referred", "closed")], "Referred to a solicitor"],
      ["withdrawn", row({ status: "closed" }), [ev("withdrawn", "closed")], "Request withdrawn"],
      ["closed", row({ status: "closed" }), [ev("closed", "closed")], "Case closed"],
    ];
    for (const [name, c, events, title] of cases) {
      const h = view(c, events);
      expect(h, name).toContain(title);
      expect(h, name).not.toContain('data-x="upload"');
      expect(h.includes('data-x="withdraw"'), name).toBe(true); // the page passes the node only for an open case; the view shows what it is given
    }
  });
  it("waiting for employer, and a case at decision with no outcome takes no more copies", () => {
    expect(text(view(row({ status: "waiting_for_employer" })))).toContain("Waiting for your employer");
    const h = view(row({ status: "decision" }));
    expect(text(h)).toContain("takes no more documents");
    expect(h).not.toContain('data-x="upload"');
  });
  it("a removed copy has no open link and says so; no copies and nothing asked says nothing is needed; a failed copies read is an alert; the closed notice shows", () => {
    expect(view(row(), [ev("received", "received")], [doc({ copyDeleted: true })])).toContain("Copy removed");
    expect(view(row(), [ev("received", "received")], [doc({ copyDeleted: true })])).not.toContain("/documents/9");
    expect(text(view(row()))).toContain("Nothing is needed from you yet");
    expect(view(row(), [], [], { docsError: "Docs off." })).toContain("Docs off.");
    expect(view(row(), [], [], { notice: { title: "DETE portal closed", body: "Wait." } })).toContain("DETE portal closed");
  });
  it("file names and a hostile employer are text, never markup", () => {
    const h = view(row({ employerName: "<script>x</script>" }), [], [doc({ fileName: '"><img src=x onerror=1>.pdf' })]);
    expect(h).not.toMatch(/<script|<img/);
    expect(h).toContain("&lt;script&gt;");
  });
  it("the problem screen is an alert with a way back", () => {
    const h = html(<CaseProblem message="Nope." />);
    expect(h).toContain('role="alert"');
    expect(h).toContain('href="/account/cases"');
  });
});

describe("words for every code of the routes these pages call (docs/openapi/candidate.yaml)", () => {
  const yaml = readFileSync(join(import.meta.dirname, "../../../../../docs/openapi/candidate.yaml"), "utf8");
  const block = (path: string) => {
    const from = yaml.indexOf(`\n  ${path}:\n`), end = yaml.indexOf("\n  /api/", from + 5);
    const b = yaml.slice(from, end < 0 ? undefined : end);
    const refs = [...b.matchAll(/responses\/([A-Za-z]+)'/g)].map((m) => { const i = yaml.indexOf(`\n    ${m[1]}:\n`); return yaml.slice(i, i + 700).split("\n").slice(0, 12).join("\n"); });
    return [b, ...refs].join("\n");
  };
  const codesIn = (s: string) => [...new Set([...[...s.matchAll(/`([A-Z][A-Z_]{4,})`/g)].map((m) => m[1]!), ...[...s.matchAll(/code: ([A-Z][A-Z_]{4,})/g)].map((m) => m[1]!)])];
  const generic = (flow: "withdraw" | "read") => caseSay(flow, { ok: false, status: 400, code: "ZZZ_NOT_A_CODE" });
  it("withdraw: each code has its own sentence", () => {
    const codes = codesIn(block("/api/candidate/cases/{id}/withdraw"));
    expect(codes).toEqual(expect.arrayContaining(["CASE_NOT_OPEN", "CASE_NOT_FOUND", "NO_SESSION", "BAD_ORIGIN", "REFUSED", "BODY_TOO_LARGE", "TOO_MANY_REQUESTS"]));
    for (const code of codes) expect(caseSay("withdraw", { ok: false, status: code === "TOO_MANY_REQUESTS" ? 429 : 400, code }), code).not.toBe(generic("withdraw"));
  });
  it("the list, the case, the timeline, the copies and the download: each code has its own sentence", () => {
    const codes = [...new Set(["/api/candidate/cases", "/api/candidate/cases/{id}", "/api/candidate/cases/{id}/timeline", "/api/candidate/cases/{id}/documents", "/api/candidate/cases/{id}/documents/{docId}"].flatMap((p) => codesIn(block(p))))];
    expect(codes).toEqual(expect.arrayContaining(["BAD_REQUEST", "CASE_NOT_FOUND", "NO_SESSION", "REFUSED", "DOCUMENT_NOT_FOUND", "FILES_UNAVAILABLE"]));
    const upload = new Set(["CASE_CLOSED", "DOCUMENT_LIMIT", "FILE_TOO_LARGE", "WRONG_FILE_TYPE", "FILE_ACTIVE_CONTENT", "EMPTY_FILE", "BODY_TOO_LARGE", "BAD_ORIGIN", "TOO_MANY_REQUESTS", "UPLOAD_TOO_MANY", "SERVICES_UNAVAILABLE", "CASE_LIMIT"]);
    const requestRoute = (c: string) => say("request", { ok: false, status: 400, code: c }).text !== say("request", { ok: false, status: 400, code: "ZZZ" }).text; // the POST of the list path belongs to the request form
    for (const code of codes.filter((c) => !upload.has(c) && !requestRoute(c) && c !== "CASE_NOT_OPEN")) expect(caseSay("read", { ok: false, status: 400, code }), code).not.toBe(generic("read"));
  });
  it("the upload codes keep their words from the request pages, and the general lines never show server text", () => {
    expect(say("upload", { ok: false, status: 409, code: "DOCUMENT_LIMIT" }).text).toMatch(/20 documents/);
    expect(caseSay("withdraw", { ok: false, status: 0 })).toMatch(/reach the site/);
    expect(caseSay("read", { ok: false, status: 503, code: "WEIRD" })).toMatch(/our side/);
    expect(caseSay("read", { ok: false, status: 429 })).toMatch(/Too many tries/);
  });
});

describe("the two page files (data layer stood in)", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const lands = async (run: () => Promise<unknown>) => { try { await run(); } catch (e) { return String((e as Error).message); } return null; };
  it("the list: signed out goes to log in and back; a signed-in candidate gets their cases and an older link; a failed read is an error, not a crash", async () => {
    state.read.cases = { ok: false, status: 401, code: "NO_SESSION" };
    expect(await lands(() => CasesPage({ searchParams: Promise.resolve({}) }))).toBe("NEXT_REDIRECT /login?next=%2Faccount%2Fcases");
    state.read.cases = { ok: true, data: { cases: [row()], next: "tok/en" } };
    const el = await CasesPage({ searchParams: Promise.resolve({}) });
    expect(el.props.cases).toHaveLength(1);
    expect(el.props.olderHref).toBe("/account/cases?after=tok%2Fen");
    state.read.cases = { ok: false, status: 400, code: "BAD_REQUEST" };
    expect((await CasesPage({ searchParams: Promise.resolve({ after: "forged" }) })).props.error).toMatch(/could not read that address/);
  });
  it("one case: a bad id, another candidate's case and a missing case are all the same 404; signed out goes to log in and back", async () => {
    for (const bad of ["abc", "-1", "1".repeat(19), "1 or 1=1", "%00", "../1", "1.5"]) expect(await lands(() => CasePage(params(bad))), bad).toBe("NEXT_NOT_FOUND");
    state.read = { case: { ok: false, status: 404, code: "CASE_NOT_FOUND" }, timeline: { ok: false, status: 404, code: "CASE_NOT_FOUND" }, docs: { ok: false, status: 404, code: "CASE_NOT_FOUND" } };
    expect(await lands(() => CasePage(params("31")))).toBe("NEXT_NOT_FOUND");
    state.read = { case: { ok: false, status: 401, code: "NO_SESSION" } };
    expect(await lands(() => CasePage(params("31")))).toBe("NEXT_REDIRECT /login?next=%2Faccount%2Fcases%2F31");
  });
  it("one case: an open case offers withdraw, an ended one does not; a failed copies read still shows the case", async () => {
    state.read = { case: { ok: true, data: { case: row() } }, timeline: { ok: true, data: { events: [ev("received", "received")] } }, docs: { ok: true, data: { documents: [doc()] } } };
    expect((await CasePage(params("31"))).props.withdraw).not.toBeNull();
    state.read.case = { ok: true, data: { case: row({ status: "closed" }) } };
    expect((await CasePage(params("31"))).props.withdraw).toBeNull();
    state.read.docs = { ok: false, status: 503, code: "FILES_UNAVAILABLE" };
    const el = await CasePage(params("31"));
    expect(el.props.docs).toEqual([]);
    expect(el.props.docsError).toMatch(/not open yet/);
    state.read.timeline = { ok: false, status: 500, code: "READ_FAILED" };
    expect((await CasePage(params("31"))).props.message).toMatch(/our side/);
  });
  it("both are noindex, with a title of 60 or fewer and a description of 120 to 160", () => {
    for (const m of [casesMeta(), caseMeta()]) {
      expect(m.robots).toEqual({ index: false, follow: false });
      expect(titleProblem(String(m.title).replace(" | Irish Work Permit", ""))).toBeNull();
      expect(descriptionProblem(String(m.description))).toBeNull();
    }
  });
});
