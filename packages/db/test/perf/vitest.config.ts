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
      { test: { name: "perf", root, include: ["*.perf.ts"], globalSetup: ["../global-setup.ts"], fileParallelism: false } },
    ],
  },
});
