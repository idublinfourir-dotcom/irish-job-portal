import { checkDatabase, sharpWorks } from "@portal/db";

export const dynamic = "force-dynamic";

export async function GET() {
  // sharp (U3): true when the image re-encoder loads in this deployed function; worked out once per instance, a boolean only
  const [database, sharp] = await Promise.all([checkDatabase(), sharpWorks()]);
  return Response.json({ ok: database, database, sharp }, { status: database ? 200 : 503 });
}
