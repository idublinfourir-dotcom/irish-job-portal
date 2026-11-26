// The data layer wall (nextjs.org/docs/app/guides/data-security): a page, layout or other non-route file under apps/*/app/ may not read the
// database itself, or it would skip the visitor cap and the read limit of gatedRead. It reads through its app's lib/data.ts. From @portal/db such
// a file may take types (they carry no data) and only the plain constants below; anything else, a namespace import, a re-export, a subpath, a
// dynamic import or require, or a relative path into packages/db, fails. Route handlers (route.ts) go through publicRead and are not checked here.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// constants, and the body format's pure parser (B16: reads no database, `_content/body.tsx`)
const ALLOWED = new Set(["VISITOR_JOBS", "PAGE_SIZE", "UPDATES_PAGE", "SITEMAP_URLS", "parseBody", "firstParagraph"]);
const ROOT = join(import.meta.dirname, "../../..");

/** Every bad import in one file's text: a short line per problem. */
function badImports(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/\b(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    const [, verb, typeOnly, clause, from] = m as unknown as [string, string, string | undefined, string, string];
    if (/(^|\/)packages\/db(\/|$)/.test(from) || /^@portal\/db\//.test(from)) { bad.push(`${from}: not through @portal/db`); continue; }
    if (from !== "@portal/db" || typeOnly) continue;
    if (verb === "export") { bad.push(`re-export from ${from}`); continue; }
    const named = /\{([^}]*)\}/.exec(clause);
    if (!named || clause.replace(named[0], "").replace(/[\s,]/g, "") !== "") { bad.push(`${clause}: default or namespace import`); continue; }
    for (const part of named[1]!.split(",").map((p) => p.trim()).filter(Boolean)) {
      if (part.startsWith("type ")) continue;
      const name = part.split(/\s+as\s+/)[0]!;
      if (!ALLOWED.has(name)) bad.push(`${name}: not an allowed import`);
    }
  }
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*["'`]([^"'`]*)["'`]/g)) if (/@portal\/db|packages\/db/.test(m[1]!)) bad.push(`dynamic ${m[1]}`);
  if (/\bimport\s+["']@portal\/db/.test(text)) bad.push("side-effect import of @portal/db");
  return bad;
}

const appFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? appFiles(join(dir, e.name)) : /\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/^route\.[jt]s$/.test(e.name) ? [join(dir, e.name)] : []));

describe("pages read through the data layer only", () => {
  it("no non-route file under apps/*/app/ imports a database reader or the pool", () => {
    const files = readdirSync(join(ROOT, "apps"), { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
      try { return appFiles(join(ROOT, "apps", d.name, "app")); } catch { return []; }
    });
    expect(files.some((f) => f.endsWith("sitemap.ts"))).toBe(true); // the walk sees the files
    const found = files.flatMap((f) => badImports(readFileSync(f, "utf8")).map((b) => `${relative(ROOT, f)}: ${b}`));
    expect(found).toEqual([]);
  });
  it("fails on a planted bad import of each kind, and lets types, the allowed constants and the data layer through", () => {
    const planted = [
      'import { listJobs } from "@portal/db";', 'import { getPool, VISITOR_JOBS } from "@portal/db";', "import { getJob as j } from '@portal/db';",
      'import * as db from "@portal/db";', 'import db from "@portal/db";', 'export { getHelp } from "@portal/db";', 'export * from "@portal/db";',
      'import { staffTools } from "@portal/db/staff-tools";', 'import { listUpdates } from "../../../packages/db/src/content";',
      'const db = await import("@portal/db");', 'const db = require("@portal/db");', 'import "@portal/db";',
      'import {\n  type JobCard,\n  similarLiveJobs,\n} from "@portal/db";', 'import { checkWithSiteLists, getCompanyPage, getOccupationPage, getGuide } from "@portal/db"',
      'import { legalRead, legalInForce } from "@portal/db";',
    ];
    for (const text of planted) expect(badImports(text), text).not.toEqual([]);
    for (const text of [
      'import type { JobCard } from "@portal/db";', 'import { type ReadResult, VISITOR_JOBS } from "@portal/db";', 'import { readJobs } from "../lib/data";',
      'import { jobPath } from "../lib/paths";', 'import type { MetadataRoute } from "next";',
    ]) expect(badImports(text), text).toEqual([]);
  });
});
