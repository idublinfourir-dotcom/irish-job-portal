// The email sender used until a real email service is wired in (#174). It keeps every email in memory so a test can read the
// link and "click" it, and prints the link to the terminal. It refuses to start for any address but this machine, so a
// deployed site can never quietly send nothing. It also refuses on Vercel and when NODE_ENV is production, even with a localhost address.
import type { EmailKind, LoginPool, SendEmail } from ".";

export type FakeEmail = { send: SendEmail; outbox: { pool: LoginPool; kind: EmailKind; to: string; link: string }[] };

export function createFakeEmail(baseURL: string, print: (line: string) => void = console.log, env: NodeJS.ProcessEnv = process.env): FakeEmail {
  // Preview mode (audit DEP-2): on a Vercel preview deployment only, PREVIEW_EMAIL=log writes each link to the function log and sends nothing.
  // Production, or anywhere else, refuses even when the variable is set.
  if (env.PREVIEW_EMAIL) {
    if (env.PREVIEW_EMAIL !== "log" || env.VERCEL_ENV !== "preview") throw new Error("PREVIEW_EMAIL=log is allowed only on a Vercel preview deployment (VERCEL_ENV=preview).");
    const outbox: FakeEmail["outbox"] = [];
    return { outbox, send: async (pool, kind, to, link) => {
      if (new URL(link).origin !== new URL(baseURL).origin) throw new Error("email link refused: not on this site");
      outbox.push({ pool, kind, to, link }); print(`[preview email] ${pool} ${kind} for ${to}: ${link}`);
    } };
  }
  if (env.VERCEL || env.NODE_ENV === "production") throw new Error("The fake email sender runs only on a developer machine, not on Vercel or with NODE_ENV=production. Wire in a real email service first.");
  const host = new URL(baseURL).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`The fake email sender runs only on localhost, not ${host}. Wire in a real email service first.`);
  const outbox: FakeEmail["outbox"] = [];
  return { outbox, send: async (pool, kind, to, link) => { outbox.push({ pool, kind, to, link }); print(`[fake email] ${pool} ${kind} for ${to}: ${link}`); } };
}
