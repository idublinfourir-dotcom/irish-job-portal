// The entry of the real run (vitest.run.config.ts): one fetch of every board, the work is in main.ts.
import { test } from "vitest";
import { main } from "./main";

test("fetch every board once", async () => {
  await main();
});
