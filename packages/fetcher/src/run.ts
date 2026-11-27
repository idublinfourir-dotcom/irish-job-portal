// The loop of design section 3.1: boards a few at a time, adverts one at a time. Never throws for one bad advert or one bad board.
import { applySecondOpinion, SHOWN, type BatchResult } from "@portal/matcher";
import { assess, listCheck, type Assessment } from "@portal/rules";
import { PACE, RATE_LIMITED, realSleep, type RawAdvert } from "@portal/sources";
import { isDue, hashAdvert } from "./hash";
import { planAdvert, stateOf } from "./plan";
import { failBoard, finishBoard, saveJob, saveKnown, saveReject, settleAdvert, startBoard, type BoardRun } from "./store";
import type { BoardReport, BoardTask, Deps, MatchResult } from "./types";

// OPS-1: a list that lost more than 30% (and more than 5) of a board of 10 or more live adverts is held, nothing written. A real mass closing is accepted by naming
// the board "kind/board" in FETCHER_ALLOW_SHRINK (comma list); the 7-day stale rule closes a truly dead board anyway.
export const SHRINK = { minBoard: 10, minLost: 5, share: 0.3 };
export function shrinkRefusal(task: { kind: string; board: string }, present: readonly string[], seen: readonly string[], allow = process.env.FETCHER_ALLOW_SHRINK ?? ""): string | null {
  const now = new Set(seen);
  const lost = present.filter((id) => !now.has(id)).length;
  if (present.length < SHRINK.minBoard || lost <= Math.max(SHRINK.minLost, SHRINK.share * present.length)) return null;
  if (allow.split(",").some((b) => b.trim() === `${task.kind}/${task.board}`)) return null;
  return `list shrank from ${present.length} to ${present.length - lost}: ${lost} adverts missing, nothing closed (set FETCHER_ALLOW_SHRINK=${task.kind}/${task.board} to accept)`;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Allowed = ReturnType<typeof listCheck>;

async function runBoard(deps: Deps, task: BoardTask, plan: typeof planAdvert, budget: { left: number }, allowed: Allowed): Promise<BoardReport> {
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

  // `known` = the adverts not gone, minus the ones due for a second read (design 3.8) and the ones with no hash (something asked for them to be read again, as
  // migration 0077 did). A gone advert is never known, so it comes back with its text.
  const present = [...run.rows].filter(([, k]) => !k.gone).map(([id]) => id);
  const known = new Set(present.filter((id) => run.rows.get(id)!.hash !== null && !isDue(id, task.rereadDays, now())));
  let fetched;
  try {
    fetched = await task.fetch(known); // no transaction is open here
  } catch (e) {
    return fail(message(e));
  }
  if (fetched.seen.length === 0 && present.length > 0) return fail(`returned nothing while ${present.length} adverts were known`);
  const held = shrinkRefusal(task, present, fetched.seen);
  if (held) return fail(held);
  report.seen = fetched.seen.length;
  let added = 0;
  let rechecked = 0;

  // Tally one advert's outcome. `saved` is what `save` returned.
  const tally = (id: string, saved: Saved) => {
    if (saved === "unsaved") report.unsaved.push(id);
    else if (saved === "same") return;
    else if (saved === "changed" || saved === "closed") {
      report.changed++;
      if (saved === "closed") rechecked++;
    } else {
      report[saved]++;
      added++;
    }
  };
  const late = () => deps.deadline !== undefined && now() > deps.deadline;

  // Step 1: the rules chain, advert by advert. Nothing is written yet.
  const items: Item[] = [];
  for (const advert of fetched.adverts) {
    if (late()) {
      report.unsaved.push(advert.id);
      continue;
    }
    try {
      const item = await prepare(deps, run, advert, allowed);
      if (item === "same") continue;
      items.push(item);
    } catch (e) {
      log(`${task.kind}/${task.board}: ${advert.id} not saved: ${message(e)}`);
      report.unsaved.push(advert.id);
    }
  }
  // Step 2: the model checks every badge, a batch at a time. A badge it could not check is not saved now (null).
  const decided = await secondOpinion(deps, budget, items, `${task.kind}/${task.board}`);
  // Step 3: write.
  for (const [i, item] of decided.entries()) {
    const advert = items[i]!.advert;
    if (!item || late()) {
      report.unsaved.push(advert.id);
      continue;
    }
    try {
      tally(advert.id, await save(deps, run, plan, item));
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

// One advert, in three steps. `prepare`: look at what is known of it and assess it with the rules chain if it is new or changed. `secondOpinion`: the model
// checks every badge. `save`: plan and write. The chain's matcher is wrapped so the plan can see what the matcher said.
type Saved = "passed" | "queued" | "rejected" | "unsaved" | "same" | "changed" | "closed";
type Item = { advert: RawAdvert; assessment: Assessment; m: MatchResult | null; hash: string };

async function prepare(deps: Deps, run: BoardRun, advert: RawAdvert, allowed: Allowed): Promise<Item | "same"> {
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
  const assessment = await assess(advert, {
    ...deps.chain,
    matcher: async (title, description) => {
      box.last = await deps.matcher(title, description);
      return box.last.match;
    },
  });
  // #305: a badge whose occupation code the lists in force do not allow is refused here, before the model is asked (the title rules say "on the list" in their own text)
  if (SHOWN.has(assessment.bucket) && !allowed(assessment.occupationCode, assessment.salaryLow))
    return { advert, assessment: { ...assessment, stage: "6 not on Critical Skills list", bucket: "rejected" }, m: box.last, hash };
  return { advert, assessment, m: box.last, hash };
}

/**
 * The AI second opinion (the gate's `applySecondOpinion`, one call a batch so a fault only costs its own batch). Returns the items in the same order, with a badge
 * the model did not back taken away (the plan refuses it, #298). A badge that could not be checked (budget used up, model error, timeout, a reply of the wrong size)
 * is null, and one whose own answer cannot be used carries its failure (the plan defers it): neither is ever saved without the model's word, both come back next run.
 */
async function secondOpinion(deps: Deps, budget: { left: number }, items: Item[], where: string): Promise<(Item | null)[]> {
  const size = deps.batchSize ?? 10;
  const out: (Item | null)[] = [...items];
  const badges = items.flatMap((it, i) => (SHOWN.has(it.assessment.bucket) ? [i] : []));
  let skipped = 0;
  for (let at = 0; at < badges.length; at += size) {
    const chunk = badges.slice(at, at + size);
    if (budget.left <= 0 || (deps.deadline && deps.now() > deps.deadline)) {
      for (const i of chunk) out[i] = null;
      skipped += chunk.length;
      continue;
    }
    budget.left--;
    let results: BatchResult[] = [];
    try {
      const finals = await applySecondOpinion(
        chunk.map((i) => items[i]!),
        async (adverts) => {
          results = await deps.checkBatch(adverts);
          const fault = results.find((r) => r.failure?.kind === "model error");
          if (fault) throw new Error(fault.failure?.why);
          return results;
        },
        deps.chain.minimums.nonList,
        size,
      );
      chunk.forEach((i, k) => {
        const r = results[k]!;
        out[i] = { ...items[i]!, assessment: finals[k]!, m: { match: r.match, quote: r.quote, modelId: r.modelId, failure: r.failure } };
      });
    } catch (e) {
      deps.log?.(`${where}: model check failed, ${chunk.length} badge adverts left for the next run: ${message(e)}`);
      for (const i of chunk) out[i] = null;
    }
  }
  if (skipped) deps.log?.(`${where}: model request budget or time used up, ${skipped} badge adverts left for the next run`);
  return out;
}

async function save(deps: Deps, run: BoardRun, plan: typeof planAdvert, { advert, assessment, m, hash }: Item): Promise<Saved> {
  const k = run.rows.get(advert.id);
  const p = plan(advert, assessment, m);
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
  const budget = { left: deps.maxModelRequests }; // shared by every board of the run
  const allowed = listCheck(deps.chain);
  const pooled = deps.boards.flatMap((t, i) => (t.serial ? [] : [i]));
  const serial = deps.boards.flatMap((t, i) => (t.serial ? [i] : []));
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < pooled.length; i = next++) reports[pooled[i]!] = await runBoard(deps, deps.boards[pooled[i]!]!, plan, budget, allowed);
  };
  // One lane for the serial boards, a pause apart. After PACE.giveUpAfter boards in a row gave up on 429/503, the rest are failed without a request.
  const lane = async () => {
    const sleep = deps.sleep ?? realSleep;
    let limited = 0;
    for (const [n, i] of serial.entries()) {
      const task = deps.boards[i]!;
      const stop = limited >= PACE.giveUpAfter;
      if (n && !stop) await sleep(PACE.serialBoardGapMs);
      const skipped = { ...task, fetch: async () => { throw new Error(`skipped after repeated 429: ${limited} ${task.kind} boards in a row were refused`); } };
      reports[i] = await runBoard(deps, stop ? skipped : task, plan, budget, allowed);
      limited = RATE_LIMITED.test(reports[i].error ?? "") ? limited + 1 : stop ? limited : 0;
    }
  };
  await Promise.all([lane(), ...Array.from({ length: Math.min(deps.concurrency ?? 8, pooled.length) }, worker)]);
  return reports;
}

/**
 * Whether the run as a whole failed (W1): every board of one kind failed, or more than half of all boards. The caller ends red on a reason,
 * after everything that worked was saved, so GitHub emails the owner. Null when the run is good enough.
 */
export function runFailure(reports: readonly BoardReport[]): string | null {
  const failed = reports.filter((r) => !r.ok);
  const kinds = [...new Set(reports.map((r) => r.kind))].filter((k) => reports.every((r) => r.kind !== k || !r.ok));
  if (kinds.length) return `every ${kinds.join(", ")} board failed (${failed.length} of ${reports.length} boards failed)`;
  if (failed.length * 2 > reports.length) return `${failed.length} of ${reports.length} boards failed`;
  return null;
}
