// W1c: the one-off move of the saved Workday adverts of the seven employers now read from their own career sites. Each advert whose
// requisition id the new source uses is re-pointed to that source with the new source's id, and its job with it, so the next fetch finds it
// known: no twin, same job id, same saved jobs. Only plain-node imports (with .ts), so workday-move-cli.ts runs it directly. Constant SQL.
import type pg from "pg";
import { inOneTransaction } from "./dete.ts";

type Db = Pick<pg.Pool, "query" | "connect">;

/** Workday tenant to the kind that reads it now. The board name stays the tenant (packages/fetcher/data/boards.json). */
export const MOVES: Readonly<Record<string, string>> = { mastercard: "phenom", thermofisher: "phenom", statestreet: "phenom", abbott: "phenom", citi: "sitemap", fmr: "sitemap", salesforce: "salesforce" };
// The Workday id is `workday:<tenant>:<path>`; the path ends in _<requisition id>, with -1, -2 when the requisition was posted again.
const REQ = /_([A-Za-z0-9.]+(?:-[A-Za-z0-9]{3,})*)(?:-\d{1,2})?$/;
export const requisition = (externalId: string): string | null => REQ.exec(externalId.split("/").pop() ?? "")?.[1] ?? null;

export const ROWS =
  "select f.id::text, f.external_id, s.board from fetched_advert f join job_source s on s.id = f.job_source_id " +
  "where s.kind = 'workday' and s.board = any($1::text[]) order by (f.gone_at is null) desc, f.id desc for update of f";
export const TARGETS = "select id::text, kind, board from job_source where (kind, board) in (select * from unnest($1::text[], $2::text[]))";
// The new board takes over the Workday board's last good fetch, so the 7-day stale close (fetcher store.ts CLOSE_STALE) counts from Workday's last
// success, not from each advert's first sight: a moved job does not close the moment its new board's first run fails.
export const ADD_TARGETS =
  "insert into job_source(kind, board, last_ok_at) select t.k, t.b, (select w.last_ok_at from job_source w where w.kind = 'workday' and w.board = t.b) " +
  "from unnest($1::text[], $2::text[]) t(k, b) on conflict (kind, board) do update set last_ok_at = greatest(job_source.last_ok_at, excluded.last_ok_at) " +
  "returning id::text, kind, board";
export const TAKEN = "select external_id from fetched_advert where job_source_id = any($1::bigint[])";
// One statement: the adverts and their jobs move together. The job side joins the id list, not the CTE, so it reads job by its fetched_advert_id key.
export const MOVE =
  "with f as (update fetched_advert f set job_source_id = t.src, external_id = t.ext from unnest($1::bigint[], $2::bigint[], $3::text[]) t(id, src, ext) " +
  "where f.id = t.id returning 1), j as (update job set job_source_id = t.src from unnest($1::bigint[], $2::bigint[]) t(id, src) where job.fetched_advert_id = t.id returning 1) " +
  "select (select count(*) from f)::int as adverts, (select count(*) from j)::int as jobs";

export type MoveResult = { boards: Record<string, { moved: number; noId: number; taken: number }>; moved: string[]; jobs: number };

/** One transaction. `apply: false` (the dry run) reads only. Running it again moves nothing: the moved rows are no longer Workday rows. */
export async function moveWorkday(db: Db, opts: { apply: boolean }): Promise<MoveResult> {
  return inOneTransaction(db, async (c) => {
    const tenants = Object.keys(MOVES);
    const kinds = tenants.map((t) => MOVES[t]!);
    const targets = (await c.query<{ id: string; kind: string; board: string }>(opts.apply ? ADD_TARGETS : TARGETS, [kinds, tenants])).rows;
    const target = new Map(targets.map((t) => [t.board, t.id]));
    const taken = new Set((await c.query<{ external_id: string }>(TAKEN, [targets.map((t) => t.id)])).rows.map((r) => r.external_id));
    const boards: MoveResult["boards"] = Object.fromEntries(tenants.map((t) => [t, { moved: 0, noId: 0, taken: 0 }]));
    const ids: string[] = [], srcs: string[] = [], exts: string[] = [], moved: string[] = [];
    for (const r of (await c.query<{ id: string; external_id: string; board: string }>(ROWS, [tenants])).rows) {
      const req = requisition(r.external_id);
      const b = boards[r.board]!;
      if (!req) {
        b.noId++;
        continue;
      }
      const ext = `${MOVES[r.board]}:${r.board}:${req}`;
      // already saved under the new source, or a second Workday posting of the same requisition (the live, newest one went first)
      if (taken.has(ext)) {
        b.taken++;
        continue;
      }
      taken.add(ext);
      b.moved++;
      moved.push(`${r.external_id} -> ${ext}`);
      ids.push(r.id);
      srcs.push(target.get(r.board) ?? "0"); // the dry run may have no target row yet; nothing is written then
      exts.push(ext);
    }
    let jobs = 0;
    if (opts.apply && ids.length) jobs = (await c.query<{ adverts: number; jobs: number }>(MOVE, [ids, srcs, exts])).rows[0]!.jobs;
    return { boards, moved, jobs };
  });
}
