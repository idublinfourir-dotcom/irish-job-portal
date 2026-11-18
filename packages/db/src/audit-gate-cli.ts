// The dependency audit gate of check.yml: `npm audit --json | node packages/db/src/audit-gate-cli.ts`. Fails on any high or critical advisory
// except the ones listed in IGNORED, each with its reason. npm audit has no flag to skip one advisory, hence this file.

// Remove an entry as soon as its package ships a fixed version (`npm audit` then shows a fix), and say so in TRACKER.md.
export const IGNORED: Record<string, string> = {
  // picomatch ReDoS (CVSS 7.5), widened on 17 Nov 2026 to every version up to 4.0.7 with no fix. Only vitest, vite, tinyglobby and
  // eslint-config-next load picomatch, on glob patterns we write; no app loads it and no visitor input reaches it.
  "GHSA-fc5q-39xc-vjpf": "picomatch ReDoS, dev tools only, no fixed version yet (18 Nov 2026)",
};

type Via = string | { url?: string; severity?: string; title?: string };
type Report = { vulnerabilities?: Record<string, { via?: Via[] }>; metadata?: unknown };

/** The high or critical advisories not in `ignored`, as "GHSA-... title" lines, each once. A package that is vulnerable only through another (`via` a name) adds nothing. */
export function blocking(report: Report, ignored: Record<string, string> = IGNORED): string[] {
  const out = new Set<string>();
  for (const v of Object.values(report.vulnerabilities ?? {}))
    for (const via of v.via ?? []) {
      if (typeof via === "string" || (via.severity !== "high" && via.severity !== "critical")) continue;
      const id = via.url?.match(/GHSA(-[a-z0-9]{4}){3}/)?.[0] ?? via.url ?? "unknown advisory";
      if (!(id in ignored)) out.add(`${id} ${via.severity} ${via.title ?? ""}`.trim());
    }
  return [...out];
}

if (import.meta.main) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const report = JSON.parse(text) as Report; // unreadable JSON throws: the step fails, never passes by mistake
  // npm prints {"error": ...} when it cannot reach the registry: that is no audit, so it fails too
  if (!report.metadata) throw new Error(`npm audit gave no report: ${text.slice(0, 300)}`);
  const left = blocking(report);
  for (const id of Object.keys(IGNORED)) console.log(`ignored: ${id}: ${IGNORED[id]}`);
  for (const line of left) console.log(`blocking: ${line}`);
  process.exitCode = left.length ? 1 : 0;
}
