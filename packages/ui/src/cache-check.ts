// The asset cache check of check.yml, run after `npm run check` has built the three apps: `node packages/ui/src/cache-check.ts`.
// Starts each built app (no database, no network) and asks the real server: every hashed file in .next/static/media must be sent as cached for a
// year, the favicon must answer (a missing one is asked for again on every page), and a page must never be sent as cached.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.join(import.meta.dirname, "../../..");
const PHOTOS = readdirSync(path.join(ROOT, "apps/candidate/app/_home/photos")).length;

const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => ok(port));
    });
  });

async function check(app: string): Promise<string[]> {
  const cwd = path.join(ROOT, "apps", app);
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], { cwd, stdio: "ignore" });
  try {
    const get = async (url: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${url}`, { signal: AbortSignal.timeout(30_000), redirect: "manual" });
      return { status: r.status, cache: r.headers.get("cache-control") ?? "", type: r.headers.get("content-type") ?? "", body: await r.text() };
    };
    for (let i = 0; ; i++) {
      try {
        await get("/favicon.ico");
        break;
      } catch (e) {
        if (i === 60 || server.exitCode !== null) throw new Error(`${app}: the built app did not start`, { cause: e });
        await sleep(250);
      }
    }
    const out: string[] = [];
    const media = readdirSync(path.join(cwd, ".next/static/media"));
    const photos = media.filter((f) => f.endsWith(".webp")).length;
    if (app === "candidate" && photos !== PHOTOS) out.push(`${photos} hashed photos in the build, ${PHOTOS} in the source`);
    for (const f of media) {
      const r = await get(`/_next/static/media/${f}`);
      if (r.status !== 200 || !/max-age=31536000, immutable/.test(r.cache)) out.push(`${f}: ${r.status} ${r.cache}`);
    }
    const icon = await get("/favicon.ico");
    if (icon.status !== 200 || !icon.type.startsWith("image/")) out.push(`/favicon.ico: ${icon.status} ${icon.type}`);
    const page = await get("/no-such-page");
    if (/immutable|max-age=[1-9]/.test(page.cache)) out.push(`a page is cached: ${page.cache}`);
    if (app === "candidate" && (page.status !== 404 || !page.body.includes("that page") || !/<meta name="robots" content="noindex/.test(page.body))) out.push(`/no-such-page answers ${page.status}: not our 404 page, or not noindex`);
    // The built home page itself: no database here, so its sections show their failed state, but the page answers (24 Nov 2026: every photo was missing
    // in the production build only, and the live home page answered 500 while the tests and the dev server were fine).
    // The admin "/" (P14) checks the session in the database before anything, so with no database it can only fail: its sign-in page is loaded instead.
    const path0 = app === "admin" ? "/sign-in" : "/";
    const home = await get(path0);
    const shown = new Set([...home.body.matchAll(/\/_next\/static\/media\/([a-z0-9-]+)\.[^"/]+\.webp/g)].map((m) => m[1])).size;
    if (home.status >= 500) out.push(`${path0} answers ${home.status}`);
    if (app === "admin" && home.status !== 200) out.push(`${path0} answers ${home.status}`);
    if (app === "candidate" && (home.status !== 200 || shown < 10)) out.push(`/ answers ${home.status} with ${shown} photos`);
    console.log(`${app}: ${path0} ${home.status}, ${shown} photos on it; ${media.length} hashed files cached for a year, ${photos} of them photos`);
    return out;
  } finally {
    server.kill();
  }
}

let failed = false;
for (const app of ["candidate", "portal", "admin"]) {
  for (const problem of await check(app)) {
    console.error(`${app}: ${problem}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
