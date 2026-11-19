// The outbox sender (8.1b): sends the pending email_outbox rows through Brevo, every other row before job alerts and oldest first in each group (#275), as app_admin (the admin app's DATABASE_URL).
//   DATABASE_URL=... BREVO_API_KEY=... EMAIL_FROM=... [ALERTS_EMAIL_FROM=...] SITE_URL=https://... PORTAL_SITE_URL=https://... node packages/db/src/outbox-cli.ts [--batch N]
// A row is marked `sending` (attempts + 1) in its own committed statement BEFORE Brevo is called, so a crash never sends it twice; a row
// left in `sending` by a crash is a human's call (look at it, then set it to pending or dropped). After MAX_ATTEMPTS failed tries a row is `failed`.
// A row with no address (person erased or deleted, invite gone) is `dropped`; account_deleted uses params.email. Two runs at once share the work (skip locked).
// A `job_alert` row (step 11, one per candidate per run) is built at send time: each alert in its params that is still active and belongs to the row's
// candidate, with its jobs that are still live (job-alert-email.ts). Nothing left, or a row older than 3 days (D4): `dropped`. It needs SITE_URL (https).
// Every email is HTML plus text (E1): a notice says what happened and links to the right site (SITE_URL for a candidate, PORTAL_SITE_URL for
// an employer or agency); both must be https when anything is pending. Job alerts go from ALERTS_EMAIL_FROM when it is set (else EMAIL_FROM):
// Brevo adds its own List-Unsubscribe to every email and a click blocks that one sender, so an alert unsubscribe must not block the notices.
// Logs hold counts and row ids only, never an address or the key. #275: Brevo Free sends 300 a day, so after the run the rows still due and the
// alerts dropped as too old go to a GitHub ::warning:: line and one audit_event row (email_outbox.run, counts only) that the staff digest reads.
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { createBrevoMail, type SendMail } from "../../auth/src/brevo.ts";
import { render, SITE_NAME, type Email } from "../../auth/src/email-layout.ts";
import { buildAlertEmail, parseAlerts, siteOrigin, type AlertRow, type JobRow } from "./job-alert-email.ts";
import { sslOptions } from "./ssl.ts";

export const MAX_ATTEMPTS = 3;
export const DEFAULT_BATCH = 50;
export const MAX_BATCH = 200;
export const ALERT_MAX_AGE_MS = 3 * 86_400_000; // D4: a job alert queued more than 3 days ago is stale, not sent

export const CLAIM =
  "with c as (select id from email_outbox where status = 'pending' and send_after <= now() order by (template = 'job_alert'), send_after, id limit $1 for update skip locked) " +
  "update email_outbox o set status = 'sending', attempts = o.attempts + 1 from c where o.id = c.id returning o.id, o.template, o.attempts, o.send_after, o.candidate_user_id, case when o.template in ('job_alert', 'data_request_confirm', 'staff_digest') then o.params end as params, " +
  "case when o.candidate_user_id is not null then 'candidate' when o.portal_user_id is not null or o.membership_id is not null then 'portal' end as side";
// The alerts of the claimed job_alert rows (still active) and the jobs they name (still live): two statements for the whole batch.
export const ALERTS =
  "select a.id::text as id, a.candidate_user_id, a.occupation_code, a.sector, a.county, a.salary_min, a.badge, a.frequency, a.unsubscribe_token from alert a " +
  "join candidate_user u on u.id = a.candidate_user_id and u.suspended_at is null and u.deleted_at is null where a.id = any($1::bigint[]) and a.status = 'active'";
export const LIVE_JOBS =
  "select id::text as id, title, employer_name, county, salary_low, salary_high, pay_grade from job where id = any($1::bigint[]) and status = 'live' and not quota_full and closes_at > now()";
export const PENDING = "select exists(select 1 from email_outbox where status = 'pending') as any";
// After the run (#275): the rows still due, and one audit row with the run's counts (no address, no id). Both on email_outbox_pending_idx.
export const LEFT = "select count(*)::int as n from email_outbox where status = 'pending' and send_after <= now()";
export const RUN_AUDIT =
  "insert into audit_event(kind, actor_system, action, after, source) values ('admin_action', 'outbox-cli by ' || session_user, 'email_outbox.run', $1::jsonb, 'scheduled_job')";
