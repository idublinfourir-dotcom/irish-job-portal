import type { Assessment, AdvertInput } from "@portal/rules";
import type { BatchResult } from "./batch";

/** Buckets the site shows with the Critical Skills badge (stated pay, big company rule, the two public pay tiers). */
export const SHOWN = new Set<Assessment["bucket"]>(["stated_pay", "big_company", "public_hse", "public_s38"]);

/** Pay over this opens the route for any occupation not on the Ineligible list (DETE, read 10 November 2026). */
export const HIGH_PAY = 68_911;

/**
 * The rule for one badge job. Stated pay over 68,911 (high pay route): the AI's pick must not be on the Ineligible list ("none" is fine).
 * Otherwise (Critical Skills list route): the pick must be on the Critical Skills list with confidence medium or high.
 * A model fault or an unusable answer keeps nothing: the job goes to the admin queue.
 */
export function keepsBadge(result: BatchResult, salaryLow: number | null): boolean {
  if (result.failure) return false;
  if (salaryLow !== null && salaryLow > HIGH_PAY) return result.entry?.list !== "ineligible";
  return result.entry?.list === "critical-skills" && (result.match.confidence === "medium" || result.match.confidence === "high");
}

/**
 * The AI as a second opinion. `rows` are adverts with the assessment the rules chain gave them, in any order. Only a badge (SHOWN bucket) goes
 * to the AI, `batchSize` adverts a request. A badge that does not stay moves to the admin queue (stage "5 unsure occupation"), never a silent drop.
 * Returns the assessments in the order given. `checkBatch` throwing stops everything: the caller decides what a model error means.
 */
export async function applySecondOpinion(
  rows: readonly { advert: AdvertInput; assessment: Assessment }[],
  checkBatch: (adverts: { title: string; description: string }[]) => Promise<BatchResult[]>,
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
      if (!keepsBadge(results[k]!, a.salaryLow)) out[i] = { ...a, stage: "5 unsure occupation (admin queue)", bucket: "queue" };
    });
  }
  return out;
}
