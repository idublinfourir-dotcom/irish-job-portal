// The words of the content editor (frame D12). Pure. The kinds and type codes are the ones docs/openapi/admin.yaml lists for /api/content.
export const TABS = [["update", "Updates feed"], ["guide", "Guides"], ["help", "Help"], ["occupation", "Occupation pages"], ["stale", "Not checked lately"]] as const;
export type Tab = (typeof TABS)[number][0];
export type Kind = "update" | "guide" | "help" | "occupation";
export const isTab = (v: string | undefined): v is Tab => TABS.some(([k]) => k === v);
export const KIND_WORD: Record<Kind, string> = { update: "update", guide: "guide", help: "help page", occupation: "occupation page" };
export const CATEGORIES: Record<Kind, [string, string][]> = {
  update: [["salary_minimums", "Salary minimums"], ["quotas", "Quotas"], ["occupation_lists", "Occupation lists"], ["processing", "Processing"]],
  help: [["report_problem", "Report a problem"], ["permit_services", "Permit services"], ["jobs_badges", "Jobs and badges"], ["account", "Account"]],
  guide: [], occupation: [],
};
export const categoryLabel = (c: string | null): string => [...CATEGORIES.update, ...CATEGORIES.help].find(([k]) => k === c)?.[1] ?? "";
export const STATE: Record<string, { label: string; tone: "peach" | "green" | "neutral" }> = { draft: { label: "Draft", tone: "peach" }, published: { label: "Published", tone: "green" }, withdrawn: { label: "Withdrawn", tone: "neutral" } };
export const BODY_MAX = 50_000;
export const TITLE_MAX = 200;

const DAY = new Intl.DateTimeFormat("en-IE", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
/** A `YYYY-MM-DD` day as "9 Nov 2026", or a dash for none. */
export const dayText = (d: string | null | undefined): string => (d && /^\d{4}-\d\d-\d\d$/.test(d) ? DAY.format(new Date(`${d}T00:00:00Z`)) : "-");
/** Whole days from a `YYYY-MM-DD` day to `now`. */
export const daysSince = (d: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - new Date(`${d}T00:00:00Z`).getTime()) / 864e5));
/** The address part for a new page from its title: lower-case letters, digits and hyphens, at most 100 characters (the route's rule). */
export const slugOf = (title: string): string => title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100).replace(/-+$/, "");
/** Who may publish a kind: a content editor help and updates, a rules data editor guides and occupation pages. */
export const publisherRole = (kind: string): string => (kind === "help" || kind === "update" ? "content_editor" : "rules_data_editor");
