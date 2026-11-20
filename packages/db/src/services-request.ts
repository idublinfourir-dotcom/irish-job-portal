// Permit services, the requester side (step 15 SV-A: M1 requests, M2 tracker; answers S-Q1 B, S-Q2 A; migrations 0061 and 0062). The routes'
// work for both apps, as files.ts: the login always comes from the session, the side from the app. A request is one transaction: the consent
// records, the case, the received event and the free check (the checker's own rules) run on the offer details, kept in offer_details. Every read
// goes through the side's reader wrapper (private.candidate_case_readable, private.portal_case_readable): a case the caller cannot read is 404.
// Never notes, staff names or staff ids in a reply; the timeline is SV-B2's route.
import type pg from "pg";
import { BadEligibilityInput, registrationFor } from "@portal/rules";
import { QueueRefused } from "./admin-queue";
import { CANDIDATE_MAX_BODY, CANDIDATE_RATE, hasControl, inTransaction, isObject, only, Refuse, withinRate } from "./candidate-route";
import { getPool } from "./index";
import type { Side } from "./files";
import { checkWithSiteLists } from "./public-pages";
import { checkerInput } from "./public-read";
import { LIVE, validId } from "./search";
import { decodeIdCursor, encodeIdCursor, toWire } from "./wire";

export const PERMIT_TYPES = ["critical_skills", "general"] as const;
// The offer as the requester types it: each value a line of 1 to 500 characters. The first seven are the checker's keys (GET /api/checker).
export const OFFER_KEYS = ["occupationCode", "annualPay", "relevantDegree", "degreeAwardMonth", "contractMonths", "weeklyHours", "title", "employerName", "startDate", "notes"] as const;
export const OFFER_VALUE_MAX = 500;
export const MAX_OPEN_CASES = 5; // open cases per requester login (services-plan-check.md section 4)
export const CASE_PAGE = 20;
export const PORTAL_CASE_RATE = { windowMs: 10 * 60_000, max: 20 }; // portal requests and withdrawals together, per login
const IDEMPOTENCY = /^[A-Za-z0-9_-]{16,64}$/;

export type CaseRequest = {
  permitType: (typeof PERMIT_TYPES)[number]; jobId: string | null; offerDetails: Record<string, string>; employerContact: boolean; idempotencyKey: string | null;
};

/** The request body of either side, or null (400). The candidate may tick employerContact only on a request that names a job (S-Q2 A); the portal sends an idempotencyKey instead. */
export function checkCaseRequest(side: Side, b: unknown): CaseRequest | null {
  const own = side === "candidate" ? "employerContact" : "idempotencyKey";
  if (!isObject(b) || !only(b, ["permitType", "jobId", "offerDetails", "servicesConsent", own])) return null;
  if (b.servicesConsent !== true || !(PERMIT_TYPES as readonly unknown[]).includes(b.permitType)) return null;
  const jobId = b.jobId === undefined || b.jobId === null ? null : validId(b.jobId) ? b.jobId : undefined;
  if (jobId === undefined) return null;
  const employerContact = b.employerContact ?? false;
  if (typeof employerContact !== "boolean" || (employerContact && jobId === null)) return null;
  const key = b.idempotencyKey ?? null;
  if (side === "portal" && (typeof key !== "string" || !IDEMPOTENCY.test(key))) return null;
  const d = b.offerDetails;
  if (!isObject(d) || !only(d, OFFER_KEYS)) return null;
  const offerDetails: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (t.length < 1 || t.length > OFFER_VALUE_MAX || hasControl(t)) return null;
    offerDetails[k] = t;
  }
  return { permitType: b.permitType as CaseRequest["permitType"], jobId, offerDetails, employerContact, idempotencyKey: key as string | null };
}

/** The checker's input from the offer, or null when the offer lacks code, pay or degree (no free check yet). A bad shape throws BadEligibilityInput (400). */
export function freeCheckInput(details: Record<string, string>) {
  if (!details.occupationCode || !details.annualPay || !details.relevantDegree) return null;
  const q = new URLSearchParams();
  for (const k of OFFER_KEYS.slice(0, 7)) if (details[k] !== undefined) q.set(k, details[k]);
  return checkerInput(q);
}

