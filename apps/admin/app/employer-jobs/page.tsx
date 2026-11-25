import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readEmployerJob, readEmployerJobs, readJobAuthority, readMe } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { isQueue, mayOpenCompany, queuesFor } from "./text";
import { EmployerJobs, href } from "./view";

export const metadata: Metadata = { title: `Held jobs, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Params = { queue?: string | string[]; id?: string | string[]; after?: string | string[] };
const code = (e: unknown) => (e instanceof Error ? e.message.split(":")[0]! : "");

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const id = one(q.id);
  const after = one(q.after);
  const r = await guarded(async () => {
    const me = await readMe();
    const queues = queuesFor(me.roles);
    const asked = one(q.queue);
    const queue = isQueue(asked) && queues.includes(asked) ? asked : queues[0]; // a queue the roles do not cover, or made up, is the first of theirs
    if (queue === undefined) throw new Error("not_reviewer");
    let list;
    try {
      list = await readEmployerJobs(queue, { after });
    } catch (e) {
      if (code(e) === "bad_cursor") list = await readEmployerJobs(queue, {}); // a page link that does not read: the first page
      else throw e;
    }
    let selected = null;
    if (id !== undefined) {
      try {
        selected = await readEmployerJob(id);
      } catch (e) {
        if (code(e) !== "not_reviewer") throw e; // an item of a queue these roles do not cover is "not found" here, with nothing of it read
      }
    }
    const documents = selected?.queue === "agency_client_check" ? ((await readJobAuthority(selected.jobId)) ?? []) : null;
    return { me, queues, queue, list, selected, missingId: id !== undefined && selected === null, documents };
  });
  if (r.refused) return <NoAccess title="Held jobs" role="trust and safety, account reviewer or administrator" />;
  const { me, queues, queue, list, selected, missingId, documents } = r.value;
  return (
    <EmployerJobs
      queues={queues} queue={queue} items={list.items} selected={selected} missingId={missingId} meId={me.id} documents={documents} canOpenCompany={mayOpenCompany(me.roles)}
      next={list.next ? href(queue, undefined, list.next) : undefined} prev={after ? href(queue) : undefined}
    />
  );
}
