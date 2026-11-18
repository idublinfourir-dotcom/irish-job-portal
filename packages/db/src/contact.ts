// The contact form (decision #55): the POST behind the candidate site (visitors and signed-in candidates) and the portal (signed-in users only).
// The sender's id always comes from the session, never the body. The reply is only { ok: true }: it never says whether an email belongs to an account.
// The database is the guard: the app roles may insert only the columns below (0003), so a message cannot be filed as already answered.
import { createHmac } from "node:crypto";
import { botRefused, botResponse } from "./bot-check";
import { clientAddress, hasControl, isObject, only, withinRate } from "./candidate-route";
import { getPool } from "./index";
import type { ReportLogin } from "./report";

// appeal (C3): only from a sender who is not signed in as an active login, so a blocked portal login or a suspended candidate (who can hold no
// session) can still write to us. Staff see whether its email belongs to a held login (contact-inbox.ts, CONTACT_ITEM).
export const CONTACT_TOPICS = ["general", "account", "data_request", "other", "appeal"] as const;
export const MAX_MESSAGE = 5000, MAX_NAME = 120, MAX_EMAIL = 254; // characters (code points, as the database counts them)
// The largest good request: 5,000 characters of 4 bytes, plus the name, email and JSON around them. Checked before the body is read.
export const MAX_CONTACT_BODY = 24_000;
export const CONTACT_RATE = { windowMs: 60 * 60_000, max: 5 }; // messages per key per hour: per login, per address, per email

export type ContactBody = { topic: (typeof CONTACT_TOPICS)[number]; name: string | null; email: string | null; body: string };

const size = (s: string) => Array.from(s).length;
const text = (v: unknown, max: number, lines: boolean): v is string => {
  if (typeof v !== "string" || v.trim() === "" || size(v) > max || !v.isWellFormed()) return false;
  return !hasControl(lines ? v.replace(/[\n\t]/g, "") : v);
};
const address = (v: unknown): v is string => text(v, MAX_EMAIL, false) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// Null means refuse. Unknown fields are refused. A visitor must give a name and an email; a signed-in sender may leave them out (the account's are used).
// The message may hold newline and tab but no other control or format character; name and email hold none.
// An active signed-in sender may not choose appeal.
export function checkContact(b: unknown, signedIn: boolean): ContactBody | null {
  if (!isObject(b) || !only(b, ["topic", "name", "email", "body"])) return null;
  const { topic, name, email, body } = b;
  if (typeof topic !== "string" || !(CONTACT_TOPICS as readonly string[]).includes(topic) || !text(body, MAX_MESSAGE, true)) return null;
  if (signedIn && topic === "appeal") return null;
  if (name === undefined ? !signedIn : !text(name, MAX_NAME, false)) return null;
  if (email === undefined ? !signedIn : !address(email)) return null;
  return { topic: topic as ContactBody["topic"], name: (name as string | undefined) ?? null, email: (email as string | undefined) ?? null, body };
}

// Fixed names per side, never taken from input.
const SIDES = {
  candidate: { surface: "candidate_site", limit: "candidate_rate_limit", user: "candidate_user", column: "candidate_user_id" },
  portal: { surface: "portal", limit: "portal_rate_limit", user: "portal_user", column: "portal_user_id" },
} as const;
export type ContactSide = keyof typeof SIDES;

// Constants, so the performance test explains the very statements the route runs. The account's own name and email fill what the form left out.
export const CONTACT_SQL = {
  visitor: "insert into contact_message(surface, from_name, from_email, topic, body) values ($1, $2, $3, $4, $5)",
  user: (side: ContactSide) =>
    `insert into contact_message(surface, ${SIDES[side].column}, from_name, from_email, topic, body) ` +
    `select $1, u.id, coalesce($3, u.name), coalesce($4, u.email), $5, $6 from ${SIDES[side].user} u where u.id = $2`,
};

const no = (status: number, code: string) => Response.json({ code }, { status });
// An address is kept in the rate-limit table only as a keyed hash (as packages/auth/src/email-limit.ts does).
const emailKey = (secret: string, email: string) => `contact:email:${createHmac("sha256", secret).update(email.toLowerCase()).digest("hex")}`;

/**
 * `login` says who is signed in. On the candidate side any refusal (no session, suspended, deleted) is treated as a visitor, because a suspended
 * candidate may need to write to us. On the portal side a login is required, except for an appeal (C3): a blocked login holds no session, so an
 * appeal is taken as from a visitor (name and email given, counted by address and email). `secret` is the side's auth secret, used only to hash email keys.
 */
export async function handleContact(request: Request, o: { origin: string; side: ContactSide; secret: string; login: (headers: Headers) => Promise<ReportLogin> }): Promise<Response> {
  if (await botRefused(process.env)) return botResponse(); // first, as in handleReport: a bot is neither read nor counted
  if (request.headers.get("origin") !== o.origin) return no(403, "BAD_ORIGIN");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_CONTACT_BODY) return no(413, "BODY_TOO_LARGE"); // before the body is read
  const raw = await request.text();
  if (raw.length > MAX_CONTACT_BODY) return no(413, "BODY_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return no(400, "BAD_REQUEST"); }
  const who = await o.login(request.headers);
  if ("refused" in who && o.side === "portal" && !(isObject(parsed) && parsed.topic === "appeal"))
    return who.refused === "no_session" ? no(401, "NO_SESSION") : no(403, "REFUSED");
  const userId = "userId" in who ? who.userId : null;
  const body = checkContact(parsed, userId !== null);
  if (!body) return no(400, "BAD_REQUEST");
  const side = SIDES[o.side];
  // A signed-in sender is counted by login. A visitor is counted by client address and by email, so neither many addresses nor many emails get through.
  const ip = clientAddress(request.headers);
  const keys = userId !== null ? [`contact:user:${userId}`] : [`contact:ip:${ip}`, emailKey(o.secret, body.email!)];
  for (const key of keys) if (!(await withinRate(side.limit, key, CONTACT_RATE))) return no(429, "TOO_MANY_REQUESTS");
  const db = getPool();
  if (userId === null) {
    await db.query(CONTACT_SQL.visitor, [side.surface, body.name, body.email, body.topic, body.body]);
  } else {
    // A login whose row is gone writes nothing.
    const r = await db.query(CONTACT_SQL.user(o.side), [side.surface, userId, body.name, body.email, body.topic, body.body]);
    if (!r.rowCount) return no(403, "REFUSED");
  }
  return Response.json({ ok: true });
}
