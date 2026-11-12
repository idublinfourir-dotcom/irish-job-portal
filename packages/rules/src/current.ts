// Version 1 of the rules (#229): today's constants and the data files, bundled as imports. For tests and the seed's check only: the apps and the
// fetch read the rules in force from the database (`getRules(db)` in packages/db/src/rules-data.ts).
import occupationLists from "../../fetcher/data/occupation-lists.json";
import publicPayEmployers from "../../fetcher/data/L2/public_employers_candidates.json";
import { checkSnapshot, snapshotOf, type RulesSnapshot } from "./snapshot";

let rules: Promise<RulesSnapshot> | undefined;
export const rulesV1 = (): Promise<RulesSnapshot> => (rules ??= Promise.resolve().then(() => checkSnapshot(snapshotOf(occupationLists, publicPayEmployers))));
