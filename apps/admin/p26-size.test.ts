// Performance (check 5): the first-load JavaScript and the stylesheet of the two services pages (P26) stay inside F1's size budget (packages/ui/src/size-budget.ts). Reads the build
// (`next build` in apps/admin), so it is skipped when there is none. The combine adds this file to `test:size`.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUDGET, measure, overBudget } from "../../packages/ui/src/size-budget";

const next = path.join(import.meta.dirname, ".next");
const built = existsSync(path.join(next, "build-manifest.json"));
const ROUTES = ["services", "services/[id]"];

function pageHtml(route: string): string {
  const read = (f: string) => readFileSync(path.join(next, f), "utf8");
  const build = JSON.parse(read("build-manifest.json")) as { polyfillFiles: string[]; rootMainFiles: string[] };
  const ref = read(`server/app/${route}/page_client-reference-manifest.js`);
  const key = `(?:layout|${route.replace(/[()[\]]/g, "\\$&")}\\/page)`;
  const js = [...build.polyfillFiles, ...build.rootMainFiles, ...[...ref.matchAll(new RegExp(`app\\/${key}":\\[("static[^\\]]*)\\]`, "g"))].flatMap((m) => m[1]!.match(/static\/[^"]+\.js/g) ?? [])];
  const css = [...ref.matchAll(new RegExp(`app\\/${key}":\\[(\\{[^\\]]*)\\]`, "g"))].flatMap((m) => m[1]!.match(/static\/[^"]+\.css/g) ?? []);
  return [...js.map((f) => `<script src="/_next/${f}">`), ...css.map((f) => `<link href="/_next/${f}">`)].join("");
}

describe.skipIf(!built)("first-load size of the P26 pages", () => {
  it.each(ROUTES)("/%s is inside the JS and CSS budget", (route) => {
    const m = measure(next, pageHtml(route));
    console.log(`P26 /${route}: JS ${m.jsGzip} gzip in ${m.jsFiles} files, CSS ${m.cssGzip} gzip`);
    expect(overBudget(m)).toEqual([]);
    expect(m.jsGzip).toBeLessThanOrEqual(BUDGET.jsGzipBytes);
  });
});
