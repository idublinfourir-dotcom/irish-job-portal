import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The performance tests, kept out of `npm run check` (the root config only looks at *.test.ts). Run: npm run test:perf
// Needs the test database, like the db project. The first project is the page counter's own unit test (no database).
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  test: {
    root,
    projects: [
      { test: { name: "perf-unit", root, include: ["*.unit.ts"] } },
      // TL1: the perf sessions commit like Supabase and CI (synchronous), so vacuum, the visibility map and the plans behave as there; node-postgres reads PGOPTIONS.
      { test: { name: "perf", root, include: ["*.perf.ts"], globalSetup: ["../global-setup.ts"], fileParallelism: false, env: { PGOPTIONS: "-c synchronous_commit=on" } } },
    ],
  },
});
