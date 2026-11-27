// Stored files (step 10 CV, step 14 case documents): the routes' work for both apps. The person always comes from the session and is in every
// WHERE or INSERT (no row level security). Storage keys are random (cv/<uuid>, case/<uuid>) and never leave the server except inside a 60-second
// presigned link. Order: an upload stores the object first, then the row (a row that fails removes its object); a delete removes the row first,
// then the object (audit OPS-3: a failed removal leaves only an unnamed object, which the weekly sweep in retention-cli.ts removes).
// Plain uploads and replacements write no audit_event, the same as the profile and every other candidate or portal write (only the export does).
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getPool } from "./index";
import { CANDIDATE_RATE, Refuse, withinRate, type CandidateEnv } from "./candidate-route";
import { checkUpload, cleanName, EXT, MAX_BODY, MAX_FILE, MIME, readUpload, type Kind } from "./file-check";
import { disarm } from "./file-disarm";
import { disposition, fileStore, FilesUnavailable } from "./file-store";
import { QueueRefused } from "./admin-queue";
import { validId } from "./search";

export { FilesUnavailable, memoryStore, setFileStore, type FileStore, type MemoryStore } from "./file-store";

export const UPLOAD_RATE = { windowMs: 60 * 60_000, max: 10 }; // uploads per login an hour, on top of the candidate write limit
export const MAX_CASE_DOCUMENTS = 20; // stored copies per case, uploaded by this side
export const LINK_SECONDS = 60;
export type Side = "candidate" | "portal";
export type FilesEnv = CandidateEnv & { side: Side };

const no = (status: number, code: string) => Response.json({ code }, { status });
const download = (url: string) => new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
const mime = (t: string) => MIME[t as Kind] ?? "application/octet-stream";

// ===== the one staff file view (S-Q6, S-Q7 A): never a presigned link; the bytes through our admin route, after the malware scan =====
/** The GuardDuty Malware Protection tag as a gate: only NO_THREATS_FOUND opens; no tag yet is "pending"; anything else is "blocked". Pure. */
export const scanGate = (tag: string | null): "ok" | "pending" | "blocked" => (tag === "NO_THREATS_FOUND" ? "ok" : tag === null ? "pending" : "blocked");
/** SEC-14: an owner's own download opens only after the malware scan passed, as the staff view does (409 SCAN_PENDING or FILE_BLOCKED, no link made). */
async function scannedLink(d: { storage_key: string; file_name: string; content_type: string }): Promise<Response> {
  const store = fileStore();
  const gate = scanGate(await store.scanStatus(d.storage_key));
  if (gate !== "ok") throw new Refuse(409, gate === "pending" ? "SCAN_PENDING" : "FILE_BLOCKED");
  return download(await store.link(d.storage_key, { fileName: d.file_name, contentType: mime(d.content_type), seconds: LINK_SECONDS }));
}
// No fetch directives (default-src): Chrome, Edge and Safari have refused to show a PDF framed under default-src 'none', and Firefox's viewer takes
// the page's CSP; sandbox makes Chrome refuse the PDF outright. The content type is fixed and nosniff is set, so nothing renders as HTML anyway;
// frame-ancestors only stops another site framing the file.
export const STAFF_VIEW_CSP = "frame-ancestors 'self'";
/** The stored copy itself, for a staff route, called inside the caller's role check and transaction (the caller writes its data_access row after
 *  this returns). The content type comes from the stored kind, never the uploader. QueueRefused scan_pending or file_blocked (409) before the scan
 *  passes, not_found when the object is missing; FilesUnavailable when storage is off. */
