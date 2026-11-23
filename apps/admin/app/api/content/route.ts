// The content editor (#234 D3): GET lists the pages of every state (?kind=&status=&after=), shows one with its body (?id=), lists the stale guides, help and occupation pages (?stale=1, optionally &kind=guide, help or occupation; Q14, B74) or shows one page as its public page would (?id=&preview=1, B74); POST creates or edits a draft and
// publishes or withdraws a page. Who may do what is decided in the database calls: a content editor writes drafts, publishes help and updates and withdraws any
// page; a rules-data editor publishes guides and occupation texts. The database wants a source and a checked-on date to publish anything but help.
import { staffSettings } from "@portal/auth";
import { createContentDraft, editContentDraft, getContentPage, getPool, listContentPages, listStaleContent, previewContentPage, publishContent, withdrawContent } from "@portal/db";
import { BadRequest, checkLength, checkOrigin, id19, parseBody, readQuery, refuse, type Field, type Spec } from "../../../lib/admin-api";
import { requireStaff } from "../../../lib/staff";

export const dynamic = "force-dynamic";

const MAX_BODY = 110_000; // characters: a 50,000-character text with its JSON escaping, and the other fields
const ACTIONS: Record<string, Spec> = {
  create: { need: ["kind", "slug", "title", "body"], may: ["sourceUrl", "checkedOn", "category", "effectiveFrom"] },
  edit: { need: ["id"], may: ["title", "body", "sourceUrl", "checkedOn", "category", "effectiveFrom"] },
  publish: { need: ["id"] },
  withdraw: { need: ["id"] },
};
// The value rules live in the database module; these only keep a wrong type out of it.
const text: Field["0"] = (v) => typeof v === "string";
const FIELDS: Record<string, Field> = {
  id: [id19, "bad_id"], kind: [text, "bad_kind"], slug: [text, "bad_slug"], title: [text, "bad_title"], body: [text, "bad_body_text"], sourceUrl: [text, "bad_source_url"], checkedOn: [text, "bad_checked_on"],
  category: [text, "bad_category"], effectiveFrom: [text, "bad_effective_from"],
};

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request.headers);
    const q = readQuery(request.url, ["id", "kind", "status", "after", "stale", "preview"]);
    if (q.stale !== undefined) {
      if (q.stale !== "1" || Object.keys(q).some((k) => k !== "stale" && k !== "kind")) throw new BadRequest("bad_query");
      return Response.json(await listStaleContent(getPool(), staff, q.kind));
    }
    if (q.preview !== undefined) {
      if (q.preview !== "1" || q.id === undefined || Object.keys(q).length > 2) throw new BadRequest("bad_query");
      const found = await previewContentPage(getPool(), staff, q.id);
      return found ? Response.json({ item: found }, { headers: { "cache-control": "no-store" } }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (q.id !== undefined) {
      const found = await getContentPage(getPool(), staff, q.id);
      return found ? Response.json({ item: found }) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(await listContentPages(getPool(), staff, { kind: q.kind, status: q.status, after: q.after }));
  } catch (e) {
    return refuse(e, "content");
  }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), new URL(staffSettings(process.env).baseURL).origin);
    checkLength(request.headers.get("content-length"), MAX_BODY);
    const staff = await requireStaff(request.headers);
    const b = parseBody(await request.text(), MAX_BODY, ACTIONS, FIELDS);
    const db = getPool();
    const s = (k: string) => b[k] as string;
    const o = (k: string) => b[k] as string | undefined;
    switch (b.action) {
      case "create": return Response.json({ ok: true, ...(await createContentDraft(db, staff, { kind: s("kind"), slug: s("slug"), title: s("title"), body: s("body"), sourceUrl: o("sourceUrl"), checkedOn: o("checkedOn"), category: o("category"), effectiveFrom: o("effectiveFrom") })) });
      case "edit": await editContentDraft(db, staff, s("id"), { title: o("title"), body: o("body"), sourceUrl: o("sourceUrl"), checkedOn: o("checkedOn"), category: o("category"), effectiveFrom: o("effectiveFrom") }); break;
      case "publish": await publishContent(db, staff, s("id")); break;
      case "withdraw": await withdrawContent(db, staff, s("id")); break;
    }
    return Response.json({ ok: true });
  } catch (e) {
    return refuse(e, "content");
  }
}
