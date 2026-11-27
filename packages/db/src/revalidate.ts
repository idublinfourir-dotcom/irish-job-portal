// Stage 3 step 2 (AUDIT section 5, "How a write reaches the cache"): staff, portal and the command-line jobs write outside the candidate deployment,
// and a revalidatePath called there clears their own project's cache, not the candidate site's. So the candidate site has one signed route,
// POST /api/revalidate, and every writer calls it through revalidateCandidate once its transaction has committed. The body is
// { paths: [{ path, type? }], at } with an HMAC-SHA256 of the exact body text in REVALIDATE_HEADER, keyed by REVALIDATE_SECRET (the same value in the
// three apps and GitHub). A path must be on PATHS, `at` within MAX_AGE_MS of the route's clock. Time stays the backstop: a missed call leaves a page
// at most its own lifetime old. Tags: none yet (the data cache brings the first); a body that names one is refused.
import { createHmac, timingSafeEqual } from "node:crypto";

export type Target = { path: string; type?: "page" | "layout" };
export const REVALIDATE_HEADER = "x-revalidate-signature";
export const MAX_AGE_MS = 60_000;
export const MAX_BODY = 8_000; // characters: PATHS twice over
const MIN_SECRET = 32;

/** Every candidate page that shows staff content (guides, help, updates, occupation texts; the home page lists guides and updates). A publish or withdraw clears them all: they regenerate on their next visit only. */
export const CONTENT_PATHS: Target[] = [
  { path: "/" }, { path: "/guides" }, { path: "/guides/[slug]", type: "page" }, { path: "/help" }, { path: "/help/[slug]", type: "page" }, { path: "/updates" },
  { path: "/occupations/[slug]", type: "page" },
];
/** The five legal pages (apps/candidate/lib/paths.ts LEGAL). Confirming a legal text clears them all. */
export const LEGAL_PATHS: Target[] = ["/privacy", "/terms", "/cookies", "/employer-acceptable-use", "/data-retention"].map((path) => ({ path }));
/** Every page under the root layout: for what the frame shows on every page (the footer's rules date). */
export const ALL_PAGES: Target = { path: "/", type: "layout" };
const key = (t: Target) => `${t.path} ${t.type ?? ""}`;
const PATHS = new Set([...CONTENT_PATHS, ...LEGAL_PATHS, ALL_PAGES].map(key));

export const signBody = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("hex");
const secretOf = (env: Record<string, string | undefined>) => (env.REVALIDATE_SECRET && env.REVALIDATE_SECRET.length >= MIN_SECRET ? env.REVALIDATE_SECRET : null);

export type Checked = { paths: Target[] } | { refused: 400 | 401 | 503; code: string };
/** The route's whole decision, before any cache is touched: a missing or short secret, a bad signature, an old or future `at`, or any key, path or type not on the list is refused. */
export function checkRevalidate(body: string, signature: string | null, env: Record<string, string | undefined>, now = Date.now()): Checked {
  const secret = secretOf(env);
  if (!secret) return { refused: 503, code: "NOT_CONFIGURED" };
  const want = Buffer.from(signBody(body, secret), "hex"), got = Buffer.from(signature ?? "", "hex");
  if (body.length > MAX_BODY || got.length !== want.length || !timingSafeEqual(got, want)) return { refused: 401, code: "BAD_SIGNATURE" };
  let b: unknown;
  try { b = JSON.parse(body); } catch { return { refused: 400, code: "BAD_BODY" }; }
  const o = (b ?? {}) as Record<string, unknown>;
  if (b === null || typeof b !== "object" || Array.isArray(b) || Object.keys(o).some((k) => k !== "paths" && k !== "at" && k !== "tags")) return { refused: 400, code: "BAD_BODY" };
  if (typeof o.at !== "number" || Math.abs(now - o.at) > MAX_AGE_MS) return { refused: 401, code: "STALE" }; // signed but old: a replay
  if (o.tags !== undefined && !(Array.isArray(o.tags) && o.tags.length === 0)) return { refused: 400, code: "UNKNOWN_TAG" };
  const paths = o.paths;
  const known = (t: unknown) => typeof t === "object" && t !== null && !Array.isArray(t) && Object.keys(t).every((k) => k === "path" || k === "type") && PATHS.has(key(t as Target));
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > PATHS.size || !paths.every(known)) return { refused: 400, code: "UNKNOWN_PATH" };
  return { paths: paths as Target[] };
}

/**
 * Asks the candidate site to clear `targets`. Off (false, no request) when REVALIDATE_SECRET or CANDIDATE_AUTH_URL is not set, as in tests and
 * development. Never throws and waits at most 5 s: the write it follows has committed, and the page's own lifetime is the backstop.
 */
export async function revalidateCandidate(env: Record<string, string | undefined>, targets: Target[], send: typeof fetch = fetch): Promise<boolean> {
  const secret = secretOf(env);
  if (!secret || !env.CANDIDATE_AUTH_URL) return false;
  try {
    const body = JSON.stringify({ paths: targets, at: Date.now() });
    const r = await send(new URL("/api/revalidate", env.CANDIDATE_AUTH_URL), {
      method: "POST", body, headers: { "content-type": "application/json", [REVALIDATE_HEADER]: signBody(body, secret) }, signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) console.error(`revalidate: the candidate site answered ${r.status}`);
    return r.ok;
  } catch (e) {
    console.error("revalidate: the candidate site did not answer", (e as Error).name);
    return false;
  }
}

/** Whether revalidateCandidate would send anything: a route handler schedules it in after() only then, so a test or a development run never needs a request scope for it. */
export const revalidateOn = (env: Record<string, string | undefined>) => secretOf(env) !== null && !!env.CANDIDATE_AUTH_URL;
