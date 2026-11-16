// The daily job expiry (D7, #48): closes employer and agency jobs past their 30 days and queues one reminder 3 days before the end
// (private.expire_employer_jobs, migration 0019). Run from the repo root with the app_admin login, daily from .github/workflows/daily-fetch.yml:
//   EXPIRY_ADMIN_DATABASE_URL=... node packages/db/src/job-expiry-cli.ts
import pg from "pg";
import { sslOptions } from "./ssl.ts";

// #93: an employer or agency job that has been under review for 30 days closes as 'under_review_expired' (job.under_review_since, migration 0027).
// One statement; a job under review for less, a restored job and a fetched job are not touched. The closed_at trigger is not needed: it is set here.
export const CLOSE_UNDER_REVIEW =
  "update job set status = 'closed', closed_at = now(), close_reason = 'under_review_expired' " +
  "where source in ('employer','agency') and status = 'under_review' and under_review_since <= now() - interval '30 days'";

export async function expireJobs(db: Pick<pg.ClientBase, "query">): Promise<{ closed: number; reminded: number; underReviewClosed: number }> {
  const r = (await db.query("select private.expire_employer_jobs() r")).rows[0].r;
  return { ...r, underReviewClosed: (await db.query(CLOSE_UNDER_REVIEW)).rowCount ?? 0 };
}

export const expiryLine = (r: { closed: number; reminded: number; underReviewClosed: number }) =>
  `${r.closed} employer jobs closed as expired, ${r.reminded} expiry reminders queued, ${r.underReviewClosed} jobs closed after 30 days under review`;

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  if (argv.length) return log("usage: job-expiry-cli.ts (no arguments)"), 2;
  const url = env.EXPIRY_ADMIN_DATABASE_URL;
  if (!url) return log("EXPIRY_ADMIN_DATABASE_URL is not set (the app_admin login)"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    const r = await expireJobs(client);
    log(expiryLine(r));
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
