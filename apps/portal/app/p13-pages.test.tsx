// P13: the landing, the verification page, the legal pages, every page's metadata, and a scan of the slice's own files. react-dom/server, no browser, no network.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));

import { Landing } from "./_landing/landing";
import { LegalView } from "./_legal/legal-view";
import { meta as withBrand, tokenMeta } from "./_site/meta";
import { VerificationView, when, type Verification } from "./verification/view";

const ROOT = import.meta.dirname;
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

describe("the landing (NE1)", () => {
  const page = html(<Landing candidates="https://c.example/" rules="https://c.example/employer-acceptable-use" help="https://c.example/help" />);
  const text = page.replace(/<[^>]+>/g, " ");
  it("has one H1, the three sign-up paths, the claim section and the sign-up buttons", () => {
    expect(page.match(/<h1/g)).toHaveLength(1);
    for (const t of ["Already sponsored a permit", "First-time sponsor", "Recruitment agency", "Claim your", "I&#x27;m an employer", "I&#x27;m a recruitment agency"]) expect(page).toContain(t);
    expect(page).toMatch(/href="\/sign-up\/account\?kind=agency"/);
    expect(page).toMatch(/href="\/sign-up\/account\?kind=employer"/);
    expect(page).toMatch(/href="\/sign-in"/);
  });
  it("copy rows: CF43 soft, CF69 'we aim to', CF16 and CF123 (no WRC register line), no figure copied from a frame", () => {
    expect(text).toMatch(/Can go live at once with a company email/);
    expect(text).toMatch(/We aim to review within 1 working day/);
    expect(text).not.toMatch(/Live at once with a company-domain email|Admin review, 1 working day|can take longer/);
    expect(text).not.toMatch(/\d{2,3}%|26,629|33,362|36,605|36,000|permits issued|\(sample\)|Harbourline|Example Recruitment|aoife/i);
    expect(text).not.toMatch(/Launch B|Candidate search|Sample|Permitly/);
  });
  it("shows no photo and no stock image, and no dangerous HTML", () => {
    expect(page).not.toMatch(/<img|background-image|dangerouslySetInnerHTML/);
    expect(page).toMatch(/data-photo-block/);
  });
  it("hides the candidate-site links when their address is not set", () => {
    const bare = html(<Landing candidates={null} rules={null} help={null} />);
    expect(bare).not.toMatch(/For candidates|Read the rules|>Help</);
    expect(bare).toMatch(/Terms/);
  });
  it("no em or en dash anywhere in the page", () => expect(page).not.toMatch(/[–—]/));
});

const V: Verification = { status: "pending_review", emailVerified: true, croNumber: "123456", croFound: true, croName: "FAKE LIMITED", croStatus: "Normal", deteMatch: true, reviewOpenedAt: "2026-11-09T10:42:00.000Z", question: null };
const view = (v: Partial<Verification>, o: Partial<{ isOwner: boolean; canDraft: boolean; help: string | null }> = {}) =>
  html(<VerificationView email="me@example.test" v={{ ...V, ...v }} isOwner={o.isOwner ?? true} canDraft={o.canDraft ?? true} help={o.help === undefined ? "https://c.example/help" : o.help} />);

describe("verification (E06)", () => {
  it("formats the review time in Irish time, and gives null for nothing or rubbish", () => {
    expect(when("2026-11-09T10:42:00.000Z")).toBe("9 Nov 2026, 10:42");
    expect(when("2026-07-09T10:42:00.000Z")).toBe("9 Jul 2026, 11:42"); // summer time
    expect(when(null)).toBeNull();
    expect(when("not a date")).toBeNull();
  });
  it("in review: the four checks, the queue time, the draft link and the support link, no upload", () => {
    const p = view({});
    for (const t of ["Your account is", "Email verified", "me@example.test", "CRO record found", "FAKE LIMITED · Normal", "In the permit records", "Admin review", "In the queue since 9 Nov 2026, 10:42", "Account live", "Draft a job while you wait", "Contact support"]) expect(p).toContain(t);
    expect(p).toMatch(/We aim to review within 1 working day/); // CF69
    expect(p).toMatch(/Drafts are kept/); // CF67
    expect(p).not.toMatch(/type="file"|Upload|You can draft a job now\. It publishes/); // CF95
    expect(p).not.toMatch(/We need one more thing/);
  });
  it("each check has its other state: email not confirmed, CRO not found, no CRO number (agency), not in the permit records, nothing queued yet", () => {
    expect(view({ emailVerified: false })).toMatch(/Email not confirmed/);
    expect(view({ croFound: false })).toMatch(/CRO record not found/);
    expect(view({ croNumber: null, croFound: null, croName: null, croStatus: null })).toMatch(/No CRO number given/);
    expect(view({ deteMatch: false })).toMatch(/Not in the permit records/);
    expect(view({ reviewOpenedAt: null })).toMatch(/Waiting for our team/);
  });
  it("needs more info: the owner sees staff's question and the one-note answer box; any other member sees neither the question nor the box", () => {
    const owner = view({ status: "needs_info", question: "Please tell us which director signed up." });
    expect(owner).toMatch(/We need one more thing/);
    expect(owner).toMatch(/Please tell us which director signed up\./);
    expect(owner).toMatch(/<textarea/);
    const owned = view({ status: "needs_info", question: null });
    expect(owned).toMatch(/Our team asked you for more information/);
    const other = view({ status: "needs_info", question: "SECRET QUESTION" }, { isOwner: false });
    expect(other).toMatch(/Ask them to open this page/);
    expect(other).not.toMatch(/SECRET QUESTION|<textarea/);
  });
  it("a viewer is not offered a draft; no support link without the candidate address; live shows the dashboard link; an ended account shows its sentence and no checks", () => {
    expect(view({}, { canDraft: false })).not.toMatch(/Draft a job/);
    expect(view({}, { help: null })).not.toMatch(/Contact support/);
    const live = view({ status: "verified" });
    expect(live).toMatch(/href="\/dashboard"/);
    expect(live).toMatch(/Your account is <span[^>]*>live/);
    for (const status of ["rejected", "suspended", "closed", "banned"]) {
      const p = view({ status });
      expect(p, status).toMatch(/not active/);
      expect(p, status).not.toMatch(/Verification progress/);
    }
  });
  it("no staff name, id or internal field reaches the HTML", () => {
    expect(view({})).not.toMatch(/organisationId|portal_user|staff|membership/i);
  });
});

