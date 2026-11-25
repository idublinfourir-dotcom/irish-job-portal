// The account pages' presentational parts rendered to HTML with fixture props for every state (no database, no network). Frames NA1, A04, A05, NA2, M07.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/account" }));
const NOW = new Date("2026-11-25T12:00:00Z");
const h = (el: Parameters<typeof html>[0]) => html(el);
const FORBIDDEN = ["Launch B", "Contact requests", "Visibility", "Profile hidden", "Sample", "% complete", "updates since", "Robin", "handler"];
const clean = (s: string) => { for (const w of FORBIDDEN) expect(s, w).not.toContain(w); expect(s).not.toMatch(/[–—]/); expect(s).not.toContain("dangerouslySetInnerHTML"); return s; };

const saved = (o: object) => ({ jobId: "1", title: "Fake Nurse", employerName: "Fake Care Ltd", county: "Cork", salaryLow: 38000, salaryHigh: 45000, salaryLine: "€38,000 to €45,000", badge: "critical_skills_eligible", passRoute: "stated_pay", live: true, reason: null, savedAt: "2026-11-20T10:00:00Z", postedAt: "2026-11-24T10:00:00Z", ...o });
const alert = (o: object) => ({ id: "31", occupationCode: "2231", sector: "health", county: "Cork", salaryMin: 32691, badge: null, frequency: "daily", status: "active", pauseReason: null, lastSentAt: "2026-11-24T10:00:00Z", ...o });
const tr = (o: object) => ({ jobId: "7", title: "Fake Chef", employerName: "Fake Hotel", county: "Kerry", live: true, reason: null, route: "redirect", stage: "applied", updatedAt: "2026-11-23T10:00:00Z", ...o });
const occ = [{ code: "2231", title: "Fake nurse" }];

describe("saved jobs (A04)", () => {
  it("lists live and closed jobs, closed with title, employer and the reason only", async () => {
    const { SavedView } = await import("./saved/view");
    const out = clean(h(<SavedView saved={[saved({}), saved({ jobId: "2", title: "Fake Radiographer", live: false, reason: "no_longer_available", salaryLine: undefined, badge: undefined })]} show="" now={NOW} />));
    expect(out).toContain("2 saved");
    expect(out).toContain("This job has closed");
    expect(out).toContain("See similar jobs");
    expect(out).toContain("View job");
    expect(out.match(/<h1/g)).toHaveLength(1);
  });
  it("filters by the address: open, closed", async () => {
    const { SavedView } = await import("./saved/view");
    const rows = [saved({}), saved({ jobId: "2", title: "Fake Closed", live: false, reason: "under_review" })];
    expect(h(<SavedView saved={rows} show="open" now={NOW} />)).not.toContain("Fake Closed");
    const closed = h(<SavedView saved={rows} show="closed" now={NOW} />);
    expect(closed).toContain("Fake Closed");
    expect(closed).toContain("under review");
    expect(closed).not.toContain("Fake Nurse");
  });
  it("empty state, and the limit notice at 200", async () => {
    const { SavedView } = await import("./saved/view");
    expect(clean(h(<SavedView saved={[]} show="" now={NOW} />))).toContain("No saved jobs yet");
    const many = Array.from({ length: 200 }, (_, i) => saved({ jobId: String(i + 1) }));
    expect(h(<SavedView saved={many} show="" now={NOW} />)).toContain("most we keep");
  });
});

describe("job alerts (A05)", () => {
  it("shows the alerts with their filters, an edit link in the address of the alert email, and the builder with exactly the route's filters", async () => {
    const { AlertsView } = await import("./alerts/view");
    const out = clean(h(<AlertsView alerts={[alert({})]} occupations={occ} edit={null} now={NOW} />));
    expect(out).toContain("Fake nurse, Cork");
    expect(out).toContain("From €32,691");
    expect(out).toContain("Both badges");
    expect(out).toContain('href="/account/alerts?edit=31#new-alert"');
    for (const name of ["occupationCode", "sector", "county", "salaryMin", "badge", "frequency"]) expect(out).toContain(`name="${name}"`);
    expect(out.match(/<select/g)).toHaveLength(3); // one occupation, one sector, one county
    expect(out.match(/name="badge"/g)).toHaveLength(3);
    expect(out).toContain("New alert");
  });
  it("edit fills the form; a missing alert says so", async () => {
    const { AlertsView } = await import("./alerts/view");
    const out = h(<AlertsView alerts={[alert({})]} occupations={occ} edit={alert({ county: "Kerry", frequency: "weekly" }) as never} now={NOW} />);
    expect(out).toContain("Edit alert");
    expect(out).toMatch(/<option value="Kerry" selected/);
    expect(h(<AlertsView alerts={[]} occupations={occ} edit="missing" now={NOW} />)).toContain("That alert no longer exists");
  });
  it("a Stamp 4 pause is worded and the switch is off; at 10 alerts the builder is switched off with a notice", async () => {
    const { AlertsView } = await import("./alerts/view");
    const out = h(<AlertsView alerts={[alert({ status: "paused", pauseReason: "stamp_4" })]} occupations={occ} edit={null} now={NOW} />);
    expect(out).toContain("Paused: Stamp 4");
    expect(out).toContain("Stamp 4");
    expect(out).not.toMatch(/role="switch"[^>]* checked=""/);
    const ten = Array.from({ length: 10 }, (_, i) => alert({ id: String(i + 1) }));
    const full = h(<AlertsView alerts={ten} occupations={occ} edit={null} now={NOW} />);
    expect(full).toContain("most we allow");
    expect(full).toMatch(/<button[^>]*disabled[^>]*>Create alert/);
  });
  it("empty state", async () => {
    const { AlertsView } = await import("./alerts/view");
    expect(h(<AlertsView alerts={[]} occupations={occ} edit={null} now={NOW} />)).toContain("No alerts yet");
  });
});

