// Candidate sign-up rules (#8, #106, #175, #176, #178): three answers checked on the server, and one consent_record row
// written inside Better Auth's own sign-up transaction, so no candidate account can exist without it.
import { APIError, getCurrentAdapter, type BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";

export type Answers = { needsPermit: true; over18: true; acceptsTerms: true };
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

/** Everything checked before any account is made. Returns the answers (the sign-up route's body, or a Google sign-in's additionalData). */
export function checkSignup(body: unknown, withName: boolean): Answers {
  const { answers, error } = readAnswers(body);
  if (!answers) throw new APIError("BAD_REQUEST", { message: error!, code: "SIGNUP_ANSWERS_REFUSED" });
  const name = (body as { name?: unknown }).name;
  if (withName && (typeof name !== "string" || !name.trim() || name.length > NAME_MAX))
    throw new APIError("BAD_REQUEST", { message: `Name must be 1 to ${NAME_MAX} characters.`, code: "SIGNUP_NAME_REFUSED" });
  return answers;
}

/** The id of the current signup_terms text (every text in the table passed the two-person rule). No text means no sign-up. */
export async function currentTermsId(database: Pool): Promise<string> {
  const r = await database.query("select id from consent_text where purpose='signup_terms' order by published_at desc, id desc limit 1");
  if (!r.rowCount) throw new APIError("SERVICE_UNAVAILABLE", { message: "Sign-up is not open yet.", code: "SIGNUP_TERMS_MISSING" });
  return r.rows[0].id;
}

/**
 * Writes the consent row for a new candidate through the transaction Better Auth opened for the sign-up, so a failed write
 * undoes the account too. The terms text is read through the same transaction: the sign-up already holds one pool connection, and
 * asking the pool for a second one could leave several sign-ups waiting on each other. Refuses to write outside a transaction
 * (fail closed). Part B (Google) calls this from its own user-create step.
 */
export async function writeConsent(base: unknown, userId: string, answers: Answers): Promise<void> {
  const trx = (await getCurrentAdapter(base as never)) as unknown as Adapter;
  if ((trx as unknown) === base) throw new Error("The consent row must be written inside the sign-up transaction.");
  const [terms] = (await trx.findMany({ model: "consentText", where: [{ field: "purpose", value: "signup_terms" }], sortBy: { field: "publishedAt", direction: "desc" }, limit: 1 })) as { id: string }[];
  if (!terms) throw new APIError("SERVICE_UNAVAILABLE", { message: "Sign-up is not open yet.", code: "SIGNUP_TERMS_MISSING" });
  await trx.create({ model: "consentRecord", data: { candidateUserId: userId, consentTextId: Number(terms.id), details: answers } });
}

/**
 * The candidate pool's sign-up plugin. The before hook runs ahead of the whole sign-up route, so a bad answer gets the same refusal
 * whether or not the email already has an account. The consent_record is the candidate_consent_record view (given_at is the default).
 */
export function candidateSignup(database: Pool): BetterAuthPlugin {
  return {
    id: "candidate-signup",
    schema: {
      consentText: {
        modelName: "consent_text",
        fields: { purpose: { type: "string", required: true }, version: { type: "string", required: true }, body: { type: "string", required: true }, publishedAt: { type: "date", required: true, fieldName: "published_at" } },
      },
      consentRecord: {
        modelName: "candidate_consent_record",
        fields: {
          candidateUserId: { type: "string", required: true, fieldName: "candidate_user_id" },
          consentTextId: { type: "number", required: true, fieldName: "consent_text_id" },
          details: { type: "json", required: false, fieldName: "details" },
        },
      },
    },
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/sign-up/email",
        handler: createAuthMiddleware(async (ctx) => {
          checkSignup(ctx.body, true);
          await currentTermsId(database);
        }),
      }],
    },
  };
}
