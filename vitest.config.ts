import { defineConfig } from "vitest/config";

// Two projects: plain tests, and tests that need the test database (see packages/db/test/README in HANDOVER-4a).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          setupFiles: ["./vitest.setup.ts"],
          include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "packages/db/test/**", "packages/fetcher/test/**"],
        },
      },
      {
        test: {
          name: "db",
          setupFiles: ["./vitest.setup.ts"],
          include: ["packages/db/test/**/*.test.ts", "packages/fetcher/test/**/*.test.ts"],
          globalSetup: ["packages/db/test/global-setup.ts"],
        },
      },
    ],
  },
});
