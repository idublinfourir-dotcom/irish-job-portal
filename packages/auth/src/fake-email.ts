// The email sender used until a real email service is wired in (#174). It keeps every email in memory so a test can read the
// link and "click" it, and prints the link to the terminal. It refuses to start for any address but this machine, so a
// deployed site can never quietly send nothing. It also refuses on Vercel and when NODE_ENV is production, even with a localhost address.
import type { EmailKind, LoginPool, SendEmail } from ".";

export type FakeEmail = { send: SendEmail; outbox: { pool: LoginPool; kind: EmailKind; to: string; link: string }[] };

export function createFakeEmail(baseURL: string, print: (line: string) => void = console.log, env: NodeJS.ProcessEnv = process.env): FakeEmail {
  if (env.VERCEL || env.NODE_ENV === "production") throw new Error("The fake email sender runs only on a developer machine, not on Vercel or with NODE_ENV=production. Wire in a real email service first.");
  const host = new URL(baseURL).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`The fake email sender runs only on localhost, not ${host}. Wire in a real email service first.`);
  const outbox: FakeEmail["outbox"] = [];
  return { outbox, send: async (pool, kind, to, link) => { outbox.push({ pool, kind, to, link }); print(`[fake email] ${pool} ${kind} for ${to}: ${link}`); } };
}
