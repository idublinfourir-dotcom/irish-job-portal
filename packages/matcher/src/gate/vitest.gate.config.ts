import { defineConfig } from "vitest/config";

// Only the gate run. Not part of the root config, so `npm run check` never runs it (the include below matches no *.test.ts).
export default defineConfig({ test: { root: import.meta.dirname, include: ["*.gate.ts"], testTimeout: 6 * 60 * 60 * 1000 } });
