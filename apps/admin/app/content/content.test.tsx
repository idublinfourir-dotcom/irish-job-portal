// The content editor (frame D12): the lists of each tab, the form for each role and state, the preview, the stale list. react-dom/server, no browser, no network.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FormView, type Item, type Props, type State } from "./actions";
import { categoryLabel, dayText, daysSince, publisherRole, slugOf } from "./text";
import { Content, href, type Preview, type Row } from "./view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/content" }));

const NOW = new Date("2026-11-25T12:00:00Z");
const row = (o: Partial<Row> = {}): Row => ({ id: "41", kind: "update", slug: "fake-update", title: "Fake salary change", status: "draft", checkedOn: null, category: "salary_minimums", effectiveFrom: "2027-01-01", ...o });
const item = (o: Partial<Item> = {}): Item => ({ id: "41", kind: "update", slug: "fake-update", title: "Fake salary change", status: "draft", body: "Fake body\nsecond line", sourceUrl: "https://enterprise.gov.ie/x", checkedOn: "2026-11-09", category: "salary_minimums", effectiveFrom: "2027-01-01", ...o });
type O = Partial<Parameters<typeof Content>[0]>;
const page = (o: O = {}) => html(<Content tab="update" items={[row()]} open={null} preview={null} isNew={false} roles={["content_editor"]} today="2026-11-25" now={NOW} {...o} />);
const el = (h: string, name: string) => new RegExp(`<(?:input|select|textarea)[^>]*name="${name}"[^>]*>`).exec(h)?.[0] ?? "";
const clean = (t: string) => expect(t).not.toMatch(/[\u2013\u2014]|undefined|\[object|Launch B|Sample|Email (me|candidates)|opted in/);

describe("the lists", () => {
  it("the updates feed shows title, type, effective day, state and checked-on day", () => {
    const p = page({ items: [row(), row({ id: "42", status: "published", category: "quotas", effectiveFrom: "2026-10-14", checkedOn: "2026-11-09", title: "Fake quota renewed" })] });
    expect(p).toMatch(/Salary minimums/);
    expect(p).toMatch(/1 Jan 2027/);
    expect(p).toMatch(/Draft/);
    expect(p).toMatch(/Published/);
    expect(p).toMatch(/9 Nov 2026/);
    expect(p).toMatch(/Updates feed/);
    expect(p).toMatch(/>New update</);
    clean(p);
  });
  it("the other tabs have no type or effective column; each kind has its own empty words", () => {
    const g = page({ tab: "guide", items: [row({ kind: "guide", title: "Fake guide" })] });
    expect(g).not.toMatch(/Effective from/);
    expect(g).toMatch(/Fake guide/);
    for (const [tab, w] of [["update", /No updates yet/], ["guide", /No guides yet/], ["help", /No help pages yet/], ["occupation", /No occupation pages yet/], ["stale", /Nothing is out of date/]] as const) expect(page({ tab, items: [] }), tab).toMatch(w);
  });
  it("the stale list shows how many days since the check and links to the page's own tab", () => {
    const p = page({ tab: "stale", items: [row({ kind: "guide", status: "published", checkedOn: "2026-07-01", title: "Fake old guide" })] });
    expect(p).toMatch(/147</);
    expect(p).toMatch(/href="\/content\?tab=guide&amp;id=41"/);
    expect(p).not.toMatch(/>New /);
  });
  it("Previous and Next; the selected row is marked", () => {
    const p = page({ selected: "41", next: "/content?after=x", prev: "/content" });
    expect(p).toMatch(/Previous/);
    expect(p).toMatch(/Next/);
    expect(p).toMatch(/aria-current="true"/);
    expect(p).not.toMatch(/\bPage \d|>1<\/a>/);
  });
  it("tabs are links; hrefs are built from the tab and the ids", () => {
    expect(href("update")).toBe("/content");
    expect(href("guide", { id: "5", preview: true })).toBe("/content?tab=guide&id=5&preview=1");
    expect(href("update", { isNew: true })).toBe("/content?new=1");
    expect(page()).toMatch(/role="tablist"/);
  });
  it("titles are text, never markup", () => {
    const p = page({ items: [row({ title: "<script>alert(1)</script> Fake" })] });
    expect(p).not.toMatch(/<script>/);
    expect(p).toMatch(/&lt;script&gt;/);
  });
});

describe("the form", () => {
  const P = (o: Partial<Props> = {}): Props => ({ kind: "update", item: item(), roles: ["content_editor"], today: "2026-11-25", back: "/content?id=41", listHref: "/content", ...o });
  const S: State = { pending: false, failed: null, ask: false };
  const f = (p: Partial<Props> = {}, s: Partial<State> = {}) => html(<FormView p={P(p)} s={{ ...S, ...s }} onSubmit={() => {}} onAsk={() => {}} />);
  it("a draft of an update by a content editor: every field, type, effective day, Publish, Save draft, Preview; no 'Email me updates'", () => {
    const p = f();
    for (const w of [/name="title"/, /name="category"/, /name="effectiveFrom"/, /name="body"/, /name="sourceUrl"/, />Publish</, />Save draft</, /Preview/, /Plain text, up to 50,000/]) expect(p).toMatch(w);
    expect(el(p, "checkedOn")).toMatch(/max="2026-11-25"/);
    expect(p).not.toMatch(/Withdraw|name="slug"/);
    expect(p).toMatch(/Salary minimums/);
    clean(p);
  });
  it("a new page asks for the address part; an occupation page asks for the SOC code and has no type or date", () => {
    expect(f({ item: null })).toMatch(/name="slug"/);
    const o = f({ item: null, kind: "occupation" });
    expect(o).toMatch(/SOC 2010 code/);
    expect(o).not.toMatch(/name="category"|name="effectiveFrom"/);
    expect(f({ item: null, kind: "help" })).toMatch(/name="category"[^>]*>[\s\S]*Report a problem/);
  });
  it("a published page is read-only with Withdraw for a content editor, and says how to change it", () => {
    const p = f({ item: item({ status: "published" }) });
    expect(p).toMatch(/A published page cannot be edited/);
    expect(p).toMatch(/>Withdraw</);
    expect(el(p, "title")).toMatch(/disabled/);
    expect(p).not.toMatch(/>Save draft<|>Publish</);
  });
  it("a withdrawn page can be edited and published again", () => {
    const p = f({ item: item({ status: "withdrawn" }) });
    expect(p).toMatch(/>Save draft</);
    expect(p).toMatch(/>Publish</);
    expect(p).not.toMatch(/>Withdraw</);
  });
  it("a rules data editor publishes a guide draft but cannot edit it; a content editor cannot publish it", () => {
    const g = f({ kind: "guide", item: item({ kind: "guide", category: null }), roles: ["rules_data_editor"] });
    expect(g).toMatch(/>Publish</);
    expect(g).not.toMatch(/>Save draft</);
    expect(el(g, "title")).toMatch(/disabled/);
    const c = f({ kind: "guide", item: item({ kind: "guide", category: null }), roles: ["content_editor"] });
    expect(c).toMatch(/>Save draft</);
    expect(c).not.toMatch(/>Publish</);
    expect(publisherRole("update")).toBe("content_editor");
    expect(publisherRole("help")).toBe("content_editor");
    expect(publisherRole("guide")).toBe("rules_data_editor");
    expect(publisherRole("occupation")).toBe("rules_data_editor");
  });
  it("an administrator reads and previews only", () => {
    const p = f({ roles: ["administrator"] });
    expect(p).not.toMatch(/>Save draft<|>Publish<|>Withdraw</);
    expect(p).toMatch(/Preview/);
    expect(page({ roles: ["administrator"] })).toMatch(/Only a content editor writes pages/);
    expect(page({ roles: ["administrator"] })).not.toMatch(/>New update</);
  });
  it("a refusal shows in words with the sign-in link for the fresh sign-in; a pending save locks the buttons", () => {
    expect(f({}, { failed: { code: "needs_source_and_checked_on", status: 409 } })).toMatch(/needs its DETE source link and a checked-on day/);
    const r = f({}, { failed: { code: "reauth_required", status: 403 } });
    expect(r).toMatch(/href="\/sign-in\?again=1&amp;next=%2Fcontent%3Fid%3D41"/);
    expect(f({}, { pending: true })).toMatch(/<button[^>]*disabled[^>]*>Save draft/);
    expect(f({}, { ask: true })).toMatch(/goes live on the public site at once/);
    clean(r);
  });
});

describe("the preview", () => {
  const pv: Preview = { title: "Fake guide", kind: "guide", body: "Line one\n<b>two</b>", sourceUrl: "https://enterprise.gov.ie/x", checkedOn: "2026-11-09", status: "draft", category: null, effectiveFrom: null };
  it("shows the page as made, its state, and text only", () => {
    const p = page({ tab: "guide", preview: pv, selected: "41", open: item({ kind: "guide" }) });
    expect(p).toMatch(/Preview of Fake guide/);
    expect(p).toMatch(/Draft/);
    expect(p).toMatch(/Checked on 9 Nov 2026/);
    expect(p).toMatch(/&lt;b&gt;two&lt;\/b&gt;/);
    expect(p).not.toMatch(/<b>two/);
    expect(p).toMatch(/Back to the form/);
  });
  it("a missing page is a notice", () => {
    expect(page({ missingId: true })).toMatch(/That page was not found/);
  });
});

describe("the words", () => {
  it("days, slugs and labels", () => {
    expect(dayText("2026-11-09")).toBe("9 Nov 2026");
    expect(dayText(null)).toBe("-");
    expect(dayText("not a day")).toBe("-");
    expect(daysSince("2026-11-20", NOW)).toBe(5);
    expect(daysSince("2027-01-01", NOW)).toBe(0);
    expect(slugOf("Salary minimums change, from January 2027!")).toBe("salary-minimums-change-from-january-2027");
    expect(slugOf("  Café & bar ")).toBe("cafe-bar");
    expect(slugOf("!!!")).toBe("");
    expect(slugOf("a".repeat(300)).length).toBe(100);
    expect(categoryLabel("quotas")).toBe("Quotas");
    expect(categoryLabel(null)).toBe("");
  });
});
