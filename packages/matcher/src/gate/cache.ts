import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelClient } from "../ai/types";
import { sha256 } from "./testset";

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);

/**
 * Keeps every model answer in `<dir>/answers/`, named by model id, advert id and a hash of the prompt, and reuses it on the next run,
 * so a run stopped by a daily request limit goes on later without paying twice. Failures are not saved. The key is never written.
 */
export function cachedClient(client: ModelClient, o: { dir: string; modelId: string; advertId: () => string; sleep?: (ms: number) => Promise<void>; delayMs?: number }) {
  const dir = join(o.dir, "answers");
  mkdirSync(dir, { recursive: true });
  const stats = { calls: 0, reused: 0 };
  const wrapped: ModelClient = async (prompt) => {
    const file = join(dir, `${safe(o.modelId)}__${safe(o.advertId())}__${sha256(`${prompt.system}\n---\n${prompt.user}`).slice(0, 16)}.json`);
    if (existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as { text?: unknown };
        if (typeof saved.text === "string") {
          stats.reused++;
          return saved.text;
        }
      } catch {
        // a half written file counts as missing
      }
    }
    if (o.delayMs && stats.calls) await o.sleep?.(o.delayMs);
    stats.calls++;
    const text = await client(prompt);
    writeFileSync(`${file}.tmp`, JSON.stringify({ text }));
    renameSync(`${file}.tmp`, file);
    return text;
  };
  return { client: wrapped, stats };
}
