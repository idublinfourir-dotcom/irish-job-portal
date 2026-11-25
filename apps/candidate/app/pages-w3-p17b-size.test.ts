// P17 part 2 (profile, settings, delete, goodbye), performance: the first-load JavaScript of each page, from the build's own manifests (the root files, the layout's files and the page's files,
// each counted once, gzip), against the shared budget of packages/ui/src/size-budget.ts. Runs when the app has been built (`npm run build -w @portal/candidate`;
// `npm run check` runs it again after the build, test:size), skipped otherwise. Measured 25 November 2026 on the production build: see the line it prints.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BUDGET } from "../../../packages/ui/src/size-budget";

const NEXT = path.join(import.meta.dirname, "../.next");
const ROUTES = ["account/profile", "account/settings", "account/settings/delete", "account-deleted"];
const built = ROUTES.every((r) => existsSync(path.join(NEXT, "server/app", r, "page_client-reference-manifest.js")));

function firstLoadJs(route: string): number {
  const read = (f: string) => readFileSync(path.join(NEXT, f), "utf8");
  const build = JSON.parse(read("build-manifest.json")) as { polyfillFiles: string[]; rootMainFiles: string[] };
  const ref = read(`server/app/${route}/page_client-reference-manifest.js`);
  const entries: Record<string, string[]> = JSON.parse(/"entryJSFiles":(\{.*?\})\}?;?\s*$/s.exec(ref)?.[1] ?? "{}");
  const files = new Set([...build.polyfillFiles, ...build.rootMainFiles, ...Object.entries(entries).filter(([k]) => k.endsWith("/app/layout") || k.endsWith(`/app/${route}/page`)).flatMap(([, v]) => v)]);
  return [...files].filter((f) => f.endsWith(".js")).reduce((n, f) => n + gzipSync(readFileSync(path.join(NEXT, f))).length, 0);
}

describe.skipIf(!built)("first-load JS of the profile, settings, delete and goodbye pages", () => {
  it("each page is within the shared first-load budget", () => {
    const sizes = Object.fromEntries(ROUTES.map((r) => [r, firstLoadJs(r)])); // in the test, not the describe: a skipped describe still runs its body
    process.stdout.write(`P17b first-load JS (gzip bytes): ${JSON.stringify(sizes)}\n`);
    for (const [route, size] of Object.entries(sizes)) {
      expect(size, route).toBeGreaterThan(100_000); // the measure found the files
      expect(size, route).toBeLessThanOrEqual(BUDGET.jsGzipBytes);
    }
  });
});
