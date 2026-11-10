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
const tokens = (name: string): string[] => cleanEmployerName(name).split(" ").filter((t) => t.length > 1);

/**
 * Python: class Matcher. `names` is the candidate list (DETE names, or WRC names), duplicates included: a
 * duplicate counts twice in the word frequencies, as in the Python.
 * Ties: the Python picks by set order, which changes with the hash seed. Here the first candidate in list order wins.
 */
export function buildNameMatcher(names: readonly string[]): { suggest(name: string): NameSuggestion } {
  const exact = new Map<string, string>();
  const index = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const n of names) {
    if (!exact.has(cleanEmployerName(n))) exact.set(cleanEmployerName(n), n);
    const ts = new Set(tokens(n));
    for (const t of ts) {
      df.set(t, (df.get(t) ?? 0) + 1);
      (index.get(t) ?? index.set(t, new Set()).get(t)!).add(n);
    }
  }
  const idf = new Map<string, number>();
  for (const [t, f] of df) idf.set(t, Math.log(names.length / f));

  const suggest = (name: string): NameSuggestion => {
    const hit = exact.get(cleanEmployerName(name));
    if (hit !== undefined) return { name: hit, score: 1.0, kind: "exact" };
    const allTokens = tokens(name);
    const distinctive = allTokens.filter((t) => !GENERIC_WORDS.has(t));
    if (distinctive.length === 0) return { name: null, score: 0.0, kind: "only generic words" };
    if (distinctive.some((t) => !idf.has(t))) return { name: null, score: 0.0, kind: "no candidate" };
    const ts = allTokens.filter((t) => idf.has(t));
    let best: string | null = null;
    let bestScore = 0.0;
    const weight = pySum(ts.map((t) => idf.get(t)!));
    const candidates = new Set<string>();
    for (const t of distinctive) for (const c of index.get(t)!) candidates.add(c);
    for (const cand of candidates) {
      const ct = new Set(tokens(cand));
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
