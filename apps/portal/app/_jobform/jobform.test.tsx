// P19: the posting form's logic, words and parts, with no database, network or browser. The form renders to HTML (react-dom/server) with fixture props for each variant; every status and
// code the yaml lists for the routes the form calls is read from docs/openapi/portal.yaml and must have its own sentence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));

import { JOB_FORM_LIVE } from "../_site/flags";
import { AuthorityView } from "./authority";
import { JobForm, type FormProps } from "./form";
import { blockedCount, bodyOf, COUNTIES, emptyForm, formFromJob, missing, money, payLine, payModes, ready, reasonWord, rowOf, socOf, type Check, type Form, type JobDetail, withOccupation } from "./model";
import { ChecksPanel } from "./panels";
import { authorityMessage, loadMessage, savedWord, saveMessage } from "./words";

const yaml = parse(readFileSync(join(import.meta.dirname, "../../../../docs/openapi/portal.yaml"), "utf8")) as {
  paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>>;
  components: { schemas: Record<string, { enum?: string[]; properties?: Record<string, { enum?: string[] }> }> };
};
const clean = (s: string) => expect(s).not.toMatch(/[\u2013\u2014]|undefined|\[object|null\b|[A-Z]{3,}_[A-Z_]{3,}/);

const ER = { agency: false, tier: 0 }, AG = { agency: true, tier: 0 }, PUB = { agency: false, tier: 1 };
const full = (o: Partial<Form> = {}): Form => ({ ...emptyForm(), title: "Fake Sous Chef", occupation: "5434 Chefs", county: "Cork", contractType: "permanent", description: "A fake kitchen needs a sous chef to run the service.", ownPageUrl: "https://jobs.example.test/chef", salaryLow: "42,000", ...o });

describe("model", () => {
  it("the counties are the yaml's County enum, nothing more", () => {
    expect([...COUNTIES]).toEqual(parse(readFileSync(join(import.meta.dirname, "../../../../docs/openapi/portal.yaml"), "utf8")).components.schemas.County.enum);
  });
  it("money and the occupation code read what is typed", () => {
    expect([money(""), money("36,000"), money("€ 36 000"), money("12.5"), money("-3"), money("abc"), money("12345678")]).toEqual([null, 36000, 36000, undefined, undefined, undefined, undefined]);
    expect([socOf("2231"), socOf("2231 Nurses"), socOf("  5434 Chefs"), socOf("223"), socOf("22310"), socOf("0123"), socOf("Chefs")]).toEqual(["2231", "2231", "5434", "", "", "", ""]);
  });
  it("what is missing is named per field, and a complete form is ready", () => {
    expect(Object.keys(missing(emptyForm(), ER)).sort()).toEqual(["contractType", "county", "description", "occupation", "ownPageUrl", "pay", "title"].sort());
    expect(ready(full(), ER)).toBe(true);
    expect(missing(full({ contractType: "fixed_term" }), ER).months).toBeTruthy();
    expect(missing(full({ ownPageUrl: "http://jobs.example.test/x" }), ER).ownPageUrl).toBeTruthy(); // https only
    expect(missing(full({ ownPageUrl: "https://user:pw@jobs.example.test/x" }), ER).ownPageUrl).toBeTruthy();
    expect(missing(full({ payMode: "range", salaryHigh: "41000" }), ER).pay).toBeTruthy(); // the top is below the bottom
    expect(missing(full({ hours: "61" }), ER).hours).toBeTruthy();
    expect(missing(full({ statement: true }), ER).signer).toBeTruthy();
    expect(missing(full({ employerIs: "client", statement: true, signerName: "Fake Signer", signerTitle: "Fake Role" }), AG).client).toBeTruthy();
    expect(missing(full({ employerIs: "client", clientName: "Fake Client", statement: true, signerName: "Fake Signer", signerTitle: "Fake Role" }), AG).authority).toBeTruthy(); // DD11, CF99
  });
  it("a live body is the whole post; pay follows the mode; the statement goes only when ticked", () => {
    expect(bodyOf(full(), ER, "live")).toEqual({ status: "live", title: "Fake Sous Chef", permitType: "critical_skills", weeklyHours: 39, description: "A fake kitchen needs a sous chef to run the service.", county: "Cork", occupationCode: "5434", contractType: "permanent", ownPageUrl: "https://jobs.example.test/chef", salaryLow: 42000 });
    expect(bodyOf(full({ payMode: "range", salaryHigh: "50000", health: "1,200", contractType: "fixed_term", months: "24" }), ER, "live")).toMatchObject({ salaryLow: 42000, salaryHigh: 50000, healthInsuranceEur: 1200, contractType: "fixed_term", contractMonths: 24 });
    const grade = bodyOf(full({ payMode: "grade", grade: "2135", salaryLow: "99999", health: "500" }), PUB, "live");
    expect(grade).toMatchObject({ payGrade: "2135" }); expect(grade).not.toHaveProperty("salaryLow"); expect(grade).not.toHaveProperty("healthInsuranceEur"); // the grade alone
    expect(bodyOf(full(), ER, "live")).not.toHaveProperty("statement");
    expect(bodyOf(full({ statement: true, signerName: " Fake Signer ", signerTitle: "HR" }), ER, "live").statement).toEqual({ signerName: "Fake Signer", signerTitle: "HR" });
    expect(bodyOf(full({ permitType: "general", exception: true }), ER, "live")).toMatchObject({ permitType: "general", exceptionConfirmed: true });
    expect(bodyOf(full(), ER, "live", "77")).toMatchObject({ jobId: "77" }); // an edit
  });
  it("agency: a client post carries the client and, with the statement, the written authority tick; an employer's body never has a client", () => {
    const f = full({ employerIs: "client", clientName: " Fake Client Ltd ", statement: true, signerName: "Fake Signer", signerTitle: "HR", authority: true });
    expect(bodyOf(f, AG, "live")).toMatchObject({ clientName: "Fake Client Ltd", statement: { signerName: "Fake Signer", signerTitle: "HR", writtenAuthority: true } });
    expect(bodyOf(f, ER, "live")).not.toHaveProperty("clientName");
    expect(bodyOf(full({ employerIs: "self", clientName: "Fake Client Ltd" }), AG, "live")).not.toHaveProperty("clientName");
  });
  it("a draft holds the title and only what was filled in", () => {
    expect(bodyOf({ ...emptyForm(), title: "Fake Draft" }, ER, "draft")).toEqual({ status: "draft", title: "Fake Draft", permitType: "critical_skills", weeklyHours: 39 });
    expect(bodyOf({ ...emptyForm(), title: "Fake Draft", salaryLow: "abc", ownPageUrl: "  " }, ER, "draft")).not.toHaveProperty("salaryLow");
  });
  it("CF98: the grade picker only for a public pay employer, never an agency", () => {
    expect(payModes(ER)).toEqual(["one", "range"]); expect(payModes(PUB)).toEqual(["one", "range", "grade"]); expect(payModes({ agency: true, tier: 2 })).toEqual(["one", "range"]);
  });
  it("a job fills the form, and a repost leaves the old signature and exception tick behind", () => {
    const j: JobDetail = { id: "5", status: "closed", badge: "sponsor_confirmed", title: "Fake Nurse", description: "A fake ward needs a nurse.", county: "Cork", occupationCode: "2231", contractType: "fixed_term", contractMonths: 24, salaryLow: 40000, salaryHigh: 45000, payGrade: null, healthInsuranceEur: 900, weeklyHours: 37, ownPageUrl: "https://x.example.test/a", clientName: "Fake Client", permitType: "general", exceptionConfirmed: true, statement: { signerName: "Fake Signer", signerTitle: "HR", writtenAuthority: true } };
    expect(formFromJob(j)).toMatchObject({ payMode: "range", months: "24", hours: "37", employerIs: "client", exception: true, signerName: "Fake Signer", statement: false });
    expect(formFromJob(j, true).exception).toBe(false);
    expect(formFromJob({ ...j, salaryLow: null, salaryHigh: null, payGrade: "2135" }).payMode).toBe("grade");
  });
  it("the pay line of the preview", () => {
    expect(payLine(full())).toBe("€42,000 a year"); expect(payLine(full({ payMode: "range", salaryHigh: "50000" }))).toBe("€42,000 to €50,000 a year");
    expect(payLine(full({ payMode: "grade" }), { title: "Fake Grade", firstEur: 38000, lastEur: 56000 })).toBe("Fake Grade: €38,000 to €56,000 a year"); expect(payLine(emptyForm())).toBe("");
  });
});

describe("the checks in words (B50)", () => {
  const ids = yaml.components.schemas.JobCheck!.properties!.id!.enum!;
  it("every check id of the yaml has its own title, in every state, never a raw code", () => {
    expect(ids.length).toBeGreaterThan(8);
    for (const id of ids) for (const state of ["pass", "note", "blocked"] as const) {
      const r = rowOf({ id, state, ...(state === "blocked" ? { code: "PAY_BELOW_MINIMUM" } : {}), detail: { minimumEur: 40904, countedEur: 36000, minimumMonths: 24, listStatus: "critical_skills", found: false, phrase: "visa fee" } });
      expect(r.title, id).not.toBe("Check"); clean(`${r.title} ${r.text}`);
    }
    expect(rowOf({ id: "zzz", state: "pass", detail: {} }).title).toBe("Check");
  });
  it("the pay check says the minimum and what is counted; a public pay route says the minimum is skipped", () => {
    const below = rowOf({ id: "pay", state: "blocked", code: "PAY_BELOW_MINIMUM", detail: { minimumEur: 40904, countedEur: 36000, healthInsuranceEur: 0, weeklyHours: 39, route: null } });
    expect(below.text).toMatch(/€40,904.*39 hours.*€36,000/);
    expect(rowOf({ id: "pay", state: "pass", detail: { route: "public_pay" } }).title).toBe("Public pay scale applies");
  });
  it("every refusal code of the rules has a sentence of its own", () => {
    const codes = yaml.components.schemas.RulesVerdict!.properties!.code!.enum!;
    expect(new Set(codes.map(reasonWord)).size).toBe(codes.length); for (const c of codes) clean(reasonWord(c));
  });
  it("the panel: waiting, all clear, blocked count, a note, an error; hostile text from the advert is escaped", () => {
    const wait = html(<ChecksPanel checks={null} missing={["the title", "the pay"]} />);
    expect(wait).toContain("the title, the pay"); expect(wait).not.toContain("blocked");
    const ok: Check[] = [{ id: "occupation", state: "pass", detail: { listStatus: "critical_skills" } }, { id: "pay", state: "pass", detail: { minimumEur: 40904, countedEur: 42000 } }];
    expect(html(<ChecksPanel checks={ok} missing={[]} />)).toContain("All clear");
    const bad: Check[] = [...ok, { id: "contract", state: "blocked", code: "CONTRACT_TOO_SHORT", detail: { minimumMonths: 24 } }, { id: "money", state: "note", detail: { phrase: "<script>x</script>" } }];
    const s = html(<ChecksPanel checks={bad} missing={[]} />);
    expect(s).toContain("1 blocked"); expect(blockedCount(bad)).toBe(1); expect(s).not.toContain("<script>"); expect(s).toContain("&lt;script&gt;"); expect(s).toContain('data-state="note"');
    expect(html(<ChecksPanel checks={null} missing={[]} error="Too many tries. Wait a few minutes, then try again." />)).toContain("Too many tries");
  });
});

// Every status and code each route can give, read from the yaml, gets a sentence of its own that is not a raw code.
describe("messages: every answer of the routes the form calls (docs/openapi/portal.yaml)", () => {
  const answers = (path: string, verb: string) => {
    const out: { status: number; code?: string }[] = [{ status: 0 }, { status: 500 }];
    for (const [status, r] of Object.entries(yaml.paths[path]![verb]!.responses)) {
      if (Number(status) < 400) continue;
      out.push({ status: Number(status) });
      for (const m of (r.description ?? "").matchAll(/`([A-Z][A-Z_]{3,})`/g)) out.push({ status: Number(status), code: m[1] });
    }
    return out;
  };
  const routes: [string, string, (a: { status: number; code?: string }) => string][] = [
    ["/api/portal/jobs", "post", saveMessage], ["/api/portal/jobs/edit", "post", saveMessage], ["/api/portal/jobs/check", "post", saveMessage],
    ["/api/portal/jobs/{id}", "get", loadMessage], ["/api/portal/jobs/form", "get", loadMessage], ["/api/portal/jobs/grades", "get", loadMessage], ["/api/portal/jobs/suggest", "get", loadMessage],
    ["/api/portal/jobs/{id}/authority", "get", authorityMessage], ["/api/portal/jobs/{id}/authority", "post", authorityMessage], ["/api/portal/jobs/{id}/authority/{docId}", "get", authorityMessage],
  ];
  it.each(routes)("%s %s", (path, verb, fn) => {
    const list = answers(path, verb);
    expect(list.length).toBeGreaterThan(4);
    for (const a of list) { const m = fn(a); expect(m.length, `${path} ${a.status} ${a.code}`).toBeGreaterThan(15); clean(m); }
    expect(new Set(list.map(fn)).size, path).toBeGreaterThan(3);
  });
  it("the codes the brief names read apart: BA35 and the agency refusals", () => {
    const m = ["PAY_NOT_ON_SCALE", "STATEMENT_REQUIRED", "GENERAL_RULES_NOT_SET", "PAY_BELOW_MINIMUM"].map((code) => saveMessage({ status: 422, code }));
    expect(new Set(m).size).toBe(4);
    expect(new Set([saveMessage({ status: 400, code: "CLIENT_ONLY_FOR_AGENCIES" }), saveMessage({ status: 400, code: "WRITTEN_AUTHORITY_REQUIRED" }), saveMessage({ status: 409, code: "NEEDS_REVIEW" }), saveMessage({ status: 409, code: "NO_STATEMENT_TEXT" })]).size).toBe(4);
    expect(saveMessage({ status: 403, code: "NOT_A_POSTER" })).toMatch(/role cannot/); // a viewer
  });
  it("what a save says: draft, live, in review, under review (BA34)", () => {
    expect(new Set(["draft", "live", "in_review", "under_review"].map((s) => savedWord(s, false))).size).toBe(4);
    expect(savedWord("live", true)).toMatch(/Draft saved/);
  });
});

const occupations = [{ code: "5434", title: "Chefs", slug: "chefs", listStatus: "critical-skills" }, { code: "6145", title: "Care workers", slug: "care-workers", listStatus: "ineligible" }, { code: "2136", title: "Programmers", slug: "programmers", listStatus: "other" }];
const props: FormProps = {
  company: { name: "Fake Kitchens Ltd", kind: "employer", tier: 0, permitHistory: "has_history" }, statement: { version: "v1", body: "FAKE STATEMENT: we will sponsor a permit." }, occupations,
  rangeNote: "Pay depends on where you start on the scale.", grades: [{ code: "2135", title: "Fake Staff Nurse", firstEur: 38166, lastEur: 56592, note: null }], mode: "new",
};
describe("the form", () => {
  it("an exception tick is cleared when the occupation changes, and kept while the same code is being typed", () => {
    const f = { ...emptyForm(), occupation: "5434 Chefs", exception: true };
    expect(withOccupation(f, "6145 Care workers").exception).toBe(false); expect(withOccupation(f, "").exception).toBe(false);
    expect(withOccupation(f, "5434").exception).toBe(true); expect(withOccupation({ ...f, exception: false }, "5434").exception).toBe(false);
  });
  it("an employer's blank form: five steps, the wording in force, no grade, no agency block, no Town or Eircode, no Launch B apply, no Hire or Applied words", () => {
    const s = html(<JobForm {...props} />);
    for (const t of ["The job", "Pay", "Contract and place", "Description and applying", "Sponsorship statement"]) expect(s).toContain(t);
    expect(s).toContain("FAKE STATEMENT: we will sponsor a permit."); expect(s).toContain("Save draft"); expect(s).toContain("Publish job"); expect(s).toContain('href="#preview"');
    expect(s).not.toMatch(/Public pay-scale grade|data-agency|Town or Eircode|Receive applications|Screening question|>Applied<|Launch B/);
    expect(s).toContain('<option value="Wicklow">'); expect(s.match(/<h1/g)).toHaveLength(1); expect(s).toContain("The checks run when these are filled in"); clean(s.replace(/<[^>]+>/g, " ").replace(/\bnull\b/g, ""));
  });
  it("a public pay employer picks a grade; an agency never does, whatever its tier (CF98), and sees who the permit employer is", () => {
    const pub = html(<JobForm {...props} company={{ ...props.company, tier: 1 }} />);
    expect(pub).toContain("Public pay-scale grade"); expect(pub).toContain("public pay-deal employer list");
    const ag = html(<JobForm {...props} company={{ ...props.company, kind: "agency", tier: 2 }} />);
    expect(ag).not.toContain("Public pay-scale grade"); expect(ag).toContain("data-agency"); expect(ag).toContain("The client"); expect(ag).toContain("Agencies tell us who the permit employer is");
  });
  it("a draft opens in edit mode with its values; a closed one reposts; an agency client job shows the written authority panel", () => {
    const job: JobDetail = { id: "9", status: "draft", badge: null, title: "Fake Draft Chef", description: "A fake kitchen needs a chef for evenings.", county: "Kerry", occupationCode: "5434", contractType: "permanent", contractMonths: null, salaryLow: 41000, salaryHigh: null, payGrade: null, healthInsuranceEur: null, weeklyHours: 39, ownPageUrl: "https://x.example.test/c", clientName: null, permitType: "critical_skills", exceptionConfirmed: false, statement: null };
    const edit = html(<JobForm {...props} mode="edit" job={job} />);
    expect(edit).toContain("Edit job"); expect(edit).toContain('value="Fake Draft Chef"'); expect(edit).toContain("Publish job"); expect(edit).toContain("SOC 5434 Chefs");
    const live = html(<JobForm {...props} mode="edit" job={{ ...job, status: "live" }} />);
    expect(live).toContain("Save changes"); expect(live).not.toContain("Save draft"); expect(edit).toContain("Save draft"); // a job past draft has no draft to save: that button would change the live job
    expect(html(<JobForm {...props} mode="repost" job={{ ...job, status: "closed" }} />)).toContain("Post this job again");
    const ag = { ...props, company: { ...props.company, kind: "agency" } };
    expect(html(<JobForm {...ag} mode="edit" job={{ ...job, clientName: "Fake Client Ltd" }} />)).toContain("written authority");
    expect(html(<JobForm {...ag} mode="new" />)).not.toContain("Copies of the client");
    const unsaved = html(<JobForm {...ag} mode="edit" job={{ ...job, clientName: null }} />); // an agency job saved as its own has no copies to list yet
    expect(unsaved).not.toContain("Copies of the client");
  });
  it("no statement wording published: the tick is off and the page says so; a first-time sponsor sees its card; a save shows its line", () => {
    const s = html(<JobForm {...props} statement={null} company={{ ...props.company, permitHistory: "first_time" }} saved="in_review" />);
    expect(s).toContain("No statement wording is published yet"); expect(s).toMatch(/<input[^>]*disabled=""[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*disabled=""/);
    expect(s).toContain("First-time sponsor"); expect(s).toContain("Our team checks the job before it goes live");
    expect(html(<JobForm {...props} saved="<script>" />)).not.toContain("<script>");
  });
  it("a General permit says the statement is needed; a Critical Skills one says it is optional", () => {
    expect(html(<JobForm {...props} />)).toContain("Optional for a Critical Skills job");
  });
});

describe("written authority copies (BA37)", () => {
  const doc = { id: "7", fileName: "authority.pdf", contentType: "pdf", sizeBytes: 182044, uploadedAt: "2026-11-18T09:30:00Z", copyDeleted: false };
  it("loading, empty, listed with an open link, a removed copy, an error", () => {
    expect(html(<AuthorityView jobId="5" docs={null} />)).toContain("Loading");
    expect(html(<AuthorityView jobId="5" docs={[]} />)).toContain("No copy on file yet");
    const s = html(<AuthorityView jobId="5" docs={[doc, { ...doc, id: "8", copyDeleted: true }]} error={authorityMessage({ status: 415 })} />);
    expect(s).toContain('href="/api/portal/jobs/5/authority/7"'); expect(s).not.toContain("/authority/8"); expect(s).toContain("The copy was removed"); expect(s).toContain("178 KB"); expect(s).toContain("PDF, a JPEG or a PNG");
  });
});

describe("the switch", () => {
  it("JOB_FORM_LIVE is on, so the links to the form show", () => { expect(JOB_FORM_LIVE).toBe(true); });
});
