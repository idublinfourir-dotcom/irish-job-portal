// The team of a company or agency (#52, #103): GET lists it, POST { action, ... } changes it. The acting login always comes from the
// session, never the body. The database functions (migration 0013) make every real check; this file refuses bad requests early,
// makes the invite token, sends the invite email and turns the functions' refusals into short codes.
import { getPool } from "@portal/db";
import { createHash, randomBytes } from "node:crypto";
import { isObject, no, only, portalLogin, readPost, withinLimit, type Refusal } from "./company";
import { portalOrigin, portalSend } from "./portal";

export const TEAM_RATE = { windowMs: 10 * 60_000, max: 20 }; // every team action together, per login (an invite sends an email)

// The invite token: 32 random bytes in the link, only its sha256 in the database (membership.invite_token_hash).
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes as base64url
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES = ["viewer", "poster", "recruiter"] as const;
type Role = (typeof ROLES)[number];

export type TeamAction =
  | { action: "invite"; email: string; role: Role; isSigner: boolean }
  | { action: "accept"; token: string }
  | { action: "request"; organisationId: number }
  | { action: "refuse" | "remove" | "transfer"; membershipId: number }
  | { action: "approve"; membershipId: number; role: Role; isSigner: boolean }
  | { action: "leave" }
  | { action: "role"; membershipId: number; role: Role; isSigner: boolean };

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

// Each action takes exactly its own fields. The owner's role is never given here: it moves only by transfer.
export function checkTeam(b: unknown): TeamAction | null {
  if (!isObject(b)) return null;
  const a = b.action;
  if (a === "invite" && only(b, ["action", "email", "role", "isSigner"]) && typeof b.email === "string" && isRole(b.role) && typeof b.isSigner === "boolean") {
    const email = b.email.trim().toLowerCase();
    if (email.length > 254 || !EMAIL.test(email) || /[\p{Cc}\p{Cf}]/u.test(email)) return null;
    return { action: a, email, role: b.role, isSigner: b.isSigner };
  }
  if (a === "accept" && only(b, ["action", "token"]) && typeof b.token === "string" && TOKEN.test(b.token)) return { action: a, token: b.token };
  if (a === "request" && only(b, ["action", "organisationId"]) && isId(b.organisationId)) return { action: a, organisationId: b.organisationId };
  if ((a === "refuse" || a === "remove" || a === "transfer") && only(b, ["action", "membershipId"]) && isId(b.membershipId))
    return { action: a, membershipId: b.membershipId };
  if (a === "approve" && only(b, ["action", "membershipId", "role", "isSigner"]) && isId(b.membershipId) && isRole(b.role) && typeof b.isSigner === "boolean")
    return { action: a, membershipId: b.membershipId, role: b.role, isSigner: b.isSigner };
  if (a === "leave" && only(b, ["action"])) return { action: a };
  if (a === "role" && only(b, ["action", "membershipId", "role", "isSigner"]) && isId(b.membershipId) && isRole(b.role) && typeof b.isSigner === "boolean")
    return { action: a, membershipId: b.membershipId, role: b.role, isSigner: b.isSigner };
  return null;
}

// The function and its arguments for every action but invite (which needs the token and the email too).
function callFor(user: string, b: Exclude<TeamAction, { action: "invite" }>): [string, unknown[]] {
  switch (b.action) {
    case "accept": return ["select private.team_accept($1, $2) r", [user, hashToken(b.token)]];
    case "request": return ["select private.team_request($1, $2) r", [user, b.organisationId]];
    case "approve": return ["select private.team_answer($1, $2, true, $3, $4) r", [user, b.membershipId, b.role, b.isSigner]];
    case "refuse": return ["select private.team_answer($1, $2, false, null, false) r", [user, b.membershipId]];
    case "remove": return ["select private.team_remove($1, $2) r", [user, b.membershipId]];
    case "transfer": return ["select private.team_transfer($1, $2) r", [user, b.membershipId]];
    case "leave": return ["select private.team_leave($1) r", [user]];
    case "role": return ["select private.team_set_role($1, $2, $3, $4) r", [user, b.membershipId, b.role, b.isSigner]];
  }
}

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400, VIEWER_NOT_SIGNER: 400, REFUSED: 403, EMAIL_NOT_VERIFIED: 403, NOT_OWNER: 403, NOT_ALLOWED_DOMAIN: 403,
  MEMBER_NOT_FOUND: 404, INVITE_NOT_VALID: 404, NOT_A_MEMBER: 409, TEAM_FULL: 409, ALREADY_IN_TEAM: 409, ALREADY_IN_A_COMPANY: 409,
  OWNER_MUST_TRANSFER: 409, ORGANISATION_NOT_AVAILABLE: 409,
};
// The functions raise 'team refused: CODE ...'. A code this file does not know is REFUSED (fail closed, no detail). A banned email
// domain is REFUSED too, the same as a blocked login, so the reply never says what is banned (#191).
export function teamRefusal(e: unknown): Refusal | null {
  const { code, message = "", constraint } = (e ?? {}) as { code?: string; message?: string; constraint?: string };
  if (code === "23505") {
    if (constraint === "one_company_per_login" || constraint === "membership_org_user_unique") return { status: 409, code: "ALREADY_IN_A_COMPANY" };
    if (constraint === "membership_org_invite_unique") return { status: 409, code: "ALREADY_IN_TEAM" };
    return null;
  }
  if (code !== "P0001") return null;
  const c = /^team refused: ([A-Z_]+)/.exec(message)?.[1];
  return c && STATUS[c] ? { status: STATUS[c], code: c } : { status: 403, code: "REFUSED" };
}

