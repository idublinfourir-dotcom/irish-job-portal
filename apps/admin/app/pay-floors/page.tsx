import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readFloorCheck, readFloorChecks, readMe } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { href, PayFloors } from "./view";

export const metadata: Metadata = { title: `Pay floor checks, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Params = { id?: string | string[]; after?: string | string[] };
const code = (e: unknown) => (e instanceof Error ? e.message.split(":")[0]! : "");

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const id = one(q.id);
  const after = one(q.after);
  const r = await guarded(async () => {
    const me = await readMe();
    let list;
    try {
      list = await readFloorChecks({ after });
    } catch (e) {
      if (code(e) === "bad_cursor") list = await readFloorChecks({}); // a page link that does not read: the first page
      else throw e;
    }
    const selected = id === undefined ? (list.items[0] ?? null) : (list.items.find((i) => i.floorId === id) ?? (await readFloorCheck(id)));
    return { me, list, selected, missingId: id !== undefined && selected === null };
  });
  if (r.refused) return <NoAccess title="Pay floor checks" role="rules data editor or administrator" />;
  const { me, list, selected, missingId } = r.value;
  return <PayFloors items={list.items} selected={selected} missingId={missingId} meId={me.id} roles={me.roles} now={new Date()} next={list.next ? href(undefined, list.next) : undefined} prev={after ? href() : undefined} />;
}
