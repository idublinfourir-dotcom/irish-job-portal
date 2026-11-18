// The daily job alert run (#236 Q1, D2, D3): private.queue_job_alerts (0024_job_alerts.sql) writes one job_alert email_outbox row per candidate
// with new jobs and stamps every due alert. The outbox command sends the rows later. Run from the repo root with the app_admin login, daily from
// .github/workflows/daily-fetch.yml after the fetch and before the retention step:
//   ALERTS_ADMIN_DATABASE_URL=... node packages/db/src/alerts-run-cli.ts
import pg from "pg";
import { sslOptions } from "./ssl.ts";

export type AlertRun = { alerts_due: number; candidates_queued: number; rows_written: number; alerts_paused: number };

export async function queueAlerts(db: Pick<pg.ClientBase, "query">, now?: Date): Promise<AlertRun> {
  return (await db.query("select private.queue_job_alerts(coalesce($1::timestamptz, now())) r", [now ?? null])).rows[0].r;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  if (argv.length) return log("usage: alerts-run-cli.ts (no arguments)"), 2;
  const url = env.ALERTS_ADMIN_DATABASE_URL;
  if (!url) return log("ALERTS_ADMIN_DATABASE_URL is not set (the app_admin login)"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    const r = await queueAlerts(client);
    log(`job alerts: ${r.alerts_due} alerts due, ${r.candidates_queued} candidates queued, ${r.rows_written} emails written, ${r.alerts_paused} paused for dormancy`);
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
