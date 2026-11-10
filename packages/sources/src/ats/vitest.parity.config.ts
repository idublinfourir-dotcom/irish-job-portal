import { defineConfig } from "vitest/config";

// Private parity run, NOT part of `npm run check` (it reads saved real responses that never enter the repo).
// From the repo root: PORTAL_PRIVATE_DATA="/home/nidan73/Brainstorm about Job Portal/step5/parity" npx vitest run -c packages/sources/src/ats/vitest.parity.config.ts
export default defineConfig({
  test: { include: ["packages/sources/src/ats/*.parity.ts"], setupFiles: ["./vitest.setup.ts"] },
});
