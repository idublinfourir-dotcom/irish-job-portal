// Stored files (CVs and case documents) in one private S3 bucket (#209, #239): put, a short download link, remove. Never logs keys, links or settings.
// The settings are FILES_S3_* only: Vercel's docs say AWS_ACCESS_KEY_ID and friends "may appear in your Vercel Functions even if you don't set
// them ... not usable as AWS credentials", so those names are never read. memoryStore() is the fake every test uses.
import { AwsClient } from "aws4fetch";

export type LinkOptions = { fileName: string; contentType: string; seconds?: number };
export type FileStore = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** A presigned GET that downloads (never renders) under the label `fileName`. */
  link(key: string, o: LinkOptions): Promise<string>;
  /** A missing object is not an error. */
  remove(key: string): Promise<void>;
};
export type S3Settings = { keyId: string; secret: string; bucket: string; region: string; endpoint?: string /* tests only: the fake on 127.0.0.1 */ };

export const SETTINGS = { keyId: "FILES_S3_KEY_ID", secret: "FILES_S3_SECRET", bucket: "FILES_S3_BUCKET", region: "FILES_S3_REGION" } as const;
export class FilesUnavailable extends Error {}

/** The settings from the environment; a missing one throws FilesUnavailable naming it (never a value). */
export function s3Settings(env: NodeJS.ProcessEnv): S3Settings {
  const missing = Object.values(SETTINGS).filter((k) => !env[k]);
  if (missing.length) throw new FilesUnavailable(`file storage is off: ${missing.join(", ")} not set`);
  return { keyId: env[SETTINGS.keyId]!, secret: env[SETTINGS.secret]!, bucket: env[SETTINGS.bucket]!, region: env[SETTINGS.region]! };
}

/** RFC 6266 / 5987: the label as UTF-8, every byte outside the unreserved set percent-encoded. */
export const disposition = (fileName: string) =>
  `attachment; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
export const MAX_LINK_SECONDS = 300;

export function s3Store(s: S3Settings): FileStore {
  const aws = new AwsClient({ accessKeyId: s.keyId, secretAccessKey: s.secret, service: "s3", region: s.region, retries: 2 });
  const base = s.endpoint ?? `https://${s.bucket}.s3.${s.region}.amazonaws.com`;
  const url = (key: string) => `${base}/${key}`; // keys are ours (cv/<uuid>, case/<uuid>): nothing to escape
  const send = async (method: string, key: string, init: RequestInit = {}) => {
    const r = await aws.fetch(url(key), { method, ...init });
    await r.body?.cancel();
    if (!r.ok) throw new Error(`file store: ${method} answered ${r.status}`);
  };
  return {
    put: (key, bytes, contentType) => send("PUT", key, { body: bytes as Uint8Array<ArrayBuffer>, headers: { "content-type": contentType } }),
    remove: (key) => send("DELETE", key),
    async link(key, { fileName, contentType, seconds = 60 }) {
      if (!(Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_LINK_SECONDS)) throw new Error(`file store: a link lasts 1 to ${MAX_LINK_SECONDS} seconds`);
      const u = new URL(url(key));
      u.searchParams.set("response-content-disposition", disposition(fileName));
      u.searchParams.set("response-content-type", contentType);
      u.searchParams.set("X-Amz-Expires", String(seconds));
      return (await aws.sign(u.toString(), { method: "GET", aws: { signQuery: true } })).url;
    },
  };
}

export type MemoryStore = FileStore & { objects: Map<string, { bytes: Uint8Array; contentType: string }>; failNext(): void };
/** The test fake: a Map. failNext() makes the next call throw. */
export function memoryStore(): MemoryStore {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  let fail = false;
  const gate = () => { if (fail) { fail = false; throw new Error("file store: fake failure"); } };
  return {
    objects,
    failNext: () => { fail = true; },
    async put(key, bytes, contentType) { gate(); objects.set(key, { bytes: new Uint8Array(bytes), contentType }); },
    async remove(key) { gate(); objects.delete(key); },
    async link(key, { fileName, contentType, seconds = 60 }) {
      gate();
      return `https://files.example.test/${key}?${new URLSearchParams({ "response-content-disposition": disposition(fileName), "response-content-type": contentType, expires: String(seconds) })}`;
    },
  };
}

// The store the routes use: made from the environment on first use, or set by a test. On globalThis so every import shares it.
const shared = globalThis as typeof globalThis & { __portalFileStore?: FileStore };
export const setFileStore = (s: FileStore | undefined) => { shared.__portalFileStore = s; };
export const fileStore = (): FileStore => (shared.__portalFileStore ??= s3Store(s3Settings(process.env)));
