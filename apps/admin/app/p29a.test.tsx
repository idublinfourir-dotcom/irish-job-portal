// P29, first half: every state of the contact inbox, the held job queues, the pay floor checks, the accounts page, the company seed and a company's page, rendered to HTML
// from fixture props (react-dom/server, no browser, no database, no network), and the words behind them. Fixtures are fake.
import type { AuthorityDocument, CompanyPreview, DeteSuggestion, DomainRow, FloorCheck, JobQueueItem, OpenRequest } from "@portal/db";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActView, ErrorNote, type ActProps, type ActState } from "./_queue/act";
import { Accounts, type Merge } from "./accounts/view";
import { HOLDS } from "./accounts/text";
import { Company } from "./companies/[id]/view";
import { DeteLinks } from "./companies/dete-links/view";
import { Seed, SHOWN_ROWS, type Pending } from "./companies/seed/view";
import { Contact, type Message, type Summary } from "./contact/view";
import { mayAct, surfaceLabel, topicLabel } from "./contact/text";
import { type Detail, EmployerJobs } from "./employer-jobs/view";
import { approveText, bytes, isQueue, mayOpenCompany, queuesFor, salaryText } from "./employer-jobs/text";
import { stepFor } from "./pay-floors/text";
import { PayFloors } from "./pay-floors/view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/" }));

