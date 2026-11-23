// The size budget of check.yml, run after `npm run check` has built the three apps: `node packages/ui/src/size-budget.ts`.
// Reads the prerendered stub page (.next/server/app/index.html), sums the gzip size of the scripts and the stylesheet it loads, and fails over budget.
// Measured 23 Nov 2026 with the kit in place: first-load JS 250 KB gzip (mostly React, Next and Sentry), CSS 5.6 KB gzip, in every app.
import { readFileSync } from "node:fs";
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

export const APPS = ["candidate", "portal", "admin"] as const;

/** Reads an app's build; a missing build throws. */
export function appBudget(app: string) {
  const next = path.join(import.meta.dirname, "../../../apps", app, ".next");
  const m = measure(next, readFileSync(path.join(next, "server/app/index.html"), "utf8"));
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
