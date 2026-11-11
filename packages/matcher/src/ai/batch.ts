import { checkAnswer } from "./check";
import { NONE, prepare, QUEUE, type AiDeps } from "./matcher";
import { batchId, batchSystemMessage, buildBatchPrompt } from "./prompt";
import type { AiFailure, AiResult, ListEntry } from "./types";

/** One advert's result from a batch: the usual result, plus the list entry the model picked (null when none). */
export type BatchResult = AiResult & { entry: ListEntry | null };

const MAX_REPLY = 100_000;
const RETRY = "Your last reply could not be used. Reply with the JSON array only.";

/** The reply's array, or why it cannot be read. Reasons are fixed phrases that never repeat model text. */
function readArray(raw: string): unknown[] | string {
  if (typeof raw !== "string" || raw.trim() === "") return "empty answer";
  if (raw.length > MAX_REPLY) return "answer too long";
  const fenced = /^\s*```(?:json)?[ \t]*\n([\s\S]*?)\n?```\s*$/.exec(raw);
  try {
    const data: unknown = JSON.parse(fenced ? (fenced[1] as string) : raw);
    return Array.isArray(data) ? data : "not a JSON array";
  } catch {
    return "not JSON";
  }
}

/**
 * One request for up to a few adverts. Each answer is checked with `checkAnswer` against its own advert only. An answer that is missing,
 * given twice, malformed, without an entry, or with a quote that is not in its own advert becomes the queue result (code none, confidence low).
 * A reply that cannot be read at all is asked for once more; then every advert in the batch is queued. Nothing here throws for a bad reply or a model error.
 */
export function createBatchChecker(deps: AiDeps) {
  const { byId, limits, attempts } = prepare(deps);
  const system = batchSystemMessage(deps.entries);

  return async function checkBatch(adverts: readonly { title: string; description: string }[]): Promise<BatchResult[]> {
    const all = (failure: AiFailure): BatchResult[] => adverts.map(() => ({ match: QUEUE, quote: null, modelId: deps.modelId, failure, entry: null }));
    if (adverts.length === 0) return [];
    let why = "";
    for (let i = 0; i < attempts; i++) {
      const { prompt, texts } = buildBatchPrompt(system, adverts, limits, i ? RETRY : undefined);
      let raw: string;
      try {
        raw = await deps.client(prompt);
      } catch (e) {
        return all({ kind: "model error", why: (e instanceof Error ? e.message : "model call failed").slice(0, 200) });
      }
      const items = readArray(raw);
      if (typeof items === "string") {
        why = items;
        continue;
      }
      // group the answers by the id they carry; an id that was not sent is ignored
      const sent = new Set(adverts.map((_, k) => batchId(k)));
      const byAdvert = new Map<string, Record<string, unknown>[]>();
      for (const item of items) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const id = (item as Record<string, unknown>).id;
        if (typeof id !== "string" || !sent.has(id)) continue;
        byAdvert.set(id, [...(byAdvert.get(id) ?? []), item as Record<string, unknown>]);
      }
      if (byAdvert.size === 0) {
        why = "no answer for any advert";
        continue;
      }
      return adverts.map((_, k): BatchResult => {
        const fail = (w: string): BatchResult => ({ match: QUEUE, quote: null, modelId: deps.modelId, failure: { kind: "bad answer", why: w }, entry: null });
        const given = byAdvert.get(batchId(k));
        if (!given) return fail("no answer for this advert");
        if (given.length > 1) return fail("answered more than once");
        const rest = { ...given[0] };
        delete rest.id;
        const c = checkAnswer(JSON.stringify(rest), byId, texts[k] as string);
        if (!c.ok) return fail(c.why);
        const base = { modelId: deps.modelId, failure: null };
        if (c.code === "none") return { ...base, match: NONE, quote: null, entry: null };
        if (!c.entry) return fail("a code without an entry");
        if (!c.quoteFound) return fail("quote not found in this advert");
        return { ...base, quote: c.quote, entry: c.entry, match: { occupationCode: c.code, onCriticalSkillsList: c.entry.list === "critical-skills" ? "yes" : "no", confidence: c.confidence } };
      });
    }
    return all({ kind: "bad answer", why });
  };
}
