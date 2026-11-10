import { defineConfig } from "vitest/config";

// Two projects: plain tests, and tests that need the test database (see packages/db/test/README in HANDOVER-4a).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          setupFiles: ["./vitest.setup.ts"],
          include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
          exclude: ["**/node_modules/**", "packages/db/test/**"],
        },
      },
      {
        test: {
          name: "db",
          setupFiles: ["./vitest.setup.ts"],
          include: ["packages/db/test/**/*.test.ts"],
          globalSetup: ["packages/db/test/global-setup.ts"],
        },
      },
    ],
  },
});
