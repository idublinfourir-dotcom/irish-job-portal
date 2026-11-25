import { PASS_ROUTE, type Assessment, type AdvertInput } from "@portal/rules";
import type { BatchResult } from "./batch";

/** Buckets the site shows with the Critical Skills badge (PASS_ROUTE). */
export const SHOWN: ReadonlySet<Assessment["bucket"]> = new Set(Object.keys(PASS_ROUTE) as Assessment["bucket"][]);

/**
 * The rule for one badge job. `highPay` is the snapshot's non-list minimum (#229, today 68,911): pay over it opens the route for any occupation
 * not on the Ineligible list. Stated pay over it (high pay route): the AI's pick must not be on the Ineligible list ("none" is fine).
 * Otherwise (Critical Skills list route): the pick must be on the Critical Skills list with confidence medium or high.
 * A model fault or an unusable answer keeps nothing: the fetcher asks again next run (#298).
 */
export function keepsBadge(result: BatchResult, salaryLow: number | null, highPay: number): boolean {
  if (result.failure) return false;
  if (salaryLow !== null && salaryLow > highPay) return result.entry?.list !== "ineligible";
  return result.entry?.list === "critical-skills" && (result.match.confidence === "medium" || result.match.confidence === "high");
}

/**
 * The AI as a second opinion. `rows` are adverts with the assessment the rules chain gave them, in any order. Only a badge (SHOWN bucket) goes
 * to the AI, `batchSize` adverts a request. A badge that does not stay gets the stage "5 unsure occupation" (no badge; the advert row keeps the stage and the model).
 * `highPay`: see `keepsBadge`. Returns the assessments in the order given. `checkBatch` throwing stops everything: the caller decides what a model error means.
 */
export async function applySecondOpinion(
  rows: readonly { advert: AdvertInput; assessment: Assessment }[],
  checkBatch: (adverts: { title: string; description: string }[]) => Promise<BatchResult[]>,
  highPay: number,
  batchSize = 10,
): Promise<Assessment[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batch size must be a whole number of at least 1");
  const out = rows.map((r) => r.assessment);
  const badges = rows.flatMap((r, i) => (SHOWN.has(r.assessment.bucket) ? [i] : []));
  for (let at = 0; at < badges.length; at += batchSize) {
    const chunk = badges.slice(at, at + batchSize);
    const results = await checkBatch(chunk.map((i) => ({ title: rows[i]!.advert.title ?? "", description: rows[i]!.advert.description ?? "" })));
    if (results.length !== chunk.length) throw new Error("the batch check gave a different number of results than adverts");
    chunk.forEach((i, k) => {
      const a = rows[i]!.assessment;
      if (!keepsBadge(results[k]!, a.salaryLow, highPay)) out[i] = { ...a, stage: "5 unsure occupation (admin queue)", bucket: "queue" };
    });
  }
  return out;
}
