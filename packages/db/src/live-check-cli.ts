// G5 part 2, the launch check of the rendered public pages: `node packages/db/src/live-check-cli.ts [report.md]`.
// Reads the public pages of the three live sites the way a visitor gets them and fails (exit 1) on what a visitor would see wrong: a page
// that is not 200, a test or local address in a link, a canonical off the page's own site, placeholder words or raw Markdown in the text.
// It is EXPECTED to fail until the legal texts are published, so it never runs in `npm run check`; only its tests do.
// GET only, one request per 1.1 s, at most 120 requests, no redirect followed to another origin. It never opens a job page (/jobs/<job>):
// each render writes a view row on live (apps/candidate/app/jobs/[job]/page.tsx, after()); those links are counted only.
// The Vercel bypass secret of each site is read from its file at run time and sent only to that site; it is never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type Site = { origin: string; secretFile: string; paths: string[]; notFound?: string[] };
export type Page = { url: string; status: number; fails: string[]; notes: string[] };
export type Result = { pages: Page[]; requests: number; jobLinks: number; leftOver: string[] };

const cfg = (f: string) => path.join(homedir(), ".config/portal", f);
// The public routes; notFound are the pages that must answer 404 in production (the style kit, a made-up path, absent files).
export const SITES: Site[] = [
  {
    origin: "https://www.irishworkpermit.ie",
    secretFile: cfg("vercel-bypass-candidate"),
    paths: ["/", "/jobs", "/guides", "/help", "/updates", "/cookies", "/data-request", "/data-retention", "/eligibility-checker",
      "/employer-acceptable-use", "/login", "/signup", "/reset", "/verify", "/permit-services", "/permit-services/request", "/privacy",
      "/terms", "/report", "/employers", "/account-deleted", "/unsubscribe", "/robots.txt", "/sitemap-index.xml"],
    notFound: ["/kit", "/sitemap.xml", "/no-such-page-g5"],
  },
  {
    origin: "https://employers.irishworkpermit.ie",
    secretFile: cfg("vercel-bypass-portal"),
    paths: ["/", "/sign-in", "/sign-up", "/sign-up/account", "/sign-up/agency", "/sign-up/claim", "/sign-up/first-time", "/forgot-password",
      "/reset-password", "/verify-email", "/help", "/privacy", "/terms", "/data-request"],
    notFound: ["/kit", "/robots.txt", "/no-such-page-g5"],
  },
  { origin: "https://admin.irishworkpermit.ie", secretFile: cfg("vercel-bypass"), paths: ["/"], notFound: ["/kit", "/robots.txt"] },
];