const NOW = new Date("2026-11-25T12:00:00Z");
const clean = (s: string) => expect(s).not.toMatch(/[\u2013\u2014]|undefined|\[object|Launch B|Sample/);
const XSS = "<img src=x onerror=alert(1)><script>x</script>";
const noMarkup = (s: string) => expect(s).not.toMatch(/<img|<script/);

describe("act: the button and its answers", () => {
  const p: ActProps = { url: "/api/contact", fixed: { action: "claim" }, label: "Claim this message", here: "/contact?id=4", confirm: "Sure?" };
  const s: ActState = { pending: false, asking: false };
  const h = { onSubmit() {}, onConfirm() {}, onCancel() {} };
  const v = (o: Partial<ActState> = {}, q: Partial<ActProps> = {}) => html(<ActView p={{ ...p, ...q }} s={{ ...s, ...o }} h={h} />);
  it("shows the button, a confirm dialog with its text, a locked button while pending, an error and a done note", () => {
    expect(v()).toMatch(/<button[^>]*type="submit"[^>]*>Claim this message/);
    expect(v({ asking: true })).toMatch(/Sure\?/);
    expect(v({ pending: true })).toMatch(/<button[^>]*disabled[^>]*>Claim this message/);
    expect(v({ error: { code: "not_claimer", text: "Another reviewer holds this item." } })).toMatch(/Another reviewer holds this item\./);
    expect(v({ done: "Done. 2 open sessions ended." })).toMatch(/2 open sessions ended/);
    expect(v({}, { confirm: undefined })).not.toMatch(/<dialog/);
  });
  it("reauth_required offers a sign in that comes back to this page; any other error does not", () => {
    const re = html(<ErrorNote error={{ code: "reauth_required", text: "For safety, sign in again to do this." }} here="/accounts" />);
    expect(re).toMatch(/href="\/sign-in\?next=%2Faccounts"/);
    expect(html(<ErrorNote error={{ code: "not_found", text: "x" }} here="/accounts" />)).not.toMatch(/sign-in/);
  });
});

describe("/contact", () => {
  const sum = (o: Partial<Summary> = {}): Summary => ({ id: "9", status: "new", topic: "appeal", surface: "portal", createdText: "2026-11-25 07:00:00+00", claimedByStaffUserId: null, claimedText: null, ...o });
  const msg = (o: Partial<Message> = {}): Message => ({ ...sum(), fromName: "Fake Sender", fromEmail: "fake@example.test", body: "Fake line one\nline two", closedText: null, fromHeldLogin: null, ...o });
  const page = (o: { items?: Summary[]; selected?: Message | null; canAct?: boolean; missingId?: boolean; next?: string; prev?: string } = {}) =>
    html(<Contact items={o.items ?? [sum()]} selected={o.selected === undefined ? null : o.selected} canAct={o.canAct ?? true} missingId={o.missingId} meId="me" now={NOW} next={o.next} prev={o.prev} />);
  it("the list: one H1, topic, place, age and a link; no name, email or text; the empty and the Previous and Next states", () => {
    const l = page({ items: [sum(), sum({ id: "10", topic: "weird_topic", surface: null, status: "claimed", claimedByStaffUserId: "me" })] });
    expect(l.match(/<h1/g)).toHaveLength(1);
    expect(l).toMatch(/Appeal/); expect(l).toMatch(/Weird topic/); expect(l).toMatch(/Not recorded/); expect(l).toMatch(/5 h/); expect(l).toMatch(/Yours/);
    expect(l).toMatch(/href="\/contact\?id=9"/); expect(l).toMatch(/Pick a message to read it/);
    expect(l).not.toMatch(/Fake Sender|@/);
    expect(page({ items: [] })).toMatch(/No message is waiting/);
    const n = page({ next: "/contact?after=abc", prev: "/contact" });
    expect(n).toMatch(/Previous/); expect(n).toMatch(/Next/);
    clean(l);
  });
  it("a message: a new one offers Claim, mine the three decisions, another's a take-over, a decided one nothing, an administrator no action", () => {
    expect(page({ selected: msg() })).toMatch(/Claim this message/);
    const mine = page({ selected: msg({ status: "claimed", claimedByStaffUserId: "me" }) });
    for (const t of ["Mark answered", ">Close<", ">Spam<"]) expect(mine).toContain(t);
    expect(mine).toMatch(/Nothing is sent from here/);
    expect(page({ selected: msg({ status: "claimed", claimedByStaffUserId: "x" }) })).toMatch(/Take over the claim/);
    const done = page({ selected: msg({ status: "answered", closedText: "2026-11-25 10:00:00+00" }) });
    expect(done).toMatch(/This message is answered since 25 Nov 2026, 10:00/); expect(done).not.toMatch(/Claim this message|Mark answered/);
    const admin = page({ selected: msg(), canAct: false });
    expect(admin).toMatch(/Only a services case handler or a content editor can act/); expect(admin).not.toMatch(/Claim this message/);
    expect(page({ selected: msg({ topic: "appeal", fromHeldLogin: true }) })).toMatch(/suspended or blocked now/);
    expect(page({ selected: null, missingId: true })).toMatch(/That message does not exist/);
  });
  it("text from outside is escaped, never markup", () => {
    const p = page({ selected: msg({ fromName: XSS, fromEmail: XSS, body: XSS }) });
    noMarkup(p); expect(p).toMatch(/&lt;img src=x onerror=alert\(1\)&gt;/);
  });
  it("the words and who acts", () => {
    expect([topicLabel("data_request"), topicLabel("x_y"), surfaceLabel(null), surfaceLabel("candidate")]).toEqual(["Data request", "X y", "Not recorded", "Candidate site"]);
    expect([mayAct(["content_editor"]), mayAct(["services_case_handler"]), mayAct(["administrator"]), mayAct([])]).toEqual([true, true, false, false]);
  });
});

describe("/employer-jobs", () => {
  const job = (o: Partial<Detail> = {}): Detail => ({
    id: "5", queue: "agency_client_check", status: "open", claimedBy: null, reason: "client_not_found", jobId: "70", jobStatus: "in_review", source: "agency", title: "Fake Engineer", employerName: "Fake Agency",
    county: "Cork", occupationCode: "2134", permitType: "critical_skills", salaryLow: 60000, salaryHigh: null, payGrade: null, badge: null, closesAt: new Date("2026-12-20T00:00:00Z"), organisationId: "33",
    company: "Fake Agency Ltd", companyStatus: "verified", restricted: false, clientName: "Fake Client", clientCheck: "not_found", advertText: "Fake advert\nline", ...o,
  } as Detail);
  const doc = (o: Partial<AuthorityDocument> = {}): AuthorityDocument => ({ id: "3", fileName: "authority.pdf", contentType: "application/pdf", sizeBytes: 204800, uploadedAt: "2026-11-24 09:00:00+00", copyDeleted: false, ...o });
  const page = (o: { selected?: Detail | null; items?: JobQueueItem[]; queues?: ("scam_flag" | "post_strike_job_review" | "agency_client_check" | "licence_lapse_job")[]; queue?: "scam_flag" | "agency_client_check"; documents?: AuthorityDocument[] | null; missingId?: boolean; open?: boolean } = {}) =>
    html(<EmployerJobs queues={o.queues ?? ["post_strike_job_review", "agency_client_check", "licence_lapse_job"]} queue={o.queue ?? "agency_client_check"} items={o.items ?? [job()]} selected={o.selected ?? null} missingId={o.missingId} meId="me"
      documents={o.documents ?? null} canOpenCompany={o.open ?? true} />);
  it("tabs only for the queues given, the list, and an empty queue says what it holds", () => {
    const p = page();
    expect(p.match(/role="tab"/g)).toHaveLength(3); expect(p).not.toMatch(/Scam check/); expect(p).toMatch(/aria-selected="true"[^>]*>Agency client check/);
    expect(p).toMatch(/Fake Engineer/); expect(p.match(/<h1/g)).toHaveLength(1);
    expect(page({ items: [] })).toMatch(/Nothing is held here/);
    clean(p);
  });
  it("an item: facts, advert as text, the written authority (open link, deleted copy, none), the company link by role", () => {
    const p = page({ selected: job(), documents: [doc(), doc({ id: "4", copyDeleted: true })] });
    expect(p).toMatch(/Fake Client \(not found\)/); expect(p).toMatch(/€60,000 a year/); expect(p).toMatch(/20 Dec 2026/); expect(p).toMatch(/Fake advert/);
    const link = p.match(/<a [^>]*href="\/api\/employer-jobs\/authority\?jobId=70&amp;docId=3"[^>]*>/)![0];
    expect(link).toMatch(/target="_blank"/); expect(link).toMatch(/rel="noopener noreferrer"/);
    expect(p).toMatch(/200 KB/); expect(p).toMatch(/The copy was deleted/); expect(p).toMatch(/href="\/companies\/33"/);
    expect(page({ selected: job(), documents: [] })).toMatch(/has not stored a copy/);
    expect(page({ selected: job(), documents: null })).not.toMatch(/aria-label="Written authority"/);
    expect(page({ selected: job(), open: false })).not.toMatch(/href="\/companies\/33"/);
    expect(page({ selected: job({ restricted: true }) })).toMatch(/strike restriction/);
    expect(page({ selected: job({ advertText: null }) })).toMatch(/advert text was not saved/);
  });
  it("buttons by state: Claim, the claimer's three, a take-over, nothing once decided", () => {
    expect(page({ selected: job() })).toMatch(/Claim this item/);
    const mine = page({ selected: job({ status: "claimed", claimedBy: "me" }) });
    expect(mine).toMatch(/Approve[\s\S]*Reject[\s\S]*Release/); expect(mine).toMatch(/Reason for Reject/);
    expect(page({ selected: job({ status: "claimed", claimedBy: "x" }) })).toMatch(/Take over the claim/);
    const done = page({ selected: job({ status: "done" }) });
    expect(done).toMatch(/This item is decided/); expect(done).not.toMatch(/Claim this item|>Approve</);
    expect(page({ missingId: true })).toMatch(/not in a queue you can open/);
  });
  it("adverts, titles and company names are escaped", () => {
    const p = page({ selected: job({ title: XSS, company: XSS, advertText: XSS, clientName: XSS, employerName: XSS }), items: [job({ title: XSS, company: XSS })] });
    noMarkup(p);
  });
  it("which queues a role reads, and the words", () => {
    expect(queuesFor(["trust_and_safety"])).toEqual(["scam_flag"]);
    expect(queuesFor(["account_reviewer"])).toEqual(["post_strike_job_review", "agency_client_check", "licence_lapse_job"]);
    expect(queuesFor(["administrator"])).toHaveLength(4); expect(queuesFor(["content_editor", "fetched_job_reviewer"])).toEqual([]);
    expect([isQueue("scam_flag"), isQueue("x"), isQueue(undefined)]).toEqual([true, false, false]);
    expect([mayOpenCompany(["account_reviewer"]), mayOpenCompany(["trust_and_safety"])]).toEqual([true, false]);
    expect(salaryText(null, null, null)).toBe("No pay stated"); expect(salaryText(40000, 50000, null)).toBe("€40,000 to €50,000 a year"); expect(salaryText(null, null, "G3")).toBe("Pay grade G3");
    expect(bytes(500)).toBe("1 KB"); expect(bytes(3 * 1024 ** 2)).toBe("3.0 MB"); expect(approveText("licence_lapse_job")).toMatch(/stays live/);
  });
});

describe("/pay-floors", () => {
  const floor = (o: Partial<FloorCheck> = {}): FloorCheck => ({
    floorId: "61", itemId: "9", createdAt: "2026-11-25 06:00:00+00", roleFamily: "3434", floorEur: 40000, signedAt: "2026-11-24 09:00:00+00", validUntil: "2027-11-24 09:00:00+00", signerName: "Fake Signer", signerTitle: "Account owner",
    organisationId: "3", displayName: "Fake Big Co", kind: "employer", isBigCompany: true, organisationStatus: "verified", currentFloorEur: null, requestId: null, proposedBy: null, ...o,
  });
  const page = (o: { f?: FloorCheck | null; roles: string[]; items?: FloorCheck[] }) => html(<PayFloors items={o.items ?? [floor()]} selected={o.f === undefined ? floor() : o.f} meId="me" roles={o.roles} now={NOW} />);
  it("who may do which step: the editor proposes, a different administrator confirms, the proposer waits, others only read", () => {
    const prop = { requestId: "4", proposedBy: "other" };
    expect([stepFor(floor(), "me", ["rules_data_editor"]), stepFor(floor(), "me", ["administrator"]), stepFor(floor(), "me", ["content_editor"])]).toEqual(["propose", "wait_other", null]);
    expect([stepFor(floor(prop), "me", ["administrator"]), stepFor(floor({ requestId: "4", proposedBy: "me" }), "me", ["administrator", "rules_data_editor"]), stepFor(floor(prop), "me", ["rules_data_editor"])]).toEqual(["confirm", "wait_second", "wait_second"]);
  });
  it("the page offers exactly that step and a Reject with a reason, never Confirm to the proposer", () => {
    expect(page({ roles: ["rules_data_editor"] })).toMatch(/Propose to confirm/);
    expect(page({ roles: ["administrator"] })).not.toMatch(/Propose to confirm|>Confirm</);
    const p = page({ roles: ["administrator"], f: floor({ requestId: "4", proposedBy: "other" }) });
    expect(p).toMatch(/>Confirm</); expect(p).toMatch(/Reason for Reject/);
    const me = page({ roles: ["administrator"], f: floor({ requestId: "4", proposedBy: "me" }) });
    expect(me).toMatch(/You proposed this floor/); expect(me).not.toMatch(/>Confirm</);
    expect(page({ roles: ["administrator"], f: floor({ isBigCompany: false }) })).toMatch(/no longer on the big-company list/);
    expect(page({ roles: ["rules_data_editor"], f: floor({ currentFloorEur: 38000 }) })).toMatch(/replacing €38,000/);
  });
  it("empty and unknown states, and the signer's text is escaped", () => {
    expect(page({ roles: ["administrator"], items: [], f: null })).toMatch(/No pay floor is waiting/);
    noMarkup(page({ roles: ["administrator"], f: floor({ signerName: XSS, signerTitle: XSS, displayName: XSS }), items: [floor({ displayName: XSS })] }));
  });
});

describe("/accounts", () => {
  const merge = (o: Partial<Merge> = {}): Merge => ({ requestId: "8", keep: "keepid123", drop: "dropid456", proposedBy: "other", createdAt: "2026-11-25 06:00:00+00", ...o });
  const page = (pending: Merge[]) => html(<Accounts pending={pending} meId="me" now={NOW} />);
  it("the four hold and lift forms, the sign-in note, and an empty merge list", () => {
    const p = page([]);
    expect(p.match(/<h1/g)).toHaveLength(1);
    for (const h of HOLDS) expect(p).toContain(h.label);
    expect(p).toMatch(/sign-in from the last 10 minutes/); expect(p).toMatch(/No merge is waiting/); expect(p).toMatch(/Propose the merge/);
    for (const [code] of [["fake_documents"], ["appeal_upheld"]]) expect(p).toContain(`value="${code}"`);
    clean(p);
  });
  it("a merge someone else proposed can be confirmed or refused; your own can only be withdrawn", () => {
    const other = page([merge()]);
    expect(other).toMatch(/Confirm the merge/); expect(other).toMatch(/Refuse/); expect(other).not.toMatch(/Withdraw/);
    const mine = page([merge({ proposedBy: "me" })]);
    expect(mine).toMatch(/Withdraw/); expect(mine).not.toMatch(/Confirm the merge/); expect(mine).toMatch(/You proposed this merge/);
    expect(other).toContain("keepid123"); expect(other).not.toMatch(/@/);
  });
  it("a login id is shown as text", () => noMarkup(page([merge({ keep: XSS, drop: XSS })])));
});

describe("/companies/seed", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ line: i + 2, displayName: `Fake Co ${i}`, kind: "public_body", brandNames: ["Fake Brand"], deteNames: [] }));
  const pend = (o: Partial<Pending> = {}): Pending => ({ requestId: "5", proposedBy: "other", createdAt: "2026-11-25 06:00:00+00", rows: rows(3), ...o });
  const page = (pending: Pending[], o: { propose?: boolean; decide?: boolean } = {}) => html(<Seed pending={pending} meId="me" canPropose={o.propose ?? false} canDecide={o.decide ?? false} now={NOW} />);
  it("empty; the editor's propose form; a pending file by who may do what", () => {
    expect(page([])).toMatch(/No import is waiting/); expect(page([])).toMatch(/Only a rules data editor can propose a file/);
    const ed = page([], { propose: true });
    expect(ed).toMatch(/Propose this file/); expect(ed).toMatch(/display_name, kind, brand_names, dete_names/); expect(ed).toMatch(/maxLength="1000000"|maxlength="1000000"/i);
    const adm = page([pend()], { decide: true });
    expect(adm).toMatch(/Confirm and import/); expect(adm).toMatch(/Refuse/); expect(adm).toMatch(/3 companies/); expect(adm).toMatch(/public body/);
    const mine = page([pend({ proposedBy: "me" })], { decide: true, propose: true });
    expect(mine).toMatch(/Withdraw/); expect(mine).not.toMatch(/Confirm and import/);
    expect(page([pend()])).toMatch(/An administrator confirms or refuses this file/);
  });
  it("a long file shows the first rows and says so; names are text", () => {
    const p = page([pend({ rows: rows(SHOWN_ROWS + 5) })], { decide: true });
    expect(p).toMatch(new RegExp(`The first ${SHOWN_ROWS} of ${SHOWN_ROWS + 5} rows`)); expect(p).not.toMatch(`Fake Co ${SHOWN_ROWS + 1}<`);
    noMarkup(page([pend({ rows: [{ line: 2, displayName: XSS, kind: "employer", brandNames: [XSS], deteNames: [XSS] }] })]));
  });
});

