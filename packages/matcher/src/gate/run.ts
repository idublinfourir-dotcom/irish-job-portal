// The gate runner: every advert of the frozen test set through the real chain with the matcher under test, then the scoring.
// Private data stays outside the repo. The report holds numbers and advert ids only, never advert text, never the key.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assess, cleanEmployerName, type ChainData, type ChainMatcher } from "@portal/rules";
import { chatClient } from "../ai/client";
import { createAiMatcher } from "../ai/matcher";
import type { AiResult, ListEntry } from "../ai/types";
import { rulesMatcher } from "../rules";
import { cachedClient } from "./cache";
import { scoreGate, type GateScore } from "./score";
import { checkFrozen, parseTestSet } from "./testset";

/** Buckets the site shows with the Critical Skills badge (stated pay, big company rule, the two public pay tiers). */
export const SHOWN = new Set(["stated_pay", "big_company", "public_hse", "public_s38"]);

export type GateReport = {
  matcher: "rules" | "ai";
  modelId: string | null;
  testSetSha256: string;
  modelCalls: number;
  answersReused: number;
  badAnswers: number;
  score: GateScore;
};

const need = (env: Record<string, string | undefined>, name: string) => {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const readText = (file: string, what: string) => {
  if (!existsSync(file)) throw new Error(`${what} is missing: ${file}`);
  return readFileSync(file, "utf8");
};

export async function runGate(env: Record<string, string | undefined>, deps: { fetch: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<{ report: GateReport; file: string }> {
  const dir = env.PORTAL_PRIVATE_DATA;
  if (!dir) throw new Error("PORTAL_PRIVATE_DATA is not set: point it at the private gate folder (it holds testset.jsonl and testset.sha256)");
  const setBytes = readText(join(dir, "testset.jsonl"), "the test set (testset.jsonl)");
  const testSetSha256 = checkFrozen(setBytes, readText(join(dir, "testset.sha256"), "the frozen hash (testset.sha256)"));
  const set = parseTestSet(setBytes);

  const dete = JSON.parse(readText(join(dir, "dete-2026.json"), "the DETE employer list (dete-2026.json)")) as [string, number][];
  const candidates = JSON.parse(readText(join(dir, "public_employers_candidates.json"), "public_employers_candidates.json")) as Record<string, { tier: 1 | 2 }>;
  const base = {
    deteNames: new Set(dete.map(([name]) => cleanEmployerName(name))),
    publicPayCandidates: new Map<string, 1 | 2>(Object.entries(candidates).map(([k, v]) => [k, v.tier])),
  };

  // The matcher under test: the word "rules" is the baseline with no key and no network; otherwise a model address, key and id.
  let matcher: ChainMatcher = rulesMatcher;
  let modelId: string | null = null;
  let current = "";
  let last: AiResult | null = null;
  let stats = { calls: 0, reused: 0 };
  if (env.PORTAL_GATE_MATCHER !== "rules") {
    modelId = need(env, "PORTAL_GATE_MODEL_ID");
    const timeoutMs = env.PORTAL_GATE_TIMEOUT_MS ? Number(env.PORTAL_GATE_TIMEOUT_MS) : undefined;
    const real = chatClient({ fetch: deps.fetch, baseUrl: need(env, "PORTAL_GATE_MODEL_URL"), key: need(env, "PORTAL_GATE_MODEL_KEY"), model: modelId, timeoutMs });
    const cached = cachedClient(real, { dir, modelId, advertId: () => current, sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), delayMs: Number(env.PORTAL_GATE_DELAY_MS ?? 0) });
    stats = cached.stats;
    const entries = JSON.parse(readText(join(dir, "occupation-lists.json"), "the occupation lists (occupation-lists.json)")) as ListEntry[];
    matcher = createAiMatcher({ client: cached.client, modelId, entries }, (r) => (last = r)).matcher;
  }

  const data: ChainData = { ...base, matcher };
  const rows = [];
  let badAnswers = 0;
  for (const t of set) {
    current = t.id;
    last = null;
    const a = await assess(t.advert, data);
    const r = last as AiResult | null;
    if (r?.failure?.kind === "model error") {
      throw new Error(`stopped at advert ${t.id}: ${r.failure.why}. ${stats.calls + stats.reused} answers are saved in ${join(dir, "answers")}; run again later to go on.`);
    }
    if (r?.failure) badAnswers++;
    rows.push({ id: t.id, passed: SHOWN.has(a.bucket), qualifies: t.label.qualifies });
  }

  const report: GateReport = { matcher: modelId ? "ai" : "rules", modelId, testSetSha256, modelCalls: stats.calls, answersReused: stats.reused, badAnswers, score: scoreGate(rows) };
  const file = join(dir, `report-${(modelId ?? "rules").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return { report, file };
}