export const ADDRESSES =
  "select o.id, coalesce(cu.email, pu.email, su.email, mu.email, m.invited_email, cm.from_email, " +
  // The deleted-account notice goes to a login that is already deleted, so its address is the one deleteAccount copied into params;
  // so does a deletion_on_hold email to a login deleted while an open case holds its erasure (run_retention, 0041).
  "case when o.template in ('account_deleted', 'deletion_on_hold') then o.params->>'email' end) as email from email_outbox o " +
  "left join candidate_user cu on cu.id = o.candidate_user_id and cu.deleted_at is null " +
  "left join portal_user pu on pu.id = o.portal_user_id and pu.deleted_at is null " +
  "left join staff_user su on su.id = o.staff_user_id and su.status = 'active' " +
  "left join membership m on m.id = o.membership_id left join portal_user mu on mu.id = m.portal_user_id and mu.deleted_at is null " +
  "left join contact_message cm on cm.id = o.contact_message_id where o.id = any($1::bigint[])";

// Draft wording (E1) until the content writers' final text (N2 stays open). One subject and one sentence per template, from the code and the
// migrations that queue them; never params (but the staff digest's whole numbers, digestLines), staff free text, a reason typed by staff or another person's data. "x" marks a notice with no
// button (the login is gone). Unknown templates get the general one.
const N: Record<string, [subject: string, line: string, x?: "x"]> = {
  // candidates (www)
  "inactive-warning": ["Your account has not been used for a while", "You have not signed in for a long time. If you want to keep your account, please sign in. Accounts that stay unused may be deleted under our data rules."],
  deletion_on_hold: ["Your account deletion is on hold", "Your account was due to be deleted, but we must keep it for now while an open case about it is dealt with."],
  account_deleted: ["Your account has been deleted", `Your account on ${SITE_NAME} has been deleted. You can sign up again at any time.`, "x"],
  account_merged: ["Your accounts have been joined", "Two accounts with your details have been joined into one."],
  report_outcome: ["We have reviewed your report", "Thank you for reporting a job. We have looked at it and made a decision."],
  // employers and agencies (employers site)
  job_expiry_reminder: ["One of your jobs closes soon", "A job your company posted reaches its closing date soon. After that it is no longer shown."],
  job_hidden: ["One of your jobs is hidden for now", "One of your company's jobs has been taken off the site while we look into a report about it."],
  account_approved: ["Your company account is approved", "We have checked your company account and approved it. You can now post jobs."],
  account_needs_info: ["We need more information about your company", "We are checking your company account and need a little more information from you."],
  account_rejected: ["Your company account was not approved", "We have checked your company account and could not approve it."],
  organisation_closed: ["Your company account is closed", `Your company's account on ${SITE_NAME} has been closed, and its jobs are no longer shown.`],
  team_removed: ["You have left a company team", "You are no longer a member of a company team. Your own login still works."],
  owner_reassign_notice: ["A change of account owner has been asked for", "We have been asked to move your company's account owner role to another member. It has not happened yet."],
  owner_reassign_done: ["Your company has a new account owner", "Your company's account owner role has moved to another member."],
  owner_transferred: ["You are now the account owner", "You are now the account owner of your company on the site."],
  rules_minimums_changed: ["The work permit pay rules have changed", "The minimum pay rules for work permits have changed. Please check that your jobs still meet them."],
  rules_jobs_under_review: ["Some of your jobs need a check", "After a change to the work permit rules, some of your company's jobs need a check before they can stay on the site."],
  pay_floor_approved: ["Your pay rate request is approved", "We have approved your company's request about a pay rate."],
  pay_floor_rejected: ["Your pay rate request was not approved", "We have looked at your company's request about a pay rate and could not approve it."],
  pay_floor_expired: ["An approved pay rate has ended", "An approved pay rate for your company has ended because the work permit rules changed."],
  strike_case_opened: ["We have opened a case about your company", "We have opened a case about your company's account and would like your reply."],
  strike_case_cleared: ["A case about your company is closed", "We have closed a case about your company's account with no action."],
  strike_decided: ["A decision about your company", "We have made a decision on a case about your company's account."],
  appeal_decided: ["A decision on your appeal", "We have made a decision on your company's appeal."],
  ban_lifted: ["Your company can use the site again", "A ban on your company's account has been lifted."],
  // staff (no site link: the admin panel; Q11)
  staff_report_new: ["A new report has arrived", "Someone has reported a job, company, message or profile. It is waiting in the reports inbox."],
  staff_digest: ["Your work waiting today", "Here is the work waiting for your roles today."],
};
// The staff digest's numbers (staff-counts.ts digestParams): a fixed label per known key, and only whole numbers above zero; anything else in params is ignored.
const DIGEST_LABELS: Record<string, string> = {
  fetched_job: "Fetched jobs to review", account_review: "Company accounts to review", pay_floor_check: "Pay floors to check",
  post_strike_job_review: "Jobs to check after a strike", scam_flag: "Jobs flagged for scam wording", agency_client_check: "Agency client checks",
  data_request: "Data requests", scheduled_check: "Scheduled checks due", reportsOpen: "Open reports", reportsNew: "Reports in the last 24 hours",
  appeals: "Appeals to decide", contact: "Contact messages", approvals: "Requests waiting for a second person",
  // #275, administrators (staff-digest-cli.ts emailLimit)
  emailsLeft: "Emails left unsent by the last send run", alertsTooOld: "Job alerts dropped as too old in the last send run", alertSubscribers: "Active job alert subscribers",
};
/** The digest lines from a row's params. Pure. */
export function digestLines(params: unknown): string[] {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return [];
  const p = params as Record<string, unknown>;
  return Object.keys(DIGEST_LABELS).filter((k) => Number.isSafeInteger(p[k]) && (p[k] as number) > 0).map((k) => `${DIGEST_LABELS[k]}: ${p[k]}`);
}
export const NOTICE_TEMPLATES = Object.keys(N);

