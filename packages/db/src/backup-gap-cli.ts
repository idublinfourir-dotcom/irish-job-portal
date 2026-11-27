// The gap between this backup and the one before it (audit of 27 Nov 2026, DEP-3): GitHub's scheduler runs the backup late and skips slots, so the
// database starts it on time (scheduler-setup-cli.ts). This is the watch on that trigger, and it does not depend on it: every backup run, however
// it was started, says how old the previous backup was, and goes red when that is over BACKUP_MAX_GAP_HOURS (unset: it only prints).
//   BACKUP_MAX_GAP_HOURS=8 node packages/db/src/backup-gap-cli.ts <newest manifest key in the bucket, or ""> <this backup's name, db-...Z>
const STAMP = /db-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z/;

/** The UTC time in a backup name or key (db-<yyyymmddThhmmZ>), or null when it has none. Pure. */
export function stampTime(name: string): number | null {
  const m = STAMP.exec(name);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) : null;
}

/** Hours from the previous backup to this one, or null when either name carries no time (the first backup ever). Pure. */
export function gapHours(prev: string, current: string): number | null {
  const a = stampTime(prev), b = stampTime(current);
  return a === null || b === null ? null : (b - a) / 3_600_000;
}

export function main(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): number {
  if (argv.length !== 2) return log("usage: backup-gap-cli.ts <previous manifest key or \"\"> <this backup's name>"), 2;
  const max = env.BACKUP_MAX_GAP_HOURS ? Number(env.BACKUP_MAX_GAP_HOURS) : null;
  if (max !== null && !(max > 0)) return log("BACKUP_MAX_GAP_HOURS must be a number above 0"), 2;
  const gap = gapHours(argv[0]!, argv[1]!);
  if (gap === null) return log("no earlier backup to compare with"), 0;
  log(`the backup before this one is ${gap.toFixed(1)} hours older`);
  if (max === null || gap <= max) return 0;
  log(`::error::the gap between backups was ${gap.toFixed(1)} hours, over the ${max} allowed: the on-time trigger in the database may have stopped (see docs/database.md, Backups)`);
  return 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env, console.log);
