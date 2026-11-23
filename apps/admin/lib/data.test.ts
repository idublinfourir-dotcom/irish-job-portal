// The admin data layer wall (nextjs.org/docs/app/guides/data-security), as candidate/lib/page-imports.test.ts is for the candidate pages: a page, layout or other
// non-route file under apps/admin/app/ may not read the database, the staff login or the route helpers itself, or it would skip data.ts (which reads as the signed-in
// staff member and leaves the role checks to the database functions). It takes types only, and the reads from ../lib/data. data.ts itself is server-only. Unit test: files are read, nothing runs.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BARRED = /(^|\/)packages\/db(\/|$)|^@portal\/(db|auth)(\/|$)|(^|\/)lib\/(staff|admin-api|account-review|companies|pay-floors|rules|trust-safety|refusal|queue-rules)$/;

/** Every bad import in one file's text: a short line per problem (a type-only import is not one). */
function badImports(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/\b(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g)) {
    const [, , typeOnly, , from] = m as unknown as [string, string, string | undefined, string, string];
    if (BARRED.test(from!) && !typeOnly) bad.push(`${from}: not through lib/data`);
  }
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*["'`]([^"'`]*)["'`]/g)) if (BARRED.test(m[1]!)) bad.push(`dynamic ${m[1]}`);
  for (const m of text.matchAll(/\bimport\s+["']([^"']+)["']/g)) if (BARRED.test(m[1]!)) bad.push(`side-effect import of ${m[1]}`);
  return bad;
}
const appFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? appFiles(join(dir, e.name)) : /\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/^route\.[jt]s$/.test(e.name) ? [join(dir, e.name)] : []));

describe("admin pages read through lib/data.ts only", () => {
  it("no non-route file under app/ imports the database, the auth package or a route helper", () => {
    const files = appFiles(join(ROOT, "app"));
    expect(files.some((f) => f.endsWith("layout.tsx"))).toBe(true); // the walk sees the files
    expect(files.flatMap((f) => badImports(readFileSync(f, "utf8")).map((b) => `${relative(ROOT, f)}: ${b}`))).toEqual([]);
  });
  it("fails on a planted bad import of each kind, and lets types and the data layer through", () => {
    const planted = [
      'import { listAudit } from "@portal/db";', 'import * as db from "@portal/db";', 'export { listStaff } from "@portal/db";', 'import { myCounts } from "@portal/db/staff-tools";',
      'import { requireStaff } from "../../lib/staff";', 'import { refuse } from "../../../lib/admin-api";', 'import { staffSettings } from "@portal/auth";', 'import "@portal/db";',
      'import { listAudit } from "../../../../packages/db/src/audit-read";', 'const db = await import("@portal/db");', 'const db = require("@portal/db");',
      'import {\n  getPool,\n} from "@portal/db";',
    ];
    for (const text of planted) expect(badImports(text), text).not.toEqual([]);
    for (const text of [
      'import type { AuditRow } from "@portal/db";', 'import { readAudit, readMe } from "../lib/data";', 'import type { MetadataRoute } from "next";', 'import { Fragment } from "react";',
    ]) expect(badImports(text), text).toEqual([]);
  });
});

describe("lib/data.ts", () => {
  const text = readFileSync(join(ROOT, "lib/data.ts"), "utf8");
  it("is server-only: it starts with the server-only import, before any other", () => {
    expect(text.match(/^import\s.*$/m)![0]).toBe('import "server-only";');
  });
  it("reads as the signed-in staff member and never skips the session: every export goes through asStaff or checks requireStaff itself", () => {
    const exports = [...text.matchAll(/^export const (\w+) = (.*)$/gm)].map((m) => [m[1]!, m[2]!] as const);
    expect(exports.length).toBeGreaterThan(30);
    for (const [name, body] of exports) expect(/^asStaff\(|requireStaff\(/.test(body), name).toBe(true);
    expect(exports.map(([n]) => n).every((n) => /^read[A-Z]/.test(n))).toBe(true);
  });
  it("no read here writes: it imports no action function", () => {
    const imported = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@portal\/db(?:\/[\w-]+)?"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim().split(/\s+as\s+/)[0]!)).filter(Boolean);
    expect(imported.length).toBeGreaterThan(30);
    expect(imported.filter((n) => /^(approve|reject|claim|release|propose|confirm|refuse|add|edit|create|publish|withdraw|close|decide|link|unlink|set|merge|cancel|complete|hide|uphold|clear|ask|invite|disable|done|attach|send|export|open)/.test(n))).toEqual([]);
  });
});
