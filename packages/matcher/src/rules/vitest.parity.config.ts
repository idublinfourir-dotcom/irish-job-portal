import { defineConfig } from "vitest/config";

// Not part of `npm run check`. Run from the repo root:
// PORTAL_PRIVATE_DATA="/home/nidan73/Brainstorm about Job Portal/step5/parity" npx vitest run --config packages/matcher/src/rules/vitest.parity.config.ts
export default defineConfig({
  test: { root: import.meta.dirname, include: ["*.parity.ts"] },
});