// ===== the route plumbing (the shape of files.ts fileRoute)
export type CaseLogin = { userId: string; organisationId?: number | null; role?: string | null } | { refused: "no_session" | "refused" | "reauth_required" };
type Who = { userId: string; organisationId: number | null; role: string | null };
const COMPANY_READERS = ["account_owner", "recruiter"]; // S-Q1 B
export type CasesEnv = { side: Side; origin: string; login: (headers: Headers) => Promise<CaseLogin> };
const no = (status: number, code: string) => Response.json({ code }, { status });
const REFUSED: Record<string, [number, string]> = {
  NOT_FOUND: [404, "CASE_NOT_FOUND"], NOT_OPEN: [409, "CASE_NOT_OPEN"], NOT_REQUESTER: [403, "NOT_REQUESTER"],
};

async function caseRoute(request: Request, env: CasesEnv, write: boolean, work: (db: pg.Pool, who: Who, text: string) => Promise<unknown>): Promise<Response> {
  let text = "";
  if (write) {
    if (request.headers.get("origin") !== env.origin) return no(403, "BAD_ORIGIN");
    if (Number(request.headers.get("content-length") ?? 0) > CANDIDATE_MAX_BODY) return no(413, "BODY_TOO_LARGE");
    text = await request.text();
    if (text.length > CANDIDATE_MAX_BODY) return no(413, "BODY_TOO_LARGE");
  }
  const who = await env.login(request.headers);
  if ("refused" in who) return who.refused === "no_session" ? no(401, "NO_SESSION") : no(403, "REFUSED");
  if (write) {
    const ok = env.side === "candidate"
      ? await withinRate("candidate_rate_limit", `candidate:${who.userId}`, CANDIDATE_RATE)
      : await withinRate("portal_rate_limit", `cases:${who.userId}`, PORTAL_CASE_RATE);
    if (!ok) return no(429, "TOO_MANY_REQUESTS");
  }
  try {
    return Response.json(toWire(await work(getPool(), { userId: who.userId, organisationId: who.organisationId ?? null, role: who.role ?? null }, text)));
  } catch (e) {
    if (e instanceof Refuse) return no(e.status, e.code);
    if (e instanceof BadEligibilityInput || e instanceof QueueRefused) return no(400, "BAD_REQUEST");
    const { code, message = "", constraint } = (e ?? {}) as { code?: string; message?: string; constraint?: string };
    if (code === "23505" && constraint === "services_case_candidate_open") return no(409, "CASE_ALREADY_OPEN");
    if (code === "23514" || code === "22P02") return no(400, "BAD_REQUEST");
    if (code === "P0001") {
      const r = REFUSED[/case withdraw refused: ([A-Z_]+)/.exec(message)?.[1] ?? ""];
      return r ? no(r[0], r[1]) : no(403, "REFUSED"); // any other rule: fail closed, no detail
    }
    throw e;
  }
}

// ===== request (M1)
const LOCK = "select pg_advisory_xact_lock(hashtextextended('services_case:' || $1, 0))"; // one request at a time per login: the cap and the replay hold
const TEXTS = "select p.purpose, (select t.id::text from consent_text t where t.purpose = p.purpose order by t.published_at desc, t.id desc limit 1) as id " +
  "from unnest(array['services_request','employer_contact']) p(purpose)";
