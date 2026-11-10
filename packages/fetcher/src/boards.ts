// One BoardTask per board of the prototype's boards.json (run_day.py:310-319). Pure: the network `fetch` comes in as a parameter.
import { fetchAmazon, fetchAshby, fetchGreenhouse, fetchSmartRecruiters, fetchWorkday, type Fetch } from "@portal/sources";
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
const NO_ADAPTER = ["lever", "workable", "recruitee"];

export function atsTasks(config: BoardsFile, fetch: Fetch, log: (line: string) => void = () => {}): BoardTask[] {
  const tasks: BoardTask[] = [];
  for (const [kind, adapter] of Object.entries(SLUG_KINDS))
    for (const [slug, employer] of config[kind as keyof typeof SLUG_KINDS] ?? [])
      tasks.push({ kind, board: slug, fetch: (known) => adapter({ slug, employer }, known, fetch) });
  for (const [employer, tenant, wd, site] of config.workday ?? [])
    tasks.push({ kind: "workday", board: tenant, fetch: (known) => fetchWorkday({ employer, tenant, wd, site }, known, fetch) });
  if (config.amazon) tasks.push({ kind: "amazon", board: "amazon", fetch: (known) => fetchAmazon(undefined, known, fetch) });
  for (const kind of NO_ADAPTER) {
    const n = Array.isArray(config[kind]) ? (config[kind] as unknown[]).length : 0;
    if (n) log(`skipped ${n} ${kind} boards: no adapter`);
  }
  return tasks;
}