/** The link in the invite email. There is no page yet: the page will read the token and POST { action: "accept", token }. */
export const inviteLink = (token: string) => `${portalOrigin()}/team/accept?token=${token}`;

// The invite runs in one transaction with the email: if the email cannot be sent, the invite is undone, so no invite exists that
// nobody was told about. The raw token lives only in this function and the email.
async function invite(user: string, b: Extract<TeamAction, { action: "invite" }>): Promise<Response> {
  const { token, hash } = newToken();
  const c = await getPool().connect();
  try {
    await c.query("begin");
    const r = (await c.query("select private.team_invite($1, $2, $3, $4, $5) r", [user, b.email, b.role, b.isSigner, hash])).rows[0].r;
    try { await portalSend()("portal", "invite", b.email, inviteLink(token)); } catch {
      await c.query("rollback");
      return no(502, "EMAIL_FAILED");
    }
    await c.query("commit");
    return Response.json(r);
  } catch (e) {
    await c.query("rollback").catch(() => {});
    const r = teamRefusal(e);
    if (r) return no(r.status, r.code);
    throw e;
  } finally { c.release(); }
}

export async function teamPost(request: Request): Promise<Response> {
  const read = await readPost(request, checkTeam);
  if (read instanceof Response) return read;
  const { login, body } = read;
  if (!(await withinLimit(`team:${login.userId}`, TEAM_RATE))) return no(429, "TOO_MANY_REQUESTS");
  if (body.action === "invite") return invite(login.userId, body);
  try {
    return Response.json((await getPool().query(...callFor(login.userId, body))).rows[0].r);
  } catch (e) {
    const r = teamRefusal(e);
    if (r) return no(r.status, r.code);
    throw e;
  }
}

// Every active member sees the members (name, email, role, signer switch). Only the owner also sees the open invites and join
// requests. A login with no company sees only its own open join request, if any.
export async function teamGet(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  const m = login.membership;
  if (!m) {
    const { rows } = await getPool().query("select id, organisation_id from membership where portal_user_id = $1 and status = 'join_requested'", [login.userId]);
    return Response.json({ team: null, joinRequest: rows[0] ? { membershipId: Number(rows[0].id), organisationId: Number(rows[0].organisation_id) } : null });
  }
  const owner = m.role === "account_owner";
  const { rows } = await getPool().query(
    `select m.id, m.status, m.role, m.is_signer, coalesce(u.email, m.invited_email) email, u.name, m.joined_at, m.invite_expires_at
       from membership m left join portal_user u on u.id = m.portal_user_id
      where m.organisation_id = $1 and (m.status = 'active' or ($2 and m.status in ('invited', 'join_requested')))
      order by m.id`, [m.organisationId, owner]);
  const pick = (s: string) => rows.filter((r) => r.status === s);
  return Response.json({
    team: {
      organisationId: m.organisationId, myMembershipId: m.id, myRole: m.role,
      members: pick("active").map((r) => ({ membershipId: Number(r.id), name: r.name, email: r.email, role: r.role, isSigner: r.is_signer, joinedAt: r.joined_at })),
      ...(owner ? {
        invites: pick("invited").map((r) => ({ membershipId: Number(r.id), email: r.email, role: r.role, isSigner: r.is_signer, expiresAt: r.invite_expires_at })),
        requests: pick("join_requested").map((r) => ({ membershipId: Number(r.id), name: r.name, email: r.email })),
      } : {}),
    },
    joinRequest: null,
  });
}
