import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readFetchedJob, readFetchedJobDryRun, readFetchedJobs, readMe, readRules } from "../../lib/data";
import { errorWords } from "../_queue/messages";
import { guarded, one } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { readCheckParams } from "./text";
import { FetchedJobs, href, type DryState } from "./view";

export const metadata: Metadata = { title: `Fetched jobs, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Params = { stage?: string | string[]; id?: string | string[]; after?: string | string[]; soc?: string | string[]; low?: string | string[]; high?: string | string[]; contract?: string | string[] };
const code = (e: unknown) => (e instanceof Error ? e.message.split(":")[0]! : "");

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const stage = one(q.stage);
  const id = one(q.id);
  const after = one(q.after);
  const input = readCheckParams({ soc: one(q.soc), low: one(q.low), high: one(q.high), contract: one(q.contract) });
  const r = await guarded(async () => {
    const me = await readMe();
    let list, shown = stage;
    try {
      list = await readFetchedJobs({ after, stage });
    } catch (e) {
      if (!["bad_cursor", "bad_stage"].includes(code(e))) throw e;
      list = await readFetchedJobs({}); // a link that does not read (a made-up category or page): the whole queue, not an error page
      shown = undefined;
    }
    const selectedId = id ?? list.items[0]?.id;
    const selected = selectedId === undefined ? null : await readFetchedJob(selectedId);
    let socOptions: { code: string; title: string }[] = [];
    let dryState: DryState = { dry: null };
    const soc = input.soc ?? selected?.occupationCode ?? "";
    if (selected) {
      const rules = await readRules();
      const seen = new Set<string>();
      for (const v of rules.inForce) if (v.kind === "critical_skills_list") for (const e of v.data as { code: string; title: string }[]) if (!seen.has(e.code)) { seen.add(e.code); socOptions.push({ code: e.code, title: e.title }); }
      socOptions = socOptions.sort((a, b) => a.code.localeCompare(b.code));
      if (selected.status !== "done" && soc !== "") {
        try {
          dryState = { dry: await readFetchedJobDryRun(selected.id, { occupationCode: soc, salaryLow: input.low, salaryHigh: input.high, contractConfirmed: input.contract ? true : undefined }) };
        } catch (e) {
          const c = code(e);
          if (!["bad_occupation_code", "bad_salary", "bad_input", "job_not_in_review", "no_advert_text", "already_decided"].includes(c)) throw e;
          dryState = { dry: null, problem: errorWords(c, 400) };
        }
      }
    }
    return { me, list, selected, missingId: id !== undefined && selected === null, socOptions, dryState, soc, shown };
  });
  if (r.refused) return <NoAccess title="Fetched job queue" role="fetched job reviewer" />;
  const { me, list, selected, missingId, socOptions, dryState, soc, shown: live } = r.value;
  return (
    <FetchedJobs
      items={list.items} counts={list.counts} stage={live} selected={selected} missingId={missingId} meId={me.id} dryState={dryState} socOptions={socOptions} soc={soc}
      contract={input.contract} low={input.low} high={input.high} now={new Date()}
      next={list.next ? href({ stage: live, after: list.next }) : undefined} prev={after ? href({ stage: live }) : undefined}
    />
  );
}
