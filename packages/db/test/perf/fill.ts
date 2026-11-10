// Loads fill.sql (the full-size fake fill) into one database. Run as postgres: Supabase's postgres may set session_replication_role,
// which switches triggers and foreign key checks off for the load, as the trial did. Fake data only.
import { readFileSync } from "node:fs";
import type { Client } from "pg";

export const CANDIDATES = 50_000;
export const ORGANISATIONS = 1_000;

// Returns the seconds each step took, so a slow fill shows in the test log.
export async function fill(client: Client, cand = CANDIDATES, orgs = ORGANISATIONS): Promise<number[]> {
  const sql = readFileSync(new URL("./fill.sql", import.meta.url), "utf8")
    .replaceAll(/:cand\b/g, String(cand))
    .replaceAll(/:orgs\b/g, String(orgs));
  await client.query("set session_replication_role = replica");
  const seconds: number[] = [];
  for (const step of sql.split(/^-- @@$/m)) {
    const t = Date.now();
    await client.query(step);
    seconds.push((Date.now() - t) / 1000);
  }
  return seconds;
}
