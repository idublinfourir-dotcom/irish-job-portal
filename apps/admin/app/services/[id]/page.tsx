import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Notice, SITE_NAME } from "@portal/ui";
import { readMe, readServiceCase, readServiceCaseDocuments, readSolicitors, readStaff } from "../../../lib/data";
import { guarded } from "../../_queue/guard";
import { NoAccess } from "../../_queue/no-access";
import { words, type CaseItem } from "../text";
import { CaseView, type DocsState } from "./detail";

export const metadata: Metadata = { title: `Services case, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const codeOf = (e: unknown) => (e instanceof Error ? e.message.split(":")[0]! : "");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await guarded(async () => {
    const me = await readMe();
    let item: CaseItem | null;
    try {
      item = (await readServiceCase(id)) as unknown as CaseItem | null; // writes the data_access row for this open
    } catch (e) {
      if (codeOf(e) === "own_case") return { me, item: null, own: true as const };
      throw e;
    }
    if (!item) return { me, item: null, own: false as const };
    const isHandler = me.roles.includes("services_case_handler");
    const isAdmin = me.roles.includes("administrator");
    const mine = isHandler && item.assignedStaffUserId === me.id;
    let docs: DocsState = { kind: "hidden", why: isHandler ? "not_mine" : "admin" };
    if (mine) {
      try {
        docs = { kind: "list", docs: (await readServiceCaseDocuments(id)).documents.map((d) => ({ ...d, uploadedAt: new Date(d.uploadedAt).toISOString() })) }; // the route sends the time as JSON text; the read gives a Date
      } catch (e) {
        docs = { kind: "error", text: words(codeOf(e), 400) };
      }
    }
    const open = item.status !== "closed";
    const firms = mine && open ? ((await readSolicitors()).items as unknown as { id: string; firm: string; active: boolean }[]) : [];
    const solicitors = firms.filter((s) => s.active).map((s) => ({ id: s.id, firm: s.firm }));
    const handlers = isAdmin && open ? (await readStaff()).staff.filter((s) => s.status === "active" && s.roles.includes("services_case_handler")).map((s) => ({ id: s.id, name: s.name })) : [];
    return { me, item, own: false as const, isHandler, isAdmin, docs, solicitors, handlers };
  });
  if (r.refused) return <NoAccess title="Services cases" role="services case handler or administrator" />;
  const v = r.value;
  if (v.own) return <div className="flex max-w-2xl flex-col gap-4"><h1 className="text-[32px] leading-tight">Services case</h1><Notice kind="info" title="This case is not for you to open">{words("own_case", 403)}</Notice></div>;
  if (!v.item) notFound();
  return <CaseView item={v.item} meId={v.me.id} isHandler={v.isHandler!} isAdmin={v.isAdmin!} docs={v.docs!} handlers={v.handlers!} solicitors={v.solicitors!} />;
}
