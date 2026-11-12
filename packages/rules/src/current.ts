// The rules the apps use, loaded once per process (#229). Today: version 1 and the data files, bundled as imports so a serverless build ships
// them. The combine points this one function at the database loader (packages/db/src/rules-data.ts, loadRules).
import occupationLists from "../../fetcher/data/occupation-lists.json";
import publicPayEmployers from "../../fetcher/data/L2/public_employers_candidates.json";
import { checkSnapshot, snapshotOf, type RulesSnapshot } from "./snapshot";

let rules: Promise<RulesSnapshot> | undefined;
export const getRules = (): Promise<RulesSnapshot> => (rules ??= Promise.resolve().then(() => checkSnapshot(snapshotOf(occupationLists, publicPayEmployers))));
