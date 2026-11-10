// The loop of design section 3.1: boards a few at a time, adverts one at a time. Never throws for one bad advert or one bad board.
import { assess } from "@portal/rules";
import type { RawAdvert } from "@portal/sources";
import { planAdvert } from "./plan";
import { failBoard, finishBoard, saveJob, saveReject, startBoard, type BoardRun } from "./store";
import type { BoardReport, BoardTask, Deps, MatchResult } from "./types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function runBoard(deps: Deps, task: BoardTask, plan: typeof planAdvert): Promise<BoardReport> {
  const { db, now, log = () => {} } = deps;
  const report: BoardReport = { kind: task.kind, board: task.board, ok: false, error: null, seen: 0, passed: 0, queued: 0, rejected: 0, closed: 0, unsaved: [] };
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

  let fetched;
  try {
    fetched = await task.fetch(run.known); // no transaction is open here
  } catch (e) {
    return fail(message(e));
  }
  if (fetched.seen.length === 0 && run.known.size > 0) return fail(`returned nothing while ${run.known.size} adverts were known`);
  report.seen = fetched.seen.length;

  for (const advert of fetched.adverts) {
    if (deps.deadline && now() > deps.deadline) {
      report.unsaved.push(advert.id);
      continue;
    }
    try {
      const saved = await handle(deps, run, advert, plan);
      if (saved === "unsaved") report.unsaved.push(advert.id);
      else report[saved]++;
    } catch (e) {
      log(`${task.kind}/${task.board}: ${advert.id} not saved: ${message(e)}`);
      report.unsaved.push(advert.id);
    }
  }

  try {
    await finishBoard(db, run, now(), fetched.seen, report.passed + report.queued + report.rejected);
    report.ok = true;
  } catch (e) {
    report.error = message(e);
  }
  return report;
}

// One advert: assess, plan, write. The chain's matcher is wrapped so the plan can see what the matcher said.
async function handle(deps: Deps, run: BoardRun, advert: RawAdvert, plan: typeof planAdvert): Promise<"passed" | "queued" | "rejected" | "unsaved"> {
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
  if (p.action === "reject") {
    await saveReject(deps.db, run.sourceId, p.advert);
    return "rejected";
  }
  return saveJob(deps.db, run.sourceId, p.advert, p.job, p.text);
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
