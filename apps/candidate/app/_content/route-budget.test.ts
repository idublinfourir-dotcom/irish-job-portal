// Performance (check 5): the first-load JavaScript of each page of P9 and P10, from the production build's manifests (the polyfills and root files, the layout's files, the page's files, each file
// once, gzip), against F1's budget (packages/ui/src/size-budget.ts: 275 000 bytes, the home page's own budget). Runs when the app has been built (`next build`), as F1's test does; the page's own
// weight over the home page is printed. Measured 24 Nov 2026 after P9 and P10 (gzip bytes): the pages that run no script of their own 248 005 (the shell alone), eligibility checker and occupation 255 015, help and report 252 124 (the contact form), company 256 986 (the report control). Budget for these pages: 262 000, about 5 KB over the largest.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BUDGET } from "../../../../packages/ui/src/size-budget";

const ROUTE_BUDGET = Math.min(BUDGET.jsGzipBytes, 262_000);

const NEXT = path.join(import.meta.dirname, "../../.next");
const built = existsSync(path.join(NEXT, "build-manifest.json"));
export const ROUTES: [string, string][] = [
  ["companies/[slug]", "companies/[slug]/page"], ["occupations/[slug]", "occupations/[slug]/page"], ["guides", "guides/page"], ["guides/[slug]", "guides/[slug]/page"], ["updates", "updates/page"],
  ["eligibility-checker", "eligibility-checker/page"], ["help", "help/page"], ["help/[slug]", "help/[slug]/page"], ["privacy", "privacy/page"], ["terms", "terms/page"], ["cookies", "cookies/page"],
  ["employer-acceptable-use", "employer-acceptable-use/page"], ["data-retention", "data-retention/page"], ["report", "report/page"],
];

/** The JSON object that starts at `from` (a `{`), by matching braces. */
function braced(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  throw new Error("unbalanced manifest");
}

function firstLoadJs(dir: string): number {
  const read = (f: string) => readFileSync(path.join(NEXT, f), "utf8");
  const build = JSON.parse(read("build-manifest.json")) as { polyfillFiles: string[]; rootMainFiles: string[] };
  const ref = read(`server/app/${dir}_client-reference-manifest.js`);
  const entries = JSON.parse(braced(ref, ref.indexOf('"entryJSFiles":') + '"entryJSFiles":'.length)) as Record<string, string[]>;
  const mine = Object.entries(entries).filter(([k]) => k.endsWith("/app/layout") || k.endsWith(`/app/${dir}`)).flatMap(([, v]) => v);
  const files = [...new Set([...build.polyfillFiles, ...build.rootMainFiles, ...mine])];
  return files.reduce((n, f) => n + gzipSync(readFileSync(path.join(NEXT, f))).length, 0);
}

describe.skipIf(!built)("first-load JS of the content pages", () => {
  it("each page is inside the shared budget", () => {
    const sizes = ROUTES.map(([name, dir]) => [name, firstLoadJs(dir)] as const);
    console.log("first-load JS gzip:", sizes.map(([n, s]) => `${n} ${s}`).join("; "));
    for (const [name, size] of sizes) expect(size, name).toBeLessThanOrEqual(ROUTE_BUDGET);
  });
});
