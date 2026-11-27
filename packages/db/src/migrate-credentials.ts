import { sslOptions } from "./ssl";

type Env = Record<string, string | undefined>;

// drizzle-kit keeps only `url` when a url is given and drops `ssl` (drizzle-kit 0.31.11 bin.cjs, postgresCredentials), so it opened its pool
// without TLS and Supabase (Enforce SSL) refused it. Passing the parts instead keeps `ssl` (audit DEP-5). An empty url stays a url so
// drizzle-kit's own "no credentials" message still shows when the variable is unset.
export function migrateCredentials(env: Env = process.env) {
  const raw = env.DATABASE_URL_MIGRATE ?? "";
  if (!raw) return { url: "" };
  const u = new URL(raw);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    ssl: sslOptions(env),
  };
}
