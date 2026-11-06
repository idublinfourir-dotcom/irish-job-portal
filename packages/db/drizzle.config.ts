import { defineConfig } from "drizzle-kit";
import { sslOptions } from "./src/ssl";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL_MIGRATE ?? "", ssl: sslOptions() },
});
