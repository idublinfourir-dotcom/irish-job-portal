// Sign-up rules for the candidate pool (#8, #106, #175, #176, #178: three answers) and the portal pool (#188, #194: one answer, the
// tick for the employer and agency terms). The answers are checked on the server, and one consent_record row is written inside
// Better Auth's own sign-up transaction, so no account can exist without it.
import { APIError, getCurrentAdapter, type BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";

export type Answers = { needsPermit: true; over18: true; acceptsTerms: true };
export type PortalAnswers = { acceptsTerms: true };
export type SignupPool = "candidate" | "portal";
// What differs per pool: the terms purpose, the per-pool consent view, and the user-id field in it. Candidates keep signup_terms.
const POOLS = {
  candidate: { purpose: "signup_terms", view: "candidate_consent_record", userField: "candidateUserId", column: "candidate_user_id" },
  portal: { purpose: "portal_signup_terms", view: "portal_consent_record", userField: "portalUserId", column: "portal_user_id" },
} as const;
const NAME_MAX = 100;
type Adapter = { findMany: (a: unknown) => Promise<unknown[]>; create: (a: unknown) => Promise<unknown> };

/** The three answers, or the reason they are refused. Only the JSON value `true` passes: strings, numbers, objects and lists do not. */
export function readAnswers(raw: unknown): { answers?: Answers; error?: string } {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (o.needsPermit === false) return { error: "This service is for people who need a work permit." };
  if (o.needsPermit !== true) return { error: "Say whether you need a work permit." };
  if (o.over18 !== true) return { error: "You must be 18 or over." };
  if (o.acceptsTerms !== true) return { error: "You must accept the terms." };
  return { answers: { needsPermit: true, over18: true, acceptsTerms: true } };
}

/** The portal's one answer, or the reason it is refused. Only the JSON value `true` passes. */
export function readPortalAnswers(raw: unknown): { answers?: PortalAnswers; error?: string } {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return o.acceptsTerms === true ? { answers: { acceptsTerms: true } } : { error: "You must accept the terms." };
}

// The same name rule for both pools: portal_user.name and candidate_user.name have no length limit in the database.
function checkName(body: unknown): void {
  const name = (body as { name?: unknown }).name;
  if (typeof name !== "string" || !name.trim() || name.length > NAME_MAX)
    throw new APIError("BAD_REQUEST", { message: `Name must be 1 to ${NAME_MAX} characters.`, code: "SIGNUP_NAME_REFUSED" });
}

/** Portal sign-up checks (the route's body): the tick, or SIGNUP_ANSWERS_REFUSED, and with `withName` the name rule. */
export function checkPortalSignup(body: unknown, withName = false): PortalAnswers {
  const { answers, error } = readPortalAnswers(body);
  if (!answers) throw new APIError("BAD_REQUEST", { message: error!, code: "SIGNUP_ANSWERS_REFUSED" });
  if (withName) checkName(body);
  return answers;
}

/** Everything checked before any account is made. Returns the answers (the sign-up route's body, or a Google sign-in's additionalData). */
export function checkSignup(body: unknown, withName: boolean): Answers {
  const { answers, error } = readAnswers(body);
  if (!answers) throw new APIError("BAD_REQUEST", { message: error!, code: "SIGNUP_ANSWERS_REFUSED" });
  if (withName) checkName(body);
  return answers;
}

/** The id of the pool's current terms text (every text in the table passed the two-person rule). No text means no sign-up. */
export async function currentTermsId(database: Pool, pool: SignupPool = "candidate"): Promise<string> {
  const r = await database.query("select id from consent_text where purpose=$1 order by published_at desc, id desc limit 1", [POOLS[pool].purpose]);
  if (!r.rowCount) throw new APIError("SERVICE_UNAVAILABLE", { message: "Sign-up is not open yet.", code: "SIGNUP_TERMS_MISSING" });
  return r.rows[0].id;
}

/**
 * Writes the consent row for a new candidate through the transaction Better Auth opened for the sign-up, so a failed write
 * undoes the account too. The terms text is read through the same transaction: the sign-up already holds one pool connection, and
 * asking the pool for a second one could leave several sign-ups waiting on each other. Refuses to write outside a transaction
 * (fail closed). Part B (Google) calls this from its own user-create step.
 */
export async function writeConsent(base: unknown, userId: string, answers: Answers | PortalAnswers, pool: SignupPool = "candidate"): Promise<void> {
  const p = POOLS[pool];
  const trx = (await getCurrentAdapter(base as never)) as unknown as Adapter;
  if ((trx as unknown) === base) throw new Error("The consent row must be written inside the sign-up transaction.");
  const [terms] = (await trx.findMany({ model: "consentText", where: [{ field: "purpose", value: p.purpose }], sortBy: { field: "publishedAt", direction: "desc" }, limit: 1 })) as { id: string }[];
  if (!terms) throw new APIError("SERVICE_UNAVAILABLE", { message: "Sign-up is not open yet.", code: "SIGNUP_TERMS_MISSING" });
  await trx.create({ model: "consentRecord", data: { [p.userField]: userId, consentTextId: Number(terms.id), details: answers } });
}

/**
 * A pool's sign-up plugin. The before hook runs ahead of the whole sign-up route, so a bad answer gets the same refusal
 * whether or not the email already has an account. The consent_record is the pool's own view, candidate_consent_record or
 * portal_consent_record (given_at is the default).
 */
export function signupPlugin(database: Pool, pool: SignupPool): BetterAuthPlugin {
  const p = POOLS[pool];
  return {
    id: `${pool}-signup`,
    schema: {
      consentText: {
        modelName: "consent_text",
        fields: { purpose: { type: "string", required: true }, version: { type: "string", required: true }, body: { type: "string", required: true }, publishedAt: { type: "date", required: true, fieldName: "published_at" } },
      },
      consentRecord: {
        modelName: p.view,
        fields: {
          [p.userField]: { type: "string", required: true, fieldName: p.column },
          consentTextId: { type: "number", required: true, fieldName: "consent_text_id" },
          details: { type: "json", required: false, fieldName: "details" },
        },
      },
    },
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/sign-up/email",
        handler: createAuthMiddleware(async (ctx) => {
          if (pool === "candidate") checkSignup(ctx.body, true);
          else checkPortalSignup(ctx.body, true);
          await currentTermsId(database, pool);
        }),
      }],
    },
  };
}
