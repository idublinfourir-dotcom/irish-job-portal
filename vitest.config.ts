import { defineConfig } from "vitest/config";

// Wall-clock budgets run beside the rest of the suite, so a busy machine can make one a few milliseconds late (24 Nov 2026: main was red on four, all in
// files the change did not touch; each passed alone). A test that fails ONLY on a clock number (a long decimal "to be less than" a limit) gets two more
// tries, half a second apart. Anything else is never tried again: a statement count, a wrong answer or a refused access fails at once. A test that is
// really too slow fails all three.
export const CLOCK_RETRY = { count: 2, delay: 500, condition: /expected \d+\.\d{4,} to be less than/ };

// Two projects: plain tests, and tests that need the test database (see packages/db/test/README in HANDOVER-4a).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          retry: CLOCK_RETRY,
          setupFiles: ["./vitest.setup.ts"],
          include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "packages/db/test/**", "packages/fetcher/test/**"],
        },
      },
      {
        test: {
          name: "db",
          retry: CLOCK_RETRY,
          setupFiles: ["./vitest.setup.ts"],
          include: ["packages/db/test/**/*.test.ts", "packages/fetcher/test/**/*.test.ts"],
          globalSetup: ["packages/db/test/global-setup.ts"],
        },
      },
    ],
  },
});
