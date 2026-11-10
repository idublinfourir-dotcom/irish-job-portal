// Prints the mutation results as a table: counts per class, then every survivor. Usage: node summary.mjs [results.jsonl]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUTCOMES = ["caught", "survived", "skipped", "error"];

/** @param {{ class?: string, id?: string, object?: string, result?: string, failed?: number, seconds?: number, sql?: string, kind?: string }[]} rows */
export function summarize(rows) {
  const muts = rows.filter((r) => r.kind !== "baseline");
  const classes = [...new Set(muts.map((r) => r.class))].sort();
  const count = (c, o) => muts.filter((r) => r.class === c && r.result === o).length;
  const lines = ["class | run | caught | survived | skipped | error"];
  for (const c of classes) {
    const run = OUTCOMES.reduce((n, o) => n + (o === "skipped" ? 0 : count(c, o)), 0);
    lines.push([c, run, ...OUTCOMES.map((o) => count(c, o))].join(" | "));
  }
  lines.push("", "survivors:");
  for (const r of muts.filter((m) => m.result === "survived")) lines.push(`${r.class} | ${r.object} | ${r.sql}`);
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? "results.jsonl";
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(summarize(rows));
}
