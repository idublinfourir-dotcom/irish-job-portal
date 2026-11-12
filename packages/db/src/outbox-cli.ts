// The outbox sender (8.1b): sends the pending email_outbox rows through Brevo, oldest first, as app_admin (the admin app's DATABASE_URL).
//   DATABASE_URL=... BREVO_API_KEY=... EMAIL_FROM=... node packages/db/src/outbox-cli.ts [--batch N]
// A row is marked `sending` (attempts + 1) in its own committed statement BEFORE Brevo is called, so a crash never sends it twice; a row
// left in `sending` by a crash is a human's call (look at it, then set it to pending or dropped). After MAX_ATTEMPTS failed tries a row is `failed`.
// A row with no address (person erased or deleted, invite gone) is `dropped`. Two runs at once share the work (skip locked).
// The wording is PLACEHOLDER text until the real templates exist. Logs hold counts and row ids only, never an address or the key.
import pg from "pg";
import { createBrevoMail, type SendMail } from "../../auth/src/brevo.ts";
import { sslOptions } from "./ssl.ts";

export const MAX_ATTEMPTS = 3;
export const DEFAULT_BATCH = 50;
export const MAX_BATCH = 200;

export const CLAIM =
  "with c as (select id from email_outbox where status = 'pending' and send_after <= now() order by send_after, id limit $1 for update skip locked) " +
  "update email_outbox o set status = 'sending', attempts = o.attempts + 1 from c where o.id = c.id returning o.id, o.template, o.attempts, o.send_after";
export const ADDRESSES =
  "select o.id, coalesce(cu.email, pu.email, su.email, mu.email, m.invited_email, cm.from_email) as email from email_outbox o " +
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

export async function sendPending(c: pg.Pool | pg.Client, send: SendMail, batch = DEFAULT_BATCH, log: (line: string) => void = () => {}): Promise<Result> {
  const out: Result = { sent: 0, retry: 0, failed: 0, dropped: 0 };
  const rows = (await c.query<{ id: string; template: string; attempts: number; send_after: Date }>(CLAIM, [Math.min(Math.max(batch, 1), MAX_BATCH)])).rows;
  if (!rows.length) return out;
  const to = new Map((await c.query<{ id: string; email: string | null }>(ADDRESSES, [rows.map((r) => r.id)])).rows.map((r) => [r.id, r.email]));
  rows.sort((a, b) => +a.send_after - +b.send_after || Number(a.id) - Number(b.id)); // update ... returning has no order
  const done = (id: string, status: string) => c.query("update email_outbox set status = $2::text, sent_at = case when $2::text = 'sent' then now() end where id = $1 and status = 'sending'", [id, status]);
  for (const r of rows) {
    const email = to.get(r.id);
    if (!email) { await done(r.id, "dropped"); out.dropped++; continue; }
    try {
      await send(email, ...noticeText(r.template));
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
    const r = await sendPending(client, mail, batch, log);
    log(`outbox: sent ${r.sent}, to retry ${r.retry}, failed for good ${r.failed}, dropped (no address) ${r.dropped}`);
    return r.retry + r.failed ? 1 : 0;
  } catch (e) {
    log(`refused: ${(e as Error).message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