// Decision #271 (0050): the data request confirm link. The token is made here, at send time, and only its sha256 is kept (review_item.detail,
// 7 days, the same hash as data-request-confirm.ts tokenHash); a newer send by staff (another sentAt), a closed item or a login that no longer matches the row drops the email. A retry makes a new token.
export const DR_TOKEN_SET =
  "update review_item set detail = detail || jsonb_build_object('confirmHash', $2::text, 'expiresAt', now() + interval '7 days') " +
  "where id = $1::bigint and queue = 'data_request' and status in ('open','claimed') and detail->>'sentAt' = $3 and detail->>'confirmedAt' is null " +
  "and detail->>'userId' = (select coalesce(candidate_user_id, portal_user_id) from email_outbox where id = $4::bigint)";
/** The confirm email (placeholder wording, no params shown). Pure. */
export function confirmEmail(site: string, token: string): Email {
  const subject = "Please confirm your data request";
  return render(subject, {
    heading: subject,
    paragraphs: ["We got a request about the data in your account. Open the link to see it and confirm it. The link works once, for 7 days.",
      "If you did not ask for this, you can ignore this email and nothing will happen."],
    button: { label: "Open the request", url: `${site}/api/data-request?token=${token}` },
    footer: FOOTER,
  });
}
const GENERAL: [string, string] = ["News about your account", "Something has changed on your account."];
const FOOTER = `You got this email because you have an account on ${SITE_NAME}. We send emails like this when something changes on your account.`;

/** A notice email. `site` is the https origin of the person's site (null: no button, the text says to sign in). */
export function noticeEmail(template: string, site: string | null, lines: string[] = []): Email {
  const [subject, line, x] = N[template] ?? GENERAL;
  return render(subject, {
    heading: subject,
    paragraphs: [line, ...lines, x ? "If you have questions, please use the contact page on the site." : "Please sign in to see the details."],
    button: site && !x ? { label: "Sign in", url: `${site}/` } : undefined,
    footer: FOOTER,
  });
}

/** `old`: the job alerts among `dropped` that were queued more than 3 days ago (D4); the rest had no address or nothing left to send. */
export type Result = { sent: number; retry: number; failed: number; dropped: number; old: number };

/** The send order (#275): every row that is not a job alert first, then oldest first, then by id. Pure; the claim's ORDER BY says the same. */
export const sendOrder = (a: { template: string; send_after: Date; id: string }, b: typeof a) =>
  Number(a.template === "job_alert") - Number(b.template === "job_alert") || +a.send_after - +b.send_after || Number(a.id) - Number(b.id);

/** The GitHub warning line when the day's limit left rows unsent or an alert went stale (#275); null when all is well. Counts only. Pure. */
export function limitWarning(r: Result, left: number): string | null {
  return left > 0 || r.old > 0
    ? `::warning::email outbox (#275, Brevo Free 300 a day): ${left} emails left unsent; dropped this run: ${r.old} job alerts too old (over 3 days), ${r.dropped - r.old} with no address or nothing to send`
    : null;
}

