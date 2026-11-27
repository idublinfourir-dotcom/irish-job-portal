import { defineConfig } from "drizzle-kit";
import { migrateCredentials } from "./src/migrate-credentials";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: migrateCredentials() as { url: string },
});