export async function staffFileView(key: string, kind: string, fileName: string): Promise<Response> {
  if (!Object.hasOwn(MIME, kind)) throw new Error("staff file view: unknown stored kind");
  const store = fileStore();
  const gate = scanGate(await store.scanStatus(key));
  if (gate !== "ok") throw new QueueRefused(gate === "pending" ? "scan_pending" : "file_blocked");
  const o = await store.get(key, MAX_FILE); // 4 MiB, under Vercel's 4.5 MB response limit
  if (!o) throw new QueueRefused("not_found");
  return new Response(o.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: {
    "content-type": MIME[kind as Kind], "content-length": String(o.bytes.length), "content-disposition": disposition(fileName, "inline"),
    "x-content-type-options": "nosniff", "cache-control": "no-store", "content-security-policy": STAFF_VIEW_CSP, "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
  } });
}
const REFUSED_STATUS: Record<string, number> = { EMPTY_FILE: 400, FILE_TOO_LARGE: 413, WRONG_FILE_TYPE: 415, FILE_ACTIVE_CONTENT: 422 };
/** The type check, then disarm (file-disarm.ts): the bytes to store, or a Refuse. Every upload passes here (CV, case documents, authority, staff, logo). */
async function checked(bytes: Uint8Array, allowed: readonly Kind[], max = MAX_FILE): Promise<{ bytes: Uint8Array; kind: Kind }> {
  const c = checkUpload(bytes, allowed, max);
  if ("refused" in c) throw new Refuse(REFUSED_STATUS[c.refused]!, c.refused);
  const d = await disarm(bytes, c.contentType, max);
  if ("refused" in d) throw new Refuse(REFUSED_STATUS[d.refused]!, d.refused);
  return { bytes: d.bytes, kind: c.contentType };
}

type Mode = "read" | "write" | "upload";
// Origin (writes), the size header (uploads, before any read), the session, the rate limits, then the work. A Refuse is a short code, a missing
// storage setting a 503 (only these routes), a database rule (the same-person guard) a 403; anything else is thrown (a 500, nothing leaked).
// `cap`: the upload's size limit by header (the logo's is smaller than the 4 MiB file cap).
async function fileRoute(request: Request, env: FilesEnv, mode: Mode, work: (db: pg.Pool, userId: string) => Promise<unknown>, cap = MAX_BODY): Promise<Response> {
  if (mode !== "read" && request.headers.get("origin") !== env.origin) return no(403, "BAD_ORIGIN");
  if (mode === "upload" && Number(request.headers.get("content-length") ?? 0) > cap) return no(413, "FILE_TOO_LARGE");
  const who = await env.login(request.headers);
  if ("refused" in who) return who.refused === "no_session" ? no(401, "NO_SESSION") : no(403, "REFUSED");
  const table = `${env.side}_rate_limit` as const;
  if (mode !== "read" && env.side === "candidate" && !(await withinRate(table, `candidate:${who.userId}`, CANDIDATE_RATE))) return no(429, "TOO_MANY_REQUESTS");
  if (mode === "upload" && !(await withinRate(table, `upload:${who.userId}`, UPLOAD_RATE))) return no(429, "TOO_MANY_REQUESTS");
  try {
    const r = await work(getPool(), who.userId);
    return r instanceof Response ? r : Response.json(r);
  } catch (e) {
    if (e instanceof Refuse) return no(e.status, e.code);
    if (e instanceof FilesUnavailable) return no(503, "FILES_UNAVAILABLE");
    const code = (e as { code?: string })?.code;
    if (code === "P0001") return no(403, "REFUSED");
    if (code === "23514") return no(400, "BAD_REQUEST");
    throw e;
  }
}

async function upload(request: Request, allowed: readonly Kind[], fallback: "cv" | "document") {
  const up = await readUpload(request);
  if ("code" in up) throw new Refuse(up.status, up.code);
  const c = await checked(up.bytes, allowed);
  return { ...c, name: cleanName(up.name, c.kind, fallback) };
}