describe("/companies/[id]", () => {
  const c = (o: Partial<CompanyPreview> = {}): CompanyPreview => ({ id: "12", slug: "fake-co", display_name: "Fake Co Ltd", kind: "employer", status: "verified", cro_number: "810001", merged_into_id: null, active_members: 3, jobs: 1, names: 2, ...o });
  const dom = (o: Partial<DomainRow> = {}): DomainRow => ({ id: "1", domain: "fake-co.example.test", source: "admin", addedBy: "s", createdAt: "2026-11-20 09:00:00+00", ...o });
  const req = (o: Partial<OpenRequest> = {}): OpenRequest => ({
    id: "4", organisation_id: "12", display_name: "Fake Co Ltd", new_owner_membership_id: "90", new_owner_email: "new@fake-co.example.test", old_owner_membership_id: "80", old_owner_email: "old@fake-co.example.test",
    requested_by_staff_user_id: "s", requested_at: "2026-11-18 09:00:00+00", completes_after: "2026-11-25 09:00:00+00", can_complete: true, ...o,
  });
  const page = (o: { c?: CompanyPreview; domains?: DomainRow[]; open?: OpenRequest[]; owner?: boolean } = {}) => html(<Company c={o.c ?? c()} domains={o.domains ?? []} open={o.open ?? []} canOwner={o.owner ?? true} now={NOW} />);
  it("the header, the domain list with Remove and the add form, the member limit with the active count", () => {
    const p = page({ domains: [dom()] });
    expect(p.match(/<h1/g)).toHaveLength(1); expect(p).toMatch(/Fake Co Ltd/); expect(p).toMatch(/CRO 810001/); expect(p).toMatch(/fake-co\.example\.test/); expect(p).toMatch(/Remove/);
    expect(p).toMatch(/Add the domain/); expect(p).toMatch(/It has 3 active members/); expect(p).toMatch(/min="1"[^>]*max="50"|max="50"[^>]*min="1"/);
    expect(page()).toMatch(/no domain saved/); clean(p);
  });
  it("the owner section: the form, an open request with Complete and Cancel, and no form for an administrator", () => {
    expect(page()).toMatch(/Record the request/); expect(page()).toMatch(/I checked the CRO number/);
    const open = page({ open: [req()] });
    expect(open).toMatch(/Complete the change/); expect(open).toMatch(/Cancel the request/); expect(open).toMatch(/The 7 days have passed/); expect(open).not.toMatch(/Record the request/);
    expect(page({ open: [req({ can_complete: false })] })).toMatch(/Can be completed from 25 Nov 2026, 09:00/);
    const adm = page({ owner: false });
    expect(adm).toMatch(/Only an account reviewer can change/); expect(adm).not.toMatch(/Record the request/);
  });
  it("a merged company says so; names and domains are text", () => {
    expect(page({ c: c({ merged_into_id: "13" }) })).toMatch(/merged into[\s\S]*company 13/);
    noMarkup(page({ c: c({ display_name: XSS }), domains: [dom({ domain: XSS })], open: [req({ new_owner_email: XSS })] }));
  });
});

