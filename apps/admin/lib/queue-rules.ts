// The rules data the fetched-job queue's approve step needs (#229): the rules in force from the database (`getRules`), and the DETE names from the
// file the scheduled fetch reads (the DETE names stay a file, #229). The names are loaded once per process, on the first approve.
import { chainRules, cleanEmployerName } from "@portal/rules";
import { getRules, type RulesData } from "@portal/db";
import dete from "../../../packages/fetcher/data/L2/dete-2026.json";

let deteNames: ReadonlySet<string> | undefined;
export async function queueRules(db: Parameters<typeof getRules>[0]): Promise<RulesData> {
  const r = await getRules(db);
  deteNames ??= new Set((dete as [string, number][]).map(([n]) => cleanEmployerName(n)));
  return { chain: { deteNames, ...chainRules(r) }, lists: r.occupationLists };
}
