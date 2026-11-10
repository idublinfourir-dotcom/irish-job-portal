import { defineConfig } from "vitest/config";

// Only the parity run. Not part of the root config, so `npm run check` never runs it.
export default defineConfig({ test: { include: ["packages/rules/src/readers/*.parity.ts"], testTimeout: 120_000 } });
