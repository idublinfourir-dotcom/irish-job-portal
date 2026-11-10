import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Not part of `npm run check`. Run from the repo root:
//   PORTAL_PRIVATE_DATA="/home/nidan73/Brainstorm about Job Portal/step5/parity" npx vitest run --config packages/rules/src/employers/vitest.parity.config.ts
const dir = dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root: dir, cacheDir: join(tmpdir(), "l1b-parity-vite"), test: { include: ["*.parity.ts"], testTimeout: 120_000 } });
