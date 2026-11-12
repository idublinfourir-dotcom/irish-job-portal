// The rules data the fetched-job queue's approve step needs, built from the files the scheduled fetch reads (packages/fetcher/data), the way the queue's
// own tests build it. The step 13 combine points this at the shared rules (13a and 13b). Loaded once per process, on the first approve.
import { cleanEmployerName } from "@portal/rules";
import type { RulesData } from "@portal/db";
import lists from "../../../packages/fetcher/data/occupation-lists.json";
import dete from "../../../packages/fetcher/data/L2/dete-2026.json";
import publicPay from "../../../packages/fetcher/data/L2/public_employers_candidates.json";

let data: RulesData | undefined;
export function queueRules(): RulesData {
  return (data ??= {
    chain: {
      deteNames: new Set((dete as [string, number][]).map(([n]) => cleanEmployerName(n))),
      publicPayCandidates: new Map(Object.entries(publicPay as Record<string, { tier: 1 | 2 }>).map(([k, v]) => [k, v.tier])),
    },
    lists: lists as RulesData["lists"],
  });
}
