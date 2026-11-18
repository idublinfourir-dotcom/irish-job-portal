// The entry of the real run (vitest.run.config.ts): one fetch of every board, the work is in main.ts.
import { test } from "vitest";
import { runFailure } from "../src";
import { main } from "./main";

test("fetch every board once", async () => {
  // Everything that worked is saved by now. A run where a whole kind or most boards failed ends red (W1), so GitHub emails the owner;
  // the workflow's later steps still run (`!cancelled()`).
  const why = runFailure(await main());
  if (why) throw new Error(`the fetch ran but failed as a whole: ${why}`);
});
