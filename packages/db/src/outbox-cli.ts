// The outbox sender (8.1b): sends the pending email_outbox rows through Brevo, oldest first, as app_admin (the admin app's DATABASE_URL).
//   DATABASE_URL=... BREVO_API_KEY=... EMAIL_FROM=... node packages/db/src/outbox-cli.ts [--batch N]
// A row is marked `sending` (attempts + 1) in its own committed statement BEFORE Brevo is called, so a crash never sends it twice; a row
// left in `sending` by a crash is a human's call (look at it, then set it to pending or dropped). After MAX_ATTEMPTS failed tries a row is `failed`.
// A row with no address (person erased or deleted, invite gone) is `dropped`; account_deleted uses params.email. Two runs at once share the work (skip locked).
// A `job_alert` row (step 11, one per candidate per run) is built at send time: each alert in its params that is still active and belongs to the row's
// candidate, with its jobs that are still live (job-alert-email.ts). Nothing left, or a row older than 3 days (D4): `dropped`. It needs SITE_URL (https).
// The wording is PLACEHOLDER text until the real templates exist. Logs hold counts and row ids only, never an address or the key.
import pg from "pg";
import { createBrevoMail, type SendMail } from "../../auth/src/brevo.ts";
import { buildAlertEmail, parseAlerts, siteOrigin, type AlertRow, type JobRow } from "./job-alert-email.ts";
import { sslOptions } from "./ssl.ts";

export const MAX_ATTEMPTS = 3;
export const DEFAULT_BATCH = 50;
export const MAX_BATCH = 200;
export const ALERT_MAX_AGE_MS = 3 * 86_400_000; // D4: a job alert queued more than 3 days ago is stale, not sent

export const CLAIM =
  "with c as (select id from email_outbox where status = 'pending' and send_after <= now() order by send_after, id limit $1 for update skip locked) " +
  "update email_outbox o set status = 'sending', attempts = o.attempts + 1 from c where o.id = c.id returning o.id, o.template, o.attempts, o.send_after, o.candidate_user_id, case when o.template = 'job_alert' then o.params end as params";
// The alerts of the claimed job_alert rows (still active) and the jobs they name (still live): two statements for the whole batch.
export const ALERTS =
  "select a.id::text as id, a.candidate_user_id, a.occupation_code, a.sector, a.county, a.salary_min, a.badge, a.frequency, a.unsubscribe_token from alert a " +
  "join candidate_user u on u.id = a.candidate_user_id and u.suspended_at is null and u.deleted_at is null where a.id = any($1::bigint[]) and a.status = 'active'";
export const LIVE_JOBS =
  "select id::text as id, title, employer_name, county, salary_low, salary_high, pay_grade from job where id = any($1::bigint[]) and status = 'live' and not quota_full and closes_at > now()";
export const PENDING_ALERTS = "select exists(select 1 from email_outbox where template = 'job_alert' and status = 'pending') as any";
export const ADDRESSES =
  "select o.id, coalesce(cu.email, pu.email, su.email, mu.email, m.invited_email, cm.from_email, " +
  // The deleted-account notice goes to a login that is already deleted, so its address is the one deleteAccount copied into params;
  // so does a deletion_on_hold email to a login deleted while an open case holds its erasure (run_retention, 0041).
  "case when o.template in ('account_deleted', 'deletion_on_hold') then o.params->>'email' end) as email from email_outbox o " +
  "left join candidate_user cu on cu.id = o.candidate_user_id and cu.deleted_at is null " +
  "left join portal_user pu on pu.id = o.portal_user_id and pu.deleted_at is null " +
  "left join staff_user su on su.id = o.staff_user_id " +
  "left join membership m on m.id = o.membership_id left join portal_user mu on mu.id = m.portal_user_id and mu.deleted_at is null " +
  "left join contact_message cm on cm.id = o.contact_message_id where o.id = any($1::bigint[])";

export const noticeText = (template: string): [string, string] => [
  "A notice about your account on the portal",
  `PLACEHOLDER WORDING.\n\nYou have a new notice (${template.replace(/[^\w-]/g, "").slice(0, 60)}). Please sign in to read it.\n`,
];

export type Result = { sent: number; retry: number; failed: number; dropped: number };

type Claimed = { id: string; template: string; attempts: number; send_after: Date; candidate_user_id: string | null; params: unknown };

