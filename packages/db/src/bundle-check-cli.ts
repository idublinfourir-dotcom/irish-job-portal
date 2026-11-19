// The client bundle check of check.yml, run after `npm run check` has built the three apps: `node packages/db/src/bundle-check-cli.ts`.
// Fails when any app's browser files (.next/static) hold Session Replay code, the name SENTRY_AUTH_TOKEN, or the token's value when one is set
// (decision #267: the browser gets only the public DSN).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPLAY = /rrweb|name:"Replay"|ReplayContainer|replayIntegration/;

/** One "file: reason" line per problem in the .js files under `dir`. */
export function leaks(dir: string, token = ""): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!f.endsWith(".js")) continue;
    const text = readFileSync(path.join(dir, f), "utf8");
    if (REPLAY.test(text)) out.push(`${f}: Session Replay code`);
    if (text.includes("SENTRY_AUTH_TOKEN")) out.push(`${f}: the name SENTRY_AUTH_TOKEN`);
    if (token && text.includes(token)) out.push(`${f}: the SENTRY_AUTH_TOKEN value`);
  }
  return out;
}

if (import.meta.main) {
  const root = path.join(import.meta.dirname, "../../../apps");
  let failed = false;
  for (const app of ["admin", "candidate", "portal"]) {
    const found = leaks(path.join(root, app, ".next/static"), process.env.SENTRY_AUTH_TOKEN); // a missing build throws: the step fails
    for (const l of found) console.error(`${app}: ${l}`);
    failed ||= found.length > 0;
  }
  console.log(failed ? "client bundle check FAILED" : "client bundles: no Session Replay, no auth token");
  process.exit(failed ? 1 : 0);
}