// ===== staff uploads (Q6 the employer's written confirmation, Q7 trust and safety evidence; PDF, JPEG or PNG, the case documents' limits) =====
// The admin routes check the size header before the session (MAX_UPLOAD_BODY) and the role before the body is read; the key keeps the type's extension,
// so a download needs no other column. Refusals are QueueRefused codes for the admin routes.
export { MAX_BODY as MAX_UPLOAD_BODY } from "./file-check";
export type StoredDocument = { key: string; contentType: Kind; fileName: string; sizeBytes: number };

/** Reads one uploaded file, stores it under `<prefix>/<uuid>.<ext>` and passes it to `save`; the stored file is removed when `save` throws. */
export async function storeStaffDocument<T>(request: Request, prefix: "sponsor" | "evidence" | "rules", save: (d: StoredDocument) => Promise<T>): Promise<T> {
  let f;
  try { f = await upload(request, ["pdf", "jpeg", "png"], "document"); } catch (e) {
    throw e instanceof Refuse ? new QueueRefused(e.code === "BAD_REQUEST" ? "bad_file" : e.code.toLowerCase()) : e;
  }
  const key = `${prefix}/${randomUUID()}.${EXT[f.kind]}`;
  const store = fileStore();
  await store.put(key, f.bytes, MIME[f.kind]);
  try {
    return await save({ key, contentType: f.kind, fileName: f.name, sizeBytes: f.bytes.length });
  } catch (e) {
    await store.remove(key).catch(() => {});
    throw e;
  }
}

// ===== the CV (one per candidate, PDF or DOCX) =====
const CV_META = `file_name as "fileName", content_type as "contentType", size_bytes as "sizeBytes", uploaded_at as "uploadedAt"`;
export const CV_SQL = {
  get: `select ${CV_META} from candidate_cv where candidate_user_id = $1`,
  key: "select storage_key, file_name, content_type from candidate_cv where candidate_user_id = $1",
  // A replacement keeps the key, so S3 overwrites the old file. The WHERE makes a lost race (two first uploads at once) update nothing.
  upsert: `insert into candidate_cv(candidate_user_id, storage_key, file_name, content_type, size_bytes) values ($1, $2, $3, $4, $5)
    on conflict (candidate_user_id) do update set file_name = excluded.file_name, content_type = excluded.content_type, size_bytes = excluded.size_bytes, uploaded_at = now()
    where candidate_cv.storage_key = excluded.storage_key returning ${CV_META}`,
  delete: "delete from candidate_cv where candidate_user_id = $1 and storage_key = $2",
};
const cvRow = async (db: pg.Pool, userId: string) => {
  const r = (await db.query(CV_SQL.key, [userId])).rows[0] as { storage_key: string; file_name: string; content_type: string } | undefined;
  if (!r) throw new Refuse(404, "CV_NOT_FOUND");
  return r;
};

export const cvGet = (r: Request, env: FilesEnv) => fileRoute(r, env, "read", async (db, userId) => {
  const cv = (await db.query(CV_SQL.get, [userId])).rows[0];
  if (!cv) throw new Refuse(404, "CV_NOT_FOUND");
  return { cv };
});

export const cvPut = (r: Request, env: FilesEnv) => fileRoute(r, env, "upload", async (db, userId) => {
  const f = await upload(r, ["pdf", "docx"], "cv");
  const old = (await db.query(CV_SQL.key, [userId])).rows[0] as { storage_key: string } | undefined;
  const key = old?.storage_key ?? `cv/${randomUUID()}`;
  const store = fileStore();
  await store.put(key, f.bytes, MIME[f.kind]);
  let row;
  try { row = await db.query(CV_SQL.upsert, [userId, key, f.name, f.kind, f.bytes.length]); } catch (e) {
    // ponytail: a failed replacement leaves the new bytes under the old row's metadata; the next upload or delete puts them right
    if (!old) await store.remove(key).catch(() => {});
    throw e;
  }
  if (!row.rowCount) { await store.remove(key).catch(() => {}); throw new Refuse(409, "TRY_AGAIN"); }
  return { cv: row.rows[0] };
});

