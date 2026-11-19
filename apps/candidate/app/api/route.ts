// GET /api (decision #265): this app's name, deployed commit, environment, the time and every route, from docs/openapi/candidate.yaml
// (packages/db/src/openapi-sync.test.ts keeps lib/api-index.json equal to it). Anyone may read it: these routes are visible in any
// browser anyway. It reads no request input and no database. APP_VERSION is set per deploy by .github/workflows/deploy.yml.
import index from "../../lib/api-index.json";

export const dynamic = "force-dynamic";

export function GET() {
  const env = process.env;
  return Response.json({ success: true, name: index.name, version: env.APP_VERSION ?? "local", environment: env.VERCEL_ENV ?? "development", timestamp: new Date().toISOString(), routes: index.routes });
}
