import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { sslOptions } from "./ssl";

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

export async function checkDatabase(): Promise<boolean> {
  try {
    await getPool().query("select 1");
    return true;
  } catch {
    return false;
  }
}
