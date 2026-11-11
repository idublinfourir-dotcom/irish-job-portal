// The page counter: how many 8 kB pages a statement touches, and a check that a whole page stays under a budget.
// A page of the site runs several statements, so the budget is for them together (design section 8: planning + execution + serialisation).
import type { ClientBase } from "pg";

export type PageCost = {
  sql: string;
  pages: number; // planning + execution + serialisation: what the budget counts
  planning: number;
  execution: number;
  serialisation: number;
  ms: number; // execution plus serialisation time
  scans: string; // the index and scan names the plan used, so a bad plan is readable in the failure
};

type Buffers = { "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number };
const blocks = (b: Buffers = {}) => (b["Shared Hit Blocks"] ?? 0) + (b["Shared Read Blocks"] ?? 0);
type Node = Buffers & { "Node Type": string; "Index Name"?: string; Plans?: Node[] };
const scansOf = (n: Node): string[] => [
  ...(n["Node Type"].includes("Scan") ? [n["Index Name"] ?? n["Node Type"]] : []),
  ...(n.Plans ?? []).flatMap(scansOf),
];

// Turns one EXPLAIN (ANALYZE, BUFFERS, SERIALIZE, FORMAT JSON) result into a PageCost. Pure, so a unit test can feed it a canned plan.
export function costOf(sql: string, explain: unknown): PageCost {
  const top = (explain as { Plan: Node; Planning?: Buffers; Serialization?: Buffers & { Time?: number }; "Execution Time": number }[])[0]!;
  const planning = blocks(top.Planning);
  const execution = blocks(top.Plan);
  const serialisation = blocks(top.Serialization);
  return {
    sql, planning, execution, serialisation, pages: planning + execution + serialisation,
    ms: Math.round((top["Execution Time"] + (top.Serialization?.Time ?? 0)) * 100) / 100,
    scans: [...new Set(scansOf(top.Plan))].join("+"),
  };
}

// A statement is its text, or its text and parameters (the Search module's queries bind their values, so they are explained the same way).
export type Statement = string | { text: string; values: unknown[] };

// Warm pass first, measured pass second, on one connection: a pooled connection has its catalog caches loaded,
// a fresh one pays hundreds of planning pages once (trial: 580 for the first query).
export async function measurePages(client: ClientBase, statements: Statement[]): Promise<PageCost[]> {
  const run = async (q: Statement) =>
    (await client.query(`explain (analyze, buffers, serialize, format json) ${typeof q === "string" ? q : q.text}`, typeof q === "string" ? undefined : q.values)).rows[0]["QUERY PLAN"];
  for (const q of statements) await run(q);
  const out: PageCost[] = [];
  for (const q of statements) out.push(costOf(typeof q === "string" ? q : q.text, await run(q)));
  return out;
}

// The message when the statements of one page together touch more than `budget` pages, else undefined.
export function pageOver(name: string, costs: PageCost[], budget: number): string | undefined {
  const total = costs.reduce((sum, c) => sum + c.pages, 0);
  if (total <= budget) return undefined;
  const worst = costs.reduce((a, b) => (b.pages > a.pages ? b : a));
  return `page "${name}" touched ${total} pages, budget ${budget}. Worst statement ${worst.pages} pages (planning ${worst.planning}, execution ${worst.execution}, serialisation ${worst.serialisation}, plan ${worst.scans}): ${worst.sql.replace(/\s+/g, " ").slice(0, 300)}`;
}

// Fails the test when a page is over its budget. Later changes call it with their own statements.
export function assertPageBudget(name: string, costs: PageCost[], budget: number): void {
  const over = pageOver(name, costs, budget);
  if (over) throw new Error(over);
}
