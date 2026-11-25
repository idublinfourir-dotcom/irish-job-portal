// A server file may render a component of a "use client" file, nothing else: a function called there throws at run time (a 500) and a constant is an empty proxy. Vitest reads
// "use client" as a plain string, so a test that renders the page passes while the built page fails (25 Nov 2026: the first-time step and the portal help page).
// ponytail: names are read with regular expressions, so a PascalCase value that is not a component is missed; use the compiler's module graph if one ever slips through.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  if (e.isDirectory()) return ["node_modules", ".next", "test"].includes(e.name) ? [] : walk(p);
  return /\.tsx?$/.test(e.name) && !/\.(test|perf|d)\.tsx?$/.test(e.name) ? [p] : [];
});
/** The server files that take a value (not a component, not a type) from a "use client" file, as "file <- name". */
export function leaks(src: Map<string, string>, ui: string): string[] {
  const client = new Set([...src].filter(([, s]) => /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(s)).map(([f]) => f));
  const find = (from: string, spec: string) => {
    const b = spec === "@portal/ui" ? ui : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
    return b && [b, `${b}.ts`, `${b}.tsx`, join(b, "index.ts"), join(b, "index.tsx")].find((x) => src.has(x));
  };
  const imports = new Map([...src].map(([f, s]) => [f, [...s.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g)].flatMap((m) => {
    const target = find(f, m[3]!);
    const names = m[1] ? [] : (m[2]!.match(/\{([\s\S]*)\}/)?.[1] ?? "").split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type ")).map((n) => n.split(/\s+as\s+/)[0]!);
    return target ? [{ target, names, all: m[2]!.startsWith("*") }] : [];
  })] as const));
  /** The file a name really comes from, through `export *` lists. */
  const home = (f: string, name: string): string | undefined =>
    new RegExp(`export\\s+(?:async\\s+)?(?:const|let|function)\\s+${name}\\b`).test(src.get(f)!) ? f : imports.get(f)!.filter((i) => i.all).map((i) => home(i.target, name)).find(Boolean);
  const todo = [...src.keys()].filter((f) => /\/(?:page|layout|route|error|not-found|default|template|sitemap|robots|manifest|opengraph-image|proxy|instrumentation)\.tsx?$/.test(f) && !client.has(f));
  const server = new Set(todo);
  for (let f = todo.pop(); f; f = todo.pop()) for (const { target } of imports.get(f)!) if (!client.has(target) && !server.has(target)) { server.add(target); todo.push(target); }
  const out: string[] = [];
  for (const f of server) for (const { target, names } of imports.get(f)!) for (const n of names)
    if (client.has(home(target, n) ?? target) && !/^[A-Z][a-z]/.test(n) && !src.get(f)!.includes(`<${n}`)) out.push(`${relative(ROOT, f)} <- ${n}`);
  return out.sort();
}

it("finds a value taken from a client file, directly or through an index, and lets components, types and client importers through", () => {
  const src = new Map(Object.entries({
    "/a/page.tsx": 'import { Form, size, type T } from "./form";\nimport { near } from "@portal/ui";\nimport { view } from "./view";\nexport default () => <Form />;',
    "/a/form.tsx": '// words\n"use client";\nimport { size2 } from "./other";\nexport const size = 1;\nexport function Form() {}',
    "/a/other.tsx": '"use client";\nexport const size2 = 2;',
    "/a/view.tsx": 'import { size2 } from "./other";\nexport const view = size2;',
    "/a/unused.tsx": 'import { size } from "./form";',
    "/ui/index.ts": 'export * from "./nav";\nexport * from "./plain";', "/ui/nav.tsx": '"use client";\nexport const near = () => 1;', "/ui/plain.ts": "export const far = 1;",
  }));
  expect(leaks(src, "/ui/index.ts").map((x) => x.replace(/^.*\/a\//, ""))).toEqual(["page.tsx <- near", "page.tsx <- size", "view.tsx <- size2"]);
});

it("no server file of the three apps takes a value from a client file", () => {
  const files = ["apps", "packages"].flatMap((d) => walk(join(ROOT, d)));
  const src = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  expect(src.size).toBeGreaterThan(500); // the walk really found the code
  expect(leaks(src, join(ROOT, "packages/ui/src/index.ts"))).toEqual([]);
});
