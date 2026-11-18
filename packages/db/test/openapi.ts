// The OpenAPI files in docs/openapi (decision #248), read for two checks: the sync test (src/openapi-sync.test.ts: every route file and
// exported method is described, nothing else is, and each operation has a summary, a 4xx and a success example) and the integration
// tests that check a real reply against its schema. Files only: nothing here reaches the network.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";

export const ROOT = join(import.meta.dirname, "../../..");
export const APPS = ["candidate", "portal", "admin"] as const;
export type App = (typeof APPS)[number];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Obj = Record<string, unknown>;
export type Spec = { paths?: Record<string, Obj>; components?: Obj };

/** The HTTP methods a route file exports (export const GET, export async function GET, export function GET). */
export const exportedMethods = (source: string) =>
  METHODS.filter((m) => new RegExp(`export\\s+(?:const|(?:async\\s+)?function)\\s+${m}\\b`).test(source));

/** A route file's path under app/ as an OpenAPI path: [id] becomes {id}, a catch-all [...all] becomes {path}. */
export const routePath = (rel: string) =>
  "/" + rel.split(sep).join("/").replace(/\/?route\.ts$/, "").replace(/\[\.\.\.[^\]]+\]/g, "{path}").replace(/\[([^\]]+)\]/g, "{$1}");

/** Every route of one app: { path: methods }. */
export function appRoutes(appDir: string): Record<string, string[]> {
  const base = join(appDir, "app");
  const out: Record<string, string[]> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") out[routePath(relative(base, p))] = exportedMethods(readFileSync(p, "utf8"));
    }
  };
  walk(join(base, "api"));
  return out;
}

export const loadSpec = (app: App): Spec => parse(readFileSync(join(ROOT, "docs/openapi", `${app}.yaml`), "utf8")) as Spec;

const resolve = (spec: Spec, s: Obj): Obj => {
  if (typeof s.$ref !== "string") return s;
  const parts = s.$ref.replace(/^#\//, "").split("/");
  return resolve(spec, parts.reduce<unknown>((o, k) => (o as Obj)[k], spec) as Obj);
};
const hasExample = (media: unknown) => {
  const m = (media ?? {}) as Obj;
  return m.example !== undefined || (typeof m.examples === "object" && m.examples !== null && Object.keys(m.examples).length > 0);
};

/** What is wrong between one app's routes and its spec; empty when in sync. */
export function syncProblems(routes: Record<string, string[]>, spec: Spec): string[] {
  const problems: string[] = [];
  const paths = spec.paths ?? {};
  for (const [path, methods] of Object.entries(routes))
    for (const m of methods) if (!paths[path]?.[m.toLowerCase()]) problems.push(`missing in spec: ${m} ${path}`);
  for (const [path, item] of Object.entries(paths))
    for (const [key, op] of Object.entries(item)) {
      if (!(METHODS as readonly string[]).includes(key.toUpperCase())) continue;
      const name = `${key.toUpperCase()} ${path}`;
      if (!routes[path]?.includes(key.toUpperCase())) problems.push(`no route for: ${name}`);
      const o = op as Obj;
      const responses = (o.responses ?? {}) as Record<string, Obj>;
      if (typeof o.summary !== "string" || !o.summary.trim()) problems.push(`no summary: ${name}`);
      if (!Object.keys(responses).some((s) => /^4(\d\d|XX)$/.test(s)) && typeof o["x-no-4xx"] !== "string") problems.push(`no 4xx response: ${name}`);
      // A success with a body needs an example; a redirect needs an example Location.
      const success = Object.entries(responses).filter(([s]) => /^[23](\d\d|XX)$/.test(s));
      const shown = success.some(([s, ref]) => {
        const r = resolve(spec, ref);
        if (s.startsWith("3")) return ((r.headers as Obj | undefined)?.Location as Obj | undefined)?.example !== undefined;
        const content = (r.content ?? {}) as Obj;
        return Object.values(content).some(hasExample);
      });
      if (!shown) problems.push(`no success example: ${name}`);
    }
  return problems;
}

// ===== a small JSON schema check for the integration tests (the subset the files use; no schema library) =====
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/** The problems of `value` against `schema` (empty when it matches). */
export function schemaProblems(spec: Spec, schema: Obj, value: unknown, at = "$"): string[] {
  const s = resolve(spec, schema);
  const out: string[] = [];
  const all = (subs: unknown) => (subs as Obj[]).flatMap((x) => schemaProblems(spec, x, value, at));
  if (s.allOf) out.push(...all(s.allOf));
  for (const k of ["oneOf", "anyOf"] as const)
    if (s[k] && !(s[k] as Obj[]).some((x) => schemaProblems(spec, x, value, at).length === 0)) out.push(`${at}: matches no ${k} branch`);
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [...out, `${at}: ${t} is not ${types.join(" or ")}`];
  }
  if (s.const !== undefined && value !== s.const) out.push(`${at}: not ${JSON.stringify(s.const)}`);
  if (s.enum && !(s.enum as unknown[]).includes(value)) out.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "string") {
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) out.push(`${at}: does not match ${s.pattern}`);
    if (typeof s.maxLength === "number" && [...value].length > s.maxLength) out.push(`${at}: longer than ${s.maxLength}`);
    if (typeof s.minLength === "number" && [...value].length < s.minLength) out.push(`${at}: shorter than ${s.minLength}`);
    if (s.format === "date-time" && Number.isNaN(Date.parse(value))) out.push(`${at}: not a date-time`);
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) out.push(`${at}: under ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) out.push(`${at}: over ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.maxItems === "number" && value.length > s.maxItems) out.push(`${at}: more than ${s.maxItems} items`);
    if (s.items) value.forEach((v, i) => out.push(...schemaProblems(spec, s.items as Obj, v, `${at}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    const o = value as Obj, props = (s.properties ?? {}) as Record<string, Obj>;
    for (const k of (s.required ?? []) as string[]) if (!(k in o)) out.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(o)) {
      if (props[k]) out.push(...schemaProblems(spec, props[k], v, `${at}.${k}`));
      else if (s.additionalProperties === false) out.push(`${at}: unexpected ${k}`);
    }
  }
  return out;
}

/** The problems of a real reply body against the documented response of `method path` at `status` (JSON content). */
export function replyProblems(spec: Spec, method: string, path: string, status: number, body: unknown): string[] {
  const op = spec.paths?.[path]?.[method.toLowerCase()] as Obj | undefined;
  if (!op) return [`not described: ${method} ${path}`];
  const r = (op.responses as Record<string, Obj>)[String(status)];
  if (!r) return [`status ${status} not described for ${method} ${path}`];
  const schema = ((resolve(spec, r).content as Obj | undefined)?.["application/json"] as Obj | undefined)?.schema as Obj | undefined;
  return schema ? schemaProblems(spec, schema, body) : [`no JSON schema for ${status} of ${method} ${path}`];
}
