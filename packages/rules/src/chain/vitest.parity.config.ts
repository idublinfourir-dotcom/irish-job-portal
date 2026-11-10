import { defineConfig } from "vitest/config";

// Only the parity run. Not part of the root config, so `npm run check` never runs it. Run from the repo root:
//   PORTAL_PRIVATE_DATA="/home/nidan73/Brainstorm about Job Portal/step5/parity" npx vitest run --config packages/rules/src/chain/vitest.parity.config.ts --disableConsoleIntercept
export default defineConfig({ test: { include: ["packages/rules/src/chain/*.parity.ts"], testTimeout: 300_000 } });
