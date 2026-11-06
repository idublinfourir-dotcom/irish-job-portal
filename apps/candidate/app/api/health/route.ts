import { checkDatabase } from "@portal/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const database = await checkDatabase();
  return Response.json({ ok: database, database }, { status: database ? 200 : 503 });
}