export const PACE_MS = 1100;
export const MAX_REQUESTS = 120;
const MAX_HOPS = 3;
const JOB_PAGE = /^\/jobs\/[^/]+/;
const SKIP = /^\/(_next|api)\/|\.(png|jpe?g|svg|ico|webp|gif|woff2?|css|js|json|webmanifest|txt|xml|pdf)$/i;
const BAD_URL = /localhost|127\.0\.0\.1|example\.com|vercel\.app|\.invalid\b|staging|^http:\/\//i;
const BAD_TEXT = /placeholder|not published yet|coming soon|lorem|no updates here yet|\*\*|^#{1,6} |\]\(/im;
// The one decided "coming soon" (#307, 27 Nov 2026): the services price line. Any other "coming soon" still fails.
export const PRICES_SOON = "Prices and invoices: coming soon.";
// Every pattern below is linear on hostile input: no class can run past the next quote or angle bracket, and the tag strip is indexOf based.
const ATTR = /\b(href|src|action|content)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/gi;
const CANONICAL = /<link\b[^<>]*\brel\s*=\s*["']?canonical\b[^<>]*>/gi;
const HREF = /\bhref\s*=\s*["']([^"'<>]*)["']/i;

/** The text a visitor reads: the body without scripts, styles, templates and comments, tags turned to spaces, one line per block. */
export function visibleText(html: string): string {
  const start = html.indexOf("<body");
  const end = html.lastIndexOf("</body>");
  let b = start >= 0 ? html.slice(start, end > start ? end : undefined) : html;
  for (const [open, close] of [["<script", "</script>"], ["<style", "</style>"], ["<template", "</template>"], ["<!--", "-->"]] as const) {
    let out = "";
    let i = 0;
    for (let j = b.indexOf(open, i); j >= 0; j = b.indexOf(open, i)) {
      out += b.slice(i, j) + " ";
      const k = b.indexOf(close, j + open.length);
      i = k < 0 ? b.length : k + close.length; // unclosed: the rest is dropped
    }
    b = out + b.slice(i);
  }
  return b
    .replace(/<br\b[^<>]*>|<\/(?:p|li|h\d|div|td|th|tr)\s*>/gi, "\n")
    .replace(/<[^<>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&")
    .split("\n").map((l) => l.replace(/[ \t\r]+/g, " ").trim()).filter(Boolean).join("\n");
}

/** Judge one HTML page: what is wrong (fails) and the same-origin page links to read next (relative links resolved, query and hash dropped). */
export function judge(html: string, pageUrl: string): { fails: string[]; links: string[] } {
  const own = new URL(pageUrl).origin;
  const fails = new Set<string>();
  const links = new Set<string>();
  for (const m of html.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase();
    const value = (m[2] ?? m[3] ?? "").trim();
    if (name === "content" && !value.includes("://")) continue; // meta content that is not an address (viewport, robots)
    if (BAD_URL.test(value)) fails.add(`bad address in ${name}: ${value.slice(0, 120)}`);
    if (name !== "href") continue;
    let u: URL;
    try { u = new URL(value, pageUrl); } catch { continue; }
    if (u.origin === own && !SKIP.test(u.pathname)) links.add(u.origin + u.pathname);
  }
  for (const tag of html.match(CANONICAL) ?? []) {
    const href = tag.match(HREF)?.[1] ?? "";
    let origin = "";
    try { origin = new URL(href, pageUrl).origin; } catch { /* reported below */ }
    if (origin !== own) fails.add(`canonical not on ${own}: ${href.slice(0, 120)}`);
  }
  for (const line of visibleText(html).split("\n")) if (BAD_TEXT.test(line.replace(PRICES_SOON, ""))) fails.add(`text: ${line.slice(0, 120)}`);
  return { fails: [...fails], links: [...links] };
}

type Deps = { fetch: typeof fetch; sleep: (ms: number) => Promise<unknown>; pace?: number; cap?: number };

/** Read the sites: the seeds first, then same-origin links, paced, capped, GET only, never a job page or another origin. */
export async function crawl(sites: Site[], secrets: Map<string, string>, deps: Deps): Promise<Result> {
  const pace = deps.pace ?? PACE_MS;
  const cap = deps.cap ?? MAX_REQUESTS;
  const notFound = new Set(sites.flatMap((s) => (s.notFound ?? []).map((p) => s.origin + p)));
  const queue = sites.flatMap((s) => [...s.paths, ...(s.notFound ?? [])].map((p) => s.origin + p));
  const seen = new Set<string>();
  const jobLinks = new Set<string>();
  const pages: Page[] = [];
  let requests = 0;
  const get = async (url: string) => {
    if (requests > 0) await deps.sleep(pace);
    requests++;
    const origin = new URL(url).origin;
    try {
      const r = await deps.fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { "x-vercel-protection-bypass": secrets.get(origin) ?? "", "user-agent": "portal-live-check" },
        signal: AbortSignal.timeout(30_000),
      });
      return { status: r.status, location: r.headers.get("location"), type: r.headers.get("content-type") ?? "", body: await r.text() };
    } catch (e) {
      return { status: 0, location: null, type: "", body: "", error: (e as Error).name }; // the name only: no message can carry a header
    }
  };
  while (queue.length && requests < cap) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    if (JOB_PAGE.test(new URL(url).pathname)) { jobLinks.add(new URL(url).pathname); continue; } // even as a seed
    const page: Page = { url, status: 0, fails: [], notes: [] };
    pages.push(page);
    let at = url;
    let r = await get(at);
    for (let hops = 0; r.status >= 300 && r.status < 400; hops++) {
      const to = new URL(r.location ?? "", at);
      if (hops === MAX_HOPS) { page.fails.push("too many redirects"); break; }
      if (to.origin !== new URL(at).origin) {
        if (sites.some((s) => s.origin === to.origin)) page.notes.push(`redirects to ${to.origin}${to.pathname} (other site, not followed)`);
        else page.fails.push(`redirects off our sites to ${to.origin} (not followed)`);
        break;
      }
      if (JOB_PAGE.test(to.pathname)) { jobLinks.add(to.pathname); page.notes.push("redirects to a job page (not followed)"); break; }
      if (requests >= cap) { page.notes.push("redirect not followed: request cap reached"); break; }
      page.notes.push(`${r.status} to ${to.pathname}`);
      at = to.origin + to.pathname + to.search;
      seen.add(to.origin + to.pathname);
      r = await get(at);
    }
    page.status = r.status;
    if (r.status >= 300 && r.status < 400) continue;
    if (notFound.has(url)) {
      if (r.status === 404) page.notes.push("404 as expected");
      else page.fails.push(`expected 404, got ${r.status}`);
      continue;
    }
    if (r.status !== 200) {
      page.fails.push(r.status === 0 ? `network error (${"error" in r ? r.error : "unknown"})` : `status ${r.status}`);
      continue;
    }
    if (!r.type.includes("html")) {
      for (const u of r.body.match(/https?:\/\/[^\s<>"']+/g) ?? []) if (BAD_URL.test(u) && !u.startsWith("http://www.sitemaps.org/schemas/")) page.fails.push(`bad address: ${u.slice(0, 120)}`);
      continue;
    }
    const j = judge(r.body, at);
    page.fails.push(...j.fails);
    for (const l of j.links) {
      const p = new URL(l).pathname;
      if (JOB_PAGE.test(p)) jobLinks.add(p);
      else if (!seen.has(l) && !queue.includes(l)) queue.push(l);
    }
  }
  return { pages, requests, jobLinks: jobLinks.size, leftOver: queue.filter((u) => !seen.has(u)) };
}

/** The Markdown report: each failing page and why, what was not checked, and a one-line total. */
export function report(r: Result): string {
  const failing = r.pages.filter((p) => p.fails.length);
  const out = ["# Live check of the public pages", ""];
  for (const p of failing) out.push(`- FAIL ${p.url} (${p.status})`, ...p.fails.map((f) => `  - ${f}`));
  if (!failing.length) out.push("No failing page.");
  out.push(
    "",
    "- Job markup (JSON-LD): not checked here; it is tested in packages/db/test/job-pages.test.ts.",
    `- Job pages seen, not opened (each render writes a view): ${r.jobLinks}.`,
    `- Expected 404s: ${r.pages.filter((p) => p.notes.includes("404 as expected")).length}. Redirects to the other site, not followed: ${r.pages.filter((p) => p.notes.some((n) => n.includes("other site"))).length}.`,
    ...r.pages.flatMap((p) => p.notes.filter((n) => n.includes("other site")).map((n) => `  - ${p.url} ${n}`)),
    `- Left unread (request cap ${MAX_REQUESTS}): ${r.leftOver.length}${r.leftOver.length ? `: ${r.leftOver.slice(0, 10).join(", ")}` : ""}.`,
    "",
    `Total: ${r.pages.length} pages read in ${r.requests} requests, ${failing.length} failing, ${r.leftOver.length} left unread.`,
  );
  return out.join("\n") + "\n";
}

/** The run: LIVE_CHECK_SITES (a JSON list of sites) replaces the three live sites, for a preview deployment or the tests. */
export async function main(argv: string[], env: NodeJS.ProcessEnv, deps: Deps, log: (l: string) => void): Promise<number> {
  const sites: Site[] = env.LIVE_CHECK_SITES ? JSON.parse(env.LIVE_CHECK_SITES) : SITES;
  const secrets = new Map<string, string>();
  for (const s of sites) {
    try { secrets.set(s.origin, readFileSync(s.secretFile, "utf8").trim()); } catch { log(`cannot read the bypass secret file for ${s.origin}`); return 2; }
  }
  const local = sites.every((s) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(s.origin).hostname));
  const r = await crawl(sites, secrets, { ...deps, pace: local ? deps.pace : PACE_MS }); // only a local test server may be read faster
  const text = report(r);
  if (argv[0]) writeFileSync(argv[0], text);
  log(argv[0] ? text.trimEnd().split("\n").at(-1)! : text.trimEnd());
  return r.pages.some((p) => p.fails.length) ? 1 : 0;
}

if (import.meta.main) {
  const pace = process.env.LIVE_CHECK_PACE_MS ? Math.max(Number(process.env.LIVE_CHECK_PACE_MS), 0) : PACE_MS; // honoured for loopback sites only (main)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  process.exit(await main(process.argv.slice(2), process.env, { fetch, sleep, pace }, (l) => console.log(l)));
}
