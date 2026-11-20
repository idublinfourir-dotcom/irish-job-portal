// The live check of the malware scan (U1, S-Q7 A), run by hand by the main session after the engineer turns on GuardDuty Malware Protection for
// S3 on the files bucket (never in tests, never in CI): it reaches the real S3.
//   FILES_S3_KEY_ID=... FILES_S3_SECRET=... FILES_S3_BUCKET=irish-job-portal-files FILES_S3_REGION=eu-west-1 node packages/db/src/file-scan-check-cli.ts
// Puts one clean text file and one holding the EICAR antivirus test string at check/<uuid>, reads each one's GuardDutyMalwareScanStatus tag every
// 10 s for up to 5 minutes, prints each status and its delay in seconds, then removes both. Prints statuses and seconds only; exit 0 only when the
// clean file shows NO_THREATS_FOUND and the EICAR file THREATS_FOUND.
import { randomUUID } from "node:crypto";
import { s3Settings, s3Store, type FileStore } from "./file-store.ts";

// The standard EICAR test file (eicar.org): harmless, every scanner reports it as a threat. Split so this source file is not itself flagged.
export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
export const WAIT = { everyMs: 10_000, maxMs: 300_000 };

export async function main(env: NodeJS.ProcessEnv, log: (line: string) => void, o: { store?: FileStore; sleep?: (ms: number) => Promise<void>; wait?: typeof WAIT } = {}): Promise<number> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const wait = o.wait ?? WAIT;
  let store = o.store;
  if (!store) {
    try { store = s3Store(s3Settings(env)); } catch (e) { return log(`FAIL settings: ${(e as Error).message}`), 1; }
  }
  const files = { clean: { key: `check/${randomUUID()}`, body: "file scan check: a clean text file", want: "NO_THREATS_FOUND" },
    eicar: { key: `check/${randomUUID()}`, body: EICAR, want: "THREATS_FOUND" } };
  const got: Record<string, string | null> = { clean: null, eicar: null };
  try {
    for (const f of Object.values(files)) await store.put(f.key, new TextEncoder().encode(f.body), "text/plain");
    const started = Date.now();
    for (let waited = 0; ; waited += wait.everyMs) {
      for (const [name, f] of Object.entries(files)) {
        if (got[name]) continue;
        const s = await store.scanStatus(f.key).catch((e: Error) => { log(`${name}: tag read failed: ${/answered (\d+)/.exec(e.message)?.[1] ?? "error"}`); return null; });
        if (s) { got[name] = s; log(`${name}: ${s} after ${Math.round((Date.now() - started) / 1000)} s`); }
      }
      if ((got.clean && got.eicar) || waited >= wait.maxMs) break;
      await sleep(wait.everyMs);
    }
    for (const name of Object.keys(files)) if (!got[name]) log(`${name}: no tag after ${wait.maxMs / 1000} s`);
  } catch (e) {
    log(`FAIL put: ${/answered (\d+)/.exec((e as Error).message)?.[1] ?? "error"}`);
  } finally {
    for (const f of Object.values(files)) await store.remove(f.key).catch(() => log("FAIL remove: a check/ object is left, delete it by hand"));
  }
  return got.clean === files.clean.want && got.eicar === files.eicar.want ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.env, console.log);