describe("/companies/dete-links", () => {
  const sug = (o: Partial<DeteSuggestion> = {}): DeteSuggestion => ({ deteName: "FAKE CO LIMITED", permits: 5, organisationId: "12", organisation: "Fake Co", matchedName: "Fake Co", score: 1, kind: "exact", ...o });
  const page = (o: { items?: DeteSuggestion[]; canAct?: boolean; next?: string; prev?: string } = {}) => html(<DeteLinks items={o.items ?? [sug()]} total={(o.items ?? [sug()]).length} page={1} canAct={o.canAct ?? true} next={o.next} prev={o.prev} />);
  it("a suggestion with Link and Not this company for the reviewer, read only for others, empty and paged states", () => {
    const p = page({ items: [sug(), sug({ deteName: "OTHER LTD", kind: "suggested", permits: 1 })], next: "/companies/dete-links?page=2" });
    expect(p.match(/<h1/g)).toHaveLength(1); expect(p).toMatch(/Link this name/); expect(p).toMatch(/Not this company/); expect(p).toMatch(/Same name/); expect(p).toMatch(/Close name/);
    expect(p).toMatch(/1 permit\)/); expect(p).toMatch(/href="\/companies\/12"/); expect(p).toMatch(/Next/);
    const ro = page({ canAct: false }); expect(ro).toMatch(/Only an account reviewer can link/); expect(ro).not.toMatch(/Link this name/);
    expect(page({ items: [] })).toMatch(/No suggestion is waiting/); clean(p);
  });
  it("names are text", () => noMarkup(page({ items: [sug({ deteName: XSS, organisation: XSS, matchedName: XSS })] })));
});
