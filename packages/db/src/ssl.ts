import type { ConnectionOptions } from "node:tls";

type Env = Record<string, string | undefined>;

// Encrypted and verified unless a local database opts out. Production can never opt out.
export function sslOptions(env: Env = process.env): false | ConnectionOptions {
  if (env.DATABASE_SSL === "disable") {
    if (env.NODE_ENV === "production") throw new Error("DATABASE_SSL=disable is not allowed in production");
    return false;
  }
  const ca = env.DATABASE_CA_CERT?.replace(/\\n/g, "\n");
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true };
}
