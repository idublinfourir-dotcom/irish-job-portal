// The launch gate number (decisions #79, #145): of the jobs the chain passes with a Critical Skills badge, the share that truly qualify.
export type GateRow = {
  id: string;
  /** The chain passed the job with a Critical Skills badge (a job the site would show). */
  passed: boolean;
  /** The label says the job truly qualifies. */
  qualifies: boolean;
};

export const MIN_ROWS = 300;
export const GATE_SHARE = 0.98;

export type GateScore = {
  scored: number;
  passed: number;
  passedCorrect: number;
  /** The gate number, null when nothing passed. */
  share: number | null;
  /** Lower end of a 95% Wilson interval for the gate number, null when nothing passed. */
  shareLow95: number | null;
  rejected: number;
  rejectedCorrect: number;
  /** Reported beside the gate number, not a gate. Null when nothing was rejected. */
  rejectedShare: number | null;
  /** Ids passed with a badge that do not truly qualify. */
  wrongPassed: string[];
  /** Ids rejected that truly qualify. */
  wrongRejected: string[];
  enoughRows: boolean;
  holds: boolean;
  note: string;
};

/** Lower end of the Wilson score interval, z = 1.96. */
const wilsonLow = (k: number, n: number) => {
  const z = 1.96;
  const p = k / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
};

export function scoreGate(rows: readonly GateRow[]): GateScore {
  const passedRows = rows.filter((r) => r.passed);
  const rejectedRows = rows.filter((r) => !r.passed);
  const passedCorrect = passedRows.filter((r) => r.qualifies).length;
  const rejectedCorrect = rejectedRows.filter((r) => !r.qualifies).length;
  const enoughRows = rows.length >= MIN_ROWS;
  const share = passedRows.length ? passedCorrect / passedRows.length : null;
  // whole numbers, so 49 of 50 is exactly 98% and no float rounding decides the gate
  const shareOk = passedRows.length > 0 && passedCorrect * 100 >= passedRows.length * Math.round(GATE_SHARE * 100);
  const holds = enoughRows && shareOk;
  const note = !enoughRows
    ? `Only ${rows.length} rows were scored. The gate needs at least ${MIN_ROWS}, so these numbers are not a gate.`
    : passedRows.length === 0
      ? "No job passed with a badge, so the gate does not hold."
      : holds
        ? "The gate holds."
        : "The gate does not hold.";
  return {
    scored: rows.length,
    passed: passedRows.length,
    passedCorrect,
    share,
    shareLow95: passedRows.length ? wilsonLow(passedCorrect, passedRows.length) : null,
    rejected: rejectedRows.length,
    rejectedCorrect,
    rejectedShare: rejectedRows.length ? rejectedCorrect / rejectedRows.length : null,
    wrongPassed: passedRows.filter((r) => !r.qualifies).map((r) => r.id),
    wrongRejected: rejectedRows.filter((r) => r.qualifies).map((r) => r.id),
    enoughRows,
    holds,
    note,
  };
}
