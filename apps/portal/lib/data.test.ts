// The portal's data layer wall (B2), like apps/candidate/lib/page-imports.test.ts: a page, layout or other non-route file under apps/portal/app/ reads only
// through lib/data.ts. It may not import the database, the login package or the rules (types excepted), nor any other lib file (they hold the route logic and
// the database calls); a dynamic import, a require or a re-export of those fails too. No database: this reads the files' text.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const WALLED = /^@portal\/(db|auth|rules|matcher)(\/|$)|(^|\/)packages\/|(^|\/)lib\/(?!data$)/;

/** Every bad import in one file's text: a short line per problem. */
function badImports(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/\b(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    const [, , typeOnly, clause, from] = m as unknown as [string, string, string | undefined, string, string];
    if (WALLED.test(from) && !typeOnly && !/^\{\s*(type\s+[^,}]+,?\s*)+\}$/.test(clause.trim())) bad.push(`${from}: read through lib/data`);
  }
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*["'`]([^"'`]*)["'`]/g)) if (WALLED.test(m[1]!)) bad.push(`dynamic ${m[1]}`);
  for (const m of text.matchAll(/\bimport\s+["']([^"']+)["']/g)) if (WALLED.test(m[1]!)) bad.push(`side-effect import of ${m[1]}`);
  return bad;
}

const appFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? appFiles(join(dir, e.name)) : /\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/^route\.[jt]s$/.test(e.name) ? [join(dir, e.name)] : []));

describe("portal pages read through lib/data.ts only", () => {
  it("no non-route file under apps/portal/app/ imports a reader, the pool, the login package or another lib file", () => {
    const files = appFiles(join(ROOT, "app"));
    expect(files.some((f) => f.endsWith("layout.tsx"))).toBe(true); // the walk sees the files
    expect(files.flatMap((f) => badImports(readFileSync(f, "utf8")).map((b) => `${relative(ROOT, f)}: ${b}`))).toEqual([]);
  });
  it("fails on a planted bad import of each kind, and lets types and the data layer through", () => {
    for (const text of [
      'import { getPool } from "@portal/db";', 'import * as db from "@portal/db";', 'export { jobList } from "../../lib/jobs";', 'import { jobList } from "../../../lib/jobs";',
      'import { portalAuth } from "../lib/portal";', 'import { requirePortal } from "@portal/auth";', 'import { staffTools } from "@portal/db/staff-tools";',
      'import { x } from "../../../../packages/db/src/jobs";', 'const db = await import("@portal/db");', 'const j = require("../lib/jobs");', 'import "@portal/db";',
      'import {\n  type Foo,\n  getPool,\n} from "@portal/db";', 'import { assess } from "@portal/rules"',
    ]) expect(badImports(text), text).not.toEqual([]);
    for (const text of [
      'import type { PortalLogin } from "@portal/auth";', 'import { type Read } from "../lib/data";', 'import { readJobs } from "../../lib/data";',
      'import type { Foo } from "../lib/jobs";', 'import { Link } from "next/link";',
    ]) expect(badImports(text), text).toEqual([]);
  });
});

describe("lib/data.ts", () => {
  const text = readFileSync(join(ROOT, "lib/data.ts"), "utf8");
  it("is server-only and reaches the database through no import of its own", () => {
    expect(text).toMatch(/^(\/\/.*\n)*import "server-only";/);
    expect(text.match(/from "@portal\/db[^"]*"/g)).toBeNull();
  });
  it("offers the reads the pages need", () => {
    for (const name of ["readLogin", "readCompany", "readVerification", "readJobs", "readJob", "readJobStats", "readTeam", "readStatus", "readCases", "readNotices", "readAgencyJobs"])
      expect(text, name).toMatch(new RegExp(`export (const|async function) ${name}\\b`));
  });
});