const SQL = {
  candidate: {
    state: "select (select email_verified from candidate_user where id = $1) as verified, (select count(*)::int from candidate_services_case where candidate_user_id = $1 and status <> 'closed') as open",
    job: `select job.organisation_id::text as org, o.kind from job join organisation o on o.id = job.organisation_id where job.id = $1::bigint and ${LIVE}`,
    consent: "insert into candidate_consent_record(candidate_user_id, consent_text_id, job_id, organisation_id) values ($1, $2::bigint, $3::bigint, $4::bigint) returning id::text as id",
    insert: `insert into candidate_services_case(candidate_user_id, organisation_id, job_id, permit_type, offer_details, payer, consent_record_id, employer_contact_consent_record_id)
      values ($1, $2::bigint, $3::bigint, $4, $5::jsonb, $6, $7::bigint, $8::bigint) returning id::text as id, status, created_at::text as "createdAt"`,
  },
  portal: {
    // the role check is in the statement that writes: an active Owner or Recruiter of a verified company (S-Q1 B)
    state: `select exists (select 1 from membership m join organisation o on o.id = m.organisation_id where m.portal_user_id = $1 and m.organisation_id = $2::bigint
        and m.status = 'active' and m.role in ('account_owner','recruiter') and o.status in ('verified','verified_restricted')) as verified,
      (select count(*)::int from portal_services_case where portal_user_id = $1 and status <> 'closed') as open,
      (select kind from organisation where id = $2::bigint) as kind,
      (select id::text from portal_services_case where dedupe_key = $3) as replay`,
    job: `select job.organisation_id::text as org, o.kind from job join organisation o on o.id = job.organisation_id where job.id = $1::bigint and job.organisation_id = $2::bigint and ${LIVE}`,
    consent: "insert into portal_consent_record(portal_user_id, consent_text_id, job_id, organisation_id) values ($1, $2::bigint, $3::bigint, $4::bigint) returning id::text as id",
    insert: `insert into portal_services_case(portal_user_id, organisation_id, job_id, permit_type, offer_details, payer, consent_record_id, employer_contact_consent_record_id, dedupe_key)
      select $1, $2::bigint, $3::bigint, $4, $5::jsonb, $6, $7::bigint, $8::bigint, $9
       where exists (select 1 from membership m where m.portal_user_id = $1 and m.organisation_id = $2::bigint and m.status = 'active' and m.role in ('account_owner','recruiter'))
      returning id::text as id, status, created_at::text as "createdAt"`,
  },
  event: { candidate: "insert into case_event(case_id, kind, status, candidate_user_id) values ($1::bigint, 'received', 'received', $2)", portal: "insert into case_event(case_id, kind, status, portal_user_id) values ($1::bigint, 'received', 'received', $2)" },
};
const payerOf = (kind: string | null | undefined) => (kind === "agency" ? "agency" : "employer");

async function createCase(db: pg.Pool, side: Side, who: Who, b: CaseRequest) {
  const input = freeCheckInput(b.offerDetails); // a bad shape is refused before any statement
  if (side === "portal" && who.organisationId === null) throw new Refuse(403, "ROLE_REFUSED");
  const dedupe = side === "portal" ? `${who.userId}:${b.idempotencyKey}` : null;
  return inTransaction(db, async (c) => {
    await c.query(LOCK, [`${side}:${who.userId}`]);
    const s = (await c.query(side === "candidate" ? SQL.candidate.state : SQL.portal.state, side === "candidate" ? [who.userId] : [who.userId, who.organisationId, dedupe])).rows[0];
    if (!s.verified) throw side === "candidate" ? new Refuse(403, "NOT_VERIFIED") : new Refuse(403, "ROLE_REFUSED");
    if (s.replay) return { case: await readOne(c, side, who, s.replay), freeCheck: null, replayed: true };
    if (s.open >= MAX_OPEN_CASES) throw new Refuse(409, "CASE_LIMIT");
    let org: string | null = side === "portal" ? String(who.organisationId) : null, payer: string | null = side === "portal" ? payerOf(s.kind) : null;
    if (b.jobId !== null) {
      const j = (await c.query(SQL[side].job, side === "candidate" ? [b.jobId] : [b.jobId, who.organisationId])).rows[0];
      if (!j) throw new Refuse(404, "JOB_NOT_FOUND"); // missing, not live, or (portal) another company's
      org = j.org;
      payer = payerOf(j.kind);
    }
    const texts = Object.fromEntries((await c.query(TEXTS)).rows.map((r) => [r.purpose, r.id as string | null]));
    if (!texts.services_request || (b.employerContact && !texts.employer_contact)) throw new Refuse(503, "SERVICES_UNAVAILABLE"); // the seed command has not run
    const consent = async (text: string) => (await c.query(SQL[side].consent, [who.userId, text, b.jobId, org])).rows[0].id as string;
    const k1 = await consent(texts.services_request);
    const k2 = b.employerContact ? await consent(texts.employer_contact!) : null;
    const freeCheck = input && { ...(await checkWithSiteLists(c, input.input)), registration: registrationFor(input.input.occupationCode, input.title) };
    const args = [who.userId, org, b.jobId, b.permitType, JSON.stringify({ details: b.offerDetails, freeCheck }), payer, k1, k2];
    const row = (await c.query(SQL[side].insert, side === "portal" ? [...args, dedupe] : args)).rows[0];
    if (!row) throw new Refuse(403, "ROLE_REFUSED");
    await c.query(SQL.event[side], [row.id, who.userId]);
    return { case: await readOne(c, side, who, row.id), freeCheck, replayed: false };
  });
}