describe("legal pages", () => {
  it("shows the text with its line breaks as text, never as HTML", () => {
    const p = html(<LegalView title="Terms" status={200} text={{ version: "v1", body: "Line one\n<b>two</b>", publishedAt: "x" }} />);
    expect(p).toMatch(/whitespace-pre-line/);
    expect(p).toContain("&lt;b&gt;two&lt;/b&gt;");
    expect(p).not.toContain("<b>two</b>");
  });
  it("has a state for each answer of the legal route: not published, over the limit, anything else", () => {
    expect(html(<LegalView title="Terms" status={404} />)).toMatch(/Not published yet/);
    expect(html(<LegalView title="Terms" status={429} />)).toMatch(/Too many reads/);
    expect(html(<LegalView title="Terms" status={400} />)).toMatch(/cannot show this text/);
    expect(html(<LegalView title="Terms" status={500} />)).toMatch(/cannot show this text/);
  });
});

describe("metadata", () => {
  it("title is 60 characters or fewer before the brand, description 120 to 160, for every page of the slice", () => {
    const pages = files(ROOT).filter((f) => /\/page\.tsx$/.test(f));
    expect(pages.length).toBeGreaterThanOrEqual(14);
    for (const f of pages) {
      if (/\/kit\//.test(f) || /dashboard\//.test(f)) continue;
      const src = readFileSync(f, "utf8");
      const m = src.match(/(?:meta|tokenMeta)\(\s*"([^"]+)",\s*"([^"]+)"/);
      expect(m, relative(ROOT, f)).not.toBeNull();
      expect(m![1]!.length, `${relative(ROOT, f)} title`).toBeLessThanOrEqual(60);
      expect(m![2]!.length, `${relative(ROOT, f)} description`).toBeGreaterThanOrEqual(120);
      expect(m![2]!.length, `${relative(ROOT, f)} description`).toBeLessThanOrEqual(160);
    }
  });
  it("meta adds the brand; a page with a token in its address sends no referrer and is not indexed", () => {
    expect(withBrand("T", "D").title).toBe("T | Irish Work Permit");
    expect(tokenMeta("T", "D")).toMatchObject({ referrer: "no-referrer", robots: { index: false } });
  });
  it("the pages that carry a token (reset, verify, invitation) use tokenMeta", () => {
    for (const f of ["(auth)/reset-password/page.tsx", "(auth)/verify-email/page.tsx", "team/accept/page.tsx"]) expect(readFileSync(join(ROOT, f), "utf8"), f).toMatch(/tokenMeta\(/);
  });
});

describe("the slice's own files", () => {
  const own = files(ROOT).filter((f) => /\.(tsx?|css)$/.test(f) && !/\/kit\/|\/api\/|\.test\./.test(f));
  it("no em or en dash, no innerHTML, no glob import, no analytics, no 'Launch B', no 'Sample', no cookie banner, no page numbers", () => {
    expect(own.length).toBeGreaterThan(15);
    for (const f of own) {
      const t = readFileSync(f, "utf8");
      const name = relative(ROOT, f);
      expect(t, `${name} dash`).not.toMatch(/[–—]/);
      expect(t, `${name} html`).not.toMatch(/dangerouslySetInnerHTML|innerHTML|import\.meta\.glob/);
      expect(t, name).not.toMatch(/gtag|analytics|CookieBanner|Launch B|"Sample"|Page \d/i);
    }
  });
  it("only the form files are client components, and no client component imports the login package or the data layer", () => {
    const client = own.filter((f) => !/global-error/.test(f) && /^"use client"/.test(readFileSync(f, "utf8")));
    expect(client.map((f) => relative(ROOT, f)).filter((f) => f.startsWith("(auth)/")).sort()).toEqual(["(auth)/company-forms.tsx", "(auth)/forms.tsx"]);
    for (const f of client) expect(relative(ROOT, f), "a page or view stays a server component").not.toMatch(/(page|view|views|layout)\.tsx$/);
    for (const f of client) expect(readFileSync(f, "utf8")).not.toMatch(/@portal\/(auth|db)|lib\/data/);
  });
});