export const cvDelete = (r: Request, env: FilesEnv) => fileRoute(r, env, "write", async (db, userId) => {
  const { storage_key } = await cvRow(db, userId);
  const store = fileStore(); // storage off: 503 before anything changes
  await db.query(CV_SQL.delete, [userId, storage_key]);
  await store.remove(storage_key).catch(() => {}); // the row is gone, so the weekly sweep removes a file left behind
  return { ok: true };
});

export const cvDownload = (r: Request, env: FilesEnv) => fileRoute(r, env, "read", async (db, userId) => {
  const cv = await cvRow(db, userId);
  return scannedLink(cv);
});

// ===== case documents (PDF, JPEG or PNG; through each side's own views) =====
const DOC_META = `id::text as id, file_name as "fileName", content_type as "contentType", byte_size as "sizeBytes", uploaded_at as "uploadedAt", copy_deleted_at is not null as "copyDeleted"`;
export const docSql = (side: Side) => ({
  case: `select c.status, (select count(*)::int from ${side}_case_document d where d.services_case_id = c.id and d.storage_key is not null) as stored
    from ${side}_services_case c where c.id = $1::bigint and c.${side}_user_id = $2`,
  insert: `insert into ${side}_case_document(services_case_id, storage_key, file_name, content_type, byte_size, ${side}_user_id) values ($1::bigint, $2, $3, $4, $5, $6) returning ${DOC_META}`,
  list: `select ${DOC_META} from ${side}_case_document where services_case_id = $1::bigint and ${side}_user_id = $2 order by id`,
  one: `select storage_key, file_name, content_type from ${side}_case_document where id = $1::bigint and services_case_id = $2::bigint and ${side}_user_id = $3 and storage_key is not null`,
});

async function ownCase(db: pg.Pool, side: Side, caseId: string, userId: string) {
  if (!validId(caseId)) throw new Refuse(400, "BAD_REQUEST");
  const c = (await db.query(docSql(side).case, [caseId, userId])).rows[0] as { status: string; stored: number } | undefined;
  if (!c) throw new Refuse(404, "CASE_NOT_FOUND"); // not this person's, whatever the case is
  return c;
}

export const caseDocsGet = (r: Request, env: FilesEnv, caseId: string) => fileRoute(r, env, "read", async (db, userId) => {
  await ownCase(db, env.side, caseId, userId);
  return { documents: (await db.query(docSql(env.side).list, [caseId, userId])).rows };
});

export const caseDocsPost = (r: Request, env: FilesEnv, caseId: string) => fileRoute(r, env, "upload", async (db, userId) => {
  const c = await ownCase(db, env.side, caseId, userId);
  if (c.status === "decision" || c.status === "closed") throw new Refuse(409, "CASE_CLOSED");
  // ponytail: two uploads at the same moment can both pass the count and make 21; a lock on the case needs a grant the roles do not have
  if (c.stored >= MAX_CASE_DOCUMENTS) throw new Refuse(409, "DOCUMENT_LIMIT");
  const f = await upload(r, ["pdf", "jpeg", "png"], "document");
  const key = `case/${randomUUID()}`;
  const store = fileStore();
  await store.put(key, f.bytes, MIME[f.kind]);
  try {
    return { document: (await db.query(docSql(env.side).insert, [caseId, key, f.name, f.kind, f.bytes.length, userId])).rows[0] };
  } catch (e) {
    await store.remove(key).catch(() => {});
    throw e;
  }
});

export const caseDocGet = (r: Request, env: FilesEnv, caseId: string, docId: string) => fileRoute(r, env, "read", async (db, userId) => {
  if (!validId(caseId) || !validId(docId)) throw new Refuse(400, "BAD_REQUEST");
  const d = (await db.query(docSql(env.side).one, [docId, caseId, userId])).rows[0] as { storage_key: string; file_name: string; content_type: string } | undefined;
  if (!d) throw new Refuse(404, "DOCUMENT_NOT_FOUND");
  return scannedLink(d);
});

