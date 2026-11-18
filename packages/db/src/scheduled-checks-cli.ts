// The daily reminders (step 15 Q3; 20c "Scheduled" queue): writes the scheduled_check review items staff work by the date. A weekly DETE notice check,
// a monthly hand check of 100 jobs, a 6-monthly big-company review, a quarterly staff role review, and one item per big-company name whose next
// review date (reviewOn, rules_version big_company_names) has come. Each item's key names its period, and review_item_scheduled_key_unique
// (migration 0040) keeps one item per key, so a second run on the same day writes nothing. Staff read and close them at /api/scheduled-checks.
// Run from the repo root with the app_admin login, daily from .github/workflows/daily-fetch.yml:
//   SCHEDULED_ADMIN_DATABASE_URL=... node packages/db/src/scheduled-checks-cli.ts
import pg from "pg";
import { sslOptions } from "./ssl.ts";

/** Each reminder and the staff role that works it (an administrator sees them all). */
export const REMINDER_ROLE = {
  dete_notice_check: "rules_data_editor",
  hand_check_100: "fetched_job_reviewer",
  big_company_review: "rules_data_editor",
  role_review: "administrator",
  big_company_name_review: "rules_data_editor",
} as const;
export type Reminder = { reason: keyof typeof REMINDER_ROLE; key: string; role: string; name?: string; reviewOn?: string };

/** The ISO 8601 week of a day, as "2026-W47". Pure. */
export function isoWeek(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // the Thursday of its week decides the year
  const y = d.getUTCFullYear();
  const w = Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

/** The reminders due on `today` (YYYY-MM-DD, Irish date), given the big-company names in force. Pure. */
export function dueReminders(today: string, names: readonly { name: string; reviewOn: string | null }[]): Reminder[] {
  const y = today.slice(0, 4), m = Number(today.slice(5, 7));
  const r = (reason: Reminder["reason"], period: string, extra: object = {}): Reminder => ({ reason, key: `${reason}:${period}`, role: REMINDER_ROLE[reason], ...extra });
  return [
    r("dete_notice_check", isoWeek(today)),
    r("hand_check_100", today.slice(0, 7)),
    r("big_company_review", `${y}-H${m <= 6 ? 1 : 2}`),
    r("role_review", `${y}-Q${Math.ceil(m / 3)}`),
    ...names.filter((n) => n.reviewOn !== null && n.reviewOn <= today)
      .map((n) => r("big_company_name_review", `${n.name}:${n.reviewOn}`, { name: n.name, reviewOn: n.reviewOn! })),
  ];
}

// Today in Ireland and the big-company names in force (the same pick as rules-admin.ts BIG_NAMES).
export const TODAY_AND_NAMES =
  "select (now() at time zone 'Europe/Dublin')::date::text as today, (select data from rules_version where kind = 'big_company_names' " +
  "and effective_from <= current_date order by effective_from desc, id desc limit 1) as names";
// One statement for every item; a key already written is skipped by the unique index.
export const WRITE_REMINDERS =
  "insert into review_item(queue, reason, detail) select 'scheduled_check', d->>'reason', d - 'reason' from jsonb_array_elements($1::jsonb) d " +
  "on conflict ((detail->>'key')) where queue = 'scheduled_check' do nothing";

export async function writeReminders(db: Pick<pg.ClientBase, "query">): Promise<{ due: number; written: number }> {
  const t = (await db.query<{ today: string; names: { name: string; reviewOn: string | null }[] | null }>(TODAY_AND_NAMES)).rows[0]!;
  const due = dueReminders(t.today, t.names ?? []);
  return { due: due.length, written: (await db.query(WRITE_REMINDERS, [JSON.stringify(due)])).rowCount ?? 0 };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  if (argv.length) return log("usage: scheduled-checks-cli.ts (no arguments)"), 2;
  const url = env.SCHEDULED_ADMIN_DATABASE_URL;
  if (!url) return log("SCHEDULED_ADMIN_DATABASE_URL is not set (the app_admin login)"), 2;
  const client = new pg.Client({ connectionString: url, ssl: sslOptions(env) });
  try {
    await client.connect();
    const r = await writeReminders(client);
    log(`scheduled checks: ${r.due} due, ${r.written} new`);
    return 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
