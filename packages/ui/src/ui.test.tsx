// Unit tests (no browser, no network): each component is rendered to HTML and the markup is checked.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SITE_NAME as AUTH_SITE_NAME } from "../../auth/src/email-layout";
import {
  ADMIN_ROLES, AdminShell, Breadcrumb, BUTTON_VARIANTS, Button, CandidateShell, Card, Checkbox, CookieBanner, CriticalSkillsBadge, Dialog, EmptyState, ICON_NAMES, Icon,
  Input, JobCard, Notice, Pager, Pill, PortalShell, Radio, Select, Skeleton, SITE_NAME, SponsorBadge, Tabs, Textarea, Toggle,
} from "./index";
import { Kit } from "./kit";

describe("brand", () => {
  it("is the same constant as the email layout", () => expect(SITE_NAME).toBe(AUTH_SITE_NAME));
});

describe("Button", () => {
  it("has a distinct look for each of the eight variants", () => {
    const classes = BUTTON_VARIANTS.map((v) => html(<Button variant={v}>x</Button>).match(/class="([^"]*)"/)![1]);
    expect(new Set(classes).size).toBe(8);
  });
  it("never uses the two permit badge colours", () => {
    for (const v of BUTTON_VARIANTS) expect(html(<Button variant={v}>x</Button>)).not.toMatch(/critical-skills|sponsor/);
  });
  it("is a button of type button, disabled when told", () => {
    expect(html(<Button>x</Button>)).toMatch(/^<button type="button"/);
    expect(html(<Button disabled>x</Button>)).toMatch(/disabled=""/);
  });
  it("is a link when given an href, with rel on _blank", () => {
    expect(html(<Button href="/jobs">x</Button>)).toMatch(/^<a [^>]*href="\/jobs"/);
    expect(html(<Button href="https://example.com" target="_blank">x</Button>)).toContain('rel="noopener noreferrer"');
  });
  it("drops the href of a disabled link and says so", () => {
    const h = html(<Button href="/jobs" aria-disabled="true">x</Button>);
    expect(h).not.toContain("href=");
    expect(h).toContain('aria-disabled="true"');
    expect(h).toContain('tabindex="-1"');
  });
  it("sizes differ", () => {
    expect(new Set(["sm", "md", "lg"].map((s) => html(<Button size={s as "sm"}>x</Button>))).size).toBe(3);
  });
});

describe("badges and pills", () => {
  it("Critical Skills has a shield and its own colour, Sponsor a pen and its own colour, neither the theme green", () => {
    const c = html(<CriticalSkillsBadge />);
    const s = html(<SponsorBadge />);
    expect(c).toContain("Critical Skills eligible");
    expect(c).toContain('data-icon="shield"');
    expect(c).toContain("bg-critical-skills");
    expect(s).toContain("Sponsor confirmed");
    expect(s).toContain('data-icon="pen"');
    expect(s).toContain("bg-sponsor ");
    for (const m of [c, s]) expect(m).not.toMatch(/green-tint|bg-deep-green/);
  });
  it("renders a pill with its key word", () => expect(html(<Pill tone="peach">Cork</Pill>)).toContain("Cork"));
});

describe("JobCard", () => {
  it("shows every prop and the saved state", () => {
    const h = html(<JobCard title="Staff Nurse" href="/jobs/x" employer="Acme" place="Cork" salary="€40,000" badges={<SponsorBadge />} saved />);
    for (const t of ["Staff Nurse", "Acme", "Cork", "€40,000", "Sponsor confirmed", 'href="/jobs/x"', 'aria-pressed="true"']) expect(h).toContain(t);
    expect(html(<JobCard title="T" employer="E" place="P" saved={false} />)).toContain('aria-pressed="false"');
    expect(html(<JobCard title="T" employer="E" place="P" />)).not.toContain("<button");
  });
  it("escapes its text", () => expect(html(<JobCard title="<script>x</script>" employer="E" place="P" />)).not.toContain("<script>"));
});

