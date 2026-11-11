import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { sslOptions } from "./ssl";

export * from "./dete";

type Db = NodePgDatabase<typeof schema>;

// One pool per running instance. Dev reloads and repeated imports reuse it.
const shared = globalThis as typeof globalThis & { __portalPool?: pg.Pool; __portalDb?: Db };

export function getPool(): pg.Pool {
  if (shared.__portalPool) return shared.__portalPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({
    connectionString,
    // Small because many instances can share one pooler.
    max: 5,
    // Reconnecting took about 17 ms in the Vercel check, so a short idle limit costs little.
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 8000,
    ssl: sslOptions(),
  });
  // Without this handler, a dropped idle connection is an uncaught exception.
  pool.on("error", (error) => console.error("database pool error:", error.message));
  attachDatabasePool(pool);
  shared.__portalPool = pool;
  return pool;
}

export function getDb(): Db {
  shared.__portalDb ??= drizzle(getPool(), { schema });
  return shared.__portalDb;
}

// The health route is public. Reuse the last answer for 5 seconds so a flood of calls cannot take pool connections from real pages.
const HEALTH_TTL_MS = 5000;
let health: { at: number; ok: Promise<boolean> } | undefined;

export function checkDatabase(): Promise<boolean> {
  const now = Date.now();
  if (health && now - health.at < HEALTH_TTL_MS) return health.ok;
  // The promise is stored, so calls made while the query runs share it. A failure is cached just as long as a success.
  const ok = (async () => getPool().query("select 1"))().then(() => true, () => false);
  health = { at: now, ok };
  return ok;
}

/** For tests only. */
export function resetHealthCache() {
  health = undefined;
}
