import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readContactMessage, readContactMessages, readMe } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { mayAct } from "./text";
import { Contact, href, type Message, type Summary } from "./view";

export const metadata: Metadata = { title: `Contact messages, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Params = { id?: string | string[]; after?: string | string[] };

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const id = one(q.id);
  const after = one(q.after);
  const r = await guarded(async () => {
    const me = await readMe();
    let list;
    try {
      list = await readContactMessages({ after });
    } catch (e) {
      if (e instanceof Error && e.message.split(":")[0] === "bad_cursor") list = await readContactMessages({}); // a page link that does not read: the first page
      else throw e;
    }
    const selected = id === undefined ? null : await readContactMessage(id); // opening one is logged, so only when asked for
    return { me, list, selected, missingId: id !== undefined && selected === null };
  });
  if (r.refused) return <NoAccess title="Contact messages" role="services case handler, content editor or administrator" />;
  const { me, list, selected, missingId } = r.value;
  return (
    <Contact
      items={list.items as unknown as Summary[]} selected={selected as unknown as Message | null} missingId={missingId} meId={me.id} canAct={mayAct(me.roles)} now={new Date()}
      next={list.next ? href(undefined, list.next) : undefined} prev={after ? href() : undefined}
    />
  );
}
