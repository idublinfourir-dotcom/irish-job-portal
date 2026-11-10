// The loop of design section 3.1: boards a few at a time, adverts one at a time. Never throws for one bad advert or one bad board.
import { assess } from "@portal/rules";
import type { RawAdvert } from "@portal/sources";
import { isDue, hashAdvert } from "./hash";
import { planAdvert, stateOf } from "./plan";
import { failBoard, finishBoard, saveJob, saveKnown, saveReject, settleAdvert, startBoard, type BoardRun } from "./store";
import type { BoardReport, BoardTask, Deps, MatchResult } from "./types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function runBoard(deps: Deps, task: BoardTask, plan: typeof planAdvert): Promise<BoardReport> {
  const { db, now, log = () => {} } = deps;
  const report: BoardReport = { kind: task.kind, board: task.board, ok: false, error: null, seen: 0, passed: 0, queued: 0, rejected: 0, changed: 0, closed: 0, unsaved: [] };
  let run: BoardRun;
  try {
    run = await startBoard(db, task.kind, task.board);
  } catch (e) {
    report.error = message(e);
    return report;
  }
  // From here a failure is written to the run row.
  const fail = async (why: string) => {
    report.error = why;
    log(`${task.kind}/${task.board}: failed: ${why}`);
    await failBoard(db, run, now(), why).catch((e) => log(`${task.kind}/${task.board}: could not record the failure: ${message(e)}`));
    return report;
  };

  // `known` = the adverts not gone, minus the ones due for a second read (design 3.8). A gone advert is never known, so it comes back with its text.
  const present = [...run.rows].filter(([, k]) => !k.gone).map(([id]) => id);
  const known = new Set(present.filter((id) => !isDue(id, task.rereadDays, now())));
  let fetched;
  try {
    fetched = await task.fetch(known); // no transaction is open here
  } catch (e) {
    return fail(message(e));
  }
  if (fetched.seen.length === 0 && present.length > 0) return fail(`returned nothing while ${present.length} adverts were known`);
  report.seen = fetched.seen.length;
  let added = 0;
  let rechecked = 0;

  for (const advert of fetched.adverts) {
    if (deps.deadline && now() > deps.deadline) {
      report.unsaved.push(advert.id);
      continue;
    }
    try {
      const saved = await handle(deps, run, advert, plan);
      if (saved === "unsaved") report.unsaved.push(advert.id);
      else if (saved === "same") continue;
      else if (saved === "changed" || saved === "closed") {
        report.changed++;
        if (saved === "closed") rechecked++;
      } else {
        report[saved]++;
        added++;
      }
    } catch (e) {
      log(`${task.kind}/${task.board}: ${advert.id} not saved: ${message(e)}`);
      report.unsaved.push(advert.id);
    }
  }

  try {
    report.closed = await finishBoard(db, run, now(), fetched.seen, added, rechecked);
    report.ok = true;
  } catch (e) {
    report.error = message(e);
  }
  return report;
}

// One advert: look at what is known of it, assess if it is new or changed, plan, write. The chain's matcher is wrapped so the plan can see what the matcher said.
type Saved = "passed" | "queued" | "rejected" | "unsaved" | "same" | "changed" | "closed";
async function handle(deps: Deps, run: BoardRun, advert: RawAdvert, plan: typeof planAdvert): Promise<Saved> {
  const hash = hashAdvert(advert);
  const k = run.rows.get(advert.id);
  if (k) {
    const state = stateOf(k, hash);
    if (state === "same") return "same";
    // Staff's jobs are never touched (3.8). Held: only gone_at clears. Staff closed it: the hash is kept up to date so it is not read again each day.
    if (state === "held" || state === "settle") {
      const next = state === "held" ? k.hash : hash;
      if (k.gone || next !== k.hash) await settleAdvert(deps.db, k, next);
      return "same";
    }
  }
  const box: { last: MatchResult | null } = { last: null };
  const a = await assess(advert, {
    ...deps.chain,
    matcher: async (title, description) => {
      box.last = await deps.matcher(title, description);
      return box.last.match;
    },
  });
  const p = plan(advert, a, box.last);
  if (p.action === "defer") return "unsaved";
  if (k) return (await saveKnown(deps.db, run.sourceId, k, p, hash)) === "close" ? "closed" : "changed";
  if (p.action === "reject") {
    await saveReject(deps.db, run.sourceId, p.advert, hash);
    return "rejected";
  }
  return saveJob(deps.db, run.sourceId, p.advert, p.job, p.text, hash);
}

/** Runs every board. `plan` is a parameter only so tests can pass plans in directly. */
export async function runBoards(deps: Deps, plan: typeof planAdvert = planAdvert): Promise<BoardReport[]> {
  const reports: BoardReport[] = new Array(deps.boards.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < deps.boards.length; i = next++) reports[i] = await runBoard(deps, deps.boards[i]!, plan);
  };
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 8, deps.boards.length) }, worker));
  return reports;
}
