import { betterAuth } from "better-auth";
import type { Pool } from "pg";

export type LoginPool = "candidate" | "employer" | "staff";

type Options = { database: Pool; baseURL: string; secret: string };

// Three separate login pools in one database (#97): the same email can exist once in each,
// with its own tables and its own cookie.
export function createAuth(name: LoginPool, { database, baseURL, secret }: Options) {
  return betterAuth({
    appName: `portal-${name}`,
    baseURL,
    basePath: `/api/auth/${name}`,
    secret,
    database,
    emailAndPassword: { enabled: true },
    // The default store is per instance. Shared storage is still to be chosen and tested.
    rateLimit: { enabled: true },
    trustedOrigins: [baseURL],
    user: { modelName: `${name}_user` },
    // The cookie cache stays off: it saved little, and old cookies kept working after sign-out.
    session: { modelName: `${name}_session`, cookieCache: { enabled: false } },
    account: { modelName: `${name}_account` },
    verification: { modelName: `${name}_verification` },
    advanced: { cookiePrefix: name, useSecureCookies: baseURL.startsWith("https://") },
  });
}
