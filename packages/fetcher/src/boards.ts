// One BoardTask per board of the prototype's boards.json (run_day.py:310-319). Pure: the network `fetch` comes in as a parameter.
import { fetchAmazon, fetchAshby, fetchGreenhouse, fetchSmartRecruiters, fetchWorkday, realSleep, runBudget, type Fetch, type Sleep } from "@portal/sources";
import type { BoardTask } from "./types";

export type BoardsFile = {
  greenhouse?: [slug: string, employer: string][];
  ashby?: [slug: string, employer: string][];
  smartrecruiters?: [slug: string, employer: string][];
  workday?: [employer: string, tenant: string, wd: string, site: string][];
  amazon?: boolean;
  [otherKind: string]: unknown; // lever, workable, recruitee: no adapter, skipped
};

const SLUG_KINDS = { greenhouse: fetchGreenhouse, ashby: fetchAshby, smartrecruiters: fetchSmartRecruiters } as const;
// The list call of greenhouse, ashby and amazon already carries the text, so reading it every day costs no request. For the others it is one request per advert, so a seventh each day.
const REREAD_DAYS = { greenhouse: 1, ashby: 1, amazon: 1, smartrecruiters: 7, workday: 7 } as const;
const NO_ADAPTER = ["lever", "workable", "recruitee"];
/** Every kind `atsTasks` makes a task for. */
export const KINDS: readonly string[] = [...Object.keys(SLUG_KINDS), "workday", "amazon"];

/**
 * The kinds one run fetches, from FETCHER_ONLY_KINDS or FETCHER_SKIP_KINDS (comma lists; blank is unset; both unset is every kind). Workday
 * runs on the engineer's laptop and the rest on GitHub (W1b). Throws, so the run never starts, on both set, an unknown kind or a list of no kinds.
 */
export function kindFilter(only = "", skip = ""): (kind: string) => boolean {
  if (only.trim() && skip.trim()) throw new Error("set FETCHER_ONLY_KINDS or FETCHER_SKIP_KINDS, not both");
  const raw = only.trim() || skip.trim();
  if (!raw) return () => true;
  const list = raw.split(",").map((k) => k.trim()).filter(Boolean);
  const bad = list.filter((k) => !KINDS.includes(k));
  if (!list.length || bad.length) throw new Error(`unknown board kind in FETCHER_${only.trim() ? "ONLY" : "SKIP"}_KINDS: ${JSON.stringify(bad.join(",") || raw)} (known: ${KINDS.join(", ")})`);
  return only.trim() ? (k) => list.includes(k) : (k) => !list.includes(k);
}

/** `sleep` is the one the 429 waits use (a fake in tests). Every board of the run shares one wait budget (PACE.runWaitMs). */
export function atsTasks(config: BoardsFile, fetch: Fetch, log: (line: string) => void = () => {}, sleep: Sleep = realSleep): BoardTask[] {
  const tasks: BoardTask[] = [];
  const opts = { sleep, budget: runBudget() };
  for (const [kind, adapter] of Object.entries(SLUG_KINDS))
    for (const [slug, employer] of config[kind as keyof typeof SLUG_KINDS] ?? [])
      tasks.push({ kind, board: slug, rereadDays: REREAD_DAYS[kind as keyof typeof REREAD_DAYS], fetch: (known) => adapter({ slug, employer }, known, fetch, opts) });
  for (const [employer, tenant, wd, site] of config.workday ?? [])
    // Serial (W1): every Workday company is one domain behind one Cloudflare rate limit, so its boards run one at a time.
    tasks.push({ kind: "workday", board: tenant, serial: true, rereadDays: REREAD_DAYS.workday, fetch: (known) => fetchWorkday({ employer, tenant, wd, site }, known, fetch, opts) });
  if (config.amazon) tasks.push({ kind: "amazon", board: "amazon", rereadDays: REREAD_DAYS.amazon, fetch: (known) => fetchAmazon(undefined, known, fetch, opts) });
  for (const kind of NO_ADAPTER) {
    const n = Array.isArray(config[kind]) ? (config[kind] as unknown[]).length : 0;
    if (n) log(`skipped ${n} ${kind} boards: no adapter`);
  }
  return tasks;
}
