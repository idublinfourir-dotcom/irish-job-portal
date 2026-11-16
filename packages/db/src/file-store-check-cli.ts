// The live check of the files key, run by hand by the engineer (never in tests, never in CI): it reaches the real S3.
//   FILES_S3_KEY_ID=... FILES_S3_SECRET=... FILES_S3_BUCKET=irish-job-portal-files FILES_S3_REGION=eu-west-1 node packages/db/src/file-store-check-cli.ts
// Puts a small object at check/<uuid>, downloads it through its link, removes it, checks the link is dead, then checks the same key can neither
// read nor write the backups bucket. One line per step, never a key or a link; exit 1 on any failure.
import { randomUUID } from "node:crypto";
import { s3Settings, s3Store } from "./file-store.ts";

const BACKUPS = "irish-job-portal-backups";

export async function main(env: NodeJS.ProcessEnv, log: (line: string) => void, get: typeof fetch = fetch): Promise<number> {
  let failed = false;
  const step = (name: string, ok: boolean, detail = "") => { log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); if (!ok) failed = true; return ok; };
  let settings;
  try { settings = s3Settings(env); } catch (e) { return step("settings", false, (e as Error).message), 1; }
  const files = s3Store(settings), backups = s3Store({ ...settings, bucket: BACKUPS });
  const key = `check/${randomUUID()}`, body = new TextEncoder().encode(`file store check ${new Date().toISOString()}`);
  const link = () => files.link(key, { fileName: "check.txt", contentType: "text/plain" });
  const status = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return /answered (\d+)/.exec((e as Error).message)?.[1] ?? "error"; } };

  if (!step("put a small object", (await status(files.put(key, body, "text/plain"))) === "ok")) return 1;
  try {
    const r = await get(await link());
    const bytes = new Uint8Array(await r.arrayBuffer());
    step("download it through its link", r.status === 200 && Buffer.from(bytes).equals(Buffer.from(body)) && /^attachment;/.test(r.headers.get("content-disposition") ?? ""), `status ${r.status}`);
  } catch (e) { step("download it through its link", false, (e as Error).name); }
  step("remove it", (await status(files.remove(key))) === "ok");
  try {
    const r = await get(await link());
    await r.body?.cancel();
    step("the link is dead after the removal", r.status === 403 || r.status === 404, `status ${r.status}`);
  } catch (e) { step("the link is dead after the removal", false, (e as Error).name); }
  try {
    const r = await get(await backups.link(key, { fileName: "x", contentType: "text/plain" }));
    await r.body?.cancel();
    step("the backups bucket refuses a read", r.status === 403, `status ${r.status}`);
  } catch (e) { step("the backups bucket refuses a read", false, (e as Error).name); }
  const put = await status(backups.put(key, body, "text/plain"));
  step("the backups bucket refuses a write", put === "403", `status ${put}`);
  if (put === "ok") await backups.remove(key).catch(() => {});
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.env, console.log);
