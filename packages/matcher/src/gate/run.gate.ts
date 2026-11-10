// Not part of `npm run check`. The one place a real model may be called, and never from a test. Run from the repo root, see README.md.
import { expect, test } from "vitest";
import { runGate } from "./run";

test("the AI matcher gate", async () => {
  const { report, file } = await runGate(process.env, { fetch });
  console.log(`${report.score.note}\npassed ${report.score.passed}, correct ${report.score.passedCorrect}, share ${report.score.share}, lower 95% ${report.score.shareLow95}\nrejected ${report.score.rejected}, rightly rejected ${report.score.rejectedCorrect}\nreport: ${file}`);
  expect(report.score.holds, report.score.note).toBe(true);
});