export async function sendPending(c: pg.Pool | pg.Client, send: SendMail, batch = DEFAULT_BATCH, log: (line: string) => void = () => {}, siteUrl?: string): Promise<Result> {
  const out: Result = { sent: 0, retry: 0, failed: 0, dropped: 0 };
  const rows = (await c.query<Claimed>(CLAIM, [Math.min(Math.max(batch, 1), MAX_BATCH)])).rows;
  if (!rows.length) return out;
  const to = new Map((await c.query<{ id: string; email: string | null }>(ADDRESSES, [rows.map((r) => r.id)])).rows.map((r) => [r.id, r.email]));
  rows.sort((a, b) => +a.send_after - +b.send_after || Number(a.id) - Number(b.id)); // update ... returning has no order
  const fresh = (r: Claimed) => Date.now() - +r.send_after <= ALERT_MAX_AGE_MS;
  const wanted = rows.filter((r) => r.template === "job_alert" && to.get(r.id) && fresh(r)).map((r) => ({ r, alerts: parseAlerts(r.params) }));
  const ids = (pick: (a: ReturnType<typeof parseAlerts>[number]) => string[]) => [...new Set(wanted.flatMap((w) => w.alerts.flatMap(pick)))];
  const found = new Map<string, AlertRow>(), live = new Map<string, JobRow>();
  if (wanted.length) {
    for (const a of (await c.query<AlertRow>(ALERTS, [ids((a) => [a.alertId])])).rows) found.set(a.id, a);
    for (const j of (await c.query<JobRow>(LIVE_JOBS, [ids((a) => a.jobIds)])).rows) live.set(j.id, j);
  }
  const alertsOf = new Map(wanted.map((w) => [w.r.id, w.alerts]));
  const done = (id: string, status: string) => c.query("update email_outbox set status = $2::text, sent_at = case when $2::text = 'sent' then now() end where id = $1 and status = 'sending'", [id, status]);
  for (const r of rows) {
    const email = to.get(r.id);
    if (!email) { await done(r.id, "dropped"); out.dropped++; continue; }
    try {
      let mail: [string, string, Record<string, string>?] = noticeText(r.template);
      if (r.template === "job_alert") {
        const site = siteOrigin(siteUrl);
        if (!site) throw new Error("SITE_URL is not an https address");
        const built = fresh(r) && r.candidate_user_id ? buildAlertEmail(r.candidate_user_id, alertsOf.get(r.id) ?? [], found, live, site) : null;
        if (!built) { await done(r.id, "dropped"); out.dropped++; continue; }
        mail = [built.subject, built.text, built.headers];
      }
      await send(email, ...mail);
      await done(r.id, "sent"); out.sent++;
    } catch (e) {
      const last = r.attempts >= MAX_ATTEMPTS;
      await done(r.id, last ? "failed" : "pending");
      out[last ? "failed" : "retry"]++;
      log(`row ${r.id} try ${r.attempts}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function parseBatch(argv: string[]): number | undefined {
  if (!argv.length) return DEFAULT_BATCH;
  const n = Number(argv[1]);
  return argv.length === 2 && argv[0] === "--batch" && /^\d{1,3}$/.test(argv[1]!) && n >= 1 && n <= MAX_BATCH ? n : undefined;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void, send?: SendMail): Promise<number> {
  const batch = parseBatch(argv);
  if (batch === undefined) return log(`usage: outbox-cli.ts [--batch 1..${MAX_BATCH}]`), 2;
  if (!env.DATABASE_URL) return log("DATABASE_URL is not set (the admin app's login, app_admin)"), 2;
  let mail = send;
  if (!mail) {
    if (!env.BREVO_API_KEY || !env.EMAIL_FROM) return log("BREVO_API_KEY and EMAIL_FROM must both be set; nothing was sent"), 2;
    mail = createBrevoMail({ apiKey: env.BREVO_API_KEY, from: env.EMAIL_FROM });
  }
  const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: sslOptions(env) });
  try {
    await client.connect();
    if ((await client.query<{ any: boolean }>(PENDING_ALERTS)).rows[0]!.any && !siteOrigin(env.SITE_URL)) return log("SITE_URL must be set to an https:// address to send job alerts; nothing was sent"), 2;
    const r = await sendPending(client, mail, batch, log, env.SITE_URL);
    log(`outbox: sent ${r.sent}, to retry ${r.retry}, failed for good ${r.failed}, dropped (no address, nothing to send or too old) ${r.dropped}`);
    return r.retry + r.failed ? 1 : 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