describe("applications (NA2, M07)", () => {
  const view = async (rows: object[], extra: object = {}) => {
    const { ApplicationsView } = await import("./applications/view");
    return clean(h(<ApplicationsView tracked={rows as never} count={rows.length} saved={[]} savedCount={0} alerts={[]} titleOf={() => undefined} now={NOW} {...extra} />));
  };
  it("groups by stage with no tabs, and puts closed, not selected and withdrawn rows apart", async () => {
    const out = await view([tr({}), tr({ jobId: "8", stage: "offer" }), tr({ jobId: "9", stage: "rejected", title: "Fake Rejected" }), tr({ jobId: "10", live: false, reason: "no_longer_available", title: "Fake Gone" })]);
    expect(out).toContain('aria-label="Applied"');
    expect(out).toContain('aria-label="Offer"');
    expect(out).not.toContain('role="tab"');
    expect(out).toContain("Closed and not selected");
    expect(out).toMatch(/Fake Rejected[\s\S]*Not selected/);
    expect(out).toMatch(/Fake Gone[\s\S]*This job has closed/);
    expect(out).toContain("Withdraw from list");
    expect(out).toContain("Start a permit request");
    expect(out).toContain("A click alone never counts");
  });
  it("an on-site row cannot be moved by hand; the empty state; the cap line", async () => {
    expect(await view([tr({ route: "on_site" })])).toContain("cannot move this one yourself");
    expect(await view([])).toContain("No applications yet");
    expect(await view([tr({})], { count: 250 })).toContain("most recent of 250");
  });
});

describe("updates (DD34)", () => {
  it("words each notice from its key, marks the unseen, counts the unseen on the page and never prints params", async () => {
    const { NoticesView } = await import("./notices/view");
    const items = [{ id: "1", category: "account", templateKey: "case_update", createdAt: "2026-11-24T10:00:00Z", readAt: null, params: { secret: "STAFF NOTE" } }, { id: "2", category: "account", templateKey: "brand_new_key", createdAt: "2026-11-20T10:00:00Z", readAt: "2026-11-21T10:00:00Z" }];
    const out = clean(h(<NoticesView items={items} next="abc" first={false} />));
    expect(out).toContain("Your case has an update");
    expect(out).toContain("You have an update");
    expect(out).toContain("1 unseen on this page");
    expect(out).toContain("Mark all as read");
    expect(out).toContain("24 November 2026");
    expect(out).toContain('href="/account/notices?after=abc"');
    expect(out).toContain('href="/account/notices"');
    expect(out).not.toContain("STAFF NOTE");
  });
  it("empty state", async () => {
    const { NoticesView } = await import("./notices/view");
    expect(h(<NoticesView items={[]} next={null} first />)).toContain("No updates yet");
  });
});

describe("home (NA1)", () => {
  const base = { name: "Alex Example", saved: 3, alerts: 1, applications: 5, tracked: [{ jobId: "7", title: "Fake Chef", employerName: "Fake Hotel", stage: "applied" }], prompt: null, permitCase: null, updates: [] };
  it("greets by the hour in Ireland, shows the three counts and none of the cut parts", async () => {
    const { HomeView, greeting } = await import("./home");
    expect(greeting(new Date("2026-11-25T09:00:00Z"))).toBe("Good morning");
    expect(greeting(new Date("2026-11-25T15:00:00Z"))).toBe("Good afternoon");
    expect(greeting(new Date("2026-11-25T20:00:00Z"))).toBe("Good evening");
    const out = clean(h(<HomeView d={base} now={NOW} />));
    expect(out).toContain("Alex");
    expect(out).not.toContain("Example");
    expect(out).toMatch(/Saved jobs/);
    expect(out).toContain("Fake Chef");
    expect(out).not.toContain("New from your alerts");
    expect(out.match(/<h1/g)).toHaveLength(1);
  });
  it("the Did you apply ask, an open permit case with documents, and the empty parts", async () => {
    const { HomeView } = await import("./home");
    const out = h(<HomeView d={{ ...base, name: null, saved: null, tracked: [], prompt: { clickId: "5", title: "Fake Radiographer", employerName: "Fake Hospital", clickedAt: "2026-11-24T10:00:00Z" }, permitCase: { id: "9", status: "documents_needed", decisionOutcome: null, permitType: "critical_skills", jobTitle: "Fake Radiographer", employerName: "Fake Hospital", payer: "employer", documentsNeeded: [{ code: "passport", label: "Passport copy" }], documentCount: 0 }, updates: [{ id: "1", templateKey: "case_update", createdAt: "2026-11-24T10:00:00Z", readAt: null }] }} now={NOW} />);
    expect(out).toContain("Did you apply for Fake Radiographer at Fake Hospital?");
    expect(out).toContain("Yes, I applied");
    expect(out).toContain("Not yet");
    expect(out).toContain("Passport copy");
    expect(out).toContain("Your employer is paying the fee");
    expect(out).toContain('href="/account/cases/9"');
    expect(out).toContain("Nothing tracked yet");
    expect(out).toContain("Your case has an update");
  });
});
