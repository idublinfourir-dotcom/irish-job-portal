// The occupation codes a candidate may pick: the two lists the badges use (Critical Skills and ineligible), the same file the fetcher reads.
import lists from "../../../packages/fetcher/data/occupation-lists.json";

export const OCCUPATION_CODES: ReadonlySet<string> = new Set(lists.map((e) => e.code));
