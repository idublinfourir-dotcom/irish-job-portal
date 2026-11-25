// Performance (check 5), P20: the first-load JavaScript and the stylesheet of the permit services pages stay inside F1's size budget (packages/ui/src/size-budget.ts). Reads the build
// (`next build` in apps/portal), so it is skipped when there is none; add this file to test:size at the combine. A page's load is the polyfills, the root files, and the chunks of the layout and of the page.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUDGET, measure, overBudget } from "../../packages/ui/src/size-budget";

const next = path.join(import.meta.dirname, ".next");
const ROUTES = ["services", "services/[id]", "services/request"];
const built = ROUTES.every((r) => existsSync(path.join(next, "server/app", r, "page_client-reference-manifest.js"))); // a build from before these pages exist skips the test

function pageHtml(route: string): string {
  const read = (f: string) => readFileSync(path.join(next, f), "utf8");
  const build = JSON.parse(read("build-manifest.json")) as { polyfillFiles: string[]; rootMainFiles: string[] };
  const ref = read(`server/app/${route ? `${route}/` : ""}page_client-reference-manifest.js`);
  const key = `(?:layout|${(route ? `${route}/` : "").replace(/[()]/g, "\\$&")}page)`;
  const js = [...build.polyfillFiles, ...build.rootMainFiles, ...[...ref.matchAll(new RegExp(`app\\/${key}":\\[("static[^\\]]*)\\]`, "g"))].flatMap((m) => m[1]!.match(/static\/[^"]+\.js/g) ?? [])];
  const css = [...ref.matchAll(new RegExp(`app\\/${key}":\\[(\\{[^\\]]*)\\]`, "g"))].flatMap((m) => m[1]!.match(/static\/[^"]+\.css/g) ?? []);
  return [...js.map((f) => `<script src="/_next/${f}">`), ...css.map((f) => `<link href="/_next/${f}">`)].join("");
}

describe.skipIf(!built)("first-load size of the P20 pages", () => {
  it.each(ROUTES)("/%s is inside the JS and CSS budget", (route) => {
    const m = measure(next, pageHtml(route));
    console.log(`P20 /${route}: JS ${m.jsGzip} gzip in ${m.jsFiles} files, CSS ${m.cssGzip} gzip`);
    expect(overBudget(m)).toEqual([]);
    expect(m.jsGzip).toBeLessThanOrEqual(BUDGET.jsGzipBytes);
  });
});
