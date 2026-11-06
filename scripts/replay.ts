import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { GameRuntime, sceneHash } from "../src/runtime.js";
import type {
  ActionResult,
  NewGame,
  Scene,
  Swipe,
  Wait,
} from "../src/types.js";

const { values } = parseArgs({
  options: { trace: { type: "string" }, screenshot: { type: "string" } },
});
if (!values.trace)
  throw new Error(
    "Use --trace path/to/game/trace.jsonl [--screenshot result.png]",
  );
const rows = (await readFile(resolve(values.trace), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const runtime = await GameRuntime.launch();
let count = 0;
try {
  for (const row of rows) {
    if (row.type !== "action") continue;
    let result: Scene | ActionResult;
    if (row.method === "newGame")
      result = await runtime.newGame(row.input as NewGame);
    else if (row.method === "swipe")
      result = await runtime.swipe(row.input as Swipe);
    else if (row.method === "wait")
      result = await runtime.wait(row.input as Wait);
    else throw new Error(`Unsupported trace action: ${row.method}`);
    const scene = "scene" in result ? result.scene : result;
    if (sceneHash(scene) !== row.scene_sha256)
      throw new Error(`Replay diverged at action ${count + 1} (${row.method})`);
    count++;
  }
  if (values.screenshot)
    await writeFile(resolve(values.screenshot), await runtime.screenshot());
  console.log(
    JSON.stringify(
      { verified_actions: count, final_scene: await runtime.scene() },
      null,
      2,
    ),
  );
} finally {
  await runtime.close();
}
