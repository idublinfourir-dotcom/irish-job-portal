import { cleanEmployerName } from "./name";
import { pyRound2, pySum } from "./py-text";

// R23 employer name suggestion. Python: prototype/employer_match.py (whole file). Suggestions only, never merged (#30).

// employer_match.py:11-13
export const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "care", "health", "healthcare", "hospital", "medical", "clinic", "nursing", "home", "homes", "centre", "center",
  "recruitment", "solutions", "systems", "consulting", "global", "dublin", "cork", "galway", "limerick", "irl",
  "and", "of", "st", "saint", "community", "private", "network", "university", "people", "jobs", "management",
]); // prettier-ignore

export type NameSuggestion = {
  name: string | null;
  score: number;
  kind: "exact" | "only generic words" | "no candidate" | "suggested";
};

// employer_match.py:15-16. (The Python also strips "'" but the cleaning has already removed it.)
const words = (cleaned: string): string[] => cleaned.split(" ").filter((t) => t.length > 1);
const tokens = (name: string): string[] => words(cleanEmployerName(name));

/**
 * Python: class Matcher. `names` is the candidate list (DETE names, or WRC names), duplicates included: a
 * duplicate counts twice in the word frequencies, as in the Python.
 * Ties: the Python picks by set order, which changes with the hash seed. Here the first candidate in list order wins.
 */
export function buildNameMatcher(names: readonly string[]): { suggest(name: string, skip?: (candidate: string) => boolean): NameSuggestion } {
  const exact = new Map<string, string>();
  const index = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  const nameTokens = new Map<string, Set<string>>(); // each candidate's words, cleaned once (24,000 DETE names: cleaning per candidate per query took seconds)
  for (const n of names) {
    let ts = nameTokens.get(n);
    if (!ts) {
      const k = cleanEmployerName(n);
      if (!exact.has(k)) exact.set(k, n);
      nameTokens.set(n, (ts = new Set(words(k))));
    }
    for (const t of ts) {
      df.set(t, (df.get(t) ?? 0) + 1);
      (index.get(t) ?? index.set(t, new Set()).get(t)!).add(n);
    }
  }
  const idf = new Map<string, number>();
  for (const [t, f] of df) idf.set(t, Math.log(names.length / f));

  // `skip` (not in the Python): a candidate the caller rules out, such as a pair staff rejected (packages/db/src/dete-links.ts).
  const suggest = (name: string, skip?: (candidate: string) => boolean): NameSuggestion => {
    const hit = exact.get(cleanEmployerName(name));
    if (hit !== undefined && !skip?.(hit)) return { name: hit, score: 1.0, kind: "exact" };
    const allTokens = tokens(name);
    const distinctive = allTokens.filter((t) => !GENERIC_WORDS.has(t));
    if (distinctive.length === 0) return { name: null, score: 0.0, kind: "only generic words" };
    if (distinctive.some((t) => !idf.has(t))) return { name: null, score: 0.0, kind: "no candidate" };
    const ts = allTokens.filter((t) => idf.has(t));
    let best: string | null = null;
    let bestScore = 0.0;
    const weight = pySum(ts.map((t) => idf.get(t)!));
    // A candidate must hold every distinctive word, so the first word's names are all of them, in the order the union of every word's names had them.
    for (const cand of index.get(distinctive[0]!)!) {
      if (skip?.(cand)) continue;
      const ct = nameTokens.get(cand)!;
      // every distinctive word of the job's employer must appear in the candidate
      if (!distinctive.every((t) => ct.has(t))) continue;
      const shared = ts.filter((t) => ct.has(t));
      const extra = pySum([...ct].filter((t) => !ts.includes(t) && !GENERIC_WORDS.has(t)).map((t) => idf.get(t) ?? 0));
      const s = pySum(shared.map((t) => idf.get(t)!)) / (weight + 0.5 * extra);
      if (s > bestScore) [best, bestScore] = [cand, s];
    }
    return best ? { name: best, score: pyRound2(bestScore), kind: "suggested" } : { name: null, score: 0.0, kind: "no candidate" };
  };
  return { suggest };
}
