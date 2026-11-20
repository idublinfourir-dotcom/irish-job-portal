// Stored files (CVs and case documents) in one private S3 bucket (#209, #239): put, a short download link, remove, a capped read (the staff view,
// S-Q6) and the malware scan tag (S-Q7 A, GuardDuty Malware Protection for S3). Never logs keys, links or settings.
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
  /** The stored bytes and their content type; null when the object is missing. Throws when it is over `max` bytes (read no further). */
  get(key: string, max: number): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** The object's GuardDutyMalwareScanStatus tag, or null when it has none (not scanned yet) or the object is missing. */
  scanStatus(key: string): Promise<string | null>;
};
export const SCAN_TAG = "GuardDutyMalwareScanStatus";
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
export const disposition = (fileName: string, how: "attachment" | "inline" = "attachment") =>
  `${how}; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
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
    async get(key, max) {
      const r = await aws.fetch(url(key), { method: "GET" });
      if (r.status === 404) { await r.body?.cancel(); return null; }
      if (!r.ok) { await r.body?.cancel(); throw new Error(`file store: GET answered ${r.status}`); }
      if (Number(r.headers.get("content-length") ?? 0) > max) { await r.body?.cancel(); throw new Error("file store: object over the cap"); }
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > max) throw new Error("file store: object over the cap"); // leaving the loop cancels the stream
        parts.push(chunk);
      }
      return { bytes: new Uint8Array(Buffer.concat(parts)), contentType: r.headers.get("content-type") ?? "application/octet-stream" };
    },
    async scanStatus(key) {
      const r = await aws.fetch(`${url(key)}?tagging`, { method: "GET" });
      const text = await r.text();
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`file store: GET tagging answered ${r.status}`);
      for (const [, k, v] of text.matchAll(/<Tag>\s*<Key>([^<]*)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g)) if (k === SCAN_TAG) return v!;
      return null;
    },
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

export type MemoryStore = FileStore & {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>; tags: Map<string, string | null>; scanDefault: string | null; failNext(): void;
};
/** The test fake: a Map. failNext() makes the next call throw. A stored key's scan status is its entry in `tags` (null: no tag), else
 *  `scanDefault` (NO_THREATS_FOUND, so tests that do not look at the scan open files as before). */
export function memoryStore(): MemoryStore {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>(), tags = new Map<string, string | null>();
  let fail = false;
  const gate = () => { if (fail) { fail = false; throw new Error("file store: fake failure"); } };
  const store: MemoryStore = {
    objects,
    tags,
    scanDefault: "NO_THREATS_FOUND",
    failNext: () => { fail = true; },
    async put(key, bytes, contentType) { gate(); objects.set(key, { bytes: new Uint8Array(bytes), contentType }); },
    async remove(key) { gate(); objects.delete(key); tags.delete(key); },
    async get(key, max) {
      gate();
      const o = objects.get(key);
      if (!o) return null;
      if (o.bytes.length > max) throw new Error("file store: object over the cap");
      return { bytes: new Uint8Array(o.bytes), contentType: o.contentType };
    },
    async scanStatus(key) { gate(); return !objects.has(key) ? null : tags.has(key) ? tags.get(key)! : store.scanDefault; },
    async link(key, { fileName, contentType, seconds = 60 }) {
      gate();
      return `https://files.example.test/${key}?${new URLSearchParams({ "response-content-disposition": disposition(fileName), "response-content-type": contentType, expires: String(seconds) })}`;
    },
  };
  return store;
}

// The store the routes use: made from the environment on first use, or set by a test. On globalThis so every import shares it.
const shared = globalThis as typeof globalThis & { __portalFileStore?: FileStore };
export const setFileStore = (s: FileStore | undefined) => { shared.__portalFileStore = s; };
export const fileStore = (): FileStore => (shared.__portalFileStore ??= s3Store(s3Settings(process.env)));