// ===== the company logo (P3: the account owner; PNG, JPEG or WebP, at most 1 MB) =====
// The bucket is private like the rest; the public pages read the logo through logoView below (migration 0074).
export const MAX_LOGO = 1024 * 1024;
const OWNER = "select 1 from membership where portal_user_id = $1 and status = 'active' and role = 'account_owner'";
const companyRefused = (e: unknown) => {
  const { code, message = "" } = (e ?? {}) as { code?: string; message?: string };
  const c = code === "P0001" ? /^(?:team|company) refused: ([A-Z_]+)/.exec(message)?.[1] : undefined;
  if (c === "ORGANISATION_NOT_AVAILABLE") return new Refuse(409, c);
  return c ? new Refuse(403, c === "NOT_OWNER" ? c : "REFUSED") : e;
};

// The 1 MiB cap (with the multipart wrapping) is checked by header before the session, like the file cap on the other uploads.
export const logoPut = (r: Request, env: FilesEnv) => fileRoute(r, env, "upload", async (db, userId) => {
  // the owner check before the body is read, so no one else fills the bucket; company_logo checks again under the company's lock
  if (!(await db.query(OWNER, [userId])).rowCount) throw new Refuse(403, "NOT_OWNER");
  const up = await readUpload(r);
  if ("code" in up) throw new Refuse(up.status, up.code);
  const c = await checked(up.bytes, ["png", "jpeg", "webp"], MAX_LOGO);
  const key = `logo/${randomUUID()}.${EXT[c.kind]}`;
  const store = fileStore();
  await store.put(key, c.bytes, MIME[c.kind]);
  let old: string | null;
  // the public address the pages read (organisation.logo_url): this app's own logoView route
  try { old = (await db.query("select private.company_logo($1, $2, $3) r", [userId, key, `${env.origin}/api/portal/company/logo/${key.slice(5)}`])).rows[0].r.oldKey; } catch (e) {
    await store.remove(key).catch(() => {});
    throw companyRefused(e);
  }
  // a failed removal leaves the old file unnamed; the weekly orphan sweep (retention-cli.ts sweep) removes it
  if (old) await store.remove(old).catch(() => {});
  return { logo: { contentType: MIME[c.kind], sizeBytes: c.bytes.length } };
}, MAX_LOGO + 16 * 1024);

const LOGO_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;
const LOGO_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
export const LOGO_BY_KEY = "select 1 from organisation where logo_key = $1 and status not in ('rejected','closed','banned')";
/** GET /api/portal/company/logo/<uuid>.<ext>, no login: the company's current logo (organisation.logo_key) for the public pages, once the malware scan has passed.
 *  Any other name, an old logo, a rejected, closed or banned company, and a file not scanned yet are the same 404. The key changes with each upload, so the reply may be cached. */
