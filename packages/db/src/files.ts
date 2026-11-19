// Stored files (step 10 CV, step 14 case documents): the routes' work for both apps. The person always comes from the session and is in every
// WHERE or INSERT (no row level security). Storage keys are random (cv/<uuid>, case/<uuid>) and never leave the server except inside a 60-second
// presigned link. Order: object first, then the row (an upload whose row fails removes its object; a delete removes the object, then the row).
// Plain uploads and replacements write no audit_event, the same as the profile and every other candidate or portal write (only the export does).
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getPool } from "./index";
import { CANDIDATE_RATE, Refuse, withinRate, type CandidateEnv } from "./candidate-route";
import { checkUpload, cleanName, EXT, MAX_BODY, MIME, readUpload, type Kind } from "./file-check";
import { fileStore, FilesUnavailable } from "./file-store";
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
/** A 60-second download link to a stored copy (the staff read of written authority, job-queues.ts). Throws FilesUnavailable when storage is off. */
export const fileLink = (key: string, fileName: string, kind: string) => fileStore().link(key, { fileName, contentType: mime(kind), seconds: LINK_SECONDS });
const REFUSED_STATUS: Record<string, number> = { EMPTY_FILE: 400, FILE_TOO_LARGE: 413, WRONG_FILE_TYPE: 415 };

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
  const c = checkUpload(up.bytes, allowed);
  if ("refused" in c) throw new Refuse(REFUSED_STATUS[c.refused]!, c.refused);
  return { bytes: up.bytes, kind: c.contentType, name: cleanName(up.name, c.contentType, fallback) };
}

// ===== staff uploads (Q6 the employer's written confirmation, Q7 trust and safety evidence; PDF, JPEG or PNG, the case documents' limits) =====
// The admin routes check the size header before the session (MAX_UPLOAD_BODY) and the role before the body is read; the key keeps the type's extension,
// so a download needs no other column. Refusals are QueueRefused codes for the admin routes.
export { MAX_BODY as MAX_UPLOAD_BODY } from "./file-check";
export type StoredDocument = { key: string; contentType: Kind; fileName: string; sizeBytes: number };

/** Reads one uploaded file, stores it under `<prefix>/<uuid>.<ext>` and passes it to `save`; the stored file is removed when `save` throws. */
export async function storeStaffDocument<T>(request: Request, prefix: "sponsor" | "evidence", save: (d: StoredDocument) => Promise<T>): Promise<T> {
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
  await fileStore().remove(storage_key);
  await db.query(CV_SQL.delete, [userId, storage_key]);
  return { ok: true };
});

export const cvDownload = (r: Request, env: FilesEnv) => fileRoute(r, env, "read", async (db, userId) => {
  const cv = await cvRow(db, userId);
  return download(await fileStore().link(cv.storage_key, { fileName: cv.file_name, contentType: mime(cv.content_type), seconds: LINK_SECONDS }));
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
  return download(await fileStore().link(d.storage_key, { fileName: d.file_name, contentType: mime(d.content_type), seconds: LINK_SECONDS }));
});

// ===== the company logo (P3: the account owner; PNG, JPEG or WebP, at most 1 MB) =====
// The bucket is private like the rest; a public read path for the company page (a short link per view) comes with the page (step 16).
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
  const c = checkUpload(up.bytes, ["png", "jpeg", "webp"], MAX_LOGO);
  if ("refused" in c) throw new Refuse(REFUSED_STATUS[c.refused]!, c.refused);
  const key = `logo/${randomUUID()}.${EXT[c.contentType]}`;
  const store = fileStore();
  await store.put(key, up.bytes, MIME[c.contentType]);
  let old: string | null;
  try { old = (await db.query("select private.company_logo($1, $2) r", [userId, key])).rows[0].r.oldKey; } catch (e) {
    await store.remove(key).catch(() => {});
    throw companyRefused(e);
  }
  // ponytail: a failed removal leaves the old file in the bucket unreferenced; a sweep of logo/ keys not in organisation.logo_key would clear it
  if (old) await store.remove(old).catch(() => {});
  return { logo: { contentType: MIME[c.contentType], sizeBytes: up.bytes.length } };
}, MAX_LOGO + 16 * 1024);

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
  return download(await fileStore().link(d.storage_key, { fileName: d.file_name, contentType: mime(d.content_type), seconds: LINK_SECONDS }));
});
