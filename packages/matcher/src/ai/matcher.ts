import type { Matcher, OccupationMatch } from "../types";
import { checkAnswer } from "./check";
import { buildPrompt, systemMessage } from "./prompt";
import type { AiFailure, AiOptions, AiResult, ListEntry, ModelClient } from "./types";

export type AiDeps = { client: ModelClient; modelId: string; entries: readonly ListEntry[]; options?: AiOptions };

// The model read the advert and no list entry fits: the chain rejects it as "occupation not recognised".
const NONE: OccupationMatch = { occupationCode: "none", onCriticalSkillsList: "unknown", confidence: "none" };
// No usable answer. Low confidence, not "none": the chain rejects "none" and sends "low" to the admin queue, so a model fault
// never drops a job unseen. A caller that can try again later reads `failure` from `match` and need not store this at all.
const QUEUE: OccupationMatch = { occupationCode: "none", onCriticalSkillsList: "unknown", confidence: "low" };
const RETRY = "Your last reply could not be used. Reply with the JSON object only.";

/**
 * The AI occupation matcher. `match` gives the result with what the fetcher stores; `matcher` is the same as a plain `Matcher`
 * for the chain, and calls `onResult` with the full result. A bad answer, a model error, a timeout or an empty answer is never a pass:
 * the result is code "none", list "unknown", confidence "low" (the chain sends that to the admin queue). Nothing here throws for them.
 */
export function createAiMatcher(deps: AiDeps, onResult?: (r: AiResult) => void) {
  const byId = new Map<string, ListEntry>();
  for (const e of deps.entries) {
    if (!/^[0-9]{4}$/.test(e.code) || !e.id || byId.has(e.id)) throw new Error(`bad list entry "${e.id}": needs a unique id and a four digit code`);
    byId.set(e.id, e);
  }
  const system = systemMessage(deps.entries);
  const limits = { title: deps.options?.titleLimit ?? 300, description: deps.options?.descriptionLimit ?? 6000 };
  const attempts = deps.options?.retry === false ? 1 : 2;

  async function match(title: string, description: string): Promise<AiResult> {
    const fail = (failure: AiFailure): AiResult => ({ match: QUEUE, quote: null, modelId: deps.modelId, failure });
    let why = "";
    for (let i = 0; i < attempts; i++) {
      const { prompt, text } = buildPrompt(system, title ?? "", description ?? "", limits, i ? RETRY : undefined);
      let raw: string;
      try {
        raw = await deps.client(prompt);
      } catch (e) {
        return fail({ kind: "model error", why: (e instanceof Error ? e.message : "model call failed").slice(0, 200) });
      }
      const c = checkAnswer(raw, byId, text);
      if (!c.ok) {
        why = c.why;
        continue;
      }
      const confidence = c.quoteFound ? c.confidence : "low";
      const base = { quote: c.quote, modelId: deps.modelId, failure: null };
      if (c.code === "none") return { ...base, match: NONE, quote: null };
      const onList = c.entry?.list === "critical-skills" ? "yes" : "no";
      return { ...base, match: { occupationCode: c.code, onCriticalSkillsList: onList, confidence } };
    }
    return fail({ kind: "bad answer", why });
  }

  const matcher: Matcher = async (title, description) => {
    const r = await match(title, description);
    onResult?.(r);
    return r.match;
  };
  return { match, matcher };
}