export async function logoView(file: string): Promise<Response> {
  if (!LOGO_FILE.test(file)) return no(404, "NOT_FOUND");
  const key = `logo/${file}`;
  if (!(await getPool().query(LOGO_BY_KEY, [key])).rowCount) return no(404, "NOT_FOUND");
  try {
    const store = fileStore();
    if (scanGate(await store.scanStatus(key)) !== "ok") return no(404, "NOT_FOUND");
    const o = await store.get(key, MAX_LOGO);
    if (!o) return no(404, "NOT_FOUND");
    return new Response(o.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: {
      "content-type": LOGO_TYPE[file.split(".")[1]!]!, "content-length": String(o.bytes.length), "x-content-type-options": "nosniff", "cache-control": "public, max-age=3600",
      "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "cross-origin", "referrer-policy": "no-referrer" } });
  } catch (e) {
    if (e instanceof FilesUnavailable) return no(503, "FILES_UNAVAILABLE");
    throw e;
  }
}

// ===== the client's written authority on an agency job (P8: optional, beside the tick; PDF, JPEG or PNG, the case documents' limits) =====
// The member comes from the login (an active poster, recruiter or owner); the job must be this company's agency job that names a client.
const AUTH_META = `id::text as id, file_name as "fileName", content_type as "contentType", byte_size as "sizeBytes", uploaded_at as "uploadedAt", copy_deleted_at is not null as "copyDeleted"`;
export const AUTHORITY_SQL = {
  job: `select m.id as membership, m.organisation_id as org, (select count(*)::int from job_authority_document d where d.job_id = j.id and d.storage_key is not null) as stored
    from membership m join job j on j.organisation_id = m.organisation_id
    where m.portal_user_id = $2 and m.status = 'active' and m.role in ('account_owner','recruiter','poster')
      and j.id = $1::bigint and j.source = 'agency' and j.permit_employer_kind = 'client'`,
  insert: `insert into job_authority_document(job_id, organisation_id, uploaded_by_membership_id, storage_key, file_name, content_type, byte_size)
    values ($1::bigint, $2, $3, $4, $5, $6, $7) returning ${AUTH_META}`,
  list: `select ${AUTH_META} from job_authority_document where job_id = $1::bigint and organisation_id = $2 order by id`,
  one: `select storage_key, file_name, content_type from job_authority_document where id = $1::bigint and job_id = $2::bigint and organisation_id = $3 and storage_key is not null`,
};
async function authorityJob(db: pg.Pool, jobId: string, userId: string) {
  if (!validId(jobId)) throw new Refuse(400, "BAD_REQUEST");
  const j = (await db.query(AUTHORITY_SQL.job, [jobId, userId])).rows[0] as { membership: string; org: string; stored: number } | undefined;
  if (!j) throw new Refuse(404, "JOB_NOT_FOUND"); // another company's job, an employer's own job, or a viewer: all the same
  return j;
}

export const authorityDocsGet = (r: Request, env: FilesEnv, jobId: string) => fileRoute(r, env, "read", async (db, userId) => {
  const j = await authorityJob(db, jobId, userId);
  return { documents: (await db.query(AUTHORITY_SQL.list, [jobId, j.org])).rows };
});

export const authorityDocsPost = (r: Request, env: FilesEnv, jobId: string) => fileRoute(r, env, "upload", async (db, userId) => {
  const j = await authorityJob(db, jobId, userId);
  // a first count before the body is read; the insert counts again under a lock on the job (private.job_authority_limit, 0045), so two uploads at once cannot make 21
  if (j.stored >= MAX_CASE_DOCUMENTS) throw new Refuse(409, "DOCUMENT_LIMIT");
  const f = await upload(r, ["pdf", "jpeg", "png"], "document");
  const key = `authority/${randomUUID()}`;
  const store = fileStore();
  await store.put(key, f.bytes, MIME[f.kind]);
  try {
    return { document: (await db.query(AUTHORITY_SQL.insert, [jobId, j.org, j.membership, key, f.name, f.kind, f.bytes.length])).rows[0] };
  } catch (e) {
    await store.remove(key).catch(() => {});
    if ((e as { message?: string })?.message === "authority refused: DOCUMENT_LIMIT") throw new Refuse(409, "DOCUMENT_LIMIT");
    throw e;
  }
});

export const authorityDocGet = (r: Request, env: FilesEnv, jobId: string, docId: string) => fileRoute(r, env, "read", async (db, userId) => {
  if (!validId(docId)) throw new Refuse(400, "BAD_REQUEST");
  const j = await authorityJob(db, jobId, userId);
  const d = (await db.query(AUTHORITY_SQL.one, [docId, jobId, j.org])).rows[0] as { storage_key: string; file_name: string; content_type: string } | undefined;
  if (!d) throw new Refuse(404, "DOCUMENT_NOT_FOUND");
  return scannedLink(d);
});
