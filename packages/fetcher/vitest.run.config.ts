import { defineConfig } from "vitest/config";

// The real run of the fetcher on the laptop, NOT part of `npm test` (it calls real job boards). From the repo root:
//   FETCHER_DATABASE_URL=... FETCHER_BOARDS_FILE=... PORTAL_PRIVATE_DATA=... npx vitest run --config packages/fetcher/vitest.run.config.ts
// No setup file: vitest.setup.ts refuses the real network. 70 minute timeout (the run itself stops assessing at 55).
export default defineConfig({
  test: { include: ["packages/fetcher/run/*.run.ts"], testTimeout: 70 * 60 * 1000, hookTimeout: 60 * 1000 },
});
