// GET /api (decision #265): this app's name, deployed commit, environment, the time and every route, from docs/openapi/admin.yaml
// (packages/db/src/openapi-sync.test.ts keeps lib/api-index.json equal to it). Any active staff member only: the staff routes are not
// a public map. No query keys. APP_VERSION is set per deploy by .github/workflows/deploy.yml.
import index from "../../lib/api-index.json";
import { readQuery, refuse } from "../../lib/admin-api";
import { requireStaff } from "../../lib/staff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireStaff(request.headers);
    readQuery(request.url, []);
    const env = process.env;
    return Response.json({ success: true, name: index.name, version: env.APP_VERSION ?? "local", environment: env.VERCEL_ENV ?? "development", timestamp: new Date().toISOString(), routes: index.routes });
  } catch (e) {
    return refuse(e, "api-index");
  }
}
