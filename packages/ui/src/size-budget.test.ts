// Performance: the size budget of the three stub pages. The measuring logic is checked on fake files; the real budget runs when the apps are built
// (check.yml runs `node packages/ui/src/size-budget.ts` after the build; here it runs if a build is present).
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APPS, appBudget, BUDGET, measure, overBudget } from "./size-budget";

describe("measure", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "budget-"));
  mkdirSync(path.join(dir, "static/chunks"), { recursive: true });
  writeFileSync(path.join(dir, "static/chunks/a.js"), "x".repeat(10_000));
  writeFileSync(path.join(dir, "static/chunks/a.css"), "y".repeat(1_000));
  const html = '<link href="/_next/static/chunks/a.css"/><script src="/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/a.js"></script>';
  it("counts each file once and reads js and css", () => {
    const m = measure(dir, html);
    expect(m).toMatchObject({ jsFiles: 1, cssFiles: 1, cssRaw: 1_000 });
    expect(m.jsGzip).toBeLessThan(200);
  });
  it("fails over budget and when there is no stylesheet", () => {
    const base = { jsGzip: 1, cssGzip: 1, cssRaw: 1, jsFiles: 1, cssFiles: 1 };
    expect(overBudget(base)).toEqual([]);
    expect(overBudget({ ...base, jsGzip: BUDGET.jsGzipBytes + 1 })).toHaveLength(1);
    expect(overBudget({ ...base, cssGzip: BUDGET.cssGzipBytes + 1, cssRaw: BUDGET.cssRawBytes + 1 })).toHaveLength(2);
    expect(overBudget({ ...base, cssFiles: 0 })).toHaveLength(1);
  });
});

describe.each(APPS)("%s build", (app) => {
  const built = existsSync(path.join(import.meta.dirname, "../../../apps", app, ".next/build-manifest.json"));
  it.skipIf(!built)("stays within the shared CSS and first-load JS budget", () => {
    expect(appBudget(app).problems).toEqual([]);
  });
});