describe("form controls", () => {
  it("links help, note and error text to the control with aria-describedby", () => {
    const h = html(<Input label="Salary" id="sal" help="Per year" note="Below the minimum" status="blocked" error="Too low" />);
    expect(h).toContain('for="sal"');
    expect(h).toContain('aria-describedby="sal-help sal-note sal-error"');
    expect(h).toContain('aria-invalid="true"');
    for (const id of ["sal-help", "sal-note", "sal-error"]) expect(h).toContain(`id="${id}"`);
    expect(h).toContain("border-error");
  });
  it("has no describedby or invalid flag when there is nothing to describe", () => {
    const h = html(<Input label="Title" id="t" />);
    expect(h).not.toContain("aria-describedby");
    expect(h).not.toContain("aria-invalid");
  });
  it("shows the passed state with a check", () => {
    const h = html(<Input label="Role" status="passed" note="On the Critical Skills list" />);
    expect(h).toContain("border-deep-green");
    expect(h).toContain('data-icon="check"');
  });
  it("gives every control a label for its id (generated ids too)", () => {
    const h = html(
      <>
        <Input label="A" />
        <Select label="B"><option>x</option></Select>
        <Textarea label="C" />
        <Checkbox label="D" />
        <Radio label="E" />
        <Toggle label="F" />
      </>,
    );
    const ids = [...h.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(6);
    for (const id of ids) expect(h).toContain(`for="${id}"`);
    expect(new Set(ids).size).toBe(6);
  });
  it("makes Toggle a switch, Checkbox a checkbox, Radio a radio", () => {
    expect(html(<Toggle label="t" />)).toContain('role="switch"');
    expect(html(<Checkbox label="t" />)).toContain('type="checkbox"');
    expect(html(<Radio label="t" />)).toContain('type="radio"');
  });
  it("links a Toggle's help text", () => expect(html(<Toggle label="t" id="x" help="h" />)).toContain('aria-describedby="x-help"'));
});

describe("navigation", () => {
  it("Tabs select the active one", () => {
    const h = html(<Tabs label="L" items={[{ label: "A", active: true, href: "/a" }, { label: "B" }]} />);
    expect(h).toContain('role="tablist"');
    expect(h).toContain('aria-selected="true"');
    expect(h).toContain('aria-selected="false"');
  });
  it("Breadcrumb marks the last item as the current page", () => {
    const h = html(<Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Here" }]} />);
    expect(h).toContain('aria-label="Breadcrumb"');
    expect(h).toContain('aria-current="page"');
  });
  it("Pager has Previous and Next and never page numbers (#125)", () => {
    const h = html(<Pager prevHref="/p?1" nextHref="/p?3" />);
    expect(h).toContain("Previous");
    expect(h).toContain("Next");
    expect(h.replace(/<[^>]*>/g, "")).not.toMatch(/\d/);
    expect(html(<Pager nextHref="/n" />)).toContain('aria-disabled="true"');
  });
});

describe("notices and states", () => {
  it("Notice roles: status for info and success, alert for warning and error", () => {
    expect(html(<Notice kind="info">x</Notice>)).toContain('role="status"');
    expect(html(<Notice kind="success">x</Notice>)).toContain('role="status"');
    expect(html(<Notice kind="warning">x</Notice>)).toContain('role="alert"');
    expect(html(<Notice kind="error">x</Notice>)).toContain('role="alert"');
    const closed = html(<Notice kind="closed" title="Portal closed">Text from the page.</Notice>);
    expect(closed).toContain('data-notice="closed"');
    expect(closed).toContain("Text from the page.");
    expect(closed).toContain('role="status"');
  });
  it("EmptyState, Card, Skeleton", () => {
    expect(html(<EmptyState title="Nothing" action={<b>go</b>}>Why</EmptyState>)).toMatch(/<h2[^>]*>Nothing.*Why.*<b>go<\/b>/);
    expect(html(<Card as="section">x</Card>)).toMatch(/^<section/);
    expect(html(<Skeleton />)).toContain('aria-hidden="true"');
  });
  it("Dialog is a labelled dialog with a Close button", () => {
    const h = html(<Dialog open={false} onClose={() => {}} title="Close job?">body</Dialog>);
    const id = h.match(/aria-labelledby="([^"]+)"/)![1];
    expect(h).toContain(`id="${id}"`);
    expect(h).toContain('aria-label="Close"');
    expect(h).not.toMatch(/<dialog[^>]* open/);
  });
});

describe("Icon", () => {
  it("has every name the frames use", () => {
    for (const n of ["check", "arrow", "shield", "flag", "clock", "bookmark", "search", "right", "left", "pin", "globe", "briefcase", "bell", "pen", "menu", "close"]) expect(ICON_NAMES).toContain(n);
  });
  it("is decorative unless titled", () => {
    expect(html(<Icon name="check" />)).toContain('aria-hidden="true"');
    expect(html(<Icon name="check" title="Done" />)).toContain('role="img"');
  });
});

describe("candidate shell", () => {
  const nav = (h: string) => h.replace(/<[^>]*>/g, "|");
  it("shows the public nav signed out", () => {
    const h = html(<CandidateShell>x</CandidateShell>);
    for (const t of ["Find jobs", "Companies", "Guides", "Eligibility checker", "Permit services", "For employers", "Log in", "Create account"]) expect(h).toContain(t);
    expect(h).not.toContain("Sign out");
  });
  it("shows the signed-in nav when signed in", () => {
    const h = html(<CandidateShell signedIn>x</CandidateShell>);
    for (const t of ["Account", "Tracker", "Saved", "Alerts", "Sign out"]) expect(h).toContain(t);
    expect(h).not.toContain("Create account");
  });
  it("has a mobile menu with no script (native details)", () => expect(html(<CandidateShell>x</CandidateShell>)).toContain("<details"));
  it("footer: GeoNames credit, report line, and the two slots only when given", () => {
    const bare = html(<CandidateShell>x</CandidateShell>);
    expect(bare).toContain('href="https://www.geonames.org/"');
    expect(bare).toContain('href="https://creativecommons.org/licenses/by/4.0/"');
    expect(nav(bare)).toContain("Place names from |GeoNames|, licensed |CC BY 4.0|");
    expect(nav(bare)).toContain("No genuine employer asks you to pay for a job offer. |Report it.|");
    expect(bare).not.toContain("Rules last checked");
    expect(bare).not.toContain("standing-line");
    const full = html(<CandidateShell standingLine="Our line." rulesCheckedOn="3 Nov 2026">x</CandidateShell>);
    expect(full).toContain("Our line.");
    expect(full).toContain("Rules last checked on 3 Nov 2026");
  });
  it("footer says Cookies and links to /cookies", () => {
    const h = html(<CandidateShell>x</CandidateShell>);
    expect(h).toMatch(/href="\/cookies"[^>]*>Cookies</);
    expect(h).not.toContain("Cookie settings");
  });
  it("keeps the brand name", () => expect(html(<CandidateShell>x</CandidateShell>)).toContain(SITE_NAME));
});

describe("cookie banner", () => {
  it("has Reject and Accept of the same look and size, and a settings link", () => {
    const h = html(<CookieBanner />);
    const btn = (t: string) => h.match(new RegExp(`<button[^>]*class="([^"]*)"[^>]*>${t}</button>`))![1];
    expect(btn("Reject")).toBe(btn("Accept"));
    expect(h).toContain("Cookie settings");
  });
  it("is not part of the shell while K11 is open", () => expect(html(<CandidateShell>x</CandidateShell>)).not.toContain("Reject"));
});

describe("portal shell", () => {
  const h = html(<PortalShell companyName="Harbourline Hotels" role="Account owner" counts={{ Jobs: 5 }} current="/jobs">x</PortalShell>);
  it("lists the Launch A links only", () => {
    for (const t of ["Dashboard", "Jobs", "Post a job", "Permit services", "Company profile", "Team", "Account status", "Help"]) expect(h).toContain(t);
    for (const t of ["Applicants", "Candidate search", "Contact requests"]) expect(h).not.toContain(t);
  });
  it("without a role key shows every Launch A link; with one hides what the role cannot use", () => {
    const l = (roleKey: "viewer" | "poster" | "recruiter" | "account_owner") => [...html(<PortalShell companyName="A B" role="x" roleKey={roleKey}>x</PortalShell>).matchAll(/<a [^>]*>([^<]*)/g)].map((m) => m[1]!);
    expect(l("viewer")).not.toContain("Post a job");
    expect(l("viewer")).not.toContain("Permit services");
    expect(l("poster")).toContain("Post a job");
    expect(l("poster")).not.toContain("Permit services");
    expect(l("recruiter")).toContain("Permit services");
  });
  it("shows company, role, initials, a count and the current page", () => {
    for (const t of ["Harbourline Hotels", "Account owner", ">HH<", "data-count"]) expect(h).toContain(t);
    expect(h).toContain('aria-current="page"');
  });
});

describe("admin shell", () => {
  const links = (roles: readonly (typeof ADMIN_ROLES)[number][]) => [...html(<AdminShell roles={roles} name="Dara">x</AdminShell>).matchAll(/<a [^>]*>([^<]*)/g)].map((m) => m[1]!);
  it("says internal, staff only", () => expect(html(<AdminShell roles={[]} name="D">x</AdminShell>)).toContain("Internal, staff only"));
  it("hides every link that needs a role for a member with none", () => expect(links([])).toEqual(["Skip to content", "Overview", "Rules data", "Audit log"]));
  it("shows a link only to the role that may open it", () => {
    expect(links(["account_reviewer"])).toContain("Account reviews");
    expect(links(["account_reviewer"])).not.toContain("Fetched jobs");
    expect(links(["trust_and_safety"])).toContain("Reports and strikes");
    expect(links(["content_editor"])).toContain("Content editor");
    expect(links(["content_editor"])).not.toContain("Staff and roles");
    expect(links(["administrator"])).toContain("Staff and roles");
    expect(links(["administrator"])).not.toContain("Account reviews");
  });
  it("lists the links by the backend roles (admin.yaml x-roles of each page's read)", () => {
    expect(links(["administrator"])).toEqual(expect.arrayContaining(["Services cases", "Big-company list", "Name merges", "Manual posting", "Content editor", "Staff and roles"]));
    expect(links(["fetched_job_reviewer"])).toContain("Name merges");
    expect(links(["fetched_job_reviewer"])).not.toContain("Manual posting");
    expect(links(["trust_and_safety"])).toEqual(expect.arrayContaining(["Reports and strikes", "Ban list", "Manual posting", "Name merges"]));
    expect(links(["rules_data_editor"])).toEqual(expect.arrayContaining(["Big-company list", "Content editor"]));
    expect(links(["services_case_handler"])).not.toContain("Content editor");
  });
  it("shows all the links to staff holding all seven roles", () => {
    const all = links(ADMIN_ROLES);
    for (const t of ["Overview", "Account reviews", "Fetched jobs", "Reports and strikes", "Services cases", "Rules data", "Big-company list", "Name merges", "Ban list", "Manual posting", "Content editor", "Audit log", "Staff and roles"]) expect(all).toContain(t);
  });
  it("shows count badges from props", () => expect(html(<AdminShell roles={["account_reviewer"]} name="D" counts={{ "Account reviews": 9 }}>x</AdminShell>)).toMatch(/data-count[^>]*>9</));
});

describe("kit preview", () => {
  const h = html(<Kit />);
  it("shows every variant, every icon and the five input states", () => {
    for (const v of BUTTON_VARIANTS) expect(h).toContain(`>${v}</button>`);
    for (const n of ICON_NAMES) expect(h).toContain(`data-icon="${n}"`);
    for (const t of ["Passed check", "Blocked", "Error", "Disabled", "Toggle on", "Radio one"]) expect(h).toContain(t);
  });
});
