// POST /api/revalidate (Stage 3 step 2, AUDIT section 5): the admin and portal apps and the command-line jobs ask this site to clear the cached pages
// their write changed (packages/db/src/revalidate.ts, revalidateCandidate). Signed with REVALIDATE_SECRET; refused unsigned, wrongly signed, older than
// 60 s, or naming a path off the fixed list. Clearing only marks a page: it regenerates on its next visit.
import { revalidatePath } from "next/cache";
import { checkRevalidate, MAX_BODY, REVALIDATE_HEADER } from "@portal/db/revalidate";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ code: "BAD_BODY" }, { status: 413 });
  const r = checkRevalidate(await request.text(), request.headers.get(REVALIDATE_HEADER), process.env);
  if ("refused" in r) return Response.json({ code: r.code }, { status: r.refused, headers: { "cache-control": "no-store" } });
  for (const t of r.paths) revalidatePath(t.path, t.type);
  return Response.json({ ok: true, cleared: r.paths.length }, { headers: { "cache-control": "no-store" } });
}
