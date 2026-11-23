// The size budget of check.yml, run after `npm run check` has built the three apps: `node packages/ui/src/size-budget.ts`.
// Reads the prerendered stub page (.next/server/app/index.html), or, when the layout reads the session and the page is dynamic (step 16 wave 1), the
// files the build manifests list for the home page (polyfills, root main files, the layout's and page's chunks and styles); sums the gzip size of the scripts and the stylesheet it loads, and fails over budget.
// Measured 23 Nov 2026 with the kit in place: first-load JS 250 KB gzip (mostly React, Next and Sentry), CSS 5.6 KB gzip, in every app.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const BUDGET = { jsGzipBytes: 275_000, cssGzipBytes: 8_000, cssRawBytes: 32_000 };

const gz = (b: Buffer) => gzipSync(b).length;

/** The sizes of what a page's HTML loads from `.next/static`. */
export function measure(nextDir: string, html: string) {
  const files = (ext: string) => [...new Set([...html.matchAll(new RegExp(`(?:src|href)="/_next/(static/[^"]+\\.${ext})"`, "g"))].map((m) => m[1]!))].map((f) => readFileSync(path.join(nextDir, f)));
  const js = files("js");
  const css = files("css");
  return { jsGzip: js.reduce((n, b) => n + gz(b), 0), cssGzip: css.reduce((n, b) => n + gz(b), 0), cssRaw: css.reduce((n, b) => n + b.length, 0), jsFiles: js.length, cssFiles: css.length };
}

export function overBudget(m: ReturnType<typeof measure>): string[] {
  const out: string[] = [];
  if (m.jsGzip > BUDGET.jsGzipBytes) out.push(`first-load JS ${m.jsGzip} bytes gzip, budget ${BUDGET.jsGzipBytes}`);
  if (m.cssGzip > BUDGET.cssGzipBytes) out.push(`CSS ${m.cssGzip} bytes gzip, budget ${BUDGET.cssGzipBytes}`);
  if (m.cssRaw > BUDGET.cssRawBytes) out.push(`CSS ${m.cssRaw} bytes raw, budget ${BUDGET.cssRawBytes}`);
  if (m.cssFiles === 0) out.push("no stylesheet found on the page");
  return out;
}

/** The HTML-shaped list of what the home page loads, from the build manifests, for an app whose home page is not prerendered. */
export function manifestHtml(nextDir: string): string {
  const read = (f: string) => readFileSync(path.join(nextDir, f), "utf8");
  const build = JSON.parse(read("build-manifest.json")) as { polyfillFiles: string[]; rootMainFiles: string[] };
  const ref = read("server/app/page_client-reference-manifest.js");
  // entryJSFiles lists plain paths, entryCSSFiles lists { path } objects; only the layout's and the page's entries count (not global-error's).
  const js = [...build.polyfillFiles, ...build.rootMainFiles, ...[...ref.matchAll(/app\/(?:layout|page)":\[("static[^\]]*)\]/g)].flatMap((m) => m[1]!.match(/static\/[^"]+\.js/g) ?? [])];
  const css = [...ref.matchAll(/app\/(?:layout|page)":\[(\{[^\]]*)\]/g)].flatMap((m) => m[1]!.match(/static\/[^"]+\.css/g) ?? []);
  return [...js.map((f) => `<script src="/_next/${f}">`), ...css.map((f) => `<link href="/_next/${f}">`)].join("");
}

export const APPS = ["candidate", "portal", "admin"] as const;

/** Reads an app's build; a missing build throws. */
export function appBudget(app: string) {
  const next = path.join(import.meta.dirname, "../../../apps", app, ".next");
  const page = path.join(next, "server/app/index.html");
  const m = measure(next, existsSync(page) ? readFileSync(page, "utf8") : manifestHtml(next));
  return { m, problems: overBudget(m) };
}

if (import.meta.main) {
  let failed = false;
  for (const app of APPS) {
    const { m, problems } = appBudget(app);
    console.log(`${app}: JS ${m.jsGzip} gzip in ${m.jsFiles} files, CSS ${m.cssGzip} gzip (${m.cssRaw} raw)`);
    for (const p of problems) console.error(`${app}: ${p}`);
    failed ||= problems.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