// ===== tracker (M2)
const FIELDS = (side: Side) => `c.id::text as id, c.status, c.decision_outcome as "decisionOutcome", c.permit_type as "permitType", c.job_id::text as "jobId", j.title as "jobTitle",
  c.created_at::text as "createdAt", coalesce((select max(t.at) from private.${side}_case_timeline($1, c.id) t), c.created_at)::text as "lastChangeAt",
  (select count(*)::int from ${side}_case_document d where d.services_case_id = c.id and d.storage_key is not null) as "documentCount"`;
// A list takes its page on the index first (the same rule as the reader's), then the wrapper confirms each row of the page, so the cost of a page
// does not grow with the number of cases (each wrapper call is a few dozen buffer hits of function planning).
const PAGE = (side: Side, where: string) => `select ${FIELDS(side)} from (select * from ${side}_services_case where ${where} and id < $2::bigint order by id desc limit ${CASE_PAGE + 1}) c
  left join job j on j.id = c.job_id where private.${side}_case_readable($1, c.id) order by c.id desc`;
const ONE = (side: Side) => `select ${FIELDS(side)} from ${side}_services_case c left join job j on j.id = c.job_id where c.id = $2::bigint and private.${side}_case_readable($1, c.id)`;
export const TRACKER_SQL = {
  candidate: { list: PAGE("candidate", "candidate_user_id = $1"), one: ONE("candidate") },
  // the requester's own cases, plus the company's portal cases when the login is its Owner or Recruiter ($3, else null; the wrapper has the last word)
  portal: { list: PAGE("portal", "(portal_user_id = $1 or organisation_id = $3::bigint)"), one: ONE("portal") },
};
const MAX_ID = "9223372036854775807";

async function readOne(db: Pick<pg.Pool, "query">, side: Side, who: { userId: string }, id: string) {
  if (!validId(id)) throw new Refuse(404, "CASE_NOT_FOUND");
  const r = (await db.query(TRACKER_SQL[side].one, [who.userId, id])).rows[0];
  if (!r) throw new Refuse(404, "CASE_NOT_FOUND");
  return r;
}

async function listCases(db: pg.Pool, side: Side, who: Who, after: string | null) {
  const from = after === null ? MAX_ID : decodeIdCursor("services_cases", after);
  const all = (await db.query(TRACKER_SQL[side].list, side === "candidate" ? [who.userId, from] : [who.userId, from, COMPANY_READERS.includes(who.role ?? "") ? who.organisationId : null])).rows;
  const rows = all.slice(0, CASE_PAGE);
  return { cases: rows, next: all.length > CASE_PAGE ? encodeIdCursor("services_cases", rows.at(-1)!.id) : null };
}

// ===== the four routes of each side
/** POST .../cases: a new request. */
export const casePost = (r: Request, env: CasesEnv) => caseRoute(r, env, true, async (db, who, text) => {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Refuse(400, "BAD_REQUEST"); }
  const b = checkCaseRequest(env.side, parsed);
  if (!b) throw new Refuse(400, "BAD_REQUEST");
  return createCase(db, env.side, who, b);
});
/** GET .../cases?after: the caller's cases, newest first. */
export const casesGet = (r: Request, env: CasesEnv) => caseRoute(r, env, false, async (db, who) => {
  const q = new URL(r.url).searchParams;
  if ([...q.keys()].some((k) => k !== "after") || q.getAll("after").length > 1) throw new Refuse(400, "BAD_REQUEST");
  return listCases(db, env.side, who, q.get("after"));
});
/** GET .../cases/[id]: one case. */
export const caseGet = (r: Request, env: CasesEnv, id: string) => caseRoute(r, env, false, async (db, who) => ({ case: await readOne(db, env.side, who, id) }));
/** POST .../cases/[id]/withdraw: the requester closes an open case as withdrawn (0062). */
export const caseWithdraw = (r: Request, env: CasesEnv, id: string) => caseRoute(r, env, true, async (db, who) => {
  if (!validId(id)) throw new Refuse(404, "CASE_NOT_FOUND");
  await db.query(`select private.${env.side}_case_withdraw($1, $2::bigint)`, [who.userId, id]);
  return { case: await readOne(db, env.side, who, id) };
});
