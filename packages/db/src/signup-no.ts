// C5 (#253): the staff read of the daily count of "no" answers to "Do you need a work permit?" at candidate sign-up (written by
// packages/auth/src/signup.ts, COUNT_NO; table signup_no_count, migration 0044). A date and a number per row, nothing about any visitor.
import type pg from "pg";

export const SIGNUP_NO_DAYS = 366;
// Backward over the primary key on day: at most 366 rows, newest first.
export const SIGNUP_NO_SQL = `select day::text as day, count from signup_no_count order by day desc limit ${SIGNUP_NO_DAYS}`;

/** The last 366 counted UTC days, newest first. A day with no "no" answer has no row. */
export async function signupNoCounts(db: Pick<pg.Pool, "query">): Promise<{ day: string; count: number }[]> {
  return (await db.query(SIGNUP_NO_SQL)).rows;
}