type Claimed = { id: string; template: string; attempts: number; send_after: Date; candidate_user_id: string | null; params: unknown; side: "candidate" | "portal" | null };

/** `siteUrl` and `portalUrl` are the candidate and employer sites (https); `sendAlert` sends job alerts (its own sender), default `send`. */
export async function sendPending(c: pg.Pool | pg.Client, send: SendMail, batch = DEFAULT_BATCH, log: (line: string) => void = () => {}, siteUrl?: string,
  portalUrl?: string, sendAlert: SendMail = send): Promise<Result> {
  const out: Result = { sent: 0, retry: 0, failed: 0, dropped: 0, old: 0 };
  const rows = (await c.query<Claimed>(CLAIM, [Math.min(Math.max(batch, 1), MAX_BATCH)])).rows;
  if (!rows.length) return out;
  const to = new Map((await c.query<{ id: string; email: string | null }>(ADDRESSES, [rows.map((r) => r.id)])).rows.map((r) => [r.id, r.email]));
  rows.sort(sendOrder); // update ... returning has no order
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
      if (r.template === "data_request_confirm") {
        const site = siteOrigin(r.side === "candidate" ? siteUrl : portalUrl);
        if (!site) throw new Error("the site address is not https");
        const p = (r.params ?? {}) as { itemId?: string; sentAt?: string };
        const token = randomBytes(32).toString("base64url");
        if (!(await c.query(DR_TOKEN_SET, [p.itemId, createHash("sha256").update(token).digest("hex"), p.sentAt, r.id])).rowCount) { await done(r.id, "dropped"); out.dropped++; continue; }
        const m = confirmEmail(site, token);
        await send(email, m.subject, m.text, m.html);
      } else if (r.template !== "job_alert") {
        const m = noticeEmail(r.template, siteOrigin(r.side === "candidate" ? siteUrl : r.side === "portal" ? portalUrl : undefined), r.template === "staff_digest" ? digestLines(r.params) : []);
        await send(email, m.subject, m.text, m.html);
      } else {
        const site = siteOrigin(siteUrl);
        if (!site) throw new Error("SITE_URL is not an https address");
        if (!fresh(r)) { await done(r.id, "dropped"); out.dropped++; out.old++; continue; }
        const built = r.candidate_user_id ? buildAlertEmail(r.candidate_user_id, alertsOf.get(r.id) ?? [], found, live, site) : null;
        if (!built) { await done(r.id, "dropped"); out.dropped++; continue; }
        await sendAlert(email, built.subject, built.text, built.html, built.headers);
      }
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

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void, send?: SendMail, sendAlert?: SendMail): Promise<number> {
  const batch = parseBatch(argv);
  if (batch === undefined) return log(`usage: outbox-cli.ts [--batch 1..${MAX_BATCH}]`), 2;
  if (!env.DATABASE_URL) return log("DATABASE_URL is not set (the admin app's login, app_admin)"), 2;
  let mail = send;
  if (!mail) {
    if (!env.BREVO_API_KEY || !env.EMAIL_FROM) return log("BREVO_API_KEY and EMAIL_FROM must both be set; nothing was sent"), 2;
    mail = createBrevoMail({ apiKey: env.BREVO_API_KEY, from: env.EMAIL_FROM });
    if (env.ALERTS_EMAIL_FROM) sendAlert = createBrevoMail({ apiKey: env.BREVO_API_KEY, from: env.ALERTS_EMAIL_FROM });
  }
  const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: sslOptions(env) });
  try {
    await client.connect();
    if ((await client.query<{ any: boolean }>(PENDING)).rows[0]!.any && !(siteOrigin(env.SITE_URL) && siteOrigin(env.PORTAL_SITE_URL)))
      return log("SITE_URL and PORTAL_SITE_URL must both be set to https:// addresses (email links go to them); nothing was sent"), 2;
    const r = await sendPending(client, mail, batch, log, env.SITE_URL, env.PORTAL_SITE_URL, sendAlert);
    log(`outbox: sent ${r.sent}, to retry ${r.retry}, failed for good ${r.failed}, dropped (no address, nothing to send or too old) ${r.dropped}`);
    const left = (await client.query<{ n: number }>(LEFT)).rows[0]!.n;
    await client.query(RUN_AUDIT, [JSON.stringify({ ...r, left })]);
    const warn = limitWarning(r, left);
    if (warn) log(warn);
    return r.retry + r.failed ? 1 : 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
