// The gate runner: every advert of the frozen test set through the real chain with the matcher under test, then the scoring.
// Private data stays outside the repo. The report holds numbers and advert ids only, never advert text, never the key.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assess, CHAIN_RULES_V1, cleanEmployerName, HSE_ENTRY, type Assessment, type ChainData, type ChainMatcher } from "@portal/rules";
import { createBatchChecker } from "../ai/batch";
import { chatClient } from "../ai/client";
import { createAiMatcher } from "../ai/matcher";
import { applySecondOpinion, SHOWN } from "../ai/secondOpinion";
import type { AiResult, ListEntry } from "../ai/types";
import { rulesMatcher } from "../rules";
import { cachedClient } from "./cache";
import { scoreGate, type GateScore } from "./score";
import { checkFrozen, parseTestSet } from "./testset";

export { SHOWN };

export type GateReport = {
  matcher: "rules" | "ai" | "rules+ai";
  modelId: string | null;
  testSetSha256: string;
  modelCalls: number;
  answersReused: number;
  badAnswers: number;
  /** Only in the rules+ai mode: the badges the rules gave, how many stayed, and the adverts per request. */
  secondOpinion: { batchSize: number; badgesBefore: number; badgesKept: number } | null;
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
  // The gate measures version 1 of the minimums and big-company names (#229) on its frozen set.
  const base = {
    deteNames: new Set(dete.map(([name]) => cleanEmployerName(name))),
    publicPayCandidates: new Map<string, 1 | 2>(Object.entries(candidates).map(([k, v]) => [k, v.tier])).set(HSE_ENTRY, 1), // the HSE switch ON (#261)
    ...CHAIN_RULES_V1,
  };

  // The matcher under test: "rules" is the baseline with no key and no network; "rules+ai" runs the rules, then asks the model once per batch
  // of badge adverts; anything else asks the model about every advert. The last two need a model address, key and id.
  const mode = env.PORTAL_GATE_MATCHER === "rules" || env.PORTAL_GATE_MATCHER === "rules+ai" ? env.PORTAL_GATE_MATCHER : "ai";
  let matcher: ChainMatcher = rulesMatcher;
  let modelId: string | null = null;
  let current = "";
  let last: AiResult | null = null;
  let stats = { calls: 0, reused: 0 };
  let checkBatch: ReturnType<typeof createBatchChecker> | null = null;
  const batchSize = Number(env.PORTAL_GATE_BATCH_SIZE ?? 10);
  if (mode !== "rules") {
    modelId = need(env, "PORTAL_GATE_MODEL_ID");
    const timeoutMs = env.PORTAL_GATE_TIMEOUT_MS ? Number(env.PORTAL_GATE_TIMEOUT_MS) : undefined;
    const real = chatClient({ fetch: deps.fetch, baseUrl: need(env, "PORTAL_GATE_MODEL_URL"), key: need(env, "PORTAL_GATE_MODEL_KEY"), model: modelId, timeoutMs });
    const cached = cachedClient(real, { dir, modelId, advertId: () => (mode === "ai" ? current : "batch"), sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), delayMs: Number(env.PORTAL_GATE_DELAY_MS ?? 0) });
    stats = cached.stats;
    const entries = JSON.parse(readText(join(dir, "occupation-lists.json"), "the occupation lists (occupation-lists.json)")) as ListEntry[];
    if (mode === "ai") matcher = createAiMatcher({ client: cached.client, modelId, entries }, (r) => (last = r)).matcher;
    else checkBatch = createBatchChecker({ client: cached.client, modelId, entries });
  }

  const data: ChainData = { ...base, matcher };
  const assessed: { id: string; advert: (typeof set)[number]["advert"]; assessment: Assessment; qualifies: boolean }[] = [];
  let badAnswers = 0;
  for (const t of set) {
    current = t.id;
    last = null;
    const assessment = await assess(t.advert, data);
    const r = last as AiResult | null;
    if (r?.failure?.kind === "model error") {
      throw new Error(`stopped at advert ${t.id}: ${r.failure.why}. ${stats.calls + stats.reused} answers are saved in ${join(dir, "answers")}; run again later to go on.`);
    }
    if (r?.failure) badAnswers++;
    assessed.push({ id: t.id, advert: t.advert, assessment, qualifies: t.label.qualifies });
  }

  let finals = assessed.map((a) => a.assessment);
  let secondOpinion: GateReport["secondOpinion"] = null;
  if (checkBatch) {
    const check = checkBatch;
    let batchNo = 0;
    finals = await applySecondOpinion(
      assessed,
      async (adverts) => {
        const results = await check(adverts);
        batchNo++;
        const fault = results.find((x) => x.failure?.kind === "model error");
        if (fault) throw new Error(`stopped at request ${batchNo}: ${fault.failure?.why}. ${readdirSync(join(dir, "answers")).length} answers are saved in ${join(dir, "answers")}; run again later to go on.`);
        badAnswers += results.filter((x) => x.failure).length;
        return results;
      },
      base.minimums.nonList,
      batchSize,
    );
    const before = assessed.filter((a) => SHOWN.has(a.assessment.bucket)).length;
    secondOpinion = { batchSize, badgesBefore: before, badgesKept: finals.filter((a) => SHOWN.has(a.bucket)).length };
  }
  const rows = assessed.map((a, i) => ({ id: a.id, passed: SHOWN.has((finals[i] as Assessment).bucket), qualifies: a.qualifies }));

  const report: GateReport = { matcher: mode, modelId, testSetSha256, modelCalls: stats.calls, answersReused: stats.reused, badAnswers, secondOpinion, score: scoreGate(rows) };
  const file = join(dir, `report-${(mode === "rules+ai" ? `rules+ai-${modelId}` : (modelId ?? "rules")).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return { report, file };
}
